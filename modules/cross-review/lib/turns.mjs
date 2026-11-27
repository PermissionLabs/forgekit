// Antigravity turn planning, shared by the adapter (actual turns) and plan (estimate), so both count the same
// way (A63): dimension groups (policy groups restricted to the run's dimensions, leftovers as one more group;
// a single group for a small re-review when rereview_single_group is on) x scope-file chunks (max files/bytes).
//
// Runtime layouts (r7, measured on 1.5.18 on 2026-11-27): the 1.5 "cli" runtime has no first-byte wall (longest
// silent gap 20 s, a single 495 s turn succeeded) and one turn for every dimension was faster and used about 3.5x
// fewer tokens than the per-group split, so the policy's top-level values run ONE turn (no groups) and split
// only a scope above 32 files / 400 KB. The <= 1.4 "par" runtime's local proxy aborts a model call whose first
// byte takes > 300 s, so it keeps the old per-group, 8-file / 120 KB split: layoutConfig puts the policy's
// par_layout (defaults PAR_LAYOUT_DEFAULTS) over the top-level values for that layout.

/** Code defaults for keys the policy leaves out (runtime 1.5 "cli"). */
export const TURN_DEFAULTS = Object.freeze({ max_files_per_turn: 32, max_bytes_per_turn: 400_000, turn_timeout_sec: 1200, retry_timeout_sec: 600 });

/** The <= 1.4 "par" runtime's split (300 s proxy first-byte wall); policy par_layout keys override these. */
export const PAR_LAYOUT_DEFAULTS = Object.freeze({
  groups: [["security"], ["correctness"], ["tests", "contract_docs"]],
  max_files_per_turn: 8,
  max_bytes_per_turn: 120_000,
  per_turn_budget_sec: 180,
  min_total_sec: 600,
  turn_timeout_sec: 600,
  retry_timeout_sec: 280,
});

/** Host config for a runtime layout: the top-level values ("cli"), or for "par" PAR_LAYOUT_DEFAULTS and the policy's par_layout on top. */
export function layoutConfig(cfg, layout) {
  if (layout !== "par") return cfg ?? {};
  return { ...(cfg ?? {}), ...PAR_LAYOUT_DEFAULTS, ...(cfg?.par_layout ?? {}) };
}

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

/** Every turn of a run: runGroups x planTurns with the policy's per-turn file/byte limits (TURN_DEFAULTS when absent). */
export function runTurns(cfg, dimensions, scopeFiles, opts = {}) {
  const groups = runGroups(cfg, dimensions, opts);
  const maxFiles = cfg?.max_files_per_turn ?? TURN_DEFAULTS.max_files_per_turn;
  const maxBytes = cfg?.max_bytes_per_turn ?? TURN_DEFAULTS.max_bytes_per_turn;
  return { groups, turns: planTurns(groups, scopeFiles, { maxFiles, maxBytes }) };
}

/**
 * Total time budget for a run of nTurns turns: per_turn_budget_sec x turns, at least min_total_sec (default
 * turn_timeout_sec, else TURN_DEFAULTS.turn_timeout_sec; A63: a 1-3 turn run is never squeezed below one turn's timeout), capped by
 * max_total_sec; without per_turn_budget_sec the fixed timeout_sec (fallbackMs) applies.
 * -> { totalMs, perTurnSec, floorSec, capSec, capped }.
 */
export function totalBudget(cfg, nTurns, fallbackMs) {
  const per = cfg?.per_turn_budget_sec;
  if (!(per > 0)) return { totalMs: fallbackMs, perTurnSec: null, floorSec: null, capSec: null, capped: false };
  const cap = cfg.max_total_sec > 0 ? cfg.max_total_sec : Infinity;
  const floor = cfg.min_total_sec > 0 ? cfg.min_total_sec : cfg.turn_timeout_sec > 0 ? cfg.turn_timeout_sec : TURN_DEFAULTS.turn_timeout_sec;
  const want = Math.max(per * Math.max(1, nTurns), floor);
  return { totalMs: Math.round(Math.min(want, cap) * 1000), perTurnSec: per, floorSec: floor, capSec: Number.isFinite(cap) ? cap : null, capped: want > cap };
}
