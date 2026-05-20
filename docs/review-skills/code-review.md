# Code Review

Run on any production-facing code change. Inputs: the diff plus enough
surrounding context to reason about callers, callees, and shared state.

## Check

**Logic**
- Does each new branch handle the cases it claims to?
- Are loop / recursion termination conditions correct?
- Are error paths reachable in practice (and tested)?

**Edge cases**
- Empty inputs, single-element inputs, off-by-one boundaries.
- Concurrent callers, retried callers, partial-failure callers.
- Null / undefined / missing fields from upstream sources.

**Error handling**
- Errors surfaced or swallowed deliberately (with a reason)?
- Resource cleanup on the error path (file handles, DB connections, locks)?
- User-visible error messages do not leak sensitive detail?

**Naming and structure**
- Names match what the thing does *now*, not what it once did.
- New abstractions earn their weight (≥3 real call sites or a forced boundary).
- No half-finished implementations or commented-out code left behind.

**Tests / verification**
- Behavior change is covered by a test, an explicit manual check, or a
  recorded "not tested because…" reason.
- Tests exercise the change, not the framework.

**Surrounding hygiene**
- Diff does not include accidental unrelated edits.
- Generated files / lockfiles changed only when intended.
- Imports and dead code cleaned up if the change touched them.

## Output

For each finding, record in the change record under "Review Cycles":

- file:line (or feature name if cross-cutting)
- the issue, in one sentence
- disposition: `fixed`, `filed_followup`, `accepted_with_reason`, `blocked`
- link to the follow-up issue or commit if applicable

A clean review (no findings) is a valid result. Record the cycle anyway.
