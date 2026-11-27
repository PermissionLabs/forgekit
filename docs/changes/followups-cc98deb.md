# Change: three low-severity follow-ups after cc98deb

## Intent

Close three follow-ups recorded on `main` at cc98deb:

1. A16/A17 (`docs/changes/antigravity-host-support.md` cycle 13): `scripts/bootstrap.sh` and
   `scripts/update-harness.sh` resolve the ForgeKit root with a plain `cd`, so an exported `CDPATH`
   and a relative invocation (`bash scripts/bootstrap.sh <target>`) make `cd` print the directory.
   The root then has two lines, and the writers fail closed with `templates/ not found`.
2. r8 (operator) residual (`docs/changes/cross-review-runner.md`): `redact`'s
   `https://accounts.google.com/\S+` rule runs past the end of a JSON string, so a redacted line of
   `raw/antigravity-messages.jsonl` no longer parses.
3. Antigravity prompt budget: in an oti-root re-review of the cc98deb pin (cycle 2,
   2026-11-27), Antigravity reported that its prompt checklist was cut at 134,525 bytes, before the
   verbatim `EARLIER FINDINGS` and `AUTHOR DISPOSITIONS` blocks. It verified the priors from the
   brief and change records instead.

## Change

- **CDPATH.** The ForgeKit root is resolved with `CDPATH='' cd -- "$(dirname -- "$0")/.."` in
  `bootstrap.sh`, `update-harness.sh`, `check-harness-sync.sh` and `worktree-add.sh`. This is the
  same `CDPATH=''` pattern `resolve_target_root` already uses. The last two had the same plain
  `cd`; `check-harness-sync.sh` failed the same way and `worktree-add.sh` passed a two-line repo root
  to `git -C`. The three test scripts get the same line so they also run with an exported `CDPATH`.
  Case 17c-5 in `scripts/test-check-harness-sync.sh` runs every script from a relative path with
  `CDPATH=.` exported.
- **redact.** The sign-in URL rule (`AUTH_URL` in `modules/cross-review/lib/inputs.mjs`) matches
  characters other than whitespace, `"` and `\`, plus whole `\uXXXX` and `\/` escapes. It therefore
  stops at the end of a JSON string (or before `\"`, `\n`, `\\`), and a Go-style `&` (`&`)
  inside the URL does not leave the rest of the query behind. Plain-text logs are redacted as before
  (up to whitespace).
- **Prompt order and budget** (`buildPrompt`, shared by all three hosts through `run.mjs`
  `promptFor`):
  - Order is now rules, schema, brief, `EARLIER FINDINGS`, `AUTHOR DISPOSITIONS`, checklist, diff
    (the checklist used to come before the prior blocks). If a host cuts a long text, it cuts the
    checklist.
  - New policy key `hosts.<h>.max_prompt_text_bytes`: null or an integer ≥ 4096. Antigravity uses
    120000, below the measured 134,525-byte cut. Claude and Codex leave it unset because no limit
    was observed; the key works for them too.
  - Over the budget, only the checklist is truncated, at a UTF-8 character boundary. A
    `CHECKLIST (TRUNCATED …: the first N of M bytes …)` header and an end marker point the reviewer
    at the full copy in `__review__/checklist.md`. The run records a warning and
    `evidence.prompt.budget`.
  - When the parts that are never cut (rules, brief, earlier findings, dispositions, and for
    Claude/Codex the diff) exceed the budget, `PromptBudgetError` makes the run `incomplete`. The
    reason is `prompt_over_budget` with each part's size. No host is started.
  - Antigravity (`promptBudget = "per_turn"`) applies the budget to each turn's first text block,
    turn rule included (`reserveBytes`). It checks every planned turn before the server starts and
    records `{ maxBytes, turns[] }`.
  - The ACP stub (`test/fixtures/fake-agy.mjs`) gets two knobs: `cutTextAt` (the runtime cut) and
    `priorAware` (verifies the priors only when both prior blocks arrive whole).
- Docs: `modules/cross-review/README.md` (prompt order and budget, redaction), residual rows in
  `docs/changes/cross-review-runner.md` and `docs/changes/antigravity-host-support.md`.

## Out of scope

- The Antigravity diff resource block and file-list block are not budgeted. The cut was observed
  only on the first text block.
- Multi-turn prior verification through the ACP stub (residual A46 part) stays open. `priorAware`
  covers the single 1.5 turn only.

## Verification

- `bash scripts/test-modules.sh` (CI's job): see the Review Cycles section for the final run.
- Regression tests, each failing on `main` and under its mutation:
  - Case 17c-5 (`bootstrap`, `update-harness`, `check-harness-sync`, `worktree-add` with
    `CDPATH=.`). Reverting the root line in each script fails its own case (exit 1, 1, 2 and 128).
  - `adapters.test.mjs` "redact … (r8)". It fails on the old `\S+` rule, which breaks the JSON. It
    also fails on a rule that only stops at `"`/`\` without consuming escapes, because the query
    after `&` leaks.
  - `run.test.mjs` "buildPrompt … (r8)": fails with the old order and with the budget ignored.
  - `run.test.mjs` "max_prompt_text_bytes applies to the Claude/Codex prompt too": fails with the
    budget ignored, or when `run.mjs` does not pass it for Claude/Codex.
  - `antigravity.test.mjs` "r8: a large checklist is truncated …": a 1.5 re-review with a ~200 KB
    checklist and the stub cutting text at 134,525 bytes ends complete with both priors verified.
    Without the budget the same run is incomplete. Fails with the budget ignored.
  - `antigravity.test.mjs` "r8: … exceed the budget …": incomplete with `prompt_over_budget`, no
    attempts, no argv. Fails with the budget ignored or the pre-spawn check removed (the server
    starts).
  - `run.test.mjs` "policy: max_prompt_text_bytes …".

## Review Cycles

| Cycle | Type | Findings | Resolution |
| --- | --- | --- | --- |
| 1 | Cross-review (Codex + Antigravity, full diff `origin/main..HEAD`) | pending | pending |

## Branch & Merge Evidence

- Working branch: `agent/followups-cc98deb`
- Target branch: `main`
- PR URL: TBD (filled on PR creation)

## Residuals

| Source | Finding | Disposition | Link/reason |
| --- | --- | --- | --- |
| Design | 120000 bytes is one measurement below one observed cut (134,525 bytes, runtime 1.5.18); the runtime's real limit and unit are undocumented | `accepted_with_reason` | Over the budget only the checklist is cut, and the reviewer is told where the full copy is; a smaller real limit would still cut the checklist first (the prior blocks come before it) |
