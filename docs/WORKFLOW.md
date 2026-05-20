# ForgeKit Workflow

ForgeKit is a human-led, agent-assisted workflow. Agents help plan, implement,
review, verify, and document focused changes. Humans keep control of product
direction, scope, QA acceptance, and merge decisions.

## Phases

Every production-level change should move through these phases.

| Phase | Required | Purpose |
| --- | --- | --- |
| `plan` | Yes for broad or risky work | Clarify intent, scope, tracks, affected docs, risks, and verification before editing. |
| `implement` | Yes | Make the smallest focused change that satisfies the approved scope. |
| `review` | Yes before merge | Run code/security/design/ops reviews as appropriate and surface actionable findings. |
| `human_qa` | Yes when humans can run or inspect the product | Let the human test the app, server, deploy preview, or workflow and report issues. |
| `merge` | Human-owned | Merge only after the human accepts the review and QA state. |
| `post_merge` | When applicable | Sync the workspace, update release notes or follow-ups, and validate deployed state. |
| `compound_capture` | When reusable learning exists | Capture solved problems, repeated mistakes, or useful patterns in durable docs. |

Phase statuses are:

```text
pending
in_progress
blocked
completed
skipped
```

`skipped` must include a short reason. Review should not be skipped for
production-facing work.

## Full-Stack Delivery Loop

Many product changes span server, deployment, frontend, app, and docs in one
PR. Treat those as tracks inside the same workflow instead of separate hidden
tasks.

Common tracks:

- `server`
- `deploy`
- `frontend`
- `app`
- `shared_contracts`
- `docs`

Each active track should have a status, owner, changed paths, verification, and
open risks. The task is not ready for merge until every required track is either
completed or explicitly skipped with a reason.

The middle of the workflow is iterative:

```text
implement -> automated_checks -> review -> fix -> human_qa -> fix -> review
```

Run as many cycles as needed in one session. Record each review and QA cycle so
findings do not live only in chat.

## Review and QA Gates

For production-facing work, run the `code-review` and `security-review` skills
(see `docs/review-skills/`) unless the change is clearly documentation-only or
mechanical. Add focused reviews from the same directory when the diff warrants
them — `api-contract-review` for public API surface changes,
`data-migration-review` for schema/backfill/destructive-data work,
`deployment-review` for rollout/infra/env changes. The skill files define the
checklist; the host (Claude Code, Codex CLI, etc.) chooses how to invoke them
(subagent, slash command, prompt). `docs/review-skills/README.md` lists
non-binding invocation hints.

Findings from every cycle must end up in the change record's "Review Cycles"
table with a disposition — see the disposition vocabulary in *Residual
findings* below. A clean review with zero findings is valid, but the cycle
still gets recorded.

Human QA is a first-class gate when the human can run or inspect the product.
The agent should hand off a testable build, local URL, preview URL, app flow, or
server health check instructions. Human-reported issues become fix-loop items
and must be resolved, filed, accepted, or blocked before merge.

Residual findings must end in one of these states:

- `fixed`
- `filed_followup`
- `accepted_with_reason`
- `blocked`

Do not let review or QA findings disappear into the conversation.

## Progress State

Runtime progress belongs in `.context/workflow-state.json` or another
gitignored `.context/` file. This state helps agents avoid losing phase context
across long sessions, but it is not the team memory.

For every non-trivial task, agents should read or create the workflow-state file
before implementation, update it whenever phase, track, review, QA, or residual
status changes, and check it before the final response. If the state file is not
used for a non-trivial task, state why.

Use a compact runtime state file by default. Keep `.context/workflow-state.json`
small enough to scan quickly: phase, active tracks, review/QA cycle status,
residual counts, links to docs, and short notes. Put detailed plans, findings,
screenshots, logs, and reasoning in the shared docs.

The shared record for the work belongs in `docs/changes/*.md`. Use that file to
record the task intent, plan, implementation notes, review findings, diagrams,
verification, QA results, and follow-ups.

Agents should check and report progress:

- when starting work
- when moving between phases
- before and after each review or QA cycle
- before asking for human review or merge approval
- before the final response

## Documentation Rule

If a change affects architecture, public APIs, data flow, deployment, security,
operations, or user-facing workflow, update the relevant document in the same
PR. If no document update is needed, state why in the PR/task notes.

Useful documentation locations:

- `docs/PROJECT_CONTEXT.md` for project-specific memory and local rules
- `docs/changes/*.md` for PR/task progress and implementation notes
- `docs/decisions/*.md` for durable architecture or product decisions
- `docs/audits/*.md` for review and audit records
- `docs/solutions/*.md` for solved problems and reusable workflow or debugging lessons
- `docs/HARNESS_NOTES.md` for reusable harness improvements

## Git Write Discipline

Before any commit, push, merge, or post-merge work, run `git status` and
`git branch --show-current`. Confirm you are on a non-default branch unless the
human explicitly asked for direct-main work in the current task.

Code changes should happen on a branch or isolated worktree when the host
supports it. Do not commit or push on `main` (or the default branch) without
an explicit human request in the current task. This rule is also pinned in the
agent entrypoints (`AGENTS.md`, `CLAUDE.md`); the entrypoint version is
authoritative if the two ever disagree.

Never run destructive ops against the default branch (`git push --force`,
`git push --force-with-lease`, `git reset --hard origin/main`, history
rewrites) without explicit human approval in the current task.

If branch protection is missing on the default branch, report it as a setup
risk and recommend enabling it before any push to the default branch.

After merge, sync the working copy with the target branch before starting the
next task. If a worktree was used, clean it up only after the PR is merged or
the human confirms it is no longer needed.

## Human Review Gate

Agents may prepare a PR and recommend a merge, but the final merge decision is
human-owned. Before asking for merge approval, the agent should report:

- changed behavior by track
- changed docs
- verification run
- review and human QA cycles completed
- residual findings and their disposition
- known risks or skipped checks
- remaining follow-ups

`merge` and `post_merge` may not be marked complete without a PR URL, recorded
human acceptance, and the merged target-branch state. See the `Branch & Merge
Evidence` section of `docs/changes/CHANGE_TEMPLATE.md` for the required fields.

## Compound Capture

At the end of a non-trivial debugging or delivery session, ask whether the work
produced reusable learning. Capture it when the answer is yes.

Capture examples:

- a repeated bug pattern and its fix
- a deployment or environment failure mode
- a review finding that should become a project rule
- a full-stack integration issue that future agents should check first
- a design or QA mismatch pattern

Use `docs/solutions/*.md` for reusable project knowledge. Use
`docs/HARNESS_NOTES.md` only when the lesson may improve ForgeKit itself.
