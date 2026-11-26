// `plan`: review grade, reviewer selection and pace. Pure functions; no network, no token files.
// Usage data is whatever the caller saved from the T3 MCP tool `provider_usage_limits`.
import { HOSTS } from "./policy.mjs";

// ---------------------------------------------------------------- globs
/** Glob -> RegExp over a repo-relative POSIX path. `**` spans directories, `*` and `?` do not. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
export const globMatch = (glob, p) => globToRegExp(glob).test(p);

/** Changed paths from a unified diff; a file that is not a diff is read as one path per line. */
export function pathsFromDiffText(text) {
  const out = new Set();
  const looksLikeDiff = /^(diff --git |\+\+\+ |--- )/m.test(text);
  if (!looksLikeDiff) {
    for (const l of text.split("\n")) { const t = l.replace(/#.*$/, "").trim(); if (t) out.add(t); }
    return [...out];
  }
  const strip = (s) => s.replace(/\t.*$/, "").trim().replace(/^"(.*)"$/, "$1");
  for (const line of text.split("\n")) {
    let m;
    if ((m = line.match(/^diff --git a\/(.+?) b\/(.+)$/))) { out.add(m[1]); out.add(m[2]); }
    else if ((m = line.match(/^(?:\+\+\+|---) (?:[ab]\/)?(.+)$/)) && strip(m[1]) !== "/dev/null") out.add(strip(m[1]));
    else if ((m = line.match(/^rename (?:from|to) (.+)$/))) out.add(m[1].trim());
  }
  return [...out];
}

// ---------------------------------------------------------------- grade
export function gradeOf(policy, dimensions, paths) {
  const g = policy.grade ?? {};
  const highDims = g.high_dimensions ?? [];
  const globs = g.high_path_globs ?? [];
  const reasons = [];
  for (const d of dimensions) if (highDims.includes(d)) reasons.push(`dimension:${d}`);
  for (const p of paths) {
    const hit = globs.find((gl) => globMatch(gl, p));
    if (hit) reasons.push(`path:${p} (${hit})`);
  }
  const grade = reasons.length ? "high" : "standard";
  const required = (g.reviewers ?? { standard: 1, high: 2 })[grade];
  return { grade, reasons, required };
}

// ---------------------------------------------------------------- pace
/**
 * Per-host pace from a provider_usage_limits payload.
 * Returns { decision: "use"|"skip"|"ask", pace, worstWindow, windows[], reason }.
 */
export function hostPace(policy, host, usage, grade) {
  const hp = policy.hosts[host];
  const paceCfg = policy.pace ?? { use_at_or_above: 1, high_only_at_or_above: 0.6 };
  const provider = hp.usage?.provider ?? host;
  const wanted = hp.usage?.windows;
  if (!usage || !Array.isArray(usage.providers)) return { decision: "ask", reason: "usage unavailable (no --usage file)" };
  const entries = usage.providers.filter((p) => p.provider === provider);
  if (!entries.length) return { decision: "ask", reason: `usage unavailable: no ${provider} entry` };
  if (entries.length > 1) return { decision: "ask", reason: `usage ambiguous: ${entries.length} ${provider} instances` };
  const e = entries[0];
  if (e.status !== "ok") return { decision: "ask", reason: `usage ${e.status ?? "unknown"}${e.reason ? `: ${e.reason}` : ""}` };
  const all = Array.isArray(e.windows) ? e.windows : [];
  const windows = wanted?.length ? wanted.map((id) => all.find((w) => w.id === id) ?? { id, missing: true }) : all;
  if (!windows.length) return { decision: "ask", reason: "usage has no windows" };
  const observedAt = Date.parse(e.observedAt ?? usage.observedAt ?? "");
  const rows = windows.map((w) => {
    if (w.missing) return { id: w.id, computable: false, reason: "window missing from usage data" };
    if (w.pace?.computable === false) return { id: w.id, computable: false, reason: `pace not computable (${w.pace.reason ?? "no reason"})` };
    const rf = w.remainingFraction;
    const reset = Date.parse(w.resetsAt ?? "");
    const dur = Number(w.windowDurationSec) * 1000;
    if (typeof rf !== "number" || !Number.isFinite(reset) || !(dur > 0) || !Number.isFinite(observedAt))
      return { id: w.id, computable: false, reason: "missing remainingFraction/resetsAt/windowDurationSec/observedAt" };
    const rtf = (reset - observedAt) / dur;
    if (!(rtf > 0)) return { id: w.id, computable: false, reason: "window already reset at observation time (stale data)" };
    return { id: w.id, kind: w.kind, computable: true, remainingFraction: rf, remainingTimeFraction: Math.min(rtf, 1), pace: rf / Math.min(rtf, 1) };
  });
  const bad = rows.filter((r) => !r.computable);
  if (bad.length) return { decision: "ask", windows: rows, reason: bad.map((r) => `${r.id}: ${r.reason}`).join("; ") };
  const worst = rows.reduce((a, b) => (b.pace < a.pace ? b : a));
  const cost = hp.expected_cost ?? {};
  const over = rows.filter((r) => typeof cost[r.kind] === "number" && cost[r.kind] > r.remainingFraction);
  const base = { pace: worst.pace, worstWindow: worst.id, windows: rows };
  if (over.length) return { ...base, decision: "skip", reason: `expected cost exceeds remaining on ${over.map((r) => `${r.id} (${cost[r.kind]} > ${r.remainingFraction})`).join(", ")}` };
  if (worst.pace >= paceCfg.use_at_or_above) return { ...base, decision: "use", reason: `pace ${fmt(worst.pace)} >= ${paceCfg.use_at_or_above}` };
  if (worst.pace >= paceCfg.high_only_at_or_above)
    return grade === "high"
      ? { ...base, decision: "use", reason: `pace ${fmt(worst.pace)} in [${paceCfg.high_only_at_or_above}, ${paceCfg.use_at_or_above}) and grade is high` }
      : { ...base, decision: "skip", reason: `pace ${fmt(worst.pace)} in [${paceCfg.high_only_at_or_above}, ${paceCfg.use_at_or_above}): used only for high grade` };
  return { ...base, decision: "skip", reason: `pace ${fmt(worst.pace)} < ${paceCfg.high_only_at_or_above}` };
}
const fmt = (n) => (Number.isFinite(n) ? n.toFixed(2) : String(n));

// ---------------------------------------------------------------- selection
/**
 * plan({policy, author, dimensions, paths, usage, noUser}) ->
 *   { status: "ok"|"ask"|"blocked", grade, gradeReasons, required, selected[], hosts{}, questions[], reason }
 * The author host is never a reviewer; selected hosts are distinct; the runner never substitutes a host silently.
 */
export function plan({ policy, author, dimensions, paths, usage, noUser = false }) {
  if (!HOSTS.includes(author)) throw new Error(`--author must be one of ${HOSTS.join(", ")}`);
  const { grade, reasons, required } = gradeOf(policy, dimensions, paths);
  const order = (policy.host_order ?? Object.keys(policy.hosts)).filter((h) => policy.hosts[h]);
  const eligible = order.filter((h) => h !== author);
  const hosts = {};
  hosts[author] = { decision: "excluded", reason: "author host is never a reviewer" };
  for (const h of eligible) hosts[h] = hostPace(policy, h, usage, grade);
  const pin = (h) => ({ host: h, model: policy.hosts[h].model, effort: policy.hosts[h].effort_map[policy.review_effort] });
  const use = eligible.filter((h) => hosts[h].decision === "use");
  const ask = eligible.filter((h) => hosts[h].decision === "ask");
  const skip = eligible.filter((h) => hosts[h].decision === "skip");
  const selected = use.slice(0, required).map(pin);
  // One line per host that was not used because of pace or missing usage data (suppressed under --no-user).
  const questions = noUser ? [] : [
    ...ask.map((h) => `${h}: ${hosts[h].reason}; run ${h} as a reviewer anyway?`),
    ...skip.map((h) => `${h}: skipped (${hosts[h].reason}); run ${h} as a reviewer anyway?`),
  ];
  const base = { grade, gradeReasons: reasons, required, author, dimensions, hosts, selected };
  if (selected.length >= required) return { ...base, status: "ok", questions, reason: `${required} reviewer(s) selected` };

  const shortfall = required - selected.length;
  if (eligible.length < required)
    return { ...base, status: "blocked", questions, reason: `needs human decision: grade ${grade} needs ${required} reviewer host(s) other than ${author}, only ${eligible.length} configured` };
  if (noUser)
    return { ...base, status: "blocked", questions: [], reason: `needs human decision: ${shortfall} more reviewer(s) needed and --no-user set (${[...ask, ...skip].map((h) => `${h}=${hosts[h].decision}`).join(", ") || "no candidates"})` };
  if (ask.length + skip.length >= shortfall)
    return { ...base, status: "ask", questions, reason: `${shortfall} more reviewer(s) needed; answer the question(s) to continue` };
  return { ...base, status: "blocked", questions, reason: "needs human decision: not enough eligible reviewer hosts" };
}
