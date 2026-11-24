# Review Skills

This directory holds the checklist contracts ForgeKit uses for the `review`
phase of `docs/WORKFLOW.md`. Each file defines a focused review type —
*what* to check and the expected output shape.

ForgeKit is host-agnostic. Each skill file is plain Markdown so the agent's
host (Claude Code, Codex CLI, Antigravity, another harness) can load it however it
wants — a slash command, an agent prompt, a subagent system prompt. The
host owns invocation; ForgeKit owns the contract.

## Skills

- `code-review.md` — logic, edge cases, error handling, naming, structure.
- `security-review.md` — authn/authz, secrets, injection, RLS, data exposure, race conditions, dependencies.
- `api-contract-review.md` — schema, versioning, breaking changes, deprecation.
- `data-migration-review.md` — backfill, locking, rollback, downtime, idempotency.
- `deployment-review.md` — env vars, secrets, rollout, observability, rollback.

Add focused reviews (e.g. accessibility, performance) as separate files when
the project repeatedly needs them. Keep each file scoped to one review type.

## Output contract

Every review skill produces a list of findings. Each finding must be
recorded in `docs/changes/<change>.md` under "Review Cycles" with one of
these dispositions:

- `fixed`
- `filed_followup`
- `accepted_with_reason`
- `blocked`

A review with zero findings is a valid result, but the cycle must still be
recorded.

## When to run which

| Trigger | Required |
| --- | --- |
| Any production-facing code change | `code-review`, `security-review` |
| Public API surface change | `api-contract-review` |
| DB schema, data backfill, or destructive data op | `data-migration-review` |
| Deploy config, env, or rollout strategy change | `deployment-review` |
| Documentation-only or purely mechanical change | None required — note it in the change record |

Reviews can be run in any order; record each as a separate cycle in
`docs/changes/*.md`.

## Host invocation hints (non-binding)

These are examples, not requirements. Different hosts will pick different
mechanisms.

Claude Code, Codex CLI, and Antigravity follow one shared review contract:
the same input (the skill file plus the current diff), read-only execution,
the same output schema, model and effort pinned by a policy file rather than
chosen per run, and any failure to complete reported as `incomplete` instead
of a clean result. The contract and the per-host adapters are added in a
follow-up change; until then the hints below are the only binding.

- **Claude Code:** load the skill file into a subagent and run the review
  against the current diff. A project-local slash command that opens the
  file works equally well.
- **Codex CLI:** pass the skill file's content as the brief to a review
  skill or direct prompt invocation against the current diff.
- **Antigravity:** load the skill file into a subagent or the current
  session and review the current diff against the checklist; report
  findings.
- **Other hosts:** read the skill file and run the equivalent of "review
  the current diff against this checklist; report findings".

Adapter reference (host tool names, may change between host releases):
Claude Code — a custom `.claude/agents/<name>.md` or `general-purpose` via
the Agent tool; Antigravity — `invoke_subagent`.

The skill content is the source of truth either way. If a host invocation
shortcut drifts from the checklist, fix the host wrapper.
