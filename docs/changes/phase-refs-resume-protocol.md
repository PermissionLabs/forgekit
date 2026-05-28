# Change: Phase refs resume protocol

## Intent

Reduce long-session drift where agents forget phase-specific guidance, especially
review skill documents, after extended work or context compaction.

Success criteria:

- New workflow states point agents to a tracked phase refs source without
  embedding long checklist text or static routing tables.
- Agents read phase references on task start, resume, phase transition, and
  gate entry, not every chat turn.
- Review entry clearly reloads `docs/review-skills/README.md` plus applicable
  focused review skills.

## Scope

- In scope: tracked phase refs, workflow-state examples, worktree state seed,
  agent/workflow docs, bootstrap/sync docs, and a short README note.
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
| Shared contracts | Completed | `docs/PHASE_REFS.json`, `templates/docs/PHASE_REFS.json`, `templates/.context/*.json`, `scripts/worktree-add.sh`, `scripts/bootstrap.sh` | JSON validation and seed check passed | Agents still need to honor the protocol |
| Docs | Completed | `README.md`, `docs/AGENT_GUIDE.md`, `docs/WORKFLOW.md`, `docs/BOOTSTRAP.md`, `docs/PROJECT_CONTEXT.md`, template docs | `git diff --check`; sync check for tracked phase refs | Enforcement remains future automation |
| Sync tooling | Completed | `scripts/check-harness-sync.sh` | `--forgekit` parity check and syntax checks passed | Broader root/template parity remains a follow-up |

## Implementation Notes

Added a tracked phase refs file and a compact state pointer:

- `resume_protocol`: when to reread `.context/workflow-state.json`.
- `resume_protocol.phase_refs_source`: where to find the tracked phase routing
  table.
- `docs/PHASE_REFS.json`: required and conditional refs to load on phase entry.
  It also defines each conditional key so agents apply the same triggers.

The compact state no longer embeds the static routing table. It only carries the
current phase and the tracked source path. This keeps repeated state reads small
while preserving a single tracked source of truth for review/design/QA routing.

Tradeoff: this is still a contract and nudge, not runtime enforcement. It makes
the phase-entry reload path more explicit and easier to automate later, but an
agent must still read the state file and phase refs source unless a future hook
or command injects them.

## Documentation Updates

- Updated docs: `README.md`, `docs/AGENT_GUIDE.md`, `docs/WORKFLOW.md`,
  `docs/BOOTSTRAP.md`, `docs/PROJECT_CONTEXT.md`, `docs/PHASE_REFS.json`, and
  downstream templates.
- No additional product docs needed because this is a harness contract change.

## Verification

- Commands run:
  - `jq . templates/.context/workflow-state.compact.example.json`
  - `jq . templates/.context/workflow-state.example.json`
  - `jq . docs/PHASE_REFS.json`
  - `jq . templates/docs/PHASE_REFS.json`
  - `jq . .context/workflow-state.json`
  - Override regex smoke checks for anchored JSON keys and prose false-positive
    cases
  - `bash -n scripts/worktree-add.sh`
  - `bash -n scripts/bootstrap.sh`
  - `bash -n scripts/check-harness-sync.sh`
  - `git diff --check`
  - `scripts/check-harness-sync.sh --forgekit`
  - `scripts/worktree-add.sh /private/tmp/forgekit-seed-check -b codex/seed-check-phase-refs origin/main`
  - `jq . .context/workflow-state.json` in the generated seed-check worktree
- Manual checks:
  - Confirmed the generated state contains `resume_protocol.phase_refs_source`
    and does not embed the static phase refs table.
  - Confirmed compact example size is reduced after moving refs to
    `docs/PHASE_REFS.json`.
  - Manually compared the new root docs changes with the matching
    `templates/docs/` changes.
- Not run:
  - Full downstream sync check against ForgeKit root is not applicable; that
    mode treats ForgeKit itself as a bootstrapped product repo and reports
    existing root/template differences plus missing downstream template files.
  - `scripts/check-harness-sync.sh --forgekit` was run, but it verifies only
    root entrypoint parity plus `docs/PHASE_REFS.json`; it still does not cover
    the root docs or script changes made in this PR.

## Review Cycles

| Cycle | Type | Findings | Resolution |
| --- | --- | --- | --- |
| 1 | Code + security | 0 findings | Clean; reviewed script-generated JSON, path handling, and doc contract scope |
| 2 | Code + security | Change note review and verification state was stale | Fixed in this document |
| 3 | Claude review | Static `phase_refs` may become stale in existing worktrees; `--forgekit` validation scope was overstated | Moved routing table to tracked `docs/PHASE_REFS.json`; narrowed validation claim and captured remaining sync-check gap |
| 4 | Design revision | Static routing table in runtime state increased token cost and was only a nudge | Moved routing table to tracked `docs/PHASE_REFS.json`; state now stores only `phase_refs_source` |
| 5 | Code review | JSON harness files could not use the existing comment-based `forgekit-override` marker | Added JSON key marker support to `scripts/check-harness-sync.sh` and documented it in `docs/BOOTSTRAP.md` |
| 6 | Code review | `scripts/bootstrap.sh` conflict check did not include new tracked `docs/PHASE_REFS.json` | Added `docs/PHASE_REFS.json` to the conflict list |
| 7 | Claude review | JSON override regex matched prose containing `"forgekit-override":`; conditional keys were undefined | Anchored JSON key matching to line start; added condition definitions to `docs/PHASE_REFS.json` |

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
| Claude review | Static `phase_refs` copied into gitignored worktree state can become stale | fixed | Moved routing table to tracked `docs/PHASE_REFS.json`; state stores only the source path |
| Claude review | `scripts/check-harness-sync.sh --forgekit` did not verify changed root docs/scripts | fixed | Added exact `docs/PHASE_REFS.json` parity check, narrowed validation language, and recorded remaining tool gap in `docs/HARNESS_NOTES.md` |
| design review | Runtime state grew with static route metadata despite token-saving goal | fixed | Removed embedded route table from state examples and seed script |
| code-review | JSON harness files need an override path for intentional downstream drift | fixed | Added support for a top-level `"forgekit-override"` key |
| code-review | Bootstrap could overwrite an existing downstream `docs/PHASE_REFS.json` without `--force` | fixed | Added the file to `scripts/bootstrap.sh` conflict detection |
| Claude review | JSON override regex could false-positive on prose mentions | fixed | Anchored JSON key matching to line start with optional whitespace |
| Claude review | Conditional phase ref keys lacked trigger definitions | fixed | Added `conditions` definitions to `docs/PHASE_REFS.json` and template copy |

## Compound Capture

- Reusable learning captured: Not yet
- Solution doc: TBD
- Skipped because: TBD

## Follow-ups

- Consider a future helper command that prints the current phase refs from
  `docs/PHASE_REFS.json` for the phase in `.context/workflow-state.json`.
- Consider a future hook or slash command that injects current phase refs on
  phase transition.
