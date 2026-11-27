// CLI: argument parsing, exit codes, --out protection, list arguments, merge.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { checkOut, parseArgs } from "../cross-review.mjs";
import { readList } from "../lib/inputs.mjs";
import { mergeReviews, loadReviewEntry } from "../lib/merge.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "cross-review.mjs");
let tmp, repo;
const git = (...a) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-C", repo, ...a], { encoding: "utf8" }).trim();
const cli = (args, cwd = tmp) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-cli-")));
  repo = path.join(tmp, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, ".gitignore"), "*\n!.gitignore\n!src/\n!src/**\n!README.md\n");
  fs.writeFileSync(path.join(repo, "src/a.ts"), "x\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# r\n");
  fs.mkdirSync(path.join(repo, "forced"));
  fs.writeFileSync(path.join(repo, "forced/tracked.txt"), "t\n");
  git("add", "-A");
  git("add", "-f", "forced/tracked.txt");
  git("add", "-f", "src/a.ts");
  git("commit", "-q", "-m", "init");
  fs.writeFileSync(path.join(tmp, "list.txt"), "src/a.ts\n# comment\nsrc/b.ts\n");
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("parseArgs: unknown and duplicate flags are usage errors; --checklist repeats (A21, operator 2)", () => {
  assert.throws(() => parseArgs(["plan", "--dimesions", "security"]), /unknown option --dimesions for plan/);
  assert.throws(() => parseArgs(["run", "--host", "codex", "--host", "claude"]), /given twice/);
  assert.throws(() => parseArgs(["nope"]), /unknown command/);
  const o = parseArgs(["run", "--checklist", "a.md", "--checklist", "b,c.md"]);
  assert.deepEqual(o.checklist, ["a.md", "b,c.md"]);
  assert.deepEqual(parseArgs(["merge", "--review", "x", "--review", "y"]).review, ["x", "y"]);
});

test("readList: @file reads a list; a bare existing file name is a path, not a list (A12)", () => {
  const cwd = process.cwd();
  process.chdir(tmp);
  try {
    assert.deepEqual(readList("@list.txt"), ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(readList("list.txt"), ["list.txt"]);
    assert.deepEqual(readList("a,b ,a"), ["a", "b"]);
  } finally { process.chdir(cwd); }
});

test("checkOut: tracked or .git paths refused even under an allowlist .gitignore; ignored ok; outside ok (A10)", () => {
  assert.throws(() => checkOut(repo, path.join(repo, "src")), /not git-ignored/);
  assert.throws(() => checkOut(repo, path.join(repo, ".git", "hooks")), /inside a \.git directory/);
  // A10: without --repo too (git rev-parse fails inside .git, so no work tree is found for it).
  assert.throws(() => checkOut(null, path.join(repo, ".git", "cross-review-out")), /inside a \.git directory/);
  assert.throws(() => checkOut(null, path.join(repo, ".git", "x.json"), { dir: false }), /inside a \.git directory/);
  const r = cli(["plan", "--author", "claude", "--paths-from", path.join(tmp, "list.txt"), "--out", path.join(repo, ".git", "plan.json")], os.tmpdir());
  assert.equal(r.status, 2);
  assert.equal(fs.existsSync(path.join(repo, ".git", "plan.json")), false);
  assert.throws(() => checkOut(repo, path.join(repo, "README.md"), { dir: false }), /not git-ignored/);
  assert.throws(() => checkOut(repo, repo), /not git-ignored/);
  // Matched by `*` but tracked (force-added): the index decides, so it is refused.
  assert.throws(() => checkOut(repo, path.join(repo, "forced", "tracked.txt"), { dir: false }), /not git-ignored/);
  checkOut(repo, path.join(repo, ".context", "r1"));
  checkOut(repo, path.join(tmp, "elsewhere"));
});

test("exit codes: usage 2, plan ok 0 / ask 3 / blocked 4, plan --out protected (A24)", () => {
  assert.equal(cli([]).status, 2);
  assert.equal(cli(["help"]).status, 0);
  assert.equal(cli(["plan", "--author", "claude", "--paths-from", "list.txt", "--bogus", "x"]).status, 2);
  assert.equal(cli(["plan", "--author", "claude", "--paths-from", "list.txt", "--prior", "no-such-prior.json"]).status, 2);
  fs.writeFileSync(path.join(tmp, "paths.txt"), "src/a.ts\n");
  const OBS = new Date().toISOString();
  const later = new Date(Date.now() + 84 * 3600_000).toISOString();
  const win = (id) => ({ id, kind: "weekly", remainingFraction: 0.95, resetsAt: later, windowDurationSec: 604800 });
  const usage = { providers: [
    { provider: "codex", status: "ok", observedAt: OBS, windows: [win("codex:primary")] },
    { provider: "claudeAgent", status: "ok", observedAt: OBS, windows: [win("claude:seven_day")] },
    { provider: "antigravity", status: "ok", observedAt: OBS, windows: [{ ...win("antigravity:gemini_5h"), kind: "session", windowDurationSec: 18000, resetsAt: new Date(Date.now() + 4 * 3600_000).toISOString() }, win("antigravity:gemini_weekly")] },
  ] };
  fs.writeFileSync(path.join(tmp, "usage.json"), JSON.stringify(usage));
  assert.equal(cli(["plan", "--author", "claude", "--paths-from", "paths.txt", "--usage", "usage.json"]).status, 0);
  assert.equal(cli(["plan", "--author", "claude", "--paths-from", "paths.txt"]).status, 3);
  assert.equal(cli(["plan", "--author", "claude", "--paths-from", "paths.txt", "--no-user"]).status, 4);
  const r = cli(["plan", "--author", "claude", "--paths-from", path.join(tmp, "paths.txt"), "--usage", path.join(tmp, "usage.json"), "--out", "README.md"], repo);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not git-ignored/);
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "# r\n");
});

const EV = "cross-review-evidence@1";
test("merge: same place + similar claim from two hosts -> one group keeping both ids (operator 3)", () => {
  const mk = (dir, host, findings) => {
    fs.mkdirSync(dir, { recursive: true });
    const review = { verdict: findings.some((x) => x.sev === "high" || x.sev === "critical") ? "block" : findings.length ? "fix" : "pass", coverage: {}, findings, limits: [] };
    fs.writeFileSync(path.join(dir, "review.json"), JSON.stringify(review));
    fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify({ schema: EV, reviewer: { host, idPrefix: findings[0]?.id[0] }, status: "complete", incompleteReasons: [], review }));
  };
  const f = (id, sev, loc, claim, evidence = "e") => ({ id, sev, loc, claim, evidence, check: "k" });
  mk(path.join(tmp, "m", "codex"), "codex", [f("X1", "high", "lib/a.mjs:10-12", "fatalReasons ignored when the reply is schema-valid", "fatalReasons only runs on validation errors"), f("X2", "med", "lib/b.mjs:5", "duplicate host_order entries")]);
  mk(path.join(tmp, "m", "antigravity"), "antigravity", [f("A1", "med", "lib/a.mjs:11", "fatal turn errors ignored when JSON is valid", "fatalReasons is only evaluated when validation fails"), f("A2", "low", "lib/c.mjs:1", "unrelated")]);
  fs.mkdirSync(path.join(tmp, "m", "claude"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "m", "claude", "review.json"), "null");
  fs.writeFileSync(path.join(tmp, "m", "claude", "evidence.json"), JSON.stringify({ schema: EV, reviewer: { host: "claude" }, status: "incomplete", incompleteReasons: ["timeout"], review: null }));
  const m = mergeReviews(["codex", "antigravity", "claude"].map((h) => loadReviewEntry(path.join(tmp, "m", h))));
  assert.equal(m.groups.length, 3);
  assert.deepEqual(m.groups[0].ids, ["X1", "A1"]);
  assert.equal(m.groups[0].sev, "high");
  assert.match(m.text, /claude: status=incomplete .*not merged: timeout/);
  const r = cli(["merge", "--review", path.join(tmp, "m", "codex"), "--review", path.join(tmp, "m", "antigravity", "review.json"), "--out", path.join(tmp, "merged.json")]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[high\] X1=A1 lib\/a.mjs:10-12 \(2 hosts\)/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, "merged.json"), "utf8")).groups.length, 3);
  assert.equal(cli(["merge", "--review", path.join(tmp, "m", "codex"), "--review", path.join(tmp, "m", "claude")]).status, 1);
});

test("merge: only complete runs with evidence are merged; bare or malformed review.json is refused (X16, operator 4)", () => {
  const d = path.join(tmp, "m2");
  fs.mkdirSync(path.join(d, "bare"), { recursive: true });
  const review = { verdict: "block", coverage: {}, findings: [{ id: "X1", sev: "high", loc: "a:1", claim: "c", evidence: "e", check: "k" }], limits: [] };
  fs.writeFileSync(path.join(d, "bare", "review.json"), JSON.stringify(review));
  const bare = loadReviewEntry(path.join(d, "bare", "review.json"));
  assert.equal(bare.status, "incomplete");
  assert.match(bare.incompleteReasons.join(), /no evidence\.json/);
  // A policy file or any truthy JSON is never a complete review.
  fs.mkdirSync(path.join(d, "junk"));
  fs.writeFileSync(path.join(d, "junk", "review.json"), JSON.stringify({ version: 1, hosts: {} }));
  fs.writeFileSync(path.join(d, "junk", "evidence.json"), JSON.stringify({ schema: EV, reviewer: { host: "codex" }, status: "complete", incompleteReasons: [], review: { version: 1, hosts: {} } }));
  assert.match(loadReviewEntry(path.join(d, "junk")).incompleteReasons.join(), /review invalid: verdict must be one of pass\|fix\|block/);
  // X16: a complete evidence with a bad verdict or null/incomplete findings is never merged and never crashes merge.
  const mkEv = (name, rv) => { fs.mkdirSync(path.join(d, name)); fs.writeFileSync(path.join(d, name, "evidence.json"), JSON.stringify({ schema: EV, reviewer: { host: "codex", idPrefix: "X" }, status: "complete", incompleteReasons: [], review: rv })); return loadReviewEntry(path.join(d, name)); };
  const nonsense = mkEv("nonsense", { verdict: "nonsense", findings: [] });
  assert.equal(nonsense.status, "incomplete");
  const nul = mkEv("nullf", { verdict: "fix", findings: [null] });
  assert.match(nul.incompleteReasons.join(), /findings\[0\] is not an object/);
  const partial = mkEv("partialf", { verdict: "fix", findings: [{ id: "X1", sev: "urgent", loc: "nowhere", claim: "c" }] });
  assert.match(partial.incompleteReasons.join(), /sev must be one of.*loc must be.*evidence empty/);
  const merged = mergeReviews([nonsense, nul, partial, { host: "forged", status: "complete", review: { verdict: "fix", findings: [null] } }]);
  assert.equal(merged.groups.length, 0);
  // A64: an entry claiming complete with a malformed review is listed as not merged, never as complete.
  for (const findings of ["bad", [null]]) {
    const mm = mergeReviews([{ host: "codex", status: "complete", source: "s", review: { verdict: "pass", findings } }]);
    assert.equal(mm.groups.length, 0);
    assert.equal(mm.hosts[0].status, "incomplete");
    assert.equal(mm.hosts[0].findings, 0);
    assert.match(mm.text, /codex: status=incomplete findings=0 \(not merged: review invalid: /);
  }
  // evidence.json itself can be passed; its nested review is what is merged.
  fs.mkdirSync(path.join(d, "ev"));
  fs.writeFileSync(path.join(d, "ev", "evidence.json"), JSON.stringify({ schema: EV, reviewer: { host: "codex", idPrefix: "X" }, status: "complete", incompleteReasons: [], review }));
  const ev = loadReviewEntry(path.join(d, "ev", "evidence.json"));
  assert.equal(ev.status, "complete");
  assert.equal(ev.review.findings.length, 1);
  const m = mergeReviews([bare, ev]);
  assert.equal(m.groups.length, 1);
  assert.match(m.text, /status=incomplete .*not merged: no evidence\.json/);
  assert.equal(cli(["merge", "--review", path.join(d, "bare", "review.json")]).status, 1);
});

test("checkOut: checked against the output's own repository and --repo; output dirs holding tracked files refused (A10)", () => {
  // Invoked from outside the target repo: the repository containing the output path still decides.
  fs.writeFileSync(path.join(tmp, "paths2.txt"), "src/a.ts\n");
  const r = cli(["plan", "--author", "claude", "--paths-from", path.join(tmp, "paths2.txt"), "--out", path.join(repo, "README.md")], os.tmpdir());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not git-ignored|tracked/);
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "# r\n");
  const m = cli(["merge", "--review", path.join(tmp, "m", "codex"), "--out", path.join(repo, "src", "a.ts")], os.tmpdir());
  assert.equal(m.status, 2);
  assert.equal(fs.readFileSync(path.join(repo, "src", "a.ts"), "utf8"), "x\n");
  // `forced/` is ignored by `*` but holds a force-added tracked file: refused as a run --out directory.
  assert.throws(() => checkOut(repo, path.join(repo, "forced")), /tracked|not git-ignored/);
  assert.throws(() => checkOut(null, path.join(repo, "forced")), /tracked|not git-ignored/);
  checkOut(null, path.join(repo, ".context", "plan.json"), { dir: false });
});

test("help prints the usage comment only (A40)", () => {
  const r = cli(["help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /cross-review\.mjs plan/);
  assert.doesNotMatch(r.stdout, /import /);
});

test("run exit codes through the CLI: complete 0, incomplete 1, usage error 2 (A24)", () => {
  const rev = git("rev-parse", "HEAD");
  const policyFile = path.join(tmp, "cli-policy.json");
  const p = JSON.parse(fs.readFileSync(path.join(HERE, "..", "review-policy.json"), "utf8"));
  // Claude stand-in: no OS sandbox is involved, so the exit codes are the same on every platform (X22).
  p.hosts.claude.bin = path.join(HERE, "fixtures", "fake-claude.mjs");
  p.hosts.claude.env_passthrough = ["FAKE_REVIEW", "FAKE_READ"];
  fs.writeFileSync(policyFile, JSON.stringify(p));
  fs.writeFileSync(path.join(tmp, "cli.patch"), "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+x\n");
  fs.writeFileSync(path.join(tmp, "cli-brief.md"), "Review.\n");
  const good = JSON.stringify({ verdict: "pass", coverage: { correctness: "checked" }, findings: [], limits: [] });
  const run = (out, env) => spawnSync(process.execPath, [CLI, "run", "--host", "claude", "--repo", repo, "--rev", rev, "--diff", path.join(tmp, "cli.patch"), "--scope", "src/a.ts", "--brief", path.join(tmp, "cli-brief.md"), "--dimensions", "correctness", "--policy", policyFile, "--out", path.join(tmp, out)], { cwd: tmp, encoding: "utf8", env: { ...process.env, ...env } });
  const ok = run("cli-run-ok", { FAKE_REVIEW: good });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /status=complete/);
  const bad = run("cli-run-bad", { FAKE_REVIEW: good, FAKE_READ: "/etc/hosts" });
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /status=incomplete/);
  const usage = spawnSync(process.execPath, [CLI, "run", "--host", "codex", "--out", path.join(tmp, "cli-run-usage")], { cwd: tmp, encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /--rev is required|is required/);
});

// ---------------------------------------------------------------- r8 full-PR review fixes
const completeDir = (dir, review, evReview = review) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "review.json"), JSON.stringify(review));
  fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify({ schema: EV, reviewer: { host: "codex", idPrefix: "X" }, status: "complete", incompleteReasons: [], review: evReview }));
  return dir;
};
const fx = (sev, loc = "a.mjs:1") => ({ id: "X1", sev, loc, claim: "c", evidence: "e", check: "k" });

test("merge: a verdict inconsistent with the findings or a bad line range is never shown as complete (X37)", () => {
  for (const [name, review] of [
    ["pass-high", { verdict: "pass", findings: [fx("high")] }],
    ["fix-high", { verdict: "fix", findings: [fx("high")] }],
    ["pass-unverified", { verdict: "pass", findings: [], prior_verification: [{ id: "X0", verified: false, note: "n" }] }],
    ["zero-line", { verdict: "fix", findings: [fx("med", "a.mjs:0-0")] }],
    ["reversed", { verdict: "fix", findings: [fx("med", "a.mjs:9-3")] }],
    ["pv-null", { verdict: "pass", findings: [], prior_verification: [null] }],
    ["pv-string-verified", { verdict: "pass", findings: [], prior_verification: [{ id: "X0", verified: "false", note: "n" }] }],
  ]) {
    const e = loadReviewEntry(completeDir(path.join(tmp, "r8m", name), { coverage: {}, limits: [], ...review }));
    assert.equal(e.status, "incomplete", name);
    const m = mergeReviews([e]);
    assert.equal(m.hosts[0].status, "incomplete", name);
    assert.equal(m.groups.length, 0, name);
  }
  assert.equal(loadReviewEntry(completeDir(path.join(tmp, "r8m", "ok"), { verdict: "block", coverage: {}, limits: [], findings: [fx("high")] })).status, "complete");
});

test("merge: evidence with a null review is incomplete even when a separate review.json looks valid (A85)", () => {
  const d = completeDir(path.join(tmp, "r8m", "nullrev"), { verdict: "pass", coverage: {}, findings: [], limits: [] }, null);
  for (const arg of [d, path.join(d, "review.json"), path.join(d, "evidence.json")]) assert.equal(loadReviewEntry(arg).status, "incomplete", arg);
});

test("merge/plan --out: a symlink followed by .. writes where it was checked, never into a tracked file (X32)", () => {
  fs.mkdirSync(path.join(repo, "ctx"), { recursive: true });
  fs.symlinkSync("../src", path.join(repo, "ctx", "link"));
  const rev = completeDir(path.join(tmp, "r8m", "x32"), { verdict: "pass", coverage: {}, findings: [], limits: [] });
  const r = cli(["merge", "--review", rev, "--out", "ctx/link/../README.md"], repo);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "# r\n");
  assert.ok(fs.existsSync(path.join(repo, "ctx", "README.md")));
});

const caseInsensitive = () => { try { return fs.realpathSync.native(repo.toUpperCase()) === fs.realpathSync.native(repo); } catch { return false; } };
test("checkOut: another letter case of the repository or of .git is still refused (A82)", { skip: !caseInsensitive() && "case-sensitive filesystem" }, () => {
  const upper = path.join(path.dirname(repo), path.basename(repo).toUpperCase());
  assert.throws(() => checkOut(repo, path.join(upper, "README.md"), { dir: false }), /tracked|not git-ignored/);
  assert.throws(() => checkOut(null, path.join(upper, "README.md"), { dir: false }), /tracked|not git-ignored/);
  assert.throws(() => checkOut(null, path.join(repo, ".GIT", "x.json"), { dir: false }), /\.git directory/);
  assert.throws(() => checkOut(repo, path.join(repo, ".Git", "x.json"), { dir: false }), /\.git directory/);
});
