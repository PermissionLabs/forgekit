# Project Context

This repository is ForgeKit, the source harness for Permission Labs agent-assisted development.

It defines shared entry files, project templates, adoption guidance, and the evolution loop for using coding agents in real product work.

## Current Scope

- Keep the first version document-first.
- Avoid building a CLI until the workflow stabilizes through real use.
- Prefer repository-level operating contracts over fully autonomous agent loops.
- Keep Claude Code, Codex, OpenCode, and future agent hosts aligned through shared docs.

## Important Paths

- `README.md`: public project overview
- `AGENTS.md`: Codex/OpenCode-style entry point for this repo
- `CLAUDE.md`: Claude Code entry point for this repo
- `docs/AGENT_GUIDE.md`: working guide for agents editing this repo
- `templates/`: files copied or synced into downstream product repos
- `docs/ARCHITECTURE.md`: architecture of the harness model
- `docs/ADOPTION.md`: how projects adopt the harness
- `docs/EVOLUTION.md`: how improvements flow back upstream

## Commands

No project commands yet.

## Local Rules

- Do not add runtime tooling before the document workflow is validated.
- Keep generated product-repo templates host-agnostic where possible.
- Separate shared harness rules from project-local rules.
