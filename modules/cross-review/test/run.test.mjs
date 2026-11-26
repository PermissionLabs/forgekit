// End-to-end `run` against fake host binaries (no model calls): snapshot, validation, retry, evidence, summary.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy, defaultPolicyPath } from "../lib/policy.mjs";
import { buildInput, removeSnapshot } from "../lib/inputs.mjs";
import { runReview, summarize } from "../lib/run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { policy: basePolicy } = loadPolicy(defaultPolicyPath());
let tmp, repo, rev, policyPath, diffPath, briefPath;
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
const DIMS = ["correctness", "tests"];
const review = (over = {}) => JSON.stringify({ verdict: "fix", coverage: { correctness: "checked", tests: "n/a:no tests in scope" }, findings: [{ id: "C1", sev: "med", loc: "src/a.ts:2", claim: "c", evidence: "e", check: "k" }], limits: [], ...over });
const FAKE_KEYS = ["FAKE_REVIEW", "FAKE_OUTPUTS", "FAKE_READ", "FAKE_WRITE", "FAKE_INIT_MODEL", "FAKE_USAGE_MODEL", "FAKE_TOOLS", "FAKE_REPORTED_MODEL", "FAKE_SANDBOX", "FAKE_COMMAND", "FAKE_ARGV_OUT"];
const setFake = (env) => { for (const k of FAKE_KEYS) delete process.env[k]; Object.assign(process.env, env); };

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-test-")));
  repo = path.join(tmp, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "src/a.ts"), "export const a = 1;\nexport const b = a + 1;\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# r\n");
  fs.symlinkSync("../README.md", path.join(repo, "src/link.md"));
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  rev = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "src/a.ts"), "WORKING TREE CHANGE NOT COMMITTED\n");
  const p = JSON.parse(JSON.stringify(basePolicy));
  p.hosts.claude.bin = path.join(HERE, "fixtures", "fake-claude.mjs");
  p.hosts.codex.bin = path.join(HERE, "fixtures", "fake-codex.mjs");
  p.hosts.claude.timeout_sec = 60;
  p.hosts.codex.timeout_sec = 60;
  policyPath = path.join(tmp, "policy.json");
  fs.writeFileSync(policyPath, JSON.stringify(p));
  diffPath = path.join(tmp, "pr.patch");
  fs.writeFileSync(diffPath, "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n export const a = 1;\n+export const b = a + 1;\n");
  briefPath = path.join(tmp, "brief.md");
  fs.writeFileSync(briefPath, "Review the change.\n");
});
after(() => { setFake({}); fs.rmSync(tmp, { recursive: true, force: true }); });

const opts = (host, out, extra = {}) => ({ host, repo, rev, diff: diffPath, scope: ["src/a.ts"], context: [], checklist: [], brief: briefPath, out: path.join(tmp, out), dimensions: DIMS, ...extra });
const policy = () => JSON.parse(fs.readFileSync(policyPath, "utf8"));

test("snapshot comes from git objects at --rev, is read-only, and refuses symlinks", () => {
  const input = buildInput({ repo, rev, diffPath, scope: ["src/a.ts"], contextRefs: ["README.md"], checklist: [], briefPath, dimensions: DIMS });
  try {
    assert.equal(fs.readFileSync(path.join(input.snapshot, "src/a.ts"), "utf8"), "export const a = 1;\nexport const b = a + 1;\n");
    assert.equal(fs.statSync(path.join(input.snapshot, "src/a.ts")).mode & 0o222, 0);
    assert.equal(fs.statSync(input.snapshot).mode & 0o222, 0);
    assert.ok(!input.snapshot.startsWith(repo));
    assert.equal(input.scopeLines.get("src/a.ts"), 2);
    assert.deepEqual(input.files.map((f) => f.kind), ["scope", "context"]);
  } finally { removeSnapshot(input.snapshot); }
  assert.throws(() => buildInput({ repo, rev, diffPath, scope: ["src/link.md"], briefPath, dimensions: DIMS }), /not a regular file/);
  assert.throws(() => buildInput({ repo, rev, diffPath, scope: ["../x"], briefPath, dimensions: DIMS }), /unsafe path/);
});

test("claude run: complete review, evidence fields, summary", async () => {
  const argvOut = path.join(tmp, "claude-argv.json");
  setFake({ FAKE_REVIEW: review(), FAKE_ARGV_OUT: argvOut });
  const ev = await runReview(opts("claude", "out-claude"), policy(), policyPath);
  assert.equal(ev.status, "complete", ev.incompleteReasons.join());
  assert.equal(ev.reviewer.host, "claude");
  assert.equal(ev.pinned.model, basePolicy.hosts.claude.model);
  assert.equal(ev.reported.model, basePolicy.hosts.claude.model);
  assert.equal(ev.matchesPinned, true);
  assert.match(ev.prompt.sha256, /^[0-9a-f]{64}$/);
  assert.equal(ev.timeoutMs, 60_000);
  assert.ok(ev.usage);
  assert.ok(ev.toolAudit[0].paths.every((p) => p.inside));
  assert.equal(ev.isolation.snapshotUnchanged, true);
  assert.equal(ev.isolation.snapshotRemoved, true);
  const evFile = path.join(tmp, "out-claude", "evidence.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(evFile, "utf8")).review, JSON.parse(review()));
  const s = summarize(ev, evFile);
  assert.match(s, /status=complete verdict=fix/);
  assert.match(s, /model=claude-opus-5-5 effort=high reported=claude-opus-5-5/);
  assert.match(s, /findings: critical=0 high=0 med=1 low=0/);
  assert.match(s, new RegExp(`evidence: ${evFile}`));
  const argv = JSON.parse(fs.readFileSync(argvOut, "utf8"));
  assert.ok(argv.includes("--restricted") && argv.includes("--no-session-persistence"));
});

test("summary prints high/critical findings in full", async () => {
  const long = "evidence ".repeat(500);
  setFake({ FAKE_REVIEW: review({ verdict: "block", findings: [{ id: "C1", sev: "high", loc: "src/a.ts:1", claim: "the claim", evidence: long, check: "the check" }] }) });
  const ev = await runReview(opts("claude", "out-high"), policy(), policyPath);
  const s = summarize(ev, "e.json");
  assert.match(s, /\[high\] C1 src\/a.ts:1/);
  assert.ok(s.includes(long.trim()));
  assert.match(s, /check: the check/);
});

test("pinned != reported model -> incomplete, review withheld", async () => {
  setFake({ FAKE_REVIEW: review(), FAKE_INIT_MODEL: "claude-sonnet-5-5", FAKE_USAGE_MODEL: "claude-sonnet-5-5" });
  const ev = await runReview(opts("claude", "out-mismatch"), policy(), policyPath);
  assert.equal(ev.status, "incomplete");
  assert.match(ev.incompleteReasons.join(), /reported_model_mismatch:claude-sonnet-5-5/);
  assert.equal(ev.review, null);
  assert.match(summarize(ev, "e"), /verdict=none \(incomplete/);
});

test("outside-snapshot read, extra tool, or snapshot write -> incomplete", async () => {
  setFake({ FAKE_REVIEW: review(), FAKE_READ: "/etc/hosts" });
  assert.match((await runReview(opts("claude", "out-o1"), policy(), policyPath)).incompleteReasons.join(), /tool_read_outside_snapshot/);
  setFake({ FAKE_REVIEW: review(), FAKE_TOOLS: "Read,Bash" });
  assert.match((await runReview(opts("claude", "out-o2"), policy(), policyPath)).incompleteReasons.join(), /tools_not_read_only:Bash/);
  setFake({ FAKE_REVIEW: review(), FAKE_WRITE: "1" });
  assert.match((await runReview(opts("claude", "out-o3"), policy(), policyPath)).incompleteReasons.join(), /snapshot_modified/);
});

test("codex run: schema retry once, then complete; second failure -> incomplete", async () => {
  const good = review({ findings: [{ id: "X1", sev: "low", loc: "src/a.ts:1", claim: "c", evidence: "e", check: "k" }] });
  setFake({ FAKE_OUTPUTS: `not json\n---\n${good}` });
  const ev = await runReview(opts("codex", "out-codex"), policy(), policyPath);
  assert.equal(ev.status, "complete", ev.incompleteReasons.join());
  assert.equal(ev.attempts.length, 2);
  assert.equal(ev.reported.model, "gpt-6.1-sol");
  assert.equal(ev.reported.sandbox, "read-only");
  assert.equal(ev.usage.total_tokens, 2468);
  setFake({ FAKE_OUTPUTS: "not json\n---\nstill not json" });
  const bad = await runReview(opts("codex", "out-codex2"), policy(), policyPath);
  assert.equal(bad.status, "incomplete");
  assert.match(bad.incompleteReasons.join(), /schema_invalid_after_retry/);
  setFake({ FAKE_REVIEW: good, FAKE_REPORTED_MODEL: "gpt-6.1-mini" });
  assert.match((await runReview(opts("codex", "out-codex3"), policy(), policyPath)).incompleteReasons.join(), /reported_model_mismatch:gpt-6.1-mini/);
  setFake({ FAKE_REVIEW: good, FAKE_COMMAND: "cat ~/.codex/auth.json" });
  assert.match((await runReview(opts("codex", "out-codex4"), policy(), policyPath)).incompleteReasons.join(), /tool_read_outside_snapshot/);
});

test("re-review: prior findings + dispositions in, per-prior-id verification out, ids continue", async () => {
  const prior = path.join(tmp, "prior.json");
  const disp = path.join(tmp, "disp.json");
  fs.writeFileSync(prior, JSON.stringify({ findings: [{ id: "C4", sev: "med", loc: "src/a.ts:1", claim: "c", evidence: "e", check: "k" }, { id: "X2", sev: "low", loc: "src/a.ts:2", claim: "c", evidence: "e", check: "k" }] }));
  fs.writeFileSync(disp, JSON.stringify([{ id: "C4", disposition: "fixed", ref: "abc123" }, { id: "X2", disposition: "accepted", ref: "out of scope" }]));
  const ok = JSON.stringify({ verdict: "pass", coverage: { correctness: "checked", tests: "checked" }, findings: [], limits: [], prior_verification: [{ id: "C4", verified: true, note: "src/a.ts:1" }, { id: "X2", verified: true, note: "src/a.ts:2" }] });
  setFake({ FAKE_REVIEW: ok });
  const ev = await runReview(opts("claude", "out-rr", { prior, dispositions: disp }), policy(), policyPath);
  assert.equal(ev.status, "complete", ev.incompleteReasons.join());
  assert.equal(ev.inputs.reReview.idStart, 5);
  assert.match(fs.readFileSync(path.join(tmp, "out-rr", "prompt.txt"), "utf8"), /RE-REVIEW: earlier findings C4, X2/);
  assert.match(summarize(ev, "e"), /prior C4: verified/);
  // Missing a prior id -> schema invalid (after one retry) -> incomplete.
  setFake({ FAKE_REVIEW: JSON.stringify({ ...JSON.parse(ok), prior_verification: [{ id: "C4", verified: true, note: "n" }] }) });
  const miss = await runReview(opts("claude", "out-rr2", { prior, dispositions: disp }), policy(), policyPath);
  assert.equal(miss.status, "incomplete");
  // Bad dispositions are refused before anything runs.
  fs.writeFileSync(disp, JSON.stringify([{ id: "C4", disposition: "fixed", ref: "abc" }]));
  await assert.rejects(runReview(opts("claude", "out-rr3", { prior, dispositions: disp }), policy(), policyPath), /dispositions missing for: X2/);
});

test("missing host binary -> incomplete, never another reviewer", async () => {
  const p = policy();
  p.hosts.codex.bin = path.join(tmp, "no-such-codex");
  setFake({ FAKE_REVIEW: review() });
  const ev = await runReview(opts("codex", "out-nobin"), p, policyPath);
  assert.equal(ev.status, "incomplete");
  assert.equal(ev.reviewer.host, "codex");
  assert.match(ev.incompleteReasons.join(), /spawn_error/);
});
