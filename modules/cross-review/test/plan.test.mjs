import { test } from "node:test";
import assert from "node:assert/strict";
import { globMatch, gradeOf, hostPace, pathsFromDiffText, plan } from "../lib/plan.mjs";
import { loadPolicy, defaultPolicyPath, policyProblems } from "../lib/policy.mjs";

const { policy } = loadPolicy(defaultPolicyPath());
const clone = (x) => JSON.parse(JSON.stringify(x));

// Shape of the T3 MCP tool `provider_usage_limits` (captured 2026-11-26, values adjusted per test).
const OBS = "2026-11-26T00:00:00.000Z";
const H = 3600_000;
const at = (hours) => new Date(Date.parse(OBS) + hours * H).toISOString();
function usage({ codex = 0.9, codexReset = 84, claude = 0.9, claudeReset = 84, gem5h = 0.98, gemWeek = 0.9, gemWeekReset = 84, extra = {} } = {}) {
  return {
    providers: [
      { provider: "codex", instance: "codex:1", status: "ok", observedAt: OBS, windows: [
        { id: "codex:primary", kind: "weekly", remainingFraction: codex, resetsAt: at(codexReset), windowDurationSec: 604800, pace: { computable: true } }] },
      { provider: "claudeAgent", instance: "claudeAgent:1", status: "ok", observedAt: OBS, windows: [
        { id: "claude:seven_day", kind: "weekly", remainingFraction: claude, resetsAt: at(claudeReset), windowDurationSec: 604800, pace: { computable: true } },
        { id: "claude:seven_day_model:fable", kind: "weekly", remainingFraction: 1, resetsAt: at(84), windowDurationSec: 604800, pace: { computable: true } }] },
      { provider: "antigravity", instance: "antigravity:1", status: "ok", observedAt: OBS, windows: [
        { id: "antigravity:shared_3p_5h", kind: "session", remainingFraction: 1, windowDurationSec: 18000, pace: { computable: false, reason: "notStarted" } },
        { id: "antigravity:gemini_5h", kind: "session", remainingFraction: gem5h, resetsAt: at(2.5), windowDurationSec: 18000, pace: { computable: true } },
        { id: "antigravity:shared_3p_weekly", kind: "weekly", remainingFraction: 1, windowDurationSec: 604800, pace: { computable: false, reason: "notStarted" } },
        { id: "antigravity:gemini_weekly", kind: "weekly", remainingFraction: gemWeek, resetsAt: at(gemWeekReset), windowDurationSec: 604800, pace: { computable: true } }] },
      ...(extra.providers ?? []),
    ],
  };
}

test("default policy is valid and pins models only in the policy", () => {
  assert.deepEqual(policyProblems(policy), []);
  assert.equal(policy.hosts.codex.model, "gpt-6.1-sol");
  assert.equal(policy.hosts.antigravity.model, "gemini-4-neon");
  assert.equal(policy.hosts.antigravity.effort_map.high, "high");
  assert.equal(policy.review_effort, "high");
  assert.equal(policy.pace.provisional, true);
});

test("policy validation catches missing model, effort and duplicate prefixes", () => {
  const p = clone(policy);
  delete p.hosts.codex.model;
  p.hosts.claude.effort_map = {};
  p.hosts.antigravity.id_prefix = "X";
  const errs = policyProblems(p).join("\n");
  assert.match(errs, /hosts\.codex\.model missing/);
  assert.match(errs, /hosts\.claude\.effort_map/);
  assert.match(errs, /prefix X is used by another host/);
});

test("globs", () => {
  assert.ok(globMatch("**/migrations/**", "supabase/migrations/001.sql"));
  assert.ok(globMatch("**/migrations/**", "migrations/001.sql"));
  assert.ok(globMatch(".github/workflows/**", ".github/workflows/ci.yml"));
  assert.ok(globMatch("**/*auth*", "src/lib/oauth.ts"));
  assert.ok(!globMatch("**/auth/**", "src/author.ts"));
  assert.ok(!globMatch("*.md", "docs/a.md"));
});

test("paths from a diff include both sides, renames and deletions", () => {
  const d = "diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts\ndiff --git a/gone.sql b/gone.sql\n--- a/gone.sql\n+++ /dev/null\n";
  assert.deepEqual(pathsFromDiffText(d).sort(), ["gone.sql", "new.ts", "old.ts"]);
  assert.deepEqual(pathsFromDiffText("a.ts\n# note\nb.ts\n"), ["a.ts", "b.ts"]);
});

test("grade: high by dimension or by configured path glob, else standard", () => {
  assert.equal(gradeOf(policy, ["correctness"], ["src/a.ts"]).grade, "standard");
  assert.equal(gradeOf(policy, ["correctness"], ["src/a.ts"]).required, 1);
  for (const d of ["security", "migration", "deployment", "contract"]) assert.equal(gradeOf(policy, [d], []).grade, "high", d);
  for (const p of ["db/migrations/1.sql", "src/auth/login.ts", ".github/workflows/ci.yml", "tools/runner/x.ts", "modules/cross-review/review-policy.json"])
    assert.equal(gradeOf(policy, ["correctness"], [p]).grade, "high", p);
  const custom = clone(policy);
  custom.grade.high_path_globs = ["infra/**"];
  assert.equal(gradeOf(custom, ["correctness"], [".github/workflows/ci.yml"]).grade, "standard");
  assert.equal(gradeOf(custom, ["correctness"], ["infra/main.tf"]).grade, "high");
});

test("pace = remainingFraction / remainingTimeFraction, worst window, only the configured windows", () => {
  // gemini_5h: 0.98 / (2.5/5) = 1.96; gemini_weekly: 0.9 / (84/168) = 1.8 -> worst 1.8 on weekly.
  const r = hostPace(policy, "antigravity", usage(), "standard");
  assert.equal(r.decision, "use");
  assert.equal(r.worstWindow, "antigravity:gemini_weekly");
  assert.ok(Math.abs(r.pace - 1.8) < 1e-9);
  // shared_3p windows (notStarted, computable=false) are not configured for the Gemini reviewer and are ignored.
  assert.ok(!r.windows.some((w) => w.id.includes("shared_3p")));
});

test("pace: computable=false or missing data in a configured window -> ask", () => {
  const p = clone(policy);
  p.hosts.antigravity.usage.windows = ["antigravity:gemini_weekly", "antigravity:shared_3p_weekly"];
  assert.equal(hostPace(p, "antigravity", usage(), "high").decision, "ask");
  const u = usage();
  delete u.providers[0].windows[0].resetsAt;
  assert.equal(hostPace(policy, "codex", u, "high").decision, "ask");
  p.hosts.codex.usage.windows = ["codex:secondary"];
  assert.match(hostPace(p, "codex", usage(), "high").reason, /window missing/);
  assert.equal(hostPace(policy, "codex", null, "high").decision, "ask");
  const un = usage();
  un.providers[0] = { provider: "codex", status: "unavailable", reason: "stale" };
  assert.equal(hostPace(policy, "codex", un, "high").decision, "ask");
});

test("pace thresholds: >=1 use; 0.6-1 high only; <0.6 skip", () => {
  // codex reset in 84h of 168h -> remaining time 0.5
  assert.equal(hostPace(policy, "codex", usage({ codex: 0.5 }), "standard").decision, "use"); // pace 1.0
  assert.equal(hostPace(policy, "codex", usage({ codex: 0.4 }), "standard").decision, "skip"); // 0.8
  assert.equal(hostPace(policy, "codex", usage({ codex: 0.4 }), "high").decision, "use");
  assert.equal(hostPace(policy, "codex", usage({ codex: 0.29 }), "high").decision, "skip"); // 0.58
});

test("expected cost greater than remaining -> skip even when pace is fine", () => {
  // gemini weekly 0.005 remaining, reset in 5h -> pace large, but expected cost 0.01 > 0.005
  const r = hostPace(policy, "antigravity", usage({ gemWeek: 0.005, gemWeekReset: 5 }), "high");
  assert.equal(r.decision, "skip");
  assert.match(r.reason, /expected cost exceeds remaining/);
});

test("expected cost is checked against the 5 h (session) window too", () => {
  // weekly is healthy; the 5 h window has 0.03 left, below the session cost estimate.
  const r = hostPace(policy, "antigravity", usage({ gem5h: 0.03 }), "high");
  assert.equal(policy.hosts.antigravity.expected_cost.session > 0.03, true);
  assert.equal(r.decision, "skip");
  assert.match(r.reason, /antigravity:gemini_5h/);
});

test("a window that resets within reset_soon_minutes is not paced (no 60x pace blow-up)", () => {
  // Codex 0.55 left, resets in 30 min: rf / rtf would be ~185. It is reported as reset-soon instead.
  const r = hostPace(policy, "codex", usage({ codex: 0.55, codexReset: 0.5 }), "standard");
  assert.equal(r.decision, "use");
  assert.equal(r.pace, null);
  assert.equal(r.windows[0].resetSoon, true);
  assert.match(r.reason, /resets soon/);
  // Not enough left for the expected cost and it resets soon -> a human decides (wait or run).
  const low = hostPace(policy, "codex", usage({ codex: 0.005, codexReset: 0.5 }), "standard");
  assert.equal(low.decision, "ask");
  assert.match(low.reason, /resets soon/);
  // Without the knob the old arithmetic applies.
  const p = clone(policy);
  delete p.pace.reset_soon_minutes;
  assert.ok(hostPace(p, "codex", usage({ codex: 0.55, codexReset: 0.5 }), "standard").pace > 60);
});

test("pace: NaN or out-of-range remainingFraction -> ask, never skip", () => {
  for (const bad of [NaN, -0.1, 1.5]) {
    const r = hostPace(policy, "codex", usage({ codex: bad }), "standard");
    assert.equal(r.decision, "ask", String(bad));
    assert.match(r.reason, /remainingFraction/);
  }
});

test("host_order duplicates are rejected by the policy check and never double-select a host", () => {
  const p = clone(policy);
  p.host_order = ["codex", "codex", "antigravity", "claude"];
  assert.match(policyProblems(p).join(), /host_order: codex listed twice/);
  const r = plan({ policy: p, author: "claude", dimensions: ["security"], paths: [], usage: usage() });
  assert.equal(new Set(r.selected.map((x) => x.host)).size, r.selected.length);
  assert.deepEqual(r.selected.map((x) => x.host), ["codex", "antigravity"]);
  p.host_order = ["codex", "nope"];
  assert.match(policyProblems(p).join(), /host_order: nope is not a configured host/);
});

test("git-quoted diff headers are decoded before path rules apply", () => {
  const q = '"a/.github/workflows/\\353\\260\\260\\355\\217\\254.yml"';
  const qb = q.replace('"a/', '"b/');
  const diff = `diff --git ${q} ${qb}\n--- ${q}\n+++ ${qb}\n@@ -1 +1 @@\n-a\n+b\n`;
  const paths = pathsFromDiffText(diff);
  assert.deepEqual(paths, [".github/workflows/배포.yml"]);
  const g = gradeOf(policy, ["correctness"], paths);
  assert.equal(g.grade, "high");
  assert.equal(g.required, 2);
});

test("hunk body lines starting with --- / +++ are not file headers", () => {
  const diff = "diff --git a/doc.sql b/doc.sql\n--- a/doc.sql\n+++ b/doc.sql\n@@ -1,2 +1,2 @@\n--- auth comment\n+++ migration note\n ctx\n";
  assert.deepEqual(pathsFromDiffText(diff), ["doc.sql"]);
  assert.equal(gradeOf(policy, ["correctness"], pathsFromDiffText(diff)).grade, "standard");
});

test("selection: author is never a reviewer; standard -> 1, high -> 2 distinct hosts", () => {
  const s = plan({ policy, author: "codex", dimensions: ["correctness"], paths: ["src/a.ts"], usage: usage() });
  assert.equal(s.status, "ok");
  assert.equal(s.selected.length, 1);
  assert.ok(!s.selected.some((x) => x.host === "codex"));
  const h = plan({ policy, author: "claude", dimensions: ["security"], paths: [], usage: usage() });
  assert.equal(h.status, "ok");
  assert.deepEqual(h.selected.map((x) => x.host).sort(), ["antigravity", "codex"]);
  assert.equal(new Set(h.selected.map((x) => x.host)).size, 2);
  assert.equal(h.selected[0].model, policy.hosts[h.selected[0].host].model);
});

test("selection: not enough eligible hosts -> blocked needs human decision", () => {
  const p = clone(policy);
  delete p.hosts.antigravity;
  p.host_order = ["codex", "claude"];
  const r = plan({ policy: p, author: "claude", dimensions: ["security"], paths: [], usage: usage() });
  assert.equal(r.status, "blocked");
  assert.match(r.reason, /needs human decision/);
});

test("selection: skipped host emits a one-line question; shortfall -> ask, --no-user -> blocked", () => {
  const u = usage({ codex: 0.1 });
  const r = plan({ policy, author: "claude", dimensions: ["security"], paths: [], usage: u });
  assert.equal(r.status, "ask");
  assert.equal(r.questions.length, 1);
  assert.match(r.questions[0], /^codex: skipped .*anyway\?$/);
  assert.ok(!r.questions[0].includes("\n"));
  const n = plan({ policy, author: "claude", dimensions: ["security"], paths: [], usage: u, noUser: true });
  assert.equal(n.status, "blocked");
  assert.deepEqual(n.questions, []);
  assert.match(n.reason, /needs human decision.*--no-user/);
  // Standard grade with enough healthy hosts: ok, and the skipped host still gets its question line.
  const s = plan({ policy, author: "claude", dimensions: ["correctness"], paths: [], usage: u });
  assert.equal(s.status, "ok");
  assert.equal(s.selected[0].host, "antigravity");
  assert.equal(s.questions.length, 1);
});

test("selection: usage unavailable -> ask; --no-user -> blocked", () => {
  const r = plan({ policy, author: "antigravity", dimensions: ["correctness"], paths: [], usage: null });
  assert.equal(r.status, "ask");
  assert.ok(r.questions.every((q) => /usage unavailable/.test(q)));
  assert.equal(plan({ policy, author: "antigravity", dimensions: ["correctness"], paths: [], usage: null, noUser: true }).status, "blocked");
});

test("selection never substitutes the author when others are short", () => {
  const r = plan({ policy, author: "codex", dimensions: ["security"], paths: [], usage: usage({ claude: 0.01, gemWeek: 0.01 }) });
  assert.notEqual(r.status, "ok");
  assert.ok(!r.selected.some((x) => x.host === "codex"));
});
