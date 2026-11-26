import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedVerdict, jsonSchemaFor, nextIdStart, parseReviewText, priorFindingsFrom, validateDispositions, validateReview } from "../lib/schema.mjs";
import { checkReported } from "../lib/run.mjs";

const scope = new Map([["src/a.ts", 40], ["src/b.ts", 10]]);
const dims = ["correctness", "security"];
const opts = { dimensions: dims, prefix: "X", scope };
const finding = (over = {}) => ({ id: "X1", sev: "med", loc: "src/a.ts:12", claim: "c", evidence: "e", check: "k", ...over });
const review = (over = {}) => ({ verdict: "fix", coverage: { correctness: "checked", security: "n/a:no auth code" }, findings: [finding()], limits: [], ...over });

test("a well-formed review passes", () => {
  assert.deepEqual(validateReview(review(), opts), []);
  assert.deepEqual(validateReview(review({ verdict: "pass", findings: [] }), opts), []);
  assert.deepEqual(validateReview(review({ verdict: "block", findings: [finding({ sev: "high" }), finding({ id: "X2", loc: "src/b.ts:1-3" })] }), opts), []);
});

test("field-level errors", () => {
  const cases = [
    [review({ verdict: "maybe" }), /verdict must be/],
    [review({ coverage: { correctness: "checked" } }), /coverage\.security missing/],
    [review({ coverage: { correctness: "checked:mostly", security: "checked" } }), /coverage\.correctness must be/],
    [review({ coverage: { correctness: "checked", security: "n/a:" } }), /coverage\.security must be/],
    [review({ coverage: { correctness: "checked", security: "checked", perf: "checked" } }), /perf is not a requested dimension/],
    [review({ findings: [finding({ id: "A1" })] }), /id should be X1/],
    [review({ findings: [finding({ sev: "medium" })] }), /sev must be/],
    [review({ findings: [finding({ loc: "src/a.ts" })] }), /loc must be "file:line"/],
    [review({ findings: [finding({ loc: "src/c.ts:1" })] }), /not in review scope/],
    [review({ findings: [finding({ loc: "src/b.ts:11" })] }), /line outside file/],
    [review({ findings: [finding({ claim: " " })] }), /claim empty/],
    [review({ findings: [finding({ extra: 1 })] }), /unexpected keys: extra/],
    [review({ limits: "none" }), /limits must be an array/],
    [review({ summary: "x" }), /unexpected top-level keys: summary/],
    [review({ verdict: "pass" }), /inconsistent/],
    [review({ verdict: "fix", findings: [finding({ sev: "critical" })] }), /expected block/],
  ];
  for (const [v, re] of cases) assert.match(validateReview(v, opts).join("\n"), re);
});

test("ids continue from idStart; no length limit on text", () => {
  const long = "x".repeat(200_000);
  assert.deepEqual(validateReview(review({ findings: [finding({ id: "X9", evidence: long })] }), { ...opts, idStart: 9 }), []);
});

test("strict parse: JSON only, no fences", () => {
  assert.ok(parseReviewText('{"a":1}').value);
  assert.match(parseReviewText("```json\n{}\n```").error, /code fences/);
  assert.match(parseReviewText("Here you go: {}").error, /not JSON/);
  assert.match(parseReviewText("").error, /empty/);
  assert.deepEqual(parseReviewText({ a: 1 }).value, { a: 1 }); // structured output from the host
});

test("re-review: prior_verification must cover every prior id; unverified prior forces at least fix", () => {
  const ro = { ...opts, priorIds: ["X8", "A10"], idStart: 9 };
  const pv = [{ id: "X8", verified: true, note: "src/a.ts:3" }, { id: "A10", verified: true, note: "src/b.ts:2" }];
  assert.deepEqual(validateReview(review({ verdict: "pass", findings: [], prior_verification: pv }), ro), []);
  assert.match(validateReview(review({ verdict: "pass", findings: [], prior_verification: pv.slice(0, 1) }), ro).join(), /prior_verification missing: A10/);
  const unv = [pv[0], { ...pv[1], verified: false }];
  assert.match(validateReview(review({ verdict: "pass", findings: [], prior_verification: unv }), ro).join(), /expected fix/);
  assert.deepEqual(validateReview(review({ verdict: "fix", findings: [], prior_verification: unv }), ro), []);
  assert.match(validateReview(review({ verdict: "pass", findings: [], prior_verification: [...pv, { id: "Z1", verified: true, note: "n" }] }), ro).join(), /must be one of X8,A10/);
  assert.match(validateReview(review({ verdict: "pass", findings: [] }), ro).join(), /prior_verification not array/);
  // Outside re-review mode the key is not allowed.
  assert.match(validateReview(review({ verdict: "pass", findings: [], prior_verification: pv }), opts).join(), /unexpected top-level keys: prior_verification/);
  assert.equal(expectedVerdict([], [{ verified: false }]), "fix");
});

test("dispositions schema", () => {
  const ids = ["X8", "A10"];
  assert.deepEqual(validateDispositions([{ id: "X8", disposition: "fixed", ref: "abc123" }, { id: "A10", disposition: "accepted", ref: "single-user harness" }], ids), []);
  const errs = validateDispositions([{ id: "X8", disposition: "filed", ref: "" }, { id: "X8", disposition: "fixed", ref: "r" }, { id: "Q1", disposition: "fixed", ref: "r" }], ids).join("\n");
  assert.match(errs, /must be one of fixed\|followup\|accepted\|blocked/);
  assert.match(errs, /ref empty/);
  assert.match(errs, /X8 duplicated/);
  assert.match(errs, /Q1 is not a prior finding id/);
  assert.match(errs, /missing for: A10/);
});

test("prior findings: accepted shapes and numbering continues per host prefix", () => {
  const list = [{ id: "X8" }, { id: "A10" }, { id: "X3" }];
  assert.equal(priorFindingsFrom(list).length, 3);
  assert.equal(priorFindingsFrom({ findings: list }).length, 3);
  assert.equal(priorFindingsFrom({ review: { findings: list } }).length, 3);
  assert.throws(() => priorFindingsFrom([{ id: "x" }]), /look like X1/);
  assert.equal(nextIdStart(list, "X"), 9);
  assert.equal(nextIdStart(list, "A"), 11);
  assert.equal(nextIdStart(list, "C"), 1);
});

test("host JSON schema is strict: every object closed, coverage keys are the run's dimensions", () => {
  const s = jsonSchemaFor(dims);
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required.sort(), ["coverage", "findings", "limits", "verdict"]);
  assert.deepEqual(s.properties.coverage.required, dims);
  assert.equal(s.properties.findings.items.additionalProperties, false);
  assert.ok(jsonSchemaFor(dims, { prior: true }).required.includes("prior_verification"));
});

test("pinned vs reported: mismatch or missing reported model -> incomplete reasons", () => {
  const pin = { model: "gpt-6.1-sol", effort: "high" };
  assert.deepEqual(checkReported(pin, { model: "gpt-6.1-sol", effort: "high" }), []);
  // A host that reports effort must report it (A16/A25); only a host that never reports it opts out.
  assert.match(checkReported(pin, { model: "gpt-6.1-sol", effort: null }).join(), /reported_effort_unavailable/);
  assert.match(checkReported(pin, { model: "gpt-6.1-sol" }).join(), /reported_effort_unavailable/);
  assert.deepEqual(checkReported(pin, { model: "gpt-6.1-sol", effort: null }, { effortReported: false }), []);
  assert.match(checkReported(pin, { model: "gpt-6.1-mini", effort: "high" }).join(), /reported_model_mismatch:gpt-6.1-mini/);
  assert.match(checkReported(pin, { model: "gpt-6.1-sol", effort: "low" }).join(), /reported_effort_mismatch:low/);
  assert.match(checkReported(pin, null).join(), /reported_model_unavailable/);
  assert.match(checkReported(pin, { model: null }).join(), /reported_model_unavailable/);
});
