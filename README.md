# ForgeKit

ForgeKit is a lightweight agent harness for human-led product development.

It gives Claude Code, Codex, OpenCode, and similar coding agents the same project entry points and workflow rules without turning the development process into a fully autonomous agent loop.

## Why This Exists

Most agent stacks optimize for autonomy: more roles, more loops, more parallel agents. ForgeKit is for the opposite problem: keeping a real product team and coding agents aligned while humans still own product judgment, scope, and final decisions.

The goal is simple:

- keep scope clear before implementation
- make small, reviewable changes
- preserve human product judgment
- make agents review and verify their own work
- keep Claude/Codex/OpenCode behavior consistent across projects
- improve the harness through real project usage

## Core Model

Each product repository gets thin agent entry points:

```text
AGENTS.md
CLAUDE.md
docs/
  AGENT_GUIDE.md
  WORKFLOW.md
  PROJECT_CONTEXT.md
  HARNESS_NOTES.md
  design-skills/
    FIGMA.md
  solutions/
    README.md
.context/
  workflow-state.json        # compact local runtime state, gitignored
```

`AGENTS.md` and `CLAUDE.md` point agents to `docs/AGENT_GUIDE.md`.

`docs/WORKFLOW.md` defines the Plan -> Implement -> Review -> Merge -> Post-merge workflow, phase statuses, progress-state expectations, and human review gates.

`docs/PROJECT_CONTEXT.md` holds project-specific commands, stack notes, product context, and local rules.

`docs/HARNESS_NOTES.md` captures improvements that may belong upstream in ForgeKit.

`docs/design-skills/FIGMA.md` tells agents what to do when a task includes a Figma link, node ID, or design QA request.

`docs/solutions/*.md` captures reusable solved problems and workflow lessons so future agents do not rediscover them from chat history.

`docs/changes/*.md` is the shared PR/task memory. `.context/` is local agent state and should stay gitignored.

## Quick Start

In your product repo, ask your agent:

> "Bootstrap ForgeKit into this repo. Follow `docs/BOOTSTRAP.md` from
> &lt;path-or-url-to-forgekit&gt;."

Or run the script directly from a local checkout of forgekit:

```bash
./scripts/bootstrap.sh /path/to/product-repo
```

The script copies `AGENTS.md`, `CLAUDE.md`, `docs/`, seeds
`.context/workflow-state.json`, and adds `.context/` to the target's
`.gitignore`. It refuses to overwrite without `--force`, and never overwrites
`docs/PROJECT_CONTEXT.md`.

See `docs/BOOTSTRAP.md` for the full procedure (used by agents and humans),
including a manual fallback when the script can't run.

After bootstrap, fill in `docs/PROJECT_CONTEXT.md` (stack, commands, important
paths, local rules, documentation map). For a non-trivial PR, create a task
note from `docs/changes/CHANGE_TEMPLATE.md` and keep
`.context/workflow-state.json` up to date.

## Repository Layout

```text
templates/
  .context/
    workflow-state.compact.example.json
    workflow-state.example.json
  AGENTS.md
  CLAUDE.md
  docs/
    AGENT_GUIDE.md
    WORKFLOW.md
    PROJECT_CONTEXT.md
    HARNESS_NOTES.md
    design-skills/
      FIGMA.md
    solutions/
      README.md
      SOLUTION_TEMPLATE.md
    changes/
      CHANGE_TEMPLATE.md
    decisions/
      DECISION_TEMPLATE.md
    audits/
      REVIEW_TEMPLATE.md
docs/
  AGENT_GUIDE.md
  WORKFLOW.md
  PROJECT_CONTEXT.md
  HARNESS_NOTES.md
  EXTERNAL_TOOLS.md
  design-skills/
    FIGMA.md
```

This repo also has its own `AGENTS.md`, `CLAUDE.md`, and `docs/` files so agents can work on ForgeKit itself.

## Intended Project Setup

Recommended future setup:

```text
product-repo/
  .harness/forgekit           # git submodule pointing to this repo
  AGENTS.md                   # copied/synced from templates
  CLAUDE.md                   # copied/synced from templates
  docs/AGENT_GUIDE.md         # copied/synced from templates
  docs/WORKFLOW.md            # copied/synced from templates
  docs/PROJECT_CONTEXT.md     # project-local
  docs/HARNESS_NOTES.md       # upstream candidates
  docs/design-skills/FIGMA.md # Figma/design workflow
  docs/solutions/*.md         # solved problems and reusable project lessons
  docs/changes/*.md           # PR/task records
  docs/decisions/*.md         # durable decisions
  docs/audits/*.md            # review records
  .context/workflow-state.json # compact local state, gitignored
```

The submodule stores the source templates and future tooling. The root project files remain normal files so Claude Code, Codex, OpenCode, and other agents can discover them naturally.

## Workflow Contract

ForgeKit v0.1 is document-first. The default workflow is:

```text
plan -> implement -> review -> human_qa -> merge -> post_merge -> compound_capture
```

For full-stack work, `implement`, `review`, and `human_qa` may repeat in a fix
loop until automated checks, agent review, and human QA are accepted.

Supported phase statuses are:

```text
pending
in_progress
blocked
completed
skipped
```

Agents should report progress at phase transitions and before final response. Humans own product direction and merge decisions.

## Evolution Loop

1. Use the harness in a real project.
2. Keep project-specific rules in `docs/PROJECT_CONTEXT.md`.
3. Record repeated friction or useful changes in `docs/HARNESS_NOTES.md`.
4. Promote proven, reusable rules back to this harness.
5. Sync downstream projects.

## Current Status

Pre-v0.1. No CLI yet. The first version is intentionally document-first, with a portable JSON progress-state contract and optional external tool guidance.
