# Project Context

This file is local to ForgeKit itself.

## Product

ForgeKit is a lightweight agent harness for human-led product development. It
standardizes how Codex, Claude Code, OpenCode, and similar coding agents read
project instructions, track workflow progress, update documentation, and
preserve human review gates.

## Status

Pre-v0.1. The repository is intentionally document-first. There is no CLI or
runtime automation yet.

## Stack

- Runtime: none
- Package manager: none
- Primary artifacts: Markdown templates and JSON examples

## Commands

- Install: not applicable
- Dev: not applicable
- Lint: not configured
- Test: not configured
- Build: not configured

## Important Paths

- `AGENTS.md` and `CLAUDE.md`: thin host-specific entry points
- `docs/AGENT_GUIDE.md`: shared behavior contract for this repository
- `docs/WORKFLOW.md`: phase, progress, review, and documentation rules
- `docs/design-skills/FIGMA.md`: Figma link and design implementation workflow
- `docs/solutions/`: solved problems and reusable project lessons
- `docs/EXTERNAL_TOOLS.md`: policy for Superpowers, gstack, and Compound
- `docs/HARNESS_NOTES.md`: reusable harness improvement candidates
- `scripts/worktree-add.sh`: optional helper that creates a worktree and seeds worktree-local state
- `templates/`: files copied or synced into downstream product repositories
- `templates/.context/workflow-state.compact.example.json`: recommended live progress state shape
- `templates/.context/workflow-state.example.json`: expanded reference schema

## Local Rules

- Keep ForgeKit host-neutral. Do not require Claude-only hooks or Codex-only
  plugins in the core template.
- Keep root `AGENTS.md` and `CLAUDE.md` small. Shared behavior belongs in
  `docs/AGENT_GUIDE.md`.
- Keep project-specific downstream details out of shared templates unless they
  apply across multiple real repositories.
- Prefer documentation and JSON contracts for v0.1. Add automation later as
  optional adapters after the workflow proves useful.
- When a task includes a Figma URL or Figma node ID, follow
  `docs/design-skills/FIGMA.md` and invoke the available host-specific Figma
  skill or command before implementation.
