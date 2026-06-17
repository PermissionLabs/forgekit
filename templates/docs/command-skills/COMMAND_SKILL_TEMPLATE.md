<!--
Copy this file into a consuming repo as docs/command-skills/<name>.md and fill
it in. This is the host-neutral source of truth for one command skill. Then add
the per-host bindings (see this directory's README.md "Host binding reference").
Delete this comment after copying.
-->

# Command Skill: `<name>`

One-line purpose. What does invoking this skill start and finish?

## Invocation

```
<name>            # no argument — describe the interactive/default behavior
<name> <arg>      # with an argument — describe what the argument selects
```

| Host | How to invoke |
| --- | --- |
| Claude Code | `/<name> [arg]` (binding: `.claude/commands/<name>.md`) |
| Codex CLI | Prompt: "run `<name>` for `<arg>`" (binding: `AGENTS.md` Command Skills entry) |

## Inputs

- **`<arg>`** — what it is, where it comes from, and what happens if omitted.
- Preconditions the human/agent must satisfy before running (clean tree, on a
  worktree, required MCP connected, etc.).

## Tool / MCP requirements

- List any MCP server or external tool this skill needs.
- Confirm it is registered for every supported host (`.mcp.json` for Claude,
  `.codex/config.toml` for Codex). If none, state "none".

## Procedure

Map every step onto a `docs/WORKFLOW.md` phase. Do not invent a parallel phase
model. Reference review/design checklists via `docs/PHASE_REFS.json` at the
phase where they apply.

### plan
- Acquire/confirm the task and its scope. (If using a tracker, this is where
  the claim/lock happens.)
- Seed an isolated worktree with `scripts/worktree-add.sh`.
- Write the change record from `docs/changes/CHANGE_TEMPLATE.md`.

### implement
- The smallest focused change that satisfies the approved scope.

### review
- Run the review skills required for the diff (`docs/review-skills/`).

### human_qa
- Hand off a testable artifact; record reported issues.

### merge  *(human-owned)*
- Gate: explicit human confirmation. Do not restate the rule here — point to
  `docs/WORKFLOW.md` and the entry points.

### post_merge
- Sync the workspace; update tracker status / release notes / follow-ups.

## Gates (human confirmation required)

- `git push` — confirm before exposing work.
- `gh pr create` — confirm before opening the PR.
- `gh pr merge` — confirm; human-owned per `docs/WORKFLOW.md`.

## Termination / handoff

- What "done" looks like.
- What the skill hands back (PR URL, updated `.context/workflow-state.json`,
  tracker status, etc.).

## Host bindings checklist

- [ ] `docs/command-skills/<name>.md` (this file) — source of truth
- [ ] `.claude/commands/<name>.md` — Claude slash command → routes here
- [ ] `AGENTS.md` "Command Skills" entry — Codex/other → routes here
- [ ] (optional) `.codex/prompts/<name>.md`
- [ ] Any required MCP mirrored across host registries
