// `merge`: combine several hosts' review.json files into one deduplicated summary. Findings from different hosts
// are grouped when they point at the same file within a few lines and their claims are similar; every host's own
// id is kept. Incomplete runs are listed but never merged (their review is withheld).
import * as fs from "node:fs";
import * as path from "node:path";
import { parseLoc, SEVS } from "./schema.mjs";

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

/** Read one --review argument: a directory holding review.json (+ evidence.json), or a review.json path. */
export function loadReviewEntry(arg) {
  const dir = fs.existsSync(arg) && fs.statSync(arg).isDirectory() ? arg : path.dirname(arg);
  const reviewFile = dir === arg ? path.join(dir, "review.json") : arg;
  const review = JSON.parse(fs.readFileSync(reviewFile, "utf8"));
  let ev = null;
  try { ev = JSON.parse(fs.readFileSync(path.join(dir, "evidence.json"), "utf8")); } catch {}
  const prefix = review?.findings?.[0]?.id?.[0] ?? ev?.reviewer?.idPrefix ?? null;
  return { source: path.resolve(reviewFile), host: ev?.reviewer?.host ?? (prefix ? `prefix:${prefix}` : path.basename(dir)), status: ev?.status ?? (review ? "complete" : "incomplete"), incompleteReasons: ev?.incompleteReasons ?? [], review };
}

/**
 * mergeReviews(entries, { lineWindow=3, minSimilarity=0.2 }); claim+evidence word Jaccard, halved for overlapping lines -> { schema, hosts[], groups[], text }
 * entries: [{ host, status, review, source }]
 */
export function mergeReviews(entries, { lineWindow = 3, minSimilarity = 0.2 } = {}) {
  const hosts = entries.map((e) => ({ host: e.host, status: e.status, source: e.source, verdict: e.status === "complete" ? e.review?.verdict ?? null : null, findings: e.status === "complete" ? e.review?.findings?.length ?? 0 : 0, incompleteReasons: e.incompleteReasons ?? [] }));
  const groups = [];
  for (const e of entries) {
    if (e.status !== "complete" || !e.review) continue;
    for (const f of e.review.findings ?? []) {
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
