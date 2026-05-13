# ForgeKit

This repository defines a lightweight operating contract for human-led, agent-assisted product development.

It is not a fully autonomous software factory. It is a shared harness for keeping Claude Code, Codex, OpenCode, and similar coding agents aligned with the same project workflow, scope boundaries, review habits, and improvement loop.

## Why This Exists

Most agent stacks optimize for autonomy: more roles, more loops, more parallel agents.

That is useful for experimentation, but real product development usually needs something stricter:

- clear scope before implementation
- human product judgment at the right moments
- small, reviewable changes
- consistent planning and verification
- project-local context that agents actually read
- a feedback loop for improving the harness itself

This harness is designed for teams that want agent speed without giving up product taste, engineering discipline, or human control.

## Core Model

Each project gets thin agent entry points:

```text
AGENTS.md
CLAUDE.md
docs/
  AGENT_GUIDE.md
  PROJECT_CONTEXT.md
  HARNESS_NOTES.md
```

`AGENTS.md` and `CLAUDE.md` point agents to the shared guide. The guide defines the workflow. Project context stays local. Harness improvement candidates are captured separately.

## Repository Layout

```text
templates/
  AGENTS.md
  CLAUDE.md
  docs/
    AGENT_GUIDE.md
    PROJECT_CONTEXT.md
    HARNESS_NOTES.md

docs/
  ARCHITECTURE.md
  ADOPTION.md
  EVOLUTION.md
```

## Intended Adoption Pattern

Recommended future setup:

```text
product-repo/
  .harness/agent-harness      # git submodule pointing to this repo
  AGENTS.md                   # copied/synced from templates
  CLAUDE.md                   # copied/synced from templates
  docs/AGENT_GUIDE.md         # copied/synced from templates
  docs/PROJECT_CONTEXT.md     # project-local
  docs/HARNESS_NOTES.md       # upstream candidates
```

The submodule stores the source templates and future tooling. The root project files remain normal files so Claude Code, Codex, OpenCode, and other agents can discover them naturally.

## Operating Loop

1. Use the harness in a real project.
2. Keep project-specific rules in `docs/PROJECT_CONTEXT.md`.
3. Record repeated friction or useful changes in `docs/HARNESS_NOTES.md`.
4. Promote proven, reusable rules back to this harness.
5. Release/update the harness and sync downstream projects.

## Current Status

Pre-v0.1. This repo is being shaped as the source of truth for Permission Labs agent-assisted development.

No CLI is included yet. The first version is intentionally document-first.
