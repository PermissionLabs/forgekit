<!--
Copy this file only when a consuming repository needs a one-release compatibility
stub at docs/command-skills/<name>.md. The canonical skill lives under
.agents/skills/<name>/. Delete this comment after copying.
-->

# Command Skill: `<name>`

The canonical discovery contract is
[`.agents/skills/<name>/SKILL.md`](../../.agents/skills/<name>/SKILL.md).

The phase-mapped procedure is
[`.agents/skills/<name>/references/procedure.md`](../../.agents/skills/<name>/references/procedure.md).

## Compatibility bindings

- Claude Code: `.claude/commands/<name>.md` forwards `$ARGUMENTS` to the canonical skill.
- Codex: native discovery reads `.agents/skills/<name>/SKILL.md`.
- Other agents: `AGENTS.md` points to the same canonical skill.

This file must not duplicate procedure steps. Remove it after the repository's
one-release migration window closes.
