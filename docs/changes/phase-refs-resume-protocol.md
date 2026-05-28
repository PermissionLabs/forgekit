# Change: Phase refs resume protocol

## Intent

Reduce long-session drift where agents forget phase-specific guidance, especially
review skill documents, after extended work or context compaction.

Success criteria:

- New workflow states point agents to phase-specific documents without embedding
  long checklist text.
- Agents read phase references on task start, resume, phase transition, and
  gate entry, not every chat turn.
- Review entry clearly reloads `docs/review-skills/README.md` plus applicable
  focused review skills.

## Scope

- In scope: workflow-state examples, worktree state seed, agent/workflow docs,
  and a short README note.
- Out of scope: CLI automation, mandatory host plugins, or runtime enforcement.

## Current State

ForgeKit already requires `.context/workflow-state.json` for non-trivial tasks,
but the state file does not tell an agent which phase-specific documents to
reload. Review guidance exists in `docs/review-skills/`, but long sessions can
lose that context unless the agent manually reopens the files.

## Plan

- [x] Plan
- [x] Implement
- [x] Review
- [ ] Human QA
- [ ] Merge
- [ ] Post-merge
- [ ] Compound capture

## Tracks

| Track | Status | Changed paths | Verification | Risks |
| --- | --- | --- | --- | --- |
| Shared contracts | Completed | `templates/.context/*.json`, `scripts/worktree-add.sh` | JSON validation and seed check passed | Existing worktrees can retain stale `phase_refs` if harness refs change later |
| Docs | Completed | `README.md`, `docs/AGENT_GUIDE.md`, `docs/WORKFLOW.md`, template docs | `git diff --check`; manual root/template parity check | Agents still need to honor the protocol |

## Implementation Notes

Added two state fields:

- `resume_protocol`: when to reread `.context/workflow-state.json`.
- `phase_refs`: compact paths to load when entering a phase.

The compact seed uses string paths only. The expanded example shows optional
`path` and `reason` objects for teams that want more detail.

Tradeoff: `phase_refs` is static routing metadata copied into each gitignored
worktree state file. That makes the current phase self-rehydrating, but existing
worktrees will not automatically receive later review-skill additions or path
renames. Agents should treat stale refs as a resume aid, not as a replacement
for the tracked workflow and review-skill docs.

## Documentation Updates

- Updated docs: `README.md`, `docs/AGENT_GUIDE.md`, `docs/WORKFLOW.md`, and the
  downstream templates for guide/workflow.
- No additional product docs needed because this is a harness contract change.

## Verification

- Commands run:
  - `jq . templates/.context/workflow-state.compact.example.json`
  - `jq . templates/.context/workflow-state.example.json`
  - `jq . .context/workflow-state.json`
  - `bash -n scripts/worktree-add.sh`
  - `git diff --check`
  - `scripts/check-harness-sync.sh --forgekit`
  - `scripts/worktree-add.sh /private/tmp/forgekit-seed-check -b codex/seed-check-phase-refs origin/main`
  - `jq . .context/workflow-state.json` in the generated seed-check worktree
- Manual checks:
  - Confirmed the generated state contains `resume_protocol` and `phase_refs`.
  - Confirmed compact example size is 2,417 bytes after the added refs.
  - Manually compared the new root docs changes with the matching
    `templates/docs/` changes.
- Not run:
  - Full downstream sync check against ForgeKit root is not applicable; that
    mode treats ForgeKit itself as a bootstrapped product repo and reports
    existing root/template differences plus missing downstream template files.
  - `scripts/check-harness-sync.sh --forgekit` was run, but it only verifies
    root entrypoint parity and does not cover the root docs or script changes
    made in this PR.

## Review Cycles

| Cycle | Type | Findings | Resolution |
| --- | --- | --- | --- |
| 1 | Code + security | 0 findings | Clean; reviewed script-generated JSON, path handling, and doc contract scope |
| 2 | Code + security | Change note review and verification state was stale | Fixed in this document |
| 3 | Claude review | Static `phase_refs` may become stale in existing worktrees; `--forgekit` validation scope was overstated | Documented staleness tradeoff and narrowed validation claim; captured sync-check gap in `docs/HARNESS_NOTES.md` |

## Human QA

- Handoff URL/build/instructions: Read the changed docs and generated state
  shape; no runtime app exists.
- Human-reported issues: Pending
- Fixes applied: Pending
- Accepted by human: Pending

## Branch & Merge Evidence

- Working branch: `codex/phase-refs`
- Target branch: `main`
- PR URL: https://github.com/PermissionLabs/forgekit/pull/13

Required before marking `merge` / `post_merge` complete:

- Human review accepted by: TBD
- Human QA accepted by: TBD
- Merge SHA (or merged PR link): TBD
- Post-merge sync command + result: TBD
- Residual risks acknowledged: TBD

## Residuals

| Source | Finding | Disposition | Link/reason |
| --- | --- | --- | --- |
| code-review | Stale review/verification status in this change note | fixed | Updated plan, tracks, and review cycle rows |
| Claude review | Static `phase_refs` copied into gitignored worktree state can become stale | accepted_with_reason | Accepted for v0.1 as a compact resume aid; documented tradeoff and source-of-truth limitation |
| Claude review | `scripts/check-harness-sync.sh --forgekit` does not verify changed root docs/scripts | fixed | Narrowed validation language and recorded tool gap in `docs/HARNESS_NOTES.md` |

## Compound Capture

- Reusable learning captured: Not yet
- Solution doc: TBD
- Skipped because: TBD

## Follow-ups

- Consider a future helper command that prints the current phase refs from
  `.context/workflow-state.json`.
