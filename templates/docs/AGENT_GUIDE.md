# Agent Guide

This file is the shared entry point for coding agents working in this repository.

## Operating Principle

This is a human-led, agent-assisted development workflow.

Agents should clarify scope, implement focused changes, review their own work,
verify what they changed, and surface risks. Agents should not expand product
direction, architecture, or task scope without explicit human approval.

## Required Reading

Before making changes:

1. Read this file.
2. Read `docs/PROJECT_CONTEXT.md` when stack, product, domain, deployment, or
   local workflow details matter.
3. Read `docs/WORKFLOW.md` for phase rules and progress-state expectations.
4. Inspect nearby code or documents before editing.

If the task includes a Figma URL, Figma node ID, design QA request, or asks to
implement UI from a design, read `docs/design-skills/FIGMA.md` before
implementation and load or invoke the host's Figma/design skill when available.

## Default Workflow

For production-level code or documentation changes, follow:

```text
plan -> implement -> review -> human_qa -> merge -> post_merge -> compound_capture
```

For every non-trivial task, read or create `.context/workflow-state.json` or an
equivalent gitignored `.context/` file before implementation. Update it whenever
phase, track, review, QA, or residual status changes. If the state file is not
used for a non-trivial task, state why.

Keep runtime state compact. Store statuses, counts, links, and short notes in
JSON; store detailed plans, review findings, QA notes, and rationale in
`docs/changes/*.md`, `docs/audits/*.md`, or `docs/solutions/*.md`.

Use `docs/changes/*.md` for PR/task notes that should be shared with the team.

Agents should report progress:

- when starting work
- when moving between phases
- before and after each review or QA cycle
- before asking for human review
- before the final response

## Planning

Plan before implementation when the request is broad, ambiguous,
architecture-affecting, product-defining, risky, or likely to touch multiple
modules.

A good plan identifies:

- intended outcome and success criteria
- in-scope and out-of-scope work
- affected APIs, data flow, docs, and user workflows
- verification steps
- risks and open questions

## Implementation

- Do not make broad refactors unless explicitly requested.
- Keep changes small and focused.
- Prefer existing project patterns over new abstractions.
- Do not add frameworks, services, or dependencies without clear need.
- Do not solve adjacent problems unless they block the requested work.
- Preserve user changes and avoid reverting work you did not make.
- Use a branch or isolated worktree for code changes when the host supports it.

## Documentation

Documents are shared team memory. Do not rely on private local memory for rules
or architectural context that future agents or teammates need.

If a change affects architecture, public APIs, data flow, deployment, security,
operations, or user-facing workflow, update the relevant document in the same
PR. If no documentation update is needed, record why in the task notes or final
response.

Use:

- `docs/PROJECT_CONTEXT.md` for project-specific commands, architecture, and
  local rules
- `docs/WORKFLOW.md` for the shared workflow contract
- `docs/changes/*.md` for PR/task progress and implementation notes
- `docs/decisions/*.md` for durable decisions
- `docs/audits/*.md` for review and audit records
- `docs/design-skills/*.md` for design-tool-specific workflow rules
- `docs/solutions/*.md` for solved problems and reusable lessons
- `docs/HARNESS_NOTES.md` for reusable harness improvements

## Review Checklist

Before final response after a code change:

- inspect changed files
- check for accidental unrelated edits
- run relevant tests or explain why they were not run
- identify required documentation updates
- report review and human QA cycles completed
- report residual findings and their disposition
- mention residual risks or assumptions

For production-facing work, human review is required before merge.

## Harness Evolution

If this harness itself needs improvement during real project work:

- apply project-specific changes in `docs/PROJECT_CONTEXT.md`
- record reusable harness improvements in `docs/HARNESS_NOTES.md`
- promote only repeated, reusable patterns to the shared harness
