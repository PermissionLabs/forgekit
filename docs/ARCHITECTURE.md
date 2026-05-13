# Architecture

This harness has three layers.

## 1. Agent Entry Points

`AGENTS.md` and `CLAUDE.md` are thin adapters for different agent hosts.

They should stay small and point to the shared guide:

```text
docs/AGENT_GUIDE.md
```

The goal is host compatibility, not duplicated policy.

## 2. Shared Workflow Contract

`docs/AGENT_GUIDE.md` defines the common behavior agents should follow across projects:

- when to ask questions
- when to plan before editing
- how to keep scope small
- how to review changes
- how to report verification
- how to preserve human product judgment

This file is the main sync target from the harness.

## 3. Project-Local Context

`docs/PROJECT_CONTEXT.md` belongs to the product repo.

It should contain stack-specific commands, architecture notes, domain context, deployment notes, and local conventions. It should not be upstreamed unless the pattern is reusable across projects.

## Why Copied Files Plus Submodule

Agent hosts naturally discover root files like `AGENTS.md` and `CLAUDE.md`.

For that reason, projects should keep real root files instead of requiring every agent to read inside a submodule path. The submodule acts as the source and tooling layer; project root files are the runtime interface.

## Future Tooling

Likely commands:

```text
harness init
harness status
harness diff
harness update
harness propose
```

These should stay thin wrappers around git, file sync, and clear review output.

