# Command Skills

This directory defines how ForgeKit projects build **command skills** —
named, executable procedures a human invokes to *start and run* a multi-step
workflow (for example: "claim a tracker task, plan it, implement it, review
it, open a PR").

A command skill is the **runner**. It does not restate the rules — it drives
the existing ForgeKit phases (`docs/WORKFLOW.md`) and loads the relevant
review/design checklists (`docs/PHASE_REFS.json`) at each step.

> ForgeKit ships this **convention and a template**, not concrete skills.
> Real command skills carry project-specific detail (trackers, deploy
> scripts, release lanes, domains) and therefore live in the **consuming
> repo**, exactly like `docs/PROJECT_CONTEXT.md`. ForgeKit owns the pattern;
> the project owns the skill.

## Command skills vs review/design skills

| | Review / design skills | Command skills |
| --- | --- | --- |
| Shape | Passive checklist contract | Active procedure / runner |
| Loaded | At a phase (via `PHASE_REFS.json`) | Invoked by name by a human |
| Output | A list of findings | A driven workflow + its artifacts |
| Example | `code-review.md` | `pick` (claim a task and run it) |

Both are host-neutral Markdown. The host owns invocation; ForgeKit owns the
contract.

## The core contract: one doc, thin per-host bindings

This mirrors ForgeKit's existing entry-point pattern (`CLAUDE.md` +
`AGENTS.md` both point to `docs/AGENT_GUIDE.md`). A command skill is exactly
the same idea applied to a procedure:

1. **One source-of-truth skill doc.** The full procedure lives in a single
   host-neutral Markdown file, by default `docs/command-skills/<name>.md` in
   the consuming repo. This is authoritative.
2. **Thin per-host bindings.** Each host gets a wrapper that does nothing but
   route to the skill doc. Bindings translate *how this host invokes the
   skill* — they never copy the steps.

**Never fork the procedure across hosts.** If a binding drifts from the doc,
fix the binding, not the doc.

### Host binding reference

| Host | Native mechanism | Binding | Invocation |
| --- | --- | --- | --- |
| Claude Code | Slash command | `.claude/commands/<name>.md` — frontmatter `description` + body "read and follow `docs/command-skills/<name>.md`; args: `$ARGUMENTS`" | `/<name> [args]` |
| Codex CLI | No skill registry | An entry in `AGENTS.md` (a "Command Skills" list) naming the skill and its doc path; optionally a `.codex/prompts/<name>.md` pointer | Prompt-driven: "run `<name>` for X" → Codex reads the doc |
| OpenCode / other | Host-native or prompt | Host's native command file if it has one, else an `AGENTS.md` entry | Per host |

Codex has no slash-command registry and no state hook, so its binding is a
**documented prompt entry**, not an executable wrapper. Treat the
`AGENTS.md` "Command Skills" list as the portable lowest common denominator:
any host that can read `AGENTS.md` can discover and run the skill from its
doc.

## Anatomy of a skill doc

A command-skill doc (`docs/command-skills/<name>.md`) should contain:

1. **Name + one-line purpose.**
2. **Invocation** — the argument form and what each bound host does.
3. **Inputs** — arguments (e.g. a task ID) and the no-argument behavior
   (e.g. list open tasks and ask the human to choose).
4. **Procedure** — the steps, **mapped onto the `docs/WORKFLOW.md` phases**
   (`plan → implement → review → human_qa → merge → post_merge`). Do not
   invent a parallel phase model; reference the phases by name.
5. **Gates** — where human confirmation is required (push, PR, merge). Point
   to `docs/WORKFLOW.md` and `AGENTS.md`/`CLAUDE.md` rather than restating
   the rule.
6. **Tool / MCP requirements** — if the skill needs an MCP server (e.g. an
   issue tracker), declare it. Shared MCP servers must be registered for
   every host (`.mcp.json` for Claude, `.codex/config.toml` for Codex) per
   the project's shared-MCP-registry rule.
7. **Termination / handoff** — what "done" means and what the skill hands
   back (PR URL, updated state, tracker status).

Keep the doc thin. It orchestrates; the rules live in `WORKFLOW.md`,
`AGENT_GUIDE.md`, and the review skills.

## Authoring a new command skill

1. Copy `COMMAND_SKILL_TEMPLATE.md` to your repo as
   `docs/command-skills/<name>.md` and fill it in.
2. Add the Claude binding: `.claude/commands/<name>.md`.
3. Add the Codex binding: an `AGENTS.md` "Command Skills" entry (and an
   optional `.codex/prompts/<name>.md`).
4. If the skill needs an MCP server, mirror it across host registries.
5. Verify both hosts route to the same doc and run the same procedure.

## Optional by default

Command skills are **optional**, like the external tool packs in
`docs/EXTERNAL_TOOLS.md`. A repo can run the pure document-first workflow
with no command skill at all. But when a repo *does* build one, it MUST
follow this convention so the skill stays multi-host instead of silently
becoming Claude-only.
