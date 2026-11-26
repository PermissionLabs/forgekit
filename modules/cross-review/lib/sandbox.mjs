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
// codex runtime grant and (when code execution is allowed) the node runtime grant: the exact versioned package
// dir or the binary file itself, never a shared prefix, $HOME, CODEX_HOME or "/" (installRoot, grantProblem);
// /private/tmp and /private/var/tmp are explicitly denied, written after every grant; no write entries
// (read-only); no network entry (network denied).
// `-s read-only` must NOT be passed: it overrides the permission profile with full-disk read (verified).
// Enforcement is proven per run without a model call: `codex sandbox` with the exact config flags of codex
// exec must fail to read harmless probe files in os.tmpdir(), /private/tmp, /private/var/tmp and $HOME (a probe
// that cannot be created fails the self-test), fail to list the Codex
// home, fail to write the snapshot, and succeed reading a snapshot file. There is no audit-only fallback.
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

// A directory that is one versioned package (Homebrew Cellar/<name>/<ver>, nvm/fnm/Volta node versions, a codex
// standalone release dir such as 0.172.0-aarch64-apple-darwin): its basename starts with a version number.
const VERSION_DIR = /^v?\d+\.\d+(?:[.\-+_][0-9A-Za-z.\-+_]*)?$/;

/**
 * Read grant for a resolved executable: the nearest versioned package directory (at most 3 levels above the
 * executable's directory; or the enclosing node_modules package for an npm install), otherwise the executable
 * file itself. Never a shared prefix (/usr/local, /opt/homebrew, ~/.local, $HOME, /): a binary that sits
 * directly in a shared bin/ is granted as a single file (X18/A52).
 */
export function installRoot(realExe) {
  const parts = realExe.split(path.sep);
  const nm = parts.lastIndexOf("node_modules");
  if (nm !== -1 && nm + 1 < parts.length - 1) {
    const pkgLen = parts[nm + 1].startsWith("@") && nm + 2 < parts.length - 1 ? nm + 3 : nm + 2;
    return parts.slice(0, pkgLen).join(path.sep) || path.sep;
  }
  let dir = path.dirname(realExe);
  for (let i = 0; i < 4 && dir !== path.dirname(dir); i++, dir = path.dirname(dir)) {
    if (VERSION_DIR.test(path.basename(dir))) return dir;
  }
  return realExe;
}

/**
 * Codex runtime: the real binary (symlinks resolved; Codex's sandbox helper re-executes this path, so it must
 * be inside an allowed root), its read grant, and whether it is a script launcher (#!, e.g. an npm install),
 * in which case the node runtime is granted too. The self-test decides whether the result is enforced.
 */
export function codexRuntime(bin, envPath) {
  const found = which(bin, envPath);
  const exe = found && real(found);
  if (!exe) return { error: `codex binary ${bin} not found on PATH` };
  let head = "";
  try { const fd = fs.openSync(exe, "r"); const b = Buffer.alloc(2); fs.readSync(fd, b, 0, 2, 0); fs.closeSync(fd); head = b.toString("latin1"); } catch {}
  return { exe, root: installRoot(exe), script: head === "#!" };
}

/** Node runtime grant (when hosts.codex.allow_code_execution or a script launcher), or null when node is not on PATH. */
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
 * Canonical form of an absolute path (A60): symlinks resolved (realpath of the longest existing ancestor plus
 * the rest, so a nonexistent path is normalized too), `..` removed, and on case-insensitive volumes (macOS
 * default; caseInsensitive option for tests) the canonical on-disk case from realpath.native.
 */
export function canonicalPath(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    let r = null;
    try { r = fs.realpathSync.native(cur); } catch {}
    if (r) return rest.length ? path.join(r, ...rest.reverse()) : r;
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    rest.push(path.basename(cur));
    cur = parent;
  }
}
const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";
const within = (child, parent, fold = false) => {
  const [c, q] = fold ? [child.toLowerCase(), parent.toLowerCase()] : [child, parent];
  return c === q || c.startsWith(q.endsWith(path.sep) ? q : q + path.sep);
};

/**
 * Why a read grant is refused, or null. A grant may never be, or contain, "/", $HOME, CODEX_HOME or a DENY_READ
 * path; a runtime grant may not lie inside a DENY_READ path either (DENY_READ always wins: no grant can reopen it).
 * Both sides are compared canonicalized (canonicalPath) and, on case-insensitive volumes, case-folded (A60).
 */
export function grantProblem(p, { home = os.homedir(), codexHome = null, runtime = true, caseInsensitive = CASE_INSENSITIVE } = {}) {
  if (typeof p !== "string" || !path.isAbsolute(p)) return `permission profile path must be absolute: ${p}`;
  const fold = caseInsensitive;
  const rs = uniq([path.resolve(p), canonicalPath(p)]);
  const forbidden = [["/", "/"], [home, "$HOME"], [codexHome, "CODEX_HOME"], ...DENY_READ.map((d) => [d, d])].filter(([x]) => x);
  for (const r of rs) for (const [f, name] of forbidden) {
    for (const fr of uniq([path.resolve(f), canonicalPath(f)])) {
      if (within(fr, r, fold)) return `read grant ${p} is or contains ${name}`;
    }
  }
  if (runtime) for (const r of rs) for (const d of DENY_READ) for (const dr of uniq([d, canonicalPath(d)])) if (within(r, dr, fold)) return `runtime read grant ${p} lies inside denied ${d}`;
  return null;
}

/**
 * permissionProfile({ snapshot, codexRoot, nodeRoot, name, home, codexHome }) -> { name, filesystem }.
 * Only "read" and "none" entries: model-run commands can never write. Grants are checked (grantProblem) and
 * recorded canonicalized (A60) before the DENY_READ entries are written last, so a grant can never overwrite a denial.
 */
export function permissionProfile({ snapshot, codexRoot, nodeRoot = null, name = `cross_review_${crypto.randomBytes(4).toString("hex")}`, home = os.homedir(), codexHome = null, caseInsensitive = CASE_INSENSITIVE }) {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`bad permission profile name ${name}`);
  const filesystem = { ":minimal": "read" };
  for (const [p, runtime] of [[snapshot, false], [codexRoot, true], [nodeRoot, true]]) {
    if (!p) continue;
    const problem = grantProblem(p, { home, codexHome, runtime, caseInsensitive });
    if (problem) throw new Error(problem);
    filesystem[canonicalPath(p)] = "read";
  }
  for (const p of DENY_READ) filesystem[p] = "none";
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
 * Self-test with no model call: `codex sandbox <args> -- <cmd>` where args are exactly the config flags of the
 * real `codex exec` (permission profile, approval/web_search overrides, disabled features). `codex sandbox` has no
 * --ignore-user-config, so it runs with CODEX_HOME pointing at an empty private directory instead (no user
 * config.toml, profiles or rules can be merged); the real Codex home is still probed by path.
 * Every probe touches only harmless paths: probe files the runner created (os.tmpdir(), /private/tmp, $HOME),
 * a directory listing of the Codex home (names only, discarded), a write attempt inside the snapshot, a read of a
 * snapshot file. Token files are never opened.
 */
export function selfTest({ exe, args, cwd, probes = {}, probeFile, codexHome, insideFile, env, run = spawnSync }) {
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-sbx-codex-home-"));
  try {
    const sxEnv = { ...env, CODEX_HOME: emptyHome };
    const sx = (cmd) => {
      const r = run(exe, ["sandbox", ...args, "--", ...cmd], { cwd, env: sxEnv, encoding: "utf8", timeout: 30_000 });
      return { status: r.status, eperm: /Operation not permitted/.test(String(r.stderr ?? "")), error: r.error ? String(r.error.message ?? r.error) : null };
    };
    const denied = (x) => x.status !== 0 && x.eperm;
    // A53/A61: every probe is required; a probe the runner could not create fails the self-test (never a pass).
    const files = { outside: probes.outside ?? probeFile ?? null, privateTmp: probes.privateTmp ?? null, privateVarTmp: probes.privateVarTmp ?? null, home: probes.home ?? null };
    const raw = {};
    for (const [k, f] of Object.entries(files)) if (f) raw[k] = sx(["/bin/cat", f]);
    raw.codexHome = sx(["/bin/ls", codexHome]);
    raw.write = sx(["/usr/bin/touch", path.join(cwd, ".cross-review-write-probe")]);
    raw.inside = sx(["/bin/cat", insideFile]);
    const res = {
      outsideReadDenied: files.outside ? denied(raw.outside) : null,
      privateTmpReadDenied: files.privateTmp ? denied(raw.privateTmp) : null,
      privateVarTmpReadDenied: files.privateVarTmp ? denied(raw.privateVarTmp) : null,
      homeReadDenied: files.home ? denied(raw.home) : null,
      codexHomeListDenied: denied(raw.codexHome),
      snapshotWriteDenied: denied(raw.write),
      snapshotReadable: raw.inside.status === 0,
      userConfig: "not loaded (CODEX_HOME = empty private dir for the self-test)",
      raw,
    };
    res.unavailable = Object.entries(PROBE_KEYS).filter(([, f]) => !files[f]).map(([k]) => k);
    res.ok = res.unavailable.length === 0 && SELF_TEST_KEYS.every((k) => res[k] === true);
    return res;
  } finally { try { fs.rmSync(emptyHome, { recursive: true, force: true }); } catch {} }
}
export const SELF_TEST_KEYS = ["outsideReadDenied", "privateTmpReadDenied", "privateVarTmpReadDenied", "homeReadDenied", "codexHomeListDenied", "snapshotWriteDenied", "snapshotReadable"];
const PROBE_KEYS = { outsideReadDenied: "outside", privateTmpReadDenied: "privateTmp", privateVarTmpReadDenied: "privateVarTmp", homeReadDenied: "home" };

/**
 * Harmless probe files in fresh private directories outside every allowed root: os.tmpdir(), /private/tmp,
 * /private/var/tmp and $HOME. A probe that cannot be created is null and recorded in errors; the self-test then
 * fails (A53/A61). cleanup() removes them.
 */
export function makeProbe({ home = os.homedir(), privateTmp = "/private/tmp", privateVarTmp = "/private/var/tmp", tmp = os.tmpdir() } = {}) {
  const dirs = [];
  const errors = [];
  const mk = (key, parent) => {
    try {
      if (!parent) throw new Error("no directory");
      const dir = real(fs.mkdtempSync(path.join(parent, parent === home ? ".cross-review-sbx-probe-" : "cross-review-sbx-probe-")));
      if (!dir) throw new Error("probe directory vanished");
      dirs.push(dir);
      const file = path.join(dir, "probe.txt");
      fs.writeFileSync(file, "cross-review sandbox probe (harmless)\n");
      return file;
    } catch (e) { errors.push(`${key} (${parent}): ${e.message}`); return null; }
  };
  const probes = { outside: mk("outside", tmp), privateTmp: mk("privateTmp", privateTmp), privateVarTmp: mk("privateVarTmp", privateVarTmp), home: mk("home", home) };
  return { file: probes.outside, probes, errors, cleanup: () => { for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } };
}
