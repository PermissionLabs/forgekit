// Antigravity turn planning, shared by the adapter (actual turns) and plan (estimate), so both count the same
// way (A63): dimension groups (policy groups restricted to the run's dimensions, leftovers as one more group;
// a single group for a small re-review when rereview_single_group is on) x scope-file chunks (max files/bytes).

/** Turn groups for this run: the policy groups restricted to the run's dimensions, leftovers as one more group. */
export function groupsFor(dimensions, policyGroups) {
  const groups = (policyGroups ?? []).map((g) => g.filter((d) => dimensions.includes(d))).filter((g) => g.length);
  const seen = new Set(groups.flat());
  const rest = dimensions.filter((d) => !seen.has(d));
  if (rest.length) groups.push(rest);
  return groups.length ? groups : [dimensions];
}

export const REREVIEW_SINGLE_GROUP_MAX_DIFF_BYTES = 120_000;

/**
 * Groups for a run. Speed knob: a re-review (prior findings given) whose diff is at most
 * rereview_single_group_max_diff_bytes uses one group with every dimension per file chunk
 * (rereview_single_group, default true), which cuts the turns by the number of groups.
 */
export function runGroups(cfg, dimensions, { rereview = false, diffBytes = Infinity } = {}) {
  const single = rereview && cfg?.rereview_single_group !== false && diffBytes <= (cfg?.rereview_single_group_max_diff_bytes ?? REREVIEW_SINGLE_GROUP_MAX_DIFF_BYTES);
  return single ? [dimensions] : groupsFor(dimensions, cfg?.groups);
}

/**
 * Turns: each dimension group, split into chunks of scope files so no turn exceeds maxFiles / maxBytes
 * (a single file larger than maxBytes gets its own chunk). One chunk -> the turn lists no file restriction.
 */
export function planTurns(groups, scopeFiles, { maxFiles, maxBytes } = {}) {
  const chunks = [];
  let cur = [], bytes = 0;
  for (const f of scopeFiles) {
    if (cur.length && ((maxFiles && cur.length >= maxFiles) || (maxBytes && bytes + f.bytes > maxBytes))) { chunks.push(cur); cur = []; bytes = 0; }
    cur.push(f);
    bytes += f.bytes;
  }
  if (cur.length) chunks.push(cur);
  const split = chunks.length > 1;
  return groups.flatMap((dims) => (split ? chunks : [null]).map((files, ci) => ({ dims, files: files?.map((f) => f.path) ?? null, label: `group:${dims.join("+")}${split ? `:files${ci + 1}/${chunks.length}` : ""}` })));
}

/** Every turn of a run: runGroups x planTurns with the policy's per-turn file/byte limits. */
export function runTurns(cfg, dimensions, scopeFiles, opts = {}) {
  const groups = runGroups(cfg, dimensions, opts);
  return { groups, turns: planTurns(groups, scopeFiles, { maxFiles: cfg?.max_files_per_turn, maxBytes: cfg?.max_bytes_per_turn }) };
}

/**
 * Total time budget for a run of nTurns turns: per_turn_budget_sec x turns, at least min_total_sec (default
 * turn_timeout_sec, else 600 s; A63: a 1-3 turn run is never squeezed below one turn's timeout), capped by
 * max_total_sec; without per_turn_budget_sec the fixed timeout_sec (fallbackMs) applies.
 * -> { totalMs, perTurnSec, floorSec, capSec, capped }.
 */
export function totalBudget(cfg, nTurns, fallbackMs) {
  const per = cfg?.per_turn_budget_sec;
  if (!(per > 0)) return { totalMs: fallbackMs, perTurnSec: null, floorSec: null, capSec: null, capped: false };
  const cap = cfg.max_total_sec > 0 ? cfg.max_total_sec : Infinity;
  const floor = cfg.min_total_sec > 0 ? cfg.min_total_sec : cfg.turn_timeout_sec > 0 ? cfg.turn_timeout_sec : 600;
  const want = Math.max(per * Math.max(1, nTurns), floor);
  return { totalMs: Math.round(Math.min(want, cap) * 1000), perTurnSec: per, floorSec: floor, capSec: Number.isFinite(cap) ? cap : null, capped: want > cap };
}
