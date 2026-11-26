// OS-enforced read confinement for Codex model-run commands (macOS Seatbelt).
//
// Why not an outer `sandbox-exec` around `codex exec`: macOS refuses a nested sandbox_apply inside any
// restrictive profile (verified 2026-11-26, macOS 27.2: even an outer profile whose only rule is
// `(deny file-write*) (allow file-write* (subpath "/"))` makes the inner `sandbox-exec` fail with EPERM / exit 71).
// Codex runs every model command under its own Seatbelt profile, so an outer profile breaks every command.
//
// Instead the runner generates a Codex permission profile (`default_permissions` + `permissions.<name>.filesystem`)
// that Codex compiles into the Seatbelt profile of every model-run command: reads are denied except the
// built-in :minimal platform set (system libraries/frameworks, /bin, /usr/bin, /etc, ...), the snapshot, the
// codex install root and (when code execution is allowed) the node install root; /private/tmp and
// /private/var/tmp are explicitly denied; no write entries (read-only); no network entry (network denied).
// `-s read-only` must NOT be passed: it overrides the permission profile with full-disk read (verified).
// Enforcement is proven per run without a model call: `codex sandbox` with the same profile must fail to
// read a harmless probe file outside the snapshot, fail to list the Codex home, fail to write the snapshot,
// and succeed reading a snapshot file.
//
// The codex process itself is not confined (it must read its own auth file); the runner never opens token files.
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Seatbelt is available: macOS with /usr/bin/sandbox-exec (Codex applies its command sandbox through it). */
export function sandboxAvailable({ platform = process.platform, exists = fs.existsSync } = {}) {
  return platform === "darwin" && exists(SANDBOX_EXEC);
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const uniq = (a) => [...new Set(a.filter(Boolean))];

/** Absolute path of `bin` on PATH (or as given when it contains a slash). */
export function which(bin, envPath = process.env.PATH ?? "") {
  if (bin.includes("/")) return path.resolve(bin);
  for (const d of envPath.split(":").filter(Boolean)) {
    const p = path.join(d, bin);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

/** Install root of a resolved executable: <root>/bin/<exe> -> <root>; otherwise the executable's directory. */
export function installRoot(realExe) {
  const dir = path.dirname(realExe);
  return path.basename(dir) === "bin" ? path.dirname(dir) : dir;
}

/**
 * Codex runtime: the real binary (symlinks resolved; Codex's sandbox helper re-executes this path, so it must
 * be inside an allowed root), its install root, and whether it is a script launcher (#!, e.g. an npm install),
 * in which case the node install root is allowed too. The self-test decides whether the result is enforced.
 */
export function codexRuntime(bin, envPath) {
  const found = which(bin, envPath);
  const exe = found && real(found);
  if (!exe) return { error: `codex binary ${bin} not found on PATH` };
  let head = "";
  try { const fd = fs.openSync(exe, "r"); const b = Buffer.alloc(2); fs.readSync(fd, b, 0, 2, 0); fs.closeSync(fd); head = b.toString("latin1"); } catch {}
  return { exe, root: installRoot(exe), script: head === "#!" };
}

/** Node runtime root (allowed for reads when hosts.codex.allow_code_execution), or null when node is not on PATH. */
export function nodeRuntime(envPath) {
  const found = which("node", envPath);
  const exe = found && real(found);
  return exe ? { exe, root: installRoot(exe) } : null;
}

/** A path or key as a TOML basic string; control characters are refused. */
export function tomlString(s) {
  const v = String(s);
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new Error(`value not usable in a codex permission profile: ${JSON.stringify(v)}`);
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Read access denied explicitly although :minimal includes them (shared temp areas).
export const DENY_READ = ["/private/tmp", "/private/var/tmp"];

/**
 * permissionProfile({ snapshot, codexRoot, nodeRoot, name }) -> { name, filesystem }.
 * Only "read" and "none" entries: model-run commands can never write. More specific entries win over broader ones.
 */
export function permissionProfile({ snapshot, codexRoot, nodeRoot = null, name = `cross_review_${crypto.randomBytes(4).toString("hex")}` }) {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`bad permission profile name ${name}`);
  const filesystem = { ":minimal": "read" };
  for (const p of DENY_READ) filesystem[p] = "none";
  for (const p of uniq([real(snapshot) ?? snapshot, codexRoot, nodeRoot])) {
    if (!path.isAbsolute(p)) throw new Error(`permission profile path must be absolute: ${p}`);
    filesystem[p] = "read";
  }
  return { name, filesystem };
}

/** `codex -c` overrides selecting the profile (used for `codex exec` and the `codex sandbox` self-test alike). */
export function profileArgs(profile) {
  const fsToml = `{${Object.entries(profile.filesystem).map(([k, v]) => `${tomlString(k)}=${tomlString(v)}`).join(", ")}}`;
  return ["-c", `default_permissions=${tomlString(profile.name)}`, "-c", `permissions.${profile.name}.filesystem=${fsToml}`];
}

/** The profile as the TOML a user would write in config.toml (stored in evidence with its hash). */
export function profileToml(profile) {
  return [`default_permissions = ${tomlString(profile.name)}`, "", `[permissions.${profile.name}.filesystem]`, ...Object.entries(profile.filesystem).map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`), ""].join("\n");
}

/**
 * Self-test with no model call: `codex sandbox <profile> -- <cmd>` exactly as model commands are confined.
 * Every probe touches only harmless paths: a probe file the runner created, a directory listing of the Codex
 * home (names only, discarded), a write attempt inside the snapshot, a read of a snapshot file.
 */
export function selfTest({ exe, args, cwd, probeFile, codexHome, insideFile, env, run = spawnSync }) {
  const sx = (cmd) => {
    const r = run(exe, ["sandbox", ...args, "--", ...cmd], { cwd, env, encoding: "utf8", timeout: 30_000 });
    return { status: r.status, eperm: /Operation not permitted/.test(String(r.stderr ?? "")), error: r.error ? String(r.error.message ?? r.error) : null };
  };
  const outside = sx(["/bin/cat", probeFile]);
  const home = sx(["/bin/ls", codexHome]);
  const write = sx(["/usr/bin/touch", path.join(cwd, ".cross-review-write-probe")]);
  const inside = sx(["/bin/cat", insideFile]);
  const res = {
    outsideReadDenied: outside.status !== 0 && outside.eperm,
    codexHomeListDenied: home.status !== 0 && home.eperm,
    snapshotWriteDenied: write.status !== 0 && write.eperm,
    snapshotReadable: inside.status === 0,
    raw: { outside, home, write, inside },
  };
  res.ok = res.outsideReadDenied && res.codexHomeListDenied && res.snapshotWriteDenied && res.snapshotReadable;
  return res;
}

/** A harmless probe file in a fresh private directory outside every allowed root; cleanup() removes it. */
export function makeProbe() {
  const dir = real(fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-sbx-probe-")));
  const file = path.join(dir, "outside.txt");
  fs.writeFileSync(file, "cross-review sandbox probe (harmless)\n");
  return { file, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}
