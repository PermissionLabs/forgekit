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
import { findRuntime, planTurns, stopGroup } from "../adapters/antigravity.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { policy: basePolicy } = loadPolicy(defaultPolicyPath());
let tmp, repo, rev, policyPath, diffPath, briefPath, profileAcp, runtimeRoot;
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
  fs.writeFileSync(path.join(bad, "agy_acp_server.par"), "not executable");
  const t0 = Date.now();
  const ev = await go({}, { runtime: { ...policy().hosts.antigravity.runtime, runtime_root: path.dirname(bad) } });
  withheld(ev, /spawn_error/);
  assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms`);
  const t1 = Date.now();
  withheld(await go({ exitAfter: "initialize" }), /fatal:agent exited|authenticate_failed:agent exited/);
  assert.ok(Date.now() - t1 < 15_000, `took ${Date.now() - t1} ms`);
});

test("stopGroup never signals an exited child's group unless ps shows a live member (A6/X3)", async () => {
  const kills = [];
  const base = { pid: 4242, exited: () => true, waitExit: async () => {}, kill: (p, s) => kills.push([p, s]), sleep: async () => {} };
  const log = await stopGroup({ ...base, members: () => [] });
  assert.deepEqual(kills, []);
  assert.equal(log[0].skipped, "no live group member after exit");
  await stopGroup({ ...base, members: () => [99] });
  assert.deepEqual(kills, [[-4242, "SIGTERM"], [-4242, "SIGKILL"]]);
  // While the child is not reaped it holds the group: signalling is safe without ps.
  const k2 = [];
  let alive = true;
  await stopGroup({ ...base, exited: () => !alive, waitExit: async () => {}, kill: (p, s) => { k2.push(s); if (s === "SIGTERM") alive = false; }, members: () => [] });
  assert.deepEqual(k2, ["SIGTERM"]);
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
