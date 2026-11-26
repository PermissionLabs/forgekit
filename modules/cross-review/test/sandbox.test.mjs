// OS sandbox: profile generation (pure) and enforcement proofs on macOS. No model call anywhere.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as sandbox from "../lib/sandbox.mjs";
import { configArgs as codexConfigArgs } from "../adapters/codex.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DARWIN = sandbox.sandboxAvailable();
let tmp, snap, outsideFile;

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-sbx-test-")));
  snap = path.join(tmp, "snap");
  fs.mkdirSync(path.join(snap, "src"), { recursive: true });
  fs.writeFileSync(path.join(snap, "src", "a.ts"), "export const a = 1;\n");
  // A harmless file outside the snapshot (never a token or user file).
  fs.mkdirSync(path.join(tmp, "outside"));
  outsideFile = path.join(tmp, "outside", "probe.txt");
  fs.writeFileSync(outsideFile, "outside\n");
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("permission profile: read/none entries only, shared temp areas denied, TOML and -c forms agree", () => {
  const p = sandbox.permissionProfile({ snapshot: snap, codexRoot: "/opt/codex", nodeRoot: "/opt/node", name: "cross_review_t" });
  // Grants first, denials last: a grant can never overwrite a denial (X18).
  assert.deepEqual(Object.entries(p.filesystem), [[":minimal", "read"], [snap, "read"], ["/opt/codex", "read"], ["/opt/node", "read"], ["/private/tmp", "none"], ["/private/var/tmp", "none"]]);
  const args = sandbox.profileArgs(p);
  assert.deepEqual(args.slice(0, 2), ["-c", 'default_permissions="cross_review_t"']);
  assert.match(args[3], /^permissions\.cross_review_t\.filesystem=\{":minimal"="read", /);
  const toml = sandbox.profileToml(p);
  assert.match(toml, /^default_permissions = "cross_review_t"\n\n\[permissions\.cross_review_t\.filesystem\]\n":minimal" = "read"/);
  assert.throws(() => sandbox.permissionProfile({ snapshot: "relative/dir", codexRoot: "/x" }), /absolute/);
  assert.throws(() => sandbox.tomlString("a\nb"), /not usable/);
  assert.equal(sandbox.tomlString('a"b\\c'), '"a\\"b\\\\c"');
  // A random profile name per run: a user config profile can never be merged into it.
  assert.notEqual(sandbox.permissionProfile({ snapshot: snap, codexRoot: "/x" }).name, sandbox.permissionProfile({ snapshot: snap, codexRoot: "/x" }).name);
});

test("sandbox-exec -p <profile>: an outside harmless file cannot be read, a snapshot file can (direct Seatbelt proof)", { skip: !DARWIN && "macOS Seatbelt only" }, () => {
  // The same deny-by-default read shape the codex profile compiles to: platform paths + the snapshot.
  const sbpl = ["(version 1)", "(allow default)", "(deny file-read*)", "(allow file-read-metadata)",
    `(allow file-read* (literal "/") (subpath "/usr/lib") (subpath "/System") (subpath "/bin") (subpath "/private/var/db/dyld") (subpath "/dev") (subpath "${snap}"))`].join("\n");
  const out = spawnSync(sandbox.SANDBOX_EXEC, ["-p", sbpl, "/bin/cat", outsideFile], { encoding: "utf8" });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /Operation not permitted/);
  const ins = spawnSync(sandbox.SANDBOX_EXEC, ["-p", sbpl, "/bin/cat", path.join(snap, "src", "a.ts")], { encoding: "utf8" });
  assert.equal(ins.status, 0, ins.stderr);
  assert.equal(ins.stdout, "export const a = 1;\n");
});

test("selfTest through the profile-enforcing codex stand-in: passes when enforced, fails when not", { skip: !DARWIN && "macOS Seatbelt only" }, () => {
  // A copy outside the source tree: the worktree may live under the denied /private/tmp.
  const exe = path.join(tmp, "bin", "fake-codex.mjs");
  fs.mkdirSync(path.dirname(exe));
  fs.copyFileSync(path.join(HERE, "fixtures", "fake-codex.mjs"), exe);
  const p = sandbox.permissionProfile({ snapshot: snap, codexRoot: exe });
  const probe = sandbox.makeProbe();
  try {
    assert.ok(probe.probes.privateTmp?.startsWith("/private/tmp/"), "a /private/tmp probe file is created");
    assert.ok(probe.probes.home?.startsWith(os.homedir() + path.sep), "a $HOME probe file is created");
    const common = { exe, args: sandbox.profileArgs(p), cwd: snap, probes: probe.probes, codexHome: path.join(tmp, "outside"), insideFile: path.join(snap, "src", "a.ts") };
    const seen = [];
    const ok = sandbox.selfTest({ ...common, env: process.env, run: (b, a, o) => { seen.push(o.env.CODEX_HOME); return spawnSync(b, a, o); } });
    assert.equal(ok.ok, true, JSON.stringify(ok.raw));
    assert.equal(ok.privateTmpReadDenied, true);
    assert.equal(ok.homeReadDenied, true);
    // A53: user config never reaches the self-test: CODEX_HOME is an empty private directory, removed afterwards.
    assert.ok(seen.every((h) => h && h !== process.env.CODEX_HOME && !fs.existsSync(h)));
    const noop = sandbox.selfTest({ ...common, env: { ...process.env, FAKE_SANDBOX_NOOP: "1" } });
    assert.equal(noop.ok, false);
    assert.equal(noop.outsideReadDenied, false);
    assert.equal(noop.privateTmpReadDenied, false);
    assert.equal(noop.homeReadDenied, false);
    assert.equal(noop.snapshotReadable, true);
  } finally { probe.cleanup(); }
  assert.equal(fs.existsSync(path.dirname(probe.probes.home)), false, "the $HOME probe directory is removed");
});

// The real codex binary, when installed: `codex sandbox` with the generated profile (no model call, no network).
const realCodex = DARWIN ? sandbox.codexRuntime("codex", process.env.PATH) : { error: "not macOS" };
test("real codex: the generated profile with the exact exec config flags is enforced by codex's Seatbelt (outside, /private/tmp and $HOME reads, CODEX_HOME listing, snapshot write denied)", { skip: (realCodex.error || realCodex.script) && `native codex not available (${realCodex.error ?? "script install"})` }, () => {
  const node = sandbox.nodeRuntime(process.env.PATH);
  const p = sandbox.permissionProfile({ snapshot: snap, codexRoot: realCodex.root, nodeRoot: node?.root });
  const probe = sandbox.makeProbe();
  try {
    const pin = { config: {} };
    const st = sandbox.selfTest({ exe: realCodex.exe, args: codexConfigArgs(pin, sandbox.profileArgs(p)), cwd: snap, probes: probe.probes, codexHome: path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex")), insideFile: path.join(snap, "src", "a.ts"), env: process.env });
    assert.equal(st.ok, true, JSON.stringify(st.raw));
  } finally { probe.cleanup(); }
});

test("selfTest fails closed when a probe is missing; makeProbe records creation failures and probes /private/var/tmp (A53/A61)", () => {
  // A stand-in runner that denies every probe read: only the missing probes can make the result fail.
  const run = (b, a) => {
    const cmd = a.slice(a.indexOf("--") + 1);
    const inside = cmd[0] === "/bin/cat" && cmd[1] === path.join(snap, "src", "a.ts");
    return inside ? { status: 0, stdout: "x", stderr: "" } : { status: 1, stdout: "", stderr: "Operation not permitted" };
  };
  const common = { exe: "/x/codex", args: [], cwd: snap, codexHome: path.join(tmp, "outside"), insideFile: path.join(snap, "src", "a.ts"), env: {}, run };
  const all = { outside: outsideFile, privateTmp: outsideFile, privateVarTmp: outsideFile, home: outsideFile };
  const full = sandbox.selfTest({ ...common, probes: all });
  assert.equal(full.ok, true);
  assert.deepEqual(full.unavailable, []);
  for (const k of Object.keys(all)) {
    const st = sandbox.selfTest({ ...common, probes: { ...all, [k]: null } });
    assert.equal(st.ok, false, `missing ${k} probe must not pass`);
    assert.equal(st.unavailable.length, 1, k);
  }
  const unwritable = path.join(tmp, "no-such-parent", "deeper");
  const probe = sandbox.makeProbe({ home: unwritable, privateTmp: unwritable, privateVarTmp: unwritable, tmp });
  try {
    assert.equal(probe.probes.home, null);
    assert.equal(probe.probes.privateVarTmp, null);
    assert.ok(probe.probes.outside);
    assert.equal(probe.errors.length, 3, probe.errors.join("\n"));
  } finally { probe.cleanup(); }
  const real = sandbox.makeProbe();
  try { assert.ok(real.probes.privateVarTmp?.startsWith("/private/var/tmp/"), "a /private/var/tmp probe file is created"); } finally { real.cleanup(); }
});

test("grantProblem compares canonical, case-folded paths; the profile records canonical paths (A60)", () => {
  const H = path.join(tmp, "Home");
  fs.mkdirSync(path.join(H, ".codex"), { recursive: true });
  const link = path.join(tmp, "codex-link");
  fs.symlinkSync(path.join(H, ".codex"), link);
  const ci = { caseInsensitive: true };
  // Non-canonical case of $HOME / CODEX_HOME.
  assert.match(sandbox.grantProblem(H, { home: H.replace("/Home", "/home"), ...ci }) ?? "", /\$HOME/);
  assert.match(sandbox.grantProblem(path.join(H, ".codex"), { home: "/nowhere", codexHome: path.join(H.replace("/Home", "/HOME"), ".codex"), ...ci }) ?? "", /CODEX_HOME/);
  // Symlinked CODEX_HOME: granting its target is refused.
  assert.match(sandbox.grantProblem(path.join(H, ".codex"), { home: "/nowhere", codexHome: link }) ?? "", /CODEX_HOME/);
  // Mixed-case and non-normalized denied paths.
  assert.match(sandbox.grantProblem("/Private/tmp/nonexistent", { home: "/nowhere", ...ci }) ?? "", /denied|\/private\/tmp/i);
  assert.match(sandbox.grantProblem("/tmp/x/../y", { home: "/nowhere" }) ?? "", /private\/tmp/);
  // The profile stores the canonical path, never the spelling it was given.
  const ver = path.join(tmp, "opt", "codex", "1.0");
  fs.mkdirSync(path.join(ver, "bin"), { recursive: true });
  const p = sandbox.permissionProfile({ snapshot: snap, codexRoot: path.join(ver, "bin", ".."), home: "/nowhere", name: "cross_review_t" });
  assert.ok(Object.hasOwn(p.filesystem, ver), Object.keys(p.filesystem).join());
  assert.ok(!Object.keys(p.filesystem).some((k) => k.includes("..")));
});

test("codex stand-in follows :minimal and last-match-wins: without the DENY_READ entries the shared temp areas are readable (A62)", { skip: !DARWIN && "macOS Seatbelt only" }, () => {
  const exe = path.join(tmp, "bin2", "fake-codex.mjs");
  fs.mkdirSync(path.dirname(exe));
  fs.copyFileSync(path.join(HERE, "fixtures", "fake-codex.mjs"), exe);
  const p = sandbox.permissionProfile({ snapshot: snap, codexRoot: exe, name: "cross_review_t" });
  const probe = sandbox.makeProbe();
  try {
    const common = { exe, cwd: snap, probes: probe.probes, codexHome: path.join(tmp, "outside"), insideFile: path.join(snap, "src", "a.ts"), env: process.env };
    const ok = sandbox.selfTest({ ...common, args: sandbox.profileArgs(p) });
    assert.equal(ok.ok, true, JSON.stringify(ok.raw));
    const weak = { ...p, filesystem: Object.fromEntries(Object.entries(p.filesystem).filter(([, v]) => v !== "none")) };
    const st = sandbox.selfTest({ ...common, args: sandbox.profileArgs(weak) });
    assert.equal(st.privateTmpReadDenied, false);
    assert.equal(st.privateVarTmpReadDenied, false);
    assert.equal(st.ok, false);
  } finally { probe.cleanup(); }
});
