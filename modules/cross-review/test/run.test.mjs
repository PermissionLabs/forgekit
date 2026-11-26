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
// Fixture repo only: signing and hooks are disabled for its commits so a global commit.gpgsign setting cannot break the suite.
const git = (...a) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-C", repo, ...a], { encoding: "utf8" }).trim();
const DIMS = ["correctness", "tests"];
const review = (over = {}) => JSON.stringify({ verdict: "fix", coverage: { correctness: "checked", tests: "n/a:no tests in scope" }, findings: [{ id: "C1", sev: "med", loc: "src/a.ts:2", claim: "c", evidence: "e", check: "k" }], limits: [], ...over });
const FAKE_KEYS = ["FAKE_REVIEW", "FAKE_OUTPUTS", "FAKE_READ", "FAKE_WRITE", "FAKE_INIT_MODEL", "FAKE_USAGE_MODEL", "FAKE_TOOLS", "FAKE_REPORTED_MODEL", "FAKE_SANDBOX", "FAKE_COMMAND", "FAKE_ARGV_OUT", "FAKE_ENV_OUT", "FAKE_ESCAPE", "FAKE_NO_O", "FAKE_EMPTY_O", "FAKE_STDOUT", "FAKE_NO_EFFORT", "FAKE_PROMPT_ECHO", "FAKE_COMMAND_OUTPUT", "FAKE_APPROVAL"];
const setFake = (env) => { for (const k of FAKE_KEYS) delete process.env[k]; Object.assign(process.env, env); };

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-test-")));
  repo = path.join(tmp, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs/check.md"), "CHECKLIST AT REV\n");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "src/a.ts"), "export const a = 1;\nexport const b = a + 1;\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# r\n");
  fs.symlinkSync("../README.md", path.join(repo, "src/link.md"));
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  rev = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "src/a.ts"), "WORKING TREE CHANGE NOT COMMITTED\n");
  fs.writeFileSync(path.join(repo, "docs/check.md"), "WORKING TREE CHECKLIST\n");
  const p = JSON.parse(JSON.stringify(basePolicy));
  p.hosts.claude.bin = path.join(HERE, "fixtures", "fake-claude.mjs");
  p.hosts.codex.bin = path.join(HERE, "fixtures", "fake-codex.mjs");
  p.hosts.claude.timeout_sec = 60;
  p.hosts.codex.timeout_sec = 60;
  p.hosts.claude.env_passthrough = FAKE_KEYS; // the child env is an allowlist; the fakes need their knobs
  p.hosts.codex.env_passthrough = FAKE_KEYS;
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
    // Private to the owner (A8): no group/other bits on the snapshot or its files.
    assert.equal(fs.statSync(input.snapshot).mode & 0o077, 0);
    assert.equal(fs.statSync(path.join(input.snapshot, "src/a.ts")).mode & 0o077, 0);
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

test("checklist comes from the --rev git object or an explicit outside file, hashed (operator 2)", async () => {
  const outside = path.join(tmp, "outside-check.md");
  fs.writeFileSync(outside, "OUTSIDE CHECKLIST\n");
  setFake({ FAKE_REVIEW: review() });
  const ev = await runReview(opts("claude", "out-check", { checklist: ["docs/check.md", path.join(repo, "docs/check.md"), outside] }), policy(), policyPath);
  assert.equal(ev.status, "complete", ev.incompleteReasons.join());
  assert.deepEqual(ev.inputs.checklist.map((c) => c.source), [`git:${rev}`, `git:${rev}`, "file"]);
  const prompt = fs.readFileSync(path.join(tmp, "out-check", "prompt.txt"), "utf8");
  assert.match(prompt, /CHECKLIST AT REV/);
  assert.doesNotMatch(prompt, /WORKING TREE CHECKLIST/);
  assert.match(prompt, /OUTSIDE CHECKLIST/);
  assert.ok(ev.inputs.checklist.every((c) => /^[0-9a-f]{64}$/.test(c.sha256)));
  // summary.txt sits next to the evidence (operator 3).
  assert.match(fs.readFileSync(path.join(tmp, "out-check", "summary.txt"), "utf8"), /status=complete/);
});

test("claude child sees only the allowlisted environment (A2)", async () => {
  const envOut = path.join(tmp, "claude-env.json");
  setFake({ FAKE_REVIEW: review(), FAKE_ENV_OUT: envOut });
  process.env.GITHUB_TOKEN_CR_TEST = "secret";
  try {
    const ev = await runReview(opts("claude", "out-env"), policy(), policyPath);
    assert.equal(ev.status, "complete", ev.incompleteReasons.join());
  } finally { delete process.env.GITHUB_TOKEN_CR_TEST; }
  const keys = JSON.parse(fs.readFileSync(envOut, "utf8"));
  assert.ok(!keys.includes("GITHUB_TOKEN_CR_TEST"));
  assert.ok(keys.includes("PATH"));
});

test("claude effort is recorded as unreported, never as verified (A16)", async () => {
  setFake({ FAKE_REVIEW: review() });
  const ev = await runReview(opts("claude", "out-effort"), policy(), policyPath);
  assert.match(ev.effortCheck, /^unreported/);
});

test("claude retry keeps first-attempt usage; a model mismatch is never retried (A18)", async () => {
  setFake({ FAKE_OUTPUTS: `not json\n---\n${review()}` });
  const ev = await runReview(opts("claude", "out-cretry"), policy(), policyPath);
  assert.equal(ev.status, "complete", ev.incompleteReasons.join());
  assert.equal(ev.attempts.length, 2);
  assert.equal(ev.usage.input_tokens, 20);
  assert.equal(ev.usage.total_cost_usd, 0.02);
  setFake({ FAKE_OUTPUTS: `not json\n---\n${review()}`, FAKE_INIT_MODEL: "claude-sonnet-5-5" });
  const mm = await runReview(opts("claude", "out-cmm"), policy(), policyPath);
  assert.equal(mm.status, "incomplete");
  assert.equal(mm.attempts.length, 1);
  assert.equal(mm.reported.model, "claude-sonnet-5-5");
  // A short total timeout still runs the first attempt (the 30 s floor applies to the retry only).
  const p = policy();
  p.hosts.claude.timeout_sec = 15;
  setFake({ FAKE_REVIEW: review() });
  const short = await runReview(opts("claude", "out-cshort"), p, policyPath);
  assert.equal(short.status, "complete", short.incompleteReasons.join());
});

test("a descendant holding the host's pipes forces incomplete even with exit 0 and valid output (X5)", async () => {
  setFake({ FAKE_REVIEW: review(), FAKE_ESCAPE: "1" });
  const ev = await runReview(opts("claude", "out-escape"), policy(), policyPath);
  assert.equal(ev.status, "incomplete");
  assert.match(ev.incompleteReasons.join(), /pipes_abandoned/);
  assert.equal(ev.review, null);
});

test("pinned != reported model -> incomplete, review withheld", async () => {
  setFake({ FAKE_REVIEW: review(), FAKE_INIT_MODEL: "claude-sonnet-5-5", FAKE_USAGE_MODEL: "claude-sonnet-5-5" });
  const ev = await runReview(opts("claude", "out-mismatch"), policy(), policyPath);
  assert.equal(ev.status, "incomplete");
  assert.match(ev.incompleteReasons.join(), /reported_model_mismatch:claude-sonnet-5-5/);
  assert.equal(ev.review, null);
  assert.match(summarize(ev, "e"), /verdict=none \(incomplete/);
});

const assertWithheld = (ev, re) => {
  assert.equal(ev.status, "incomplete");
  assert.equal(ev.review, null);
  assert.match(ev.incompleteReasons.join(), re);
};

test("outside-snapshot read, extra tool, or snapshot write -> incomplete", async () => {
  setFake({ FAKE_REVIEW: review(), FAKE_READ: "/etc/hosts" });
  assertWithheld(await runReview(opts("claude", "out-o1"), policy(), policyPath), /tool_read_outside_snapshot/);
  setFake({ FAKE_REVIEW: review(), FAKE_TOOLS: "Read,Bash" });
  assertWithheld(await runReview(opts("claude", "out-o2"), policy(), policyPath), /tools_not_read_only:Bash/);
  setFake({ FAKE_REVIEW: review(), FAKE_WRITE: "1" });
  assertWithheld(await runReview(opts("claude", "out-o3"), policy(), policyPath), /snapshot_modified/);
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
  assert.equal(bad.review, null);
  assert.equal(bad.attempts.length, 2);
  setFake({ FAKE_REVIEW: good, FAKE_REPORTED_MODEL: "gpt-6.1-mini" });
  assertWithheld(await runReview(opts("codex", "out-codex3"), policy(), policyPath), /reported_model_mismatch:gpt-6.1-mini/);
  setFake({ FAKE_REVIEW: good, FAKE_COMMAND: "cat ~/.codex/auth.json" });
  assertWithheld(await runReview(opts("codex", "out-codex4"), policy(), policyPath), /tool_read_outside_snapshot/);
  setFake({ FAKE_REVIEW: good, FAKE_NO_EFFORT: "1" });
  assertWithheld(await runReview(opts("codex", "out-codex5"), policy(), policyPath), /reported_effort_unavailable/);
});

test("codex: a stale -o file is never read; an empty -o falls back to stdout (A17)", async () => {
  const good = review({ findings: [{ id: "X1", sev: "low", loc: "src/a.ts:1", claim: "c", evidence: "e", check: "k" }] });
  const raw = path.join(tmp, "out-stale", "raw");
  fs.mkdirSync(raw, { recursive: true });
  fs.writeFileSync(path.join(raw, "codex-first-last.txt"), good);
  fs.writeFileSync(path.join(raw, "codex-retry-last.txt"), good);
  setFake({ FAKE_REVIEW: "not json", FAKE_NO_O: "1" });
  assertWithheld(await runReview(opts("codex", "out-stale"), policy(), policyPath), /schema_invalid_after_retry/);
  setFake({ FAKE_REVIEW: good, FAKE_EMPTY_O: "1" });
  const ev = await runReview(opts("codex", "out-empty-o"), policy(), policyPath);
  assert.equal(ev.status, "complete", ev.incompleteReasons.join());
});

test("codex: the child env is an allowlist and the prompt echo is not audited as tool calls (A2/X6)", async () => {
  const good = review({ findings: [] , verdict: "pass" });
  const envOut = path.join(tmp, "codex-env.json");
  const brief = path.join(tmp, "brief-mcp.md");
  fs.writeFileSync(brief, "Review the change.\n\nmcp is disabled for this review\ntool calls are read-only\n");
  process.env.GITHUB_TOKEN_CR_TEST = "secret";
  try {
    setFake({ FAKE_REVIEW: good, FAKE_ENV_OUT: envOut, FAKE_COMMAND_OUTPUT: "line\n\nmcp is mentioned here\nexec" });
    const ev = await runReview(opts("codex", "out-codex-env", { brief }), policy(), policyPath);
    assert.ok(!JSON.parse(fs.readFileSync(envOut, "utf8")).includes("GITHUB_TOKEN_CR_TEST"));
    // The tool-like line after a blank line inside command output is still conservatively flagged.
    assert.match(ev.incompleteReasons.join(), /non_read_tool_calls:1/);
    setFake({ FAKE_REVIEW: good });
    const clean = await runReview(opts("codex", "out-codex-mcp", { brief }), policy(), policyPath);
    assert.equal(clean.status, "complete", clean.incompleteReasons.join());
    assert.equal(clean.extra.hostVersion, "codex-cli 0.167.0");
  } finally { delete process.env.GITHUB_TOKEN_CR_TEST; }
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
  assertWithheld(miss, /schema_invalid_after_retry/);
  assert.equal(miss.attempts.length, 2);
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

test("empty dimensions are refused and never leak a snapshot (A21)", async () => {
  const before = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("cross-review-snap-")).length;
  await assert.rejects(runReview(opts("claude", "out-nodims", { dimensions: undefined }), policy(), policyPath), /dimensions/);
  const after = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("cross-review-snap-")).length;
  assert.ok(after <= before);
});
