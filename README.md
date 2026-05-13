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
  PROJECT_CONTEXT.md
  HARNESS_NOTES.md
```

`AGENTS.md` and `CLAUDE.md` point agents to `docs/AGENT_GUIDE.md`.

`docs/PROJECT_CONTEXT.md` holds project-specific commands, stack notes, product context, and local rules.

`docs/HARNESS_NOTES.md` captures improvements that may belong upstream in ForgeKit.

## Repository Layout

```text
templates/
  AGENTS.md
  CLAUDE.md
  docs/
    AGENT_GUIDE.md
    PROJECT_CONTEXT.md
    HARNESS_NOTES.md
```

This repo also has its own `AGENTS.md`, `CLAUDE.md`, and `docs/AGENT_GUIDE.md` so agents can work on ForgeKit itself.

## Intended Project Setup

Recommended future setup:

```text
product-repo/
  .harness/forgekit           # git submodule pointing to this repo
  AGENTS.md                   # copied/synced from templates
  CLAUDE.md                   # copied/synced from templates
  docs/AGENT_GUIDE.md         # copied/synced from templates
  docs/PROJECT_CONTEXT.md     # project-local
  docs/HARNESS_NOTES.md       # upstream candidates
```

The submodule stores the source templates and future tooling. The root project files remain normal files so Claude Code, Codex, OpenCode, and other agents can discover them naturally.

## Evolution Loop

1. Use the harness in a real project.
2. Keep project-specific rules in `docs/PROJECT_CONTEXT.md`.
3. Record repeated friction or useful changes in `docs/HARNESS_NOTES.md`.
4. Promote proven, reusable rules back to this harness.
5. Sync downstream projects.

## Current Status

Pre-v0.1. No CLI yet. The first version is intentionally document-first.
