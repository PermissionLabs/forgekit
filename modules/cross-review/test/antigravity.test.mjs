// Antigravity adapter runtime against an ACP stub (fixtures/fake-agy.mjs): no model call, no real profile.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy, defaultPolicyPath } from "../lib/policy.mjs";
import { runReview } from "../lib/run.mjs";
import { buildEnv, exitReason, findRuntime, isAgy, launchArgs, planTurns, stopGroup, totalBudget } from "../adapters/antigravity.mjs";
import { decodeGeneration, normalizeModelName, protoFields } from "../lib/agy-session-db.mjs";
import { plan } from "../lib/plan.mjs";
import { runTurns } from "../lib/turns.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { policy: basePolicy } = loadPolicy(defaultPolicyPath());
let tmp, repo, rev, policyPath, diffPath, briefPath, profileAcp, runtimeRoot, cliRoot;
const git = (...a) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-C", repo, ...a], { encoding: "utf8" }).trim();
const DIMS = ["correctness", "tests"];

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-agy-test-")));
  repo = path.join(tmp, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "src/a.ts"), "export const a = 1;\nexport const b = a + 1;\n");
  fs.writeFileSync(path.join(repo, "src/b.ts"), "export const c = 3;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  rev = git("rev-parse", "HEAD");
  runtimeRoot = path.join(tmp, "runtime", "versions");
  for (const v of ["1.2.0", "1.10.0"]) {
    fs.mkdirSync(path.join(runtimeRoot, v), { recursive: true });
    // .par is not a loadable module name for node: a tiny sh launcher execs the stub.
    fs.writeFileSync(path.join(runtimeRoot, v, "agy_acp_server.par"), `#!/bin/sh\nexec '${process.execPath}' '${path.join(HERE, "fixtures", "fake-agy.mjs")}' "$@"\n`);
    fs.chmodSync(path.join(runtimeRoot, v, "agy_acp_server.par"), 0o755);
  }
  // 1.5 "cli" layout: release-id directories with .install-complete.json naming the executable.
  cliRoot = path.join(tmp, "cli-runtime", "versions");
  const launcher = `#!/bin/sh\nexec '${process.execPath}' --no-warnings '${path.join(HERE, "fixtures", "fake-agy.mjs")}' "$@"\n`;
  const rel = (dir, rec, exe = "antigravity", body = launcher) => {
    const d = path.join(cliRoot, dir);
    fs.mkdirSync(d, { recursive: true });
    if (body !== null) { fs.writeFileSync(path.join(d, exe), body); fs.chmodSync(path.join(d, exe), 0o755); }
    fs.writeFileSync(path.join(d, ".install-complete.json"), JSON.stringify({ releaseId: dir, executable: { name: exe, bytes: Buffer.byteLength(body ?? "") }, ...rec }));
  };
  rel("aaa-new", { version: "1.5.18" });
  rel("bbb-old", { version: "1.5.2" });
  rel("ccc-badsize", { version: "9.9.1", executable: { name: "antigravity", bytes: 1 } });
  rel("ddd-badname", { version: "9.9.2", executable: { name: "../antigravity", bytes: 1 } }, "x");
  rel("eee-noversion", { version: "../9" });
  rel("fff-symlink", { version: "9.9.3" }, "antigravity", null);
  fs.symlinkSync(path.join(cliRoot, "aaa-new", "antigravity"), path.join(cliRoot, "fff-symlink", "antigravity"));
  rel("ggg-nobytes", { version: "9.9.4", executable: { name: "antigravity" } });
  rel("hhh-strbytes", { version: "9.9.5", executable: { name: "antigravity", bytes: String(Buffer.byteLength(launcher)) } });
  // A symlinked version directory (pointing outside versions/) and a symlinked install record are never used.
  const outside = path.join(tmp, "outside-rel");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "antigravity"), launcher); fs.chmodSync(path.join(outside, "antigravity"), 0o755);
  fs.writeFileSync(path.join(outside, ".install-complete.json"), JSON.stringify({ version: "9.9.6", executable: { name: "antigravity", bytes: Buffer.byteLength(launcher) } }));
  fs.symlinkSync(outside, path.join(cliRoot, "iii-dirlink"));
  fs.mkdirSync(path.join(cliRoot, "jjj-reclink"));
  fs.writeFileSync(path.join(cliRoot, "jjj-reclink", "antigravity"), launcher); fs.chmodSync(path.join(cliRoot, "jjj-reclink", "antigravity"), 0o755);
  fs.symlinkSync(path.join(outside, ".install-complete.json"), path.join(cliRoot, "jjj-reclink", ".install-complete.json"));
  // .par fallback: a non-numeric directory name and a symlinked .par are never candidates.
  fs.mkdirSync(path.join(cliRoot, "old"));
  fs.writeFileSync(path.join(cliRoot, "old", "agy_acp_server.par"), launcher); fs.chmodSync(path.join(cliRoot, "old", "agy_acp_server.par"), 0o755);
  fs.mkdirSync(path.join(cliRoot, "9.9.7"));
  fs.symlinkSync(path.join(outside, "antigravity"), path.join(cliRoot, "9.9.7", "agy_acp_server.par"));
  fs.mkdirSync(path.join(cliRoot, "1.4.9"));
  fs.writeFileSync(path.join(cliRoot, "1.4.9", "agy_acp_server.par"), launcher);
  fs.chmodSync(path.join(cliRoot, "1.4.9", "agy_acp_server.par"), 0o755);
  profileAcp = path.join(tmp, "profiles", "p1", "antigravity-acp");
  fs.mkdirSync(profileAcp, { recursive: true });
  const p = JSON.parse(JSON.stringify(basePolicy));
  Object.assign(p.hosts.antigravity, { timeout_sec: 400, turn_timeout_sec: 120, retry_timeout_sec: 90, runtime: { runtime_root: runtimeRoot, profile_root: path.join(tmp, "profiles"), expect_agent_version: null } });
  policyPath = path.join(tmp, "policy.json");
  fs.writeFileSync(policyPath, JSON.stringify(p));
  diffPath = path.join(tmp, "pr.patch");
  fs.writeFileSync(diffPath, "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n export const a = 1;\n+export const b = a + 1;\n");
  briefPath = path.join(tmp, "brief.md");
  fs.writeFileSync(briefPath, "Review the change.\n");
});
after(() => { delete process.env.FAKE_AGY; fs.rmSync(tmp, { recursive: true, force: true }); });

const policy = (over = {}) => { const p = JSON.parse(fs.readFileSync(policyPath, "utf8")); Object.assign(p.hosts.antigravity, over); return p; };
let n = 0;
const go = async (fake = {}, over = {}, extra = {}) => {
  process.env.FAKE_AGY = JSON.stringify(fake);
  return runReview({ host: "antigravity", repo, rev, diff: diffPath, scope: ["src/a.ts", "src/b.ts"], context: [], checklist: [], brief: briefPath, out: path.join(tmp, `out-${n++}`), dimensions: DIMS, ...extra }, policy(over), policyPath);
};
const withheld = (ev, re) => {
  assert.equal(ev.status, "incomplete");
  assert.equal(ev.review, null);
  assert.match(ev.incompleteReasons.join("\n"), re);
};

test("happy path: one turn per group, contiguous ids, proxy model per turn, session files and isolation cleaned", async () => {
  const ev = await go();
  assert.equal(ev.status, "complete", ev.incompleteReasons.join());
  assert.deepEqual(ev.review.findings.map((f) => f.id), ["A1", "A2"]);
  assert.deepEqual(ev.extra.groups, [["correctness"], ["tests"]]);
  assert.ok(ev.attempts.every((a) => a.proxyModels.length === 1));
  assert.equal(ev.reported.model, "gemini-4-neon");
  assert.equal(ev.isolation.runtime, "1.10.0"); // highest version, not directory order (A31)
  assert.deepEqual(ev.extra.sessionCleanup.removed.sort(), ["11111111-1111-4111-8111-111111111111.db", "11111111-1111-4111-8111-111111111111.meta"]);
  assert.equal(fs.existsSync(ev.isolation.geminiHome), false);
  assert.ok(ev.extra.process.signals.every((s) => s.sig === undefined || s.why === "child alive"));
});

test("a turn ending in a fatal condition withholds the review even when its text is schema-valid (X1/A11)", async () => {
  withheld(await go({ stopReason: { 1: "cancelled" } }), /stop_reason:group:tests:cancelled/);
  withheld(await go({ stderrLine: { 0: "E1126 agent.go:1] RESOURCE_EXHAUSTED quota" } }), /agent_error:group:correctness/);
  withheld(await go({ stderrLine: { 0: "Proxy failed to connect to CCPA API" } }), /upstream_502:group:correctness/);
  withheld(await go({ error: { 1: "boom" } }), /prompt_error:group:tests:boom/);
  withheld(await go({ stderrLine: { 0: "Open the following link to authenticate the ACP server: https://accounts.google.com/x" } }), /auth_required/);
});

test("the corrective retry is checked for fatal conditions too (X1)", async () => {
  const ev = await go({ invalid: [0], stopReason: { 1: "cancelled" } });
  withheld(ev, /stop_reason:group:correctness:retry:cancelled/);
});

test("every turn needs a matching proxy model line (X4)", async () => {
  withheld(await go({ noProxy: [0, 1] }), /proxy_model_unconfirmed:group:correctness/);
  withheld(await go({ noProxy: [1] }), /proxy_model_unconfirmed:group:tests/);
  withheld(await go({ proxyModel: "gemini-4-lite-high" }), /proxy_model_mismatch:gemini-4-lite-high/);
});

test("tool audit uses the full rawInput and tool_call_update titles (A5)", async () => {
  // A long path that only escapes after the first 500 characters.
  withheld(await go({ longEscape: true }), /tool_read_outside_snapshot/);
  withheld(await go({ updateTitle: { 1: "run_command" } }), /non_view_file_tool_calls:1/);
});

test("ids continue across turns; a turn restarting at A1 is rejected (A13)", async () => {
  const ev = await go({ restartIds: true });
  withheld(ev, /schema_invalid_after_retry:group:tests/);
  assert.match(JSON.stringify(ev.attempts.map((a) => a.validation)), /findings\[0\]\.id should be A2/);
});

test("large scope is split into file chunks per turn (operator 5)", async () => {
  const ev = await go({}, { max_files_per_turn: 1 });
  assert.equal(ev.status, "complete", ev.incompleteReasons.join());
  assert.equal(ev.attempts.length, 4);
  assert.deepEqual(ev.attempts.map((a) => a.label), ["group:correctness:files1/2", "group:correctness:files2/2", "group:tests:files1/2", "group:tests:files2/2"]);
  assert.deepEqual(ev.review.findings.map((f) => `${f.id} ${f.loc}`), ["A1 src/a.ts:1", "A2 src/b.ts:1", "A3 src/a.ts:1", "A4 src/b.ts:1"]);
});

test("spawn failure and an early server exit fail fast instead of waiting for the RPC timeout (A14)", async () => {
  const bad = path.join(tmp, "bad-runtime", "versions", "9.9.9");
  fs.mkdirSync(bad, { recursive: true });
  // Discovered (regular, executable) but cannot start: its interpreter does not exist.
  fs.writeFileSync(path.join(bad, "agy_acp_server.par"), "#!/nonexistent/cross-review-interpreter\n");
  fs.chmodSync(path.join(bad, "agy_acp_server.par"), 0o755);
  const t0 = Date.now();
  const ev = await go({}, { runtime: { ...policy().hosts.antigravity.runtime, runtime_root: path.dirname(bad) } });
  withheld(ev, /spawn_error/);
  assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms`);
  const t1 = Date.now();
  withheld(await go({ exitAfter: "initialize" }), /fatal:agent exited|authenticate_failed:agent exited/);
  assert.ok(Date.now() - t1 < 15_000, `took ${Date.now() - t1} ms`);
});

test("stopGroup: after exit only members started between spawn and exit are signalled, by pid (A6/X3)", async () => {
  const kills = [];
  const spawnedAt = Date.now() - 10_000, exitAt = Date.now() - 1000;
  const base = { pid: 4242, spawnedAt, exitedAt: () => exitAt, exited: () => true, waitExit: async () => {}, kill: (p, s) => kills.push([p, s]), sleep: async () => {} };
  const log = await stopGroup({ ...base, members: () => [] });
  assert.deepEqual(kills, []);
  assert.equal(log[0].skipped, "no live group member after exit");
  // A bare numeric match, or a replacement group started after the exit: never signalled.
  await stopGroup({ ...base, members: () => [99] });
  await stopGroup({ ...base, members: () => [{ pid: 99, startMs: exitAt + 5000 }] });
  assert.deepEqual(kills, []);
  await stopGroup({ ...base, members: () => [{ pid: 99, startMs: spawnedAt + 2000 }] });
  assert.deepEqual(kills, [[99, "SIGTERM"], [99, "SIGKILL"]]);
  // While the child is not reaped it holds the group: signalling the group is safe without ps.
  const k2 = [];
  let alive = true;
  await stopGroup({ ...base, exited: () => !alive, waitExit: async () => {}, kill: (p, s) => { k2.push([p, s]); if (s === "SIGTERM") alive = false; }, members: () => [] });
  assert.deepEqual(k2, [[-4242, "SIGTERM"]]);
});

test("an unterminated last stderr line is flushed and checked before the review is accepted (X1/A11)", async () => {
  withheld(await go({ trailingStderr: "E1126 agent.go:9] RESOURCE_EXHAUSTED: quota exceeded" }), /agent_error:stderr/);
  withheld(await go({ trailingStderr: "Proxy failed to connect to CCPA API" }), /upstream_502:stderr outside a turn/);
});

test("an upstream 5xx before the first turn (during session setup) is never absorbed by a later turn (A55)", async () => {
  withheld(await go({ splitStderr: ["System step error (HTTP 502)", "\n"] }), /upstream_502:stderr outside a turn \(1\)/);
});

test("server exit classification: only the signal we sent to the live group after cleanup started is ours (X12)", async () => {
  const pid = 4242, sent = [{ sig: "SIGTERM", target: -pid, why: "child alive" }];
  assert.equal(exitReason({ exitInfo: { code: null, signal: "SIGTERM", wall: 200 }, cleanupStartedWall: 100, signals: sent, pid }), null);
  // Crash before cleanup, followed by our SIGTERM to a leftover descendant: still the agent's crash.
  assert.match(exitReason({ exitInfo: { code: null, signal: "SIGSEGV", wall: 50 }, cleanupStartedWall: 100, signals: [{ sig: "SIGTERM", target: 999 }], pid }), /agent_exit_signal:SIGSEGV \(before cleanup: crash\)/);
  assert.match(exitReason({ exitInfo: { code: null, signal: "SIGTERM", wall: 50 }, cleanupStartedWall: 100, signals: sent, pid }), /before cleanup/);
  // A different signal during cleanup is not ours either.
  assert.match(exitReason({ exitInfo: { code: null, signal: "SIGABRT", wall: 200 }, cleanupStartedWall: 100, signals: sent, pid }), /agent_exit_signal:SIGABRT$/);
  assert.equal(exitReason({ exitInfo: { code: 3, signal: null, wall: 200 }, cleanupStartedWall: 100, signals: [], pid }), "agent_exit_nonzero:3");
  // End to end: the server kills itself with SIGABRT when stdin closes (during cleanup, a signal we never sent).
  withheld(await go({ signalOnStdinEnd: "SIGABRT" }), /agent_exit_signal:SIGABRT/);
});

test("an incomplete run keeps the accepted turns as reviewIfIncomplete, like the other adapters", async () => {
  const ev = await go({ stopReason: { 1: "cancelled" } });
  withheld(ev, /stop_reason:group:tests:cancelled/);
  assert.deepEqual(ev.reviewIfIncomplete.findings.map((f) => f.id), ["A1"]);
  assert.equal(ev.reviewIfIncomplete.coverage.correctness, "checked");
  assert.match(ev.reviewIfIncomplete.coverage.tests, /^n\/a:not reviewed/);
});

test("~-prefixed tool paths are outside the snapshot (A47)", async () => {
  const ev = await go({ readPath: { 0: "~/.codex/auth.json" } });
  withheld(ev, /tool_read_outside_snapshot:1/);
  assert.deepEqual(ev.toolAudit.outsideSnapshot, ["~/.codex/auth.json"]);
});

test("the total budget scales with the planned turns, with a floor and a cap (A63)", async () => {
  assert.deepEqual(totalBudget({ per_turn_budget_sec: 180, max_total_sec: 3600 }, 16, 1_500_000), { totalMs: 2_880_000, perTurnSec: 180, floorSec: 600, capSec: 3600, capped: false });
  assert.equal(totalBudget({ per_turn_budget_sec: 180, max_total_sec: 3600 }, 30, 1).totalMs, 3_600_000);
  assert.equal(totalBudget({ per_turn_budget_sec: 180, max_total_sec: 3600 }, 30, 1).capped, true);
  assert.equal(totalBudget({}, 16, 1_500_000).totalMs, 1_500_000);
  // A63: a 1-turn run is never squeezed below one turn's timeout (was 180 s; 89 s made turn 0 time out before it ran).
  // Floor precedence (A69): min_total_sec, else turn_timeout_sec, else 600.
  assert.equal(totalBudget({ per_turn_budget_sec: 180, max_total_sec: 3600, turn_timeout_sec: 700 }, 1, 1).totalMs, 700_000);
  assert.equal(totalBudget({ per_turn_budget_sec: 180, max_total_sec: 3600, turn_timeout_sec: 700, min_total_sec: 900 }, 1, 1).totalMs, 900_000);
  assert.equal(totalBudget({ per_turn_budget_sec: 89, max_total_sec: 3600 }, 1, 1).totalMs, 600_000);
  assert.equal(totalBudget({ per_turn_budget_sec: 180, min_total_sec: 900, max_total_sec: 3600 }, 2, 1).totalMs, 900_000);
  assert.equal(totalBudget({ per_turn_budget_sec: 180, min_total_sec: 900, max_total_sec: 700 }, 2, 1).totalMs, 700_000);
  const ev = await go({}, { per_turn_budget_sec: 100, max_total_sec: 1000, min_total_sec: 150 });
  assert.equal(ev.status, "complete", ev.incompleteReasons.join());
  assert.equal(ev.timeoutMs, 200_000); // 2 turns x 100 s
  const ev2 = await go({}, { per_turn_budget_sec: 30, max_total_sec: 1000 });
  assert.equal(ev2.status, "complete", ev2.incompleteReasons.join());
  assert.equal(ev2.timeoutMs, 600_000); // floor: min_total_sec (600, from the shipped policy), not turn_timeout_sec
});

test("plan() estimates Antigravity turns like the adapter (leftover group, byte chunks) and warns only when antigravity reviews (A63/A65/A66)", () => {
  const dims = ["security", "correctness", "tests", "contract_docs", "portability"];
  const hp = basePolicy.hosts.antigravity;
  // r4: 23 scope files; 4 groups (portability is the leftover group); bytes split them into 4 chunks -> 16 turns.
  const files = Array.from({ length: 23 }, (_, i) => ({ path: `f${i}.mjs`, bytes: 20_000 }));
  const scopeFiles = files.map((f) => ({ ...f, kind: "scope" }));
  const actual = runTurns(hp, dims, scopeFiles).turns.length;
  const p = plan({ policy: basePolicy, author: "claude", dimensions: dims, paths: files.map((f) => f.path), usage: null, files });
  assert.equal(p.hosts.antigravity.budget.estimatedTurns, actual);
  assert.equal(actual, 4 * Math.ceil(23 / Math.floor(hp.max_bytes_per_turn / 20_000)));
  // Without sizes the estimate is the lower bound by file count (still including the leftover group).
  const lb = plan({ policy: basePolicy, author: "claude", dimensions: dims, paths: files.map((f) => f.path), usage: null });
  assert.equal(lb.hosts.antigravity.budget.estimatedTurns, 4 * Math.ceil(23 / hp.max_files_per_turn));
  // A66: plan() itself carries the cap warning ...
  const many = Array.from({ length: 200 }, (_, i) => `f${i}.js`);
  const big = plan({ policy: basePolicy, author: "claude", dimensions: ["security", "correctness", "tests"], paths: many, usage: null });
  assert.match(big.warnings.join(), /antigravity: about \d+ turns .* exceeds max_total_sec 3600/);
  assert.match(big.hosts.antigravity.budget.warning, /exceeds max_total_sec/);
  // ... A65: but not when antigravity is the author.
  const own = plan({ policy: basePolicy, author: "antigravity", dimensions: ["security", "correctness", "tests"], paths: many, usage: null });
  assert.equal(own.hosts.antigravity.decision, "excluded");
  assert.equal(own.hosts.antigravity.budget, undefined);
  assert.ok(!own.warnings.some((w) => /^antigravity:/.test(w)), own.warnings.join());
});

test("re-review speed knob: a small re-review runs one group per file chunk; large diffs and the knob off keep the groups", () => {
  const dims = ["security", "correctness", "tests", "contract_docs", "portability"];
  const hp = basePolicy.hosts.antigravity;
  const files = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}`, bytes: 1000, kind: "scope" }));
  assert.equal(hp.rereview_single_group, true);
  const small = runTurns(hp, dims, files, { rereview: true, diffBytes: 50_000 });
  assert.deepEqual(small.groups, [dims]);
  assert.equal(small.turns.length, 2); // 10 files / 8 per turn
  assert.equal(runTurns(hp, dims, files, { rereview: false, diffBytes: 50_000 }).turns.length, 8);
  assert.equal(runTurns(hp, dims, files, { rereview: true, diffBytes: 500_000 }).turns.length, 8);
  assert.equal(runTurns({ ...hp, rereview_single_group: false }, dims, files, { rereview: true, diffBytes: 1 }).turns.length, 8);
  const p = plan({ policy: basePolicy, author: "claude", dimensions: dims, paths: files.map((f) => f.path), usage: null, files, rereview: true, diffBytes: 50_000 });
  assert.equal(p.hosts.antigravity.budget.estimatedTurns, 2);
  assert.match(p.hosts.antigravity.budget.singleGroup, /re-review/);
  // singleGroup is shown only when the collapse applied (A68): not for a large diff, the knob off, or one natural group.
  const big = plan({ policy: basePolicy, author: "claude", dimensions: dims, paths: files.map((f) => f.path), usage: null, files, rereview: true, diffBytes: 500_000 });
  assert.equal(big.hosts.antigravity.budget.singleGroup, undefined);
  const off = { ...basePolicy, hosts: { ...basePolicy.hosts, antigravity: { ...hp, rereview_single_group: false } } };
  assert.equal(plan({ policy: off, author: "claude", dimensions: dims, paths: files.map((f) => f.path), usage: null, files, rereview: true, diffBytes: 1 }).hosts.antigravity.budget.singleGroup, undefined);
  const oneGroup = hp.groups.find((g) => g.length > 1);
  assert.equal(plan({ policy: basePolicy, author: "claude", dimensions: oneGroup, paths: files.map((f) => f.path), usage: null, files, rereview: true, diffBytes: 1 }).hosts.antigravity.budget.singleGroup, undefined);
});

test("a non-zero server exit after the last prompt invalidates the review (X12)", async () => {
  withheld(await go({ exitCode: 17 }), /agent_exit_nonzero:17/);
});

test("ACP runtime isolation paths: permission requests rejected, unexpected client RPCs, .meta cwd guard (A46)", async () => {
  const perm = await go({ permission: [0] });
  assert.equal(perm.status, "complete", perm.incompleteReasons.join());
  assert.match(perm.warnings.join(), /permission requests rejected \(reject_once\): 1/);
  withheld(await go({ clientRpc: { 0: "fs/read_text_file" } }), /unexpected_client_requests:1/);
  const meta = await go({ metaCwd: "/somewhere/else" });
  assert.equal(meta.extra.sessionCleanup.skipped, ".meta cwd differs from runner cwd");
  assert.deepEqual(meta.extra.sessionCleanup.removed, []);
});

test("stderr redaction and auth detection work across chunk boundaries (A9)", async () => {
  const ev = await go({ splitStderr: ["token ya29.AAAAAAAA", "BBBBBBBBBB done\n"] });
  assert.equal(ev.status, "complete", ev.incompleteReasons.join());
  const log = fs.readFileSync(path.join(tmp, `out-${n - 1}`, "raw", "antigravity-stderr.log"), "utf8");
  assert.ok(!log.includes("BBBBBBBBBB"), "second half of a split token leaked");
  withheld(await go({ splitStderr: ["Open the following link to auth", "enticate the ACP server: https://x\n"] }), /auth_required/);
});

test("planTurns and findRuntime", () => {
  const files = [{ path: "a", bytes: 10 }, { path: "b", bytes: 10 }, { path: "c", bytes: 500 }];
  assert.deepEqual(planTurns([["x"]], files, {}).map((t) => t.files), [null]);
  assert.deepEqual(planTurns([["x"]], files, { maxBytes: 100 }).map((t) => t.files), [["a", "b"], ["c"]]);
  assert.deepEqual(planTurns([["x"], ["y"]], files, { maxFiles: 2 }).map((t) => t.label), ["group:x:files1/2", "group:x:files2/2", "group:y:files1/2", "group:y:files2/2"]);
  assert.equal(findRuntime(runtimeRoot).version, "1.10.0");
  assert.match(findRuntime("/nowhere/{platform}-{arch}/v").root, new RegExp(`${process.platform}-${process.arch}`));
});

// ---------------------------------------------------------------- 1.5 "cli" runtime layout
// The 1.5 adapter reads the session database with node:sqlite (Node 22.13+ without flags).
const noSqlite = await import("node:sqlite").then(() => false, () => "node:sqlite unavailable (Node < 22.13)");
const ctest = (name, fn) => test(name, { skip: noSqlite }, fn);
const goCli = (fake = {}, over = {}) => go(fake, { runtime: { ...policy().hosts.antigravity.runtime, runtime_root: cliRoot }, ...over });

ctest("cli layout: findRuntime reads .install-complete.json, picks the highest valid version, skips bad records", () => {
  const r = findRuntime(cliRoot);
  assert.equal(r.version, "1.5.18");
  assert.equal(r.layout, "cli");
  assert.equal(r.executable, path.join(cliRoot, "aaa-new", "antigravity"));
  // size mismatch, a path in the name, a non-numeric version and a symlinked executable are never candidates
  assert.deepEqual(r.candidates.sort(), ["1.4.9 (par)", "1.5.18 (cli)", "1.5.2 (cli)"]);
  assert.equal(findRuntime(runtimeRoot).layout, "par");
  assert.deepEqual(launchArgs("par", { geminiHome: "/h", logFile: "/l" }), []);
  assert.deepEqual(launchArgs("cli", { geminiHome: "/h", logFile: "/l" }), ["acp", "--gemini-dir", "/h", "--app-data-dir", "antigravity-acp", "--log-file", "/l", "--disable-telemetry"]);
});

ctest("cli layout: env drops inherited Antigravity variables, adds the update/browser guards, no harness path", () => {
  const env = buildEnv({ PATH: "/usr/bin", GEMINI_HOME: "/x", AGY_CLI_DISABLE_AUTO_UPDATE: "0", CHROME_CRASHPAD_PIPE_NAME: "p", GOOGLE_API_KEY: "k" }, { geminiHome: "/h", tmpDir: "/t", harness: "/hx", layout: "cli", shimDir: "/s" });
  assert.equal(env.GEMINI_HOME, "/h");
  assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, "1");
  assert.equal(env.PATH, `/s${path.delimiter}/usr/bin`);
  assert.equal(env.ANTIGRAVITY_HARNESS_PATH, undefined);
  assert.equal(env.CHROME_CRASHPAD_PIPE_NAME, undefined);
  assert.equal(env.GOOGLE_API_KEY, undefined);
  assert.equal(buildEnv({ PATH: "/usr/bin" }, { geminiHome: "/h", tmpDir: "/t", harness: "/hx" }).ANTIGRAVITY_HARNESS_PATH, "/hx");
});

test("isAgy matches the 1.4 server, the 1.5 `antigravity acp` process and this run's executable", () => {
  assert.ok(isAgy("/r/versions/1.4.5/agy_acp_server.par"));
  assert.ok(isAgy("/Users/u/.t3/tools/antigravity-acp/darwin-arm64/versions/d10e/antigravity acp --gemini-dir /h"));
  assert.ok(isAgy("/opt/x/runtime-bin --worker", "/opt/x/runtime-bin"));
  assert.ok(!isAgy("/Applications/Antigravity.app/Contents/MacOS/Antigravity"));
  assert.ok(!isAgy("vim antigravity.md"));
});

ctest("session database decoding: generation model and display name, normalisation", () => {
  const v = (x) => { const o = []; while (x > 127) { o.push((x & 127) | 128); x = Math.floor(x / 128); } o.push(x); return Buffer.from(o); };
  const enc = (fs_) => Buffer.concat(fs_.map(([n, s]) => { const b = Buffer.isBuffer(s) ? s : Buffer.from(s); return Buffer.concat([v(n * 8 + 2), v(b.length), b]); }));
  const g = decodeGeneration(enc([[1, enc([[19, "gemini-4-neon"], [21, "Gemini 4 Neon (High)"]])]]));
  assert.deepEqual(g, { model: "gemini-4-neon", display: "Gemini 4 Neon (High)", normalized: "gemini-4-neon-high" });
  assert.equal(normalizeModelName("Gemini 4 Neon (XHigh)"), "gemini-4-neon-xhigh");
  assert.throws(() => decodeGeneration(enc([[2, "x"]])), /missing/);
  assert.throws(() => protoFields(Buffer.from([0x0a, 0x05, 0x61])), /truncated/);
});

test("cli layout happy path: argv, per-turn generation model, read_file audit, session files removed by workspace", async () => {
  const ev = await goCli({ steps: true });
  assert.equal(ev.status, "complete", ev.incompleteReasons.join());
  assert.equal(ev.extra.runtime.layout, "cli");
  assert.equal(ev.isolation.runtime, "1.5.18");
  assert.deepEqual(ev.argv.slice(1, 6), ["acp", "--gemini-dir", ev.isolation.geminiHome, "--app-data-dir", "antigravity-acp"]);
  assert.deepEqual(ev.attempts.map((a) => a.generationModels), [["gemini-4-neon/gemini-4-neon-high"], ["gemini-4-neon/gemini-4-neon-high"]]);
  assert.equal(ev.reported.model, "gemini-4-neon");
  assert.deepEqual(ev.toolAudit.nonViewFileCalls, []);
  assert.deepEqual(ev.toolAudit.callsWithoutAuditablePath, []);
  assert.equal(ev.extra.sessionCleanup.ownedBy, "session database workspace");
  assert.deepEqual(ev.extra.sessionCleanup.removed.sort(), ["11111111-1111-4111-8111-111111111111.db", "annotations/11111111-1111-4111-8111-111111111111.pbtxt"]);
  assert.equal(ev.extra.sessionMode, "default");
  assert.equal(fs.existsSync(ev.isolation.geminiHome), false);
});

ctest("cli layout: a turn without a generation record, a different model or level, or no database -> incomplete", async () => {
  withheld(await goCli({ noGen: [1] }), /model_unconfirmed:group:tests/);
  withheld(await goCli({ genDisplay: "Gemini 4 Neon (Low)" }), /generation_model_mismatch:gemini-4-neon\/gemini-4-neon-low/);
  withheld(await goCli({ genModel: "gemini-3.8-flash" }), /generation_model_mismatch:gemini-3\.8-flash/);
  withheld(await goCli({ noGen: [0, 1] }), /model_unconfirmed:group:correctness/);
  const nodb = await goCli({ noDb: true });
  withheld(nodb, /model_unconfirmed:session database unreadable/);
  assert.equal(nodb.extra.sessionCleanup.skipped, ".meta and session database missing");
});

ctest("cli layout: a late generation of one turn never confirms a later turn without its own (X27/A76)", async () => {
  const ev = await goCli({ lateGen: true, noGen: [1] });
  withheld(ev, /model_unconfirmed:group:tests/);
  assert.equal(ev.attempts[0].generationModels.length, 2);
  assert.equal((await goCli({ lateGen: true })).status, "complete");
});

ctest("cli layout: tool audit keeps a call's name across title-only updates, and refuses idless or nameless-then-renamed calls (X29/A78)", async () => {
  const ok = await goCli({ updateTitle: { 0: "File a.ts" } });
  assert.equal(ok.status, "complete", ok.incompleteReasons.join());
  withheld(await goCli({ idless: { 0: true } }), /tool_calls_without_id:1/);
  withheld(await goCli({ namelessSteps: { 0: true } }), /unauditable_tool_calls:1/);
});

ctest("cli layout: session files are kept when the database has no session id (X26/A77)", async () => {
  const ev = await goCli({ noTrajSid: true });
  assert.equal(ev.status, "complete", ev.incompleteReasons.join());
  assert.equal(ev.extra.sessionCleanup.skipped, "session database has no session id");
  assert.deepEqual(ev.extra.sessionCleanup.removed, []);
  fs.rmSync(path.join(profileAcp, "conversations", "11111111-1111-4111-8111-111111111111.db"));
});

ctest("cli layout: non-read tools, reads outside the snapshot, log-file errors, auth and session mode are fatal", async () => {
  withheld(await goCli({ toolName: { 0: "run_command" } }), /non_view_file_tool_calls:1/);
  withheld(await goCli({ readPath: { 0: "/etc/hosts" } }), /tool_read_outside_snapshot/);
  withheld(await goCli({ stderrLine: { 0: "E1126 agent.go:1] RESOURCE_EXHAUSTED quota" } }), /agent_error:group:correctness/);
  withheld(await goCli({ mode: "auto" }), /session_mode_not_default:auto/);
  const b = await goCli({ browser: true });
  withheld(b, /auth_required/);
  assert.equal(b.extra.authRequired, true);
});

ctest("cli layout: session files are kept when the database workspace is not this run's snapshot", async () => {
  const ev = await goCli({ workspace: "/somewhere/else" });
  assert.equal(ev.status, "complete", ev.incompleteReasons.join());
  assert.equal(ev.extra.sessionCleanup.skipped, "session database workspace differs from runner cwd");
  assert.deepEqual(ev.extra.sessionCleanup.removed, []);
  assert.ok(fs.existsSync(path.join(profileAcp, "conversations", "11111111-1111-4111-8111-111111111111.db")));
  fs.rmSync(path.join(profileAcp, "conversations", "11111111-1111-4111-8111-111111111111.db"));
});
