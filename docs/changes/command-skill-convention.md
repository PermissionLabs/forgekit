# Change: Command-skill convention (multi-host executable skills)

## Intent

ForgeKit specifies host-neutral *reference* skills (`review-skills/`,
`design-skills/`) and thin per-host entry points (`CLAUDE.md` + `AGENTS.md` →
`AGENT_GUIDE.md`), but it has no convention for **executable command skills** —
named procedures a human invokes to run a multi-step workflow (e.g. "claim a
tracker task → plan → implement → review → PR"). Today such skills (e.g. a
project's `/goal`, `/release`) land only in `.claude/commands/`, making them
Claude-only and invisible to Codex.

Add a convention + template so any consuming repo can author a command skill
once (one host-neutral doc) and bind it to multiple hosts (Claude slash
command, Codex prompt entry) without forking the procedure.

Success: a project (wildfolio first) can build a command skill — e.g. `pick`
(Linear claim-lock runner) — that both Claude Code and Codex run from a single
source-of-truth doc.

## Scope

- In scope: `templates/docs/command-skills/README.md` (convention),
  `templates/docs/command-skills/COMMAND_SKILL_TEMPLATE.md` (skeleton); wiring
  into `bootstrap.sh` / `check-harness-sync.sh` so the new dir syncs; forgekit's
  own `docs/` copy; an `AGENT_GUIDE.md` reference to the new skill class.
- Out of scope: any concrete command skill (`pick`, `goal`, `release`) — those
  are project-local and land in the consuming repo, not in forgekit templates.

## Current State

Checked before implementing:

- `templates/docs/review-skills/README.md` — house style for a skills dir +
  "host owns invocation, ForgeKit owns the contract" framing.
- `README.md` + `templates/CLAUDE.md` / `templates/AGENTS.md` — existing
  thin-entry-point dual-host pattern this convention mirrors.
- `docs/WORKFLOW.md` — phase model (`plan → … → post_merge`) the procedure maps
  onto; command skills orchestrate phases, not replace them.
- `docs/EXTERNAL_TOOLS.md` — establishes command-skill-style runners as
  *optional* layers; this convention stays guidance, not a required command.
- `scripts/bootstrap.sh` — copies all of `templates/docs/` recursively (new dir
  auto-propagates), but its conflict list + `check-harness-sync.sh` track an
  explicit path set that does not yet include `docs/command-skills`.
- Codex registration reality: `AGENTS.md` entry point + `.codex/config.toml`
  (MCP mirror); no slash registry, no state hook → Codex binding is a prompt
  entry, not an executable wrapper.

## Plan

- [x] Plan
- [x] Implement (convention + template + discoverability trigger + sync wiring)
- [x] Review (self-review; human review pending)
- [ ] Human QA
- [ ] Merge
- [ ] Post-merge
- [ ] Compound capture

## Tracks

| Track | Status | Changed paths | Verification | Risks |
| --- | --- | --- | --- | --- |
| Docs | Completed | `templates/docs/command-skills/*`, `templates/docs/AGENT_GUIDE.md`, `templates/docs/PHASE_REFS.json` (+ forgekit `docs/` mirrors) | bootstrap roundtrip propagates all three | none |
| Harness scripts | Completed | `scripts/bootstrap.sh`, `scripts/check-harness-sync.sh` | `bash -n` + roundtrip sync in-sync; project skill not flagged stale | none |
| Server / Deploy / Frontend / App / Shared contracts | Skipped | — | — | not applicable (harness docs only) |

## Implementation Notes

- Convention mirrors the existing entry-point pattern: one SoT doc + thin
  per-host bindings; "never fork the procedure across hosts."
- Host binding table makes the Claude/Codex asymmetry explicit (Codex = prompt
  entry via `AGENTS.md`, the portable lowest common denominator).
- Procedure section mandates mapping onto existing `WORKFLOW.md` phases rather
  than inventing a parallel model — keeps command skills thin runners.
- Kept command skills explicitly **optional** (aligns with `EXTERNAL_TOOLS.md`).

## Documentation Updates

- Added: `templates/docs/command-skills/README.md`,
  `templates/docs/command-skills/COMMAND_SKILL_TEMPLATE.md`.
- Pending: forgekit's own `docs/command-skills/` copy; `AGENT_GUIDE.md`
  reference; `bootstrap.sh` + `check-harness-sync.sh` tracked-path additions.

## Verification

- `bash -n scripts/check-harness-sync.sh scripts/bootstrap.sh` — syntax OK.
- `scripts/check-harness-sync.sh --forgekit` — root vs templates in sync
  (PHASE_REFS parity holds after edit).
- Bootstrap roundtrip into a temp repo: `command-skills/` (README + TEMPLATE)
  propagated; AGENT_GUIDE trigger present (grep=1); PHASE_REFS
  `authoring_command_skill` condition + implement ref present; downstream sync
  check reports all in sync.
- Edge: a project-local `docs/command-skills/pick.md` added downstream is NOT
  flagged STALE (only README is byte-checked; project skills are untracked).

## Review Cycles

| Cycle | Type | Findings | Resolution |
| --- | --- | --- | --- |
| 1 | Self-review (docs + shell) | (a) PHASE_REFS ref sits under `implement` only, not `plan` — `plan` has no PHASE_REFS entry and the AGENT_GUIDE trigger says "before implementation", so coverage holds. (b) No secrets / injection surface in the two static shell additions. | accepted_with_reason |

## Branch & Merge Evidence

- Working branch: `feat/command-skill-convention`
- Target branch: `main`
- PR URL: TBD

## Follow-ups

- Wire `docs/command-skills` into `bootstrap.sh` conflict list +
  `check-harness-sync.sh` tracked paths.
- Mirror into forgekit's own `docs/command-skills/`.
- Reference the new skill class from `templates/docs/AGENT_GUIDE.md`.
- First consumer: wildfolio `pick` skill (separate, project-local work).
