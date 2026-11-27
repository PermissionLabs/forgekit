// `plan`: review grade, reviewer selection and pace. Only planForInstallation reads local runtime metadata.
// Usage data is whatever the caller saved from the T3 MCP tool `provider_usage_limits`.
import { findRuntime, installationRoots } from "../adapters/antigravity.mjs";
import { HOSTS } from "./policy.mjs";
import { parseDiffPaths } from "./diff.mjs";
import { groupsFor, layoutConfig, runTurns, totalBudget } from "./turns.mjs";

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
  return parseDiffPaths(text).paths;
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
  const matched = reasons.filter((r) => r.startsWith("path:")).length;
  if (paths.length) reasons.push(`paths: ${matched} of ${paths.length} matched a high glob, ${paths.length - matched} unmatched`);
  const grade = reasons.some((r) => !r.startsWith("paths: ")) ? "high" : "standard";
  const required = (g.reviewers ?? { standard: 1, high: 2 })[grade];
  return { grade, reasons, required };
}

// ---------------------------------------------------------------- pace
/**
 * Per-host pace from a provider_usage_limits payload.
 * Returns { decision: "use"|"skip"|"ask", pace, worstWindow, windows[], reason }.
 * Expected cost (hosts.<h>.expected_cost, keyed by window kind, e.g. "session" for a 5 h window and "weekly")
 * is compared with every window's remaining fraction. A window that resets within pace.reset_soon_minutes is
 * not paced (rf / tiny remaining time would blow up): it only has to cover the expected cost.
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
    if (typeof rf !== "number" || !Number.isFinite(rf) || rf < 0 || rf > 1)
      return { id: w.id, computable: false, reason: `remainingFraction not a number in [0, 1] (${rf})` };
    if (!Number.isFinite(reset) || !(dur > 0) || !Number.isFinite(observedAt))
      return { id: w.id, computable: false, reason: "missing resetsAt/windowDurationSec/observedAt" };
    const rtf = (reset - observedAt) / dur;
    if (!(rtf > 0)) return { id: w.id, computable: false, reason: "window already reset at observation time (stale data)" };
    const resetsInMin = Math.round((reset - observedAt) / 60000);
    if (typeof paceCfg.reset_soon_minutes === "number" && resetsInMin <= paceCfg.reset_soon_minutes)
      return { id: w.id, kind: w.kind, computable: true, resetSoon: true, resetsInMin, remainingFraction: rf, remainingTimeFraction: Math.min(rtf, 1), pace: null };
    return { id: w.id, kind: w.kind, computable: true, resetsInMin, remainingFraction: rf, remainingTimeFraction: Math.min(rtf, 1), pace: rf / Math.min(rtf, 1) };
  });
  const bad = rows.filter((r) => !r.computable);
  if (bad.length) return { decision: "ask", windows: rows, reason: bad.map((r) => `${r.id}: ${r.reason}`).join("; ") };
  const cost = hp.expected_cost ?? {};
  const over = rows.filter((r) => typeof cost[r.kind] === "number" && cost[r.kind] > r.remainingFraction);
  const paced = rows.filter((r) => r.pace !== null);
  const soonNote = rows.filter((r) => r.resetSoon).map((r) => `${r.id} resets in ${r.resetsInMin} min (not paced)`).join("; ");
  const overText = (list) => list.map((r) => `${r.id} (${cost[r.kind]} > ${r.remainingFraction})`).join(", ");
  // Every window is evaluated before deciding: skip (any window) beats ask (a window that resets soon).
  const hardOver = over.filter((r) => !r.resetSoon);
  if (hardOver.length) return { decision: "skip", pace: paced.length ? Math.min(...paced.map((r) => r.pace)) : null, worstWindow: null, windows: rows, reason: `expected cost exceeds remaining on ${overText(hardOver)}` };
  let paceVerdict = null;
  if (paced.length) {
    const worst = paced.reduce((a, b) => (b.pace < a.pace ? b : a));
    const base = { pace: worst.pace, worstWindow: worst.id, windows: rows, ...(soonNote ? { note: soonNote } : {}) };
    if (worst.pace >= paceCfg.use_at_or_above) paceVerdict = { ...base, decision: "use", reason: `pace ${fmt(worst.pace)} >= ${paceCfg.use_at_or_above}` };
    else if (worst.pace >= paceCfg.high_only_at_or_above)
      paceVerdict = grade === "high"
        ? { ...base, decision: "use", reason: `pace ${fmt(worst.pace)} in [${paceCfg.high_only_at_or_above}, ${paceCfg.use_at_or_above}) and grade is high` }
        : { ...base, decision: "skip", reason: `pace ${fmt(worst.pace)} in [${paceCfg.high_only_at_or_above}, ${paceCfg.use_at_or_above}): used only for high grade` };
    else paceVerdict = { ...base, decision: "skip", reason: `pace ${fmt(worst.pace)} < ${paceCfg.high_only_at_or_above}` };
  }
  if (paceVerdict?.decision === "skip") return over.length ? { ...paceVerdict, reason: `${paceVerdict.reason}; also expected cost exceeds remaining on ${overText(over)} (resets soon)` } : paceVerdict;
  // Cost over a window that resets soon (and no other window fails): waiting is an option, so a human decides.
  if (over.length) return { decision: "ask", pace: paceVerdict?.pace ?? null, worstWindow: paceVerdict?.worstWindow ?? null, windows: rows, reason: `expected cost exceeds remaining on ${overText(over)}, but it resets soon (${soonNote}); wait or run anyway?` };
  if (!paceVerdict) return { decision: "use", pace: null, worstWindow: null, windows: rows, reason: `every window resets soon and covers the expected cost (${soonNote})` };
  return paceVerdict;
}
const fmt = (n) => (Number.isFinite(n) ? n.toFixed(2) : String(n));

// ---------------------------------------------------------------- antigravity budget
/**
 * Estimated Antigravity turns and budget, counted by the adapter's own helper (lib/turns.mjs, A63): groups
 * (including the leftover group, or a single group for a small re-review) x file chunks by max_files_per_turn
 * and, when file sizes are known ({ path, bytes } entries), max_bytes_per_turn. A bare count of paths gives a
 * lower bound (sizes unknown). warning is set when the estimate exceeds max_total_sec. layout is the runtime
 * layout the run will use ("cli" for 1.5, the default: one turn; "par" for <= 1.4: par_layout split).
 */
export function antigravityBudget(policyHost, dimensions, files, { rereview = false, diffBytes = Infinity, layout = "cli" } = {}) {
  const hp = layoutConfig(policyHost, layout);
  const list = typeof files === "number" ? Array.from({ length: files }, (_, i) => ({ path: `f${i}`, bytes: 0 })) : files.map((f) => (typeof f === "string" ? { path: f, bytes: 0 } : f));
  const sizesKnown = typeof files !== "number" && list.some((f) => f.bytes > 0);
  const { groups, turns: t } = runTurns(hp, dimensions, list, { rereview, diffBytes });
  const turns = t.length;
  const base = { estimatedTurns: turns, groups: groups.length, sizesKnown, layout, ...(groups.length === 1 && groupsFor(dimensions, hp?.groups).length > 1 ? { singleGroup: "re-review with a small diff (rereview_single_group)" } : {}) };
  const per = hp.per_turn_budget_sec;
  if (!(per > 0)) return { ...base, totalSec: hp.timeout_sec ?? null, note: "fixed timeout_sec (no per_turn_budget_sec)" };
  const tb = totalBudget(hp, turns, null);
  const b = { ...base, perTurnSec: per, floorSec: tb.floorSec, capSec: tb.capSec, totalSec: tb.totalMs / 1000 };
  if (tb.capped) b.warning = `antigravity: about ${turns} turns x ${per} s = ${per * turns} s exceeds max_total_sec ${tb.capSec} s; later turns may not run (split the review or raise the cap)`;
  return b;
}

/** Estimate with the same installed runtime and profile selection used when starting a review. */
export function planForInstallation(options, home) {
  let antigravityLayout = "cli";
  try {
    const roots = installationRoots(options.policy.hosts.antigravity?.runtime ?? {}, home);
    antigravityLayout = findRuntime(roots.runtime).layout ?? "cli";
  } catch {
    // Planning remains available on machines without a readable local runtime.
  }
  return plan({ ...options, antigravityLayout });
}

// ---------------------------------------------------------------- selection
/**
 * plan({policy, author, dimensions, paths, usage, noUser, files?, rereview?, diffBytes?, antigravityLayout?}) ->
 *   { status: "ok"|"ask"|"blocked", grade, gradeReasons, required, selected[], hosts{}, questions[], reason }
 * The author host is never a reviewer; selected hosts are distinct; the runner never substitutes a host silently.
 */
export function plan({ policy, author, dimensions, paths, usage, noUser = false, files = null, rereview = false, diffBytes = Infinity, antigravityLayout = "cli" }) {
  if (!HOSTS.includes(author)) throw new Error(`--author must be one of ${HOSTS.join(", ")}`);
  const { grade, reasons, required } = gradeOf(policy, dimensions, paths);
  const order = [...new Set(policy.host_order ?? Object.keys(policy.hosts))].filter((h) => policy.hosts[h]);
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
  const warnings = [];
  // A65: no budget (and no warning) when antigravity is the author, i.e. never a reviewer in this plan.
  if (hosts.antigravity && hosts.antigravity.decision !== "excluded" && policy.hosts.antigravity) {
    hosts.antigravity.budget = antigravityBudget(policy.hosts.antigravity, dimensions, files ?? paths.length, { rereview, diffBytes, layout: antigravityLayout });
    if (hosts.antigravity.budget.warning) warnings.push(hosts.antigravity.budget.warning);
  }
  const base = { grade, gradeReasons: reasons, required, author, dimensions, hosts, selected, warnings };
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
