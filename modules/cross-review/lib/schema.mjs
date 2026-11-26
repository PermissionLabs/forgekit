// Common review output schema, dispositions schema, and the validators every adapter result goes through.
//
// Review:       { verdict: pass|fix|block,
//                 coverage: { <dimension>: "checked" | "n/a:<reason>" },
//                 findings: [{ id: <prefix><n>, sev: critical|high|med|low, loc: "file:line", claim, evidence, check }],
//                 limits: [string],
//                 prior_verification?: [{ id, verified: boolean, note }] }   (re-review mode only)
// Disposition:  { id, disposition: fixed|followup|accepted|blocked, ref }

export const VERDICTS = ["pass", "fix", "block"];
export const SEVS = ["critical", "high", "med", "low"];
export const DISPOSITIONS = ["fixed", "followup", "accepted", "blocked"];
const FINDING_KEYS = ["id", "sev", "loc", "claim", "evidence", "check"];

/** Strict parse: the whole reply must be one JSON object (no prose, no code fences). */
export function parseReviewText(text) {
  if (text && typeof text === "object") return { value: text };
  if (typeof text !== "string" || !text.trim()) return { error: "empty reply" };
  const t = text.trim();
  if (/^```/.test(t)) return { error: "wrapped in code fences (not allowed)" };
  try { return { value: JSON.parse(t) }; } catch (e) { return { error: `not JSON: ${e.message}` }; }
}

export function parseLoc(loc) {
  const m = typeof loc === "string" ? loc.match(/^(.+?):(\d+)(?:-(\d+))?$/) : null;
  return m ? { file: m[1], a: Number(m[2]), b: Number(m[3] ?? m[2]) } : null;
}

/** The verdict a review must carry, given its findings and prior verification. */
export function expectedVerdict(findings, priorVerification = []) {
  if (findings.some((f) => f?.sev === "critical" || f?.sev === "high")) return "block";
  if (findings.length || priorVerification.some((p) => p?.verified === false)) return "fix";
  return "pass";
}

/**
 * validateReview(value, opts) -> string[] (empty when valid)
 * opts: { dimensions[], prefix, idStart=1, scope: Map<path, lineCount>, priorIds[]=[], mustCoverPrior[]=priorIds }
 */
export function validateReview(v, opts) {
  const { dimensions, prefix, idStart = 1, scope, priorIds = [] } = opts;
  const mustCover = opts.mustCoverPrior ?? priorIds;
  const errors = [];
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["top-level not an object"];
  const allowed = ["verdict", "coverage", "findings", "limits", ...(priorIds.length ? ["prior_verification"] : [])];
  const extra = Object.keys(v).filter((k) => !allowed.includes(k));
  if (extra.length) errors.push(`unexpected top-level keys: ${extra.join(",")}`);
  if (!VERDICTS.includes(v.verdict)) errors.push(`verdict must be one of ${VERDICTS.join("|")}`);

  if (!v.coverage || typeof v.coverage !== "object" || Array.isArray(v.coverage)) errors.push("coverage missing");
  else {
    for (const d of dimensions) if (!(d in v.coverage)) errors.push(`coverage.${d} missing`);
    for (const [k, x] of Object.entries(v.coverage)) {
      if (!dimensions.includes(k)) errors.push(`coverage.${k} is not a requested dimension`);
      if (!(x === "checked" || (typeof x === "string" && /^n\/a:\s*\S/s.test(x)))) errors.push(`coverage.${k} must be "checked" or "n/a:<reason>"`);
    }
  }

  if (!Array.isArray(v.findings)) errors.push("findings not array");
  else v.findings.forEach((f, i) => {
    const want = `${prefix}${idStart + i}`;
    if (f?.id !== want) errors.push(`findings[${i}].id should be ${want}`);
    if (!SEVS.includes(f?.sev)) errors.push(`findings[${i}].sev must be one of ${SEVS.join("|")}`);
    const loc = parseLoc(f?.loc);
    if (!loc) errors.push(`findings[${i}].loc must be "file:line"`);
    else if (scope) {
      const lines = scope.get(loc.file);
      if (lines === undefined) errors.push(`findings[${i}].loc ${f.loc}: file not in review scope`);
      else if (loc.a < 1 || loc.b < loc.a || loc.b > Math.max(lines, 1)) errors.push(`findings[${i}].loc ${f.loc}: line outside file (1-${lines})`);
    }
    for (const k of ["claim", "evidence", "check"]) if (typeof f?.[k] !== "string" || !f[k].trim()) errors.push(`findings[${i}].${k} empty`);
    const ex = Object.keys(f ?? {}).filter((k) => !FINDING_KEYS.includes(k));
    if (ex.length) errors.push(`findings[${i}] unexpected keys: ${ex.join(",")}`);
  });

  if (!Array.isArray(v.limits) || !v.limits.every((s) => typeof s === "string")) errors.push("limits must be an array of strings");

  let prior = [];
  if (priorIds.length) {
    if (!Array.isArray(v.prior_verification)) errors.push("prior_verification not array");
    else {
      prior = v.prior_verification;
      const seen = new Set();
      prior.forEach((p, i) => {
        if (!priorIds.includes(p?.id)) errors.push(`prior_verification[${i}].id must be one of ${priorIds.join(",")}`);
        else if (seen.has(p.id)) errors.push(`prior_verification[${i}].id ${p.id} duplicated`);
        else seen.add(p.id);
        if (typeof p?.verified !== "boolean") errors.push(`prior_verification[${i}].verified must be boolean`);
        if (typeof p?.note !== "string" || !p.note.trim()) errors.push(`prior_verification[${i}].note empty`);
        const ex = Object.keys(p ?? {}).filter((k) => !["id", "verified", "note"].includes(k));
        if (ex.length) errors.push(`prior_verification[${i}] unexpected keys: ${ex.join(",")}`);
      });
      const missing = mustCover.filter((x) => !seen.has(x));
      if (missing.length) errors.push(`prior_verification missing: ${missing.join(",")}`);
    }
  }
  if (Array.isArray(v.findings) && VERDICTS.includes(v.verdict)) {
    const want = expectedVerdict(v.findings, prior);
    if (v.verdict !== want) errors.push(`verdict ${v.verdict} inconsistent with findings/prior_verification (expected ${want})`);
  }
  return errors;
}

/** Previous findings: a review object, an evidence file with .review, or a bare findings array. */
export function priorFindingsFrom(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.findings) ? value.findings : Array.isArray(value?.review?.findings) ? value.review.findings : null;
  if (!list) throw new Error("prior findings: expected a findings array, a review object, or an evidence file with review.findings");
  const errs = [];
  const ids = new Set();
  list.forEach((f, i) => {
    if (!/^[A-Z]\d+$/.test(f?.id ?? "")) errs.push(`prior[${i}].id must look like X1`);
    else if (ids.has(f.id)) errs.push(`prior[${i}].id ${f.id} duplicated`);
    else ids.add(f.id);
  });
  if (errs.length) throw new Error(`prior findings invalid:\n- ${errs.join("\n- ")}`);
  return list;
}

/** validateDispositions(list, priorIds) -> string[]; every prior id needs exactly one disposition. */
export function validateDispositions(list, priorIds) {
  if (!Array.isArray(list)) return ["dispositions must be an array"];
  const errs = [];
  const seen = new Set();
  list.forEach((d, i) => {
    if (!priorIds.includes(d?.id)) errs.push(`dispositions[${i}].id ${d?.id} is not a prior finding id`);
    else if (seen.has(d.id)) errs.push(`dispositions[${i}].id ${d.id} duplicated`);
    else seen.add(d.id);
    if (!DISPOSITIONS.includes(d?.disposition)) errs.push(`dispositions[${i}].disposition must be one of ${DISPOSITIONS.join("|")}`);
    if (typeof d?.ref !== "string" || !d.ref.trim()) errs.push(`dispositions[${i}].ref empty (commit, test, issue or reason)`);
    const ex = Object.keys(d ?? {}).filter((k) => !["id", "disposition", "ref"].includes(k));
    if (ex.length) errs.push(`dispositions[${i}] unexpected keys: ${ex.join(",")}`);
  });
  const missing = priorIds.filter((x) => !seen.has(x));
  if (missing.length) errs.push(`dispositions missing for: ${missing.join(",")}`);
  return errs;
}

/** Next free number for this host's prefix after the prior findings (re-review numbering continues). */
export function nextIdStart(priorFindings, prefix) {
  const nums = priorFindings.map((f) => f.id).filter((id) => id.startsWith(prefix)).map((id) => Number(id.slice(prefix.length)));
  return nums.length ? Math.max(...nums) + 1 : 1;
}

/**
 * JSON Schema handed to hosts that support structured output (Claude --json-schema, Codex --output-schema).
 * Coverage keys are the run's dimensions so the schema stays strict (every property required, no extras).
 * Format rules the schema cannot express (id numbering, loc in scope, verdict consistency) are checked by validateReview.
 */
export function jsonSchemaFor(dimensions, { prior = false } = {}) {
  const str = { type: "string" };
  const props = {
    verdict: { type: "string", enum: VERDICTS },
    coverage: {
      type: "object",
      properties: Object.fromEntries(dimensions.map((d) => [d, { type: "string", description: 'exactly "checked", or "n/a:<reason>"' }])),
      required: dimensions,
      additionalProperties: false,
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: { id: str, sev: { type: "string", enum: SEVS }, loc: { type: "string", description: "repo-relative path:line" }, claim: str, evidence: str, check: str },
        required: FINDING_KEYS,
        additionalProperties: false,
      },
    },
    limits: { type: "array", items: str },
  };
  if (prior) props.prior_verification = {
    type: "array",
    items: { type: "object", properties: { id: str, verified: { type: "boolean" }, note: str }, required: ["id", "verified", "note"], additionalProperties: false },
  };
  return { type: "object", properties: props, required: Object.keys(props), additionalProperties: false };
}

/** Human-readable shape used inside prompts. */
export function schemaText(dimensions, prefix, idStart, priorIds = []) {
  return `{"verdict":"pass"|"fix"|"block","coverage":{${dimensions.map((d) => `"${d}":"checked"|"n/a:<reason>"`).join(",")}},` +
    (priorIds.length ? `"prior_verification":[{"id":"${priorIds[0]}","verified":true|false,"note":"<what you checked, file:line>"}],` : "") +
    `"findings":[{"id":"${prefix}${idStart}","sev":"critical"|"high"|"med"|"low","loc":"<repo-relative path>:<line>","claim":"...","evidence":"...","check":"..."}],"limits":["..."]}`;
}
