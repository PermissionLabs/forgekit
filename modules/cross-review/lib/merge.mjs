// `merge`: combine several hosts' review.json files into one deduplicated summary. Findings from different hosts
// are grouped when they point at the same file within a few lines and their claims are similar; every host's own
// id is kept. Incomplete runs are listed but never merged (their review is withheld).
import * as fs from "node:fs";
import * as path from "node:path";
import { expectedVerdict, parseLoc, SEVS, VERDICTS } from "./schema.mjs";

const STOP = new Set(["the", "and", "for", "with", "that", "this", "are", "not", "can", "when", "from", "into", "its", "but", "only", "any", "all", "has", "have", "was", "were", "will", "does", "than", "then", "also", "even", "which", "while", "their", "there", "been", "being", "each", "other"]);
const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9_$.]{3,}/g)?.filter((w) => !STOP.has(w)) ?? []);
export function similarity(a, b) {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

/** Line distance between two locs in the same file (0 when the ranges overlap); Infinity for different files. */
export function locDistance(la, lb) {
  const a = parseLoc(la), b = parseLoc(lb);
  if (!a || !b || a.file !== b.file) return Infinity;
  if (a.b < b.a) return b.a - a.b;
  if (b.b < a.a) return a.a - b.b;
  return 0;
}

/**
 * Shape problems of a review to be merged (X16): verdict in the enum, findings an array of objects each with a
 * string id, a severity from the enum, a file:line loc and non-empty claim/evidence/check. [] when mergeable.
 */
export function reviewShapeProblems(review) {
  if (!review || typeof review !== "object" || Array.isArray(review)) return ["review is not an object"];
  const errs = [];
  if (!VERDICTS.includes(review.verdict)) errs.push(`verdict must be one of ${VERDICTS.join("|")}`);
  if (!Array.isArray(review.findings)) return [...errs, "findings is not an array"];
  review.findings.forEach((f, i) => {
    if (!f || typeof f !== "object" || Array.isArray(f)) { errs.push(`findings[${i}] is not an object`); return; }
    if (typeof f.id !== "string" || !f.id) errs.push(`findings[${i}].id missing`);
    if (!SEVS.includes(f.sev)) errs.push(`findings[${i}].sev must be one of ${SEVS.join("|")}`);
    const loc = parseLoc(f.loc);
    if (!loc) errs.push(`findings[${i}].loc must be "file:line"`);
    else if (loc.a < 1 || loc.b < loc.a) errs.push(`findings[${i}].loc ${f.loc}: line range must start at 1 and not be reversed`);
    for (const k of ["claim", "evidence", "check"]) if (typeof f[k] !== "string" || !f[k].trim()) errs.push(`findings[${i}].${k} empty`);
  });
  // X37: the verdict must agree with the findings and prior verification, as run's validator requires.
  const pv = review.prior_verification;
  if (pv !== undefined && !Array.isArray(pv)) errs.push("prior_verification is not an array");
  // (r9 smoke) each entry an object with a string id and a boolean verified, so "false" or null never reads as verified.
  else if (pv?.some((p) => !p || typeof p !== "object" || Array.isArray(p) || typeof p.id !== "string" || !p.id || typeof p.verified !== "boolean")) errs.push("prior_verification entries need a string id and a boolean verified");
  else if (VERDICTS.includes(review.verdict) && review.findings.every((f) => f && typeof f === "object")) {
    const want = expectedVerdict(review.findings, review.prior_verification ?? []);
    if (review.verdict !== want) errs.push(`verdict ${review.verdict} inconsistent with findings/prior_verification (expected ${want})`);
  }
  return errs;
}

/**
 * Read one --review argument: a run directory (evidence.json + review.json), an evidence.json, or a review.json
 * next to its evidence.json. Only a run whose evidence says status=complete is merged: a review.json without
 * evidence (no status), an incomplete run, or a review that is not { verdict, findings[] } is listed as
 * incomplete and never merged.
 */
export function loadReviewEntry(arg) {
  const isDir = fs.existsSync(arg) && fs.statSync(arg).isDirectory();
  const dir = isDir ? arg : path.dirname(arg);
  const file = isDir ? path.join(dir, "review.json") : arg;
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return undefined; } };
  const given = readJson(file);
  let ev = given?.schema === "cross-review-evidence@1" ? given : readJson(path.join(dir, "evidence.json"));
  if (ev?.schema !== "cross-review-evidence@1") ev = null;
  // A85: with evidence present, only its review counts; a separate review.json never stands in for a null one.
  const review = ev ? ev.review ?? null : given;
  const reasons = [];
  if (given === undefined && !ev) reasons.push(`cannot read ${file}`);
  if (!ev) reasons.push("no evidence.json: run status unknown (merge needs a complete run's evidence)");
  else if (ev.status !== "complete") reasons.push(...(ev.incompleteReasons?.length ? ev.incompleteReasons : [`status=${ev.status ?? "missing"}`]));
  if (ev?.status === "complete") reasons.push(...reviewShapeProblems(review).map((e) => `review invalid: ${e}`));
  if (ev?.status === "complete" && given && !given.schema && ev.review && JSON.stringify(given) !== JSON.stringify(ev.review)) reasons.push("review.json differs from evidence.json review");
  const first = Array.isArray(review?.findings) ? review.findings[0] : null;
  const prefix = ev?.reviewer?.idPrefix ?? (typeof first?.id === "string" ? first.id[0] : null) ?? null;
  return {
    source: path.resolve(file), host: ev?.reviewer?.host ?? (prefix ? `prefix:${prefix}` : path.basename(dir)),
    status: reasons.length ? "incomplete" : "complete", incompleteReasons: reasons, review: reasons.length ? null : review,
  };
}

/**
 * mergeReviews(entries, { lineWindow=3, minSimilarity=0.2 }); claim+evidence word Jaccard, halved for overlapping lines -> { schema, hosts[], groups[], text }
 * entries: [{ host, status, review, source }]
 */
export function mergeReviews(entries, { lineWindow = 3, minSimilarity = 0.2 } = {}) {
  // A64: a "complete" entry whose review is malformed is shown as not merged, never as complete (X16: never a crash).
  const checked = entries.map((e) => {
    if (e.status !== "complete") return e;
    const probs = e.review ? reviewShapeProblems(e.review) : ["no review"];
    return probs.length ? { ...e, status: "incomplete", incompleteReasons: [...(e.incompleteReasons ?? []), ...probs.map((x) => `review invalid: ${x}`)] } : e;
  });
  const hosts = checked.map((e) => ({ host: e.host, status: e.status, source: e.source, verdict: e.status === "complete" ? e.review.verdict : null, findings: e.status === "complete" ? e.review.findings.length : 0, incompleteReasons: e.incompleteReasons ?? [] }));
  const groups = [];
  for (const e of checked) {
    if (e.status !== "complete") continue;
    for (const f of e.review.findings) {
      const m = { host: e.host, id: f.id, sev: f.sev, loc: f.loc, claim: f.claim, text: `${f.claim} ${f.evidence}` };
      // Same place (overlapping lines) needs weaker textual agreement than nearby lines.
      const text = `${f.claim} ${f.evidence}`;
      const g = groups.find((gr) => !gr.members.some((x) => x.host === e.host)
        && gr.members.some((x) => { const d = locDistance(x.loc, f.loc), sim = similarity(x.text, text); return d <= lineWindow && sim >= (d === 0 ? minSimilarity / 2 : minSimilarity); }));
      if (g) g.members.push(m); else groups.push({ members: [m] });
    }
  }
  const rank = (s) => SEVS.indexOf(s);
  for (const g of groups) {
    for (const m of g.members) delete m.text;
    g.sev = g.members.map((x) => x.sev).sort((a, b) => rank(a) - rank(b))[0];
    g.ids = g.members.map((x) => x.id);
    g.loc = g.members[0].loc;
    g.agreement = new Set(g.members.map((x) => x.host)).size;
  }
  groups.sort((a, b) => rank(a.sev) - rank(b.sev) || b.agreement - a.agreement || String(a.loc).localeCompare(String(b.loc)));
  const lines = [`cross-review merge: ${entries.length} review(s), ${groups.length} distinct finding group(s)`];
  for (const h of hosts) lines.push(`  ${h.host}: status=${h.status}${h.verdict ? ` verdict=${h.verdict}` : ""} findings=${h.findings}${h.status !== "complete" ? ` (not merged: ${h.incompleteReasons.join("; ") || "incomplete"})` : ""}`);
  for (const g of groups) {
    lines.push(`[${g.sev}] ${g.ids.join("=")} ${g.loc}${g.agreement > 1 ? ` (${g.agreement} hosts)` : ""}`);
    for (const m of g.members) lines.push(`  ${m.id} (${m.host}, ${m.sev}, ${m.loc}): ${m.claim}`);
  }
  return { schema: "cross-review-merge@1", lineWindow, minSimilarity, hosts, groups, text: lines.join("\n") };
}
