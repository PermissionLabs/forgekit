# Change: Antigravity host support & entrypoint budget guardrails

## Intent

ForgeKit's thin-entrypoint + `docs/` reference model already fits Antigravity
well, but ForgeKit's templates, host binding tables, bootstrap guidance, and
sync script only named Claude Code and Codex. Real usage (`t3code` + `router`)
also surfaced a silent failure mode: Antigravity truncates any rule file
(`AGENTS.md` / `GEMINI.md`) over **24,000 bytes** and expects standalone
Markdown without YAML frontmatter.

Add first-class Antigravity support across ForgeKit's docs, templates, and
`scripts/check-harness-sync.sh` while keeping ForgeKit lightweight and
host-neutral (no mandatory third root entrypoint file).

## Scope

- In scope:
  - Host-neutral `# Agent Entry Point` title in `AGENTS.md` and
    `templates/AGENTS.md` (backwards-compatible: `check-harness-sync.sh` allows
    title-line diffs and `update-harness.sh` preserves existing titles).
  - Antigravity documentation across `README.md`, `docs/PROJECT_CONTEXT.md`,
    `docs/BOOTSTRAP.md`, `docs/WORKFLOW.md` (+ template),
    `docs/command-skills/README.md` (+ template),
    `docs/command-skills/COMMAND_SKILL_TEMPLATE.md` (+ template),
    `docs/review-skills/README.md` (+ template), `docs/EXTERNAL_TOOLS.md`,
    `docs/HARNESS_NOTES.md`, and `scripts/bootstrap.sh`.
  - Optional `GEMINI.md` alias policy + 24,000-byte cap and YAML frontmatter
    checks in `scripts/check-harness-sync.sh`, driven by one host→file→rule
    table (`ENTRYPOINT_HOST_RULES`, `ENTRYPOINT_FILES`) at the top of the
    script; `scripts/update-harness.sh` pre-checks `GEMINI.md` too.
  - Deterministic contract tests in `scripts/test-check-harness-sync.sh` wired
    into `scripts/test-modules.sh`.
- Out of scope:
  - Adding a mandatory `GEMINI.md` file to `templates/` (unnecessary because
    Antigravity auto-loads `AGENTS.md` natively and deduplicates by realpath).
  - Antigravity-specific runtime hooks or host adapters under `modules/`.

## Plan

- [x] Plan
- [x] Implement
- [x] Review
- [ ] Human QA
- [ ] Merge
- [ ] Post-merge
- [ ] Compound capture

## Tracks

| Track | Status | Changed paths | Verification | Risks |
| --- | --- | --- | --- | --- |
| Docs & Templates | Completed | `AGENTS.md`, `README.md`, `docs/*`, `templates/*` | `scripts/check-harness-sync.sh --forgekit` | Low — title-line diff preserves downstream compatibility |
| Sync & Tests | Completed | `scripts/check-harness-sync.sh`, `scripts/update-harness.sh`, `scripts/bootstrap.sh`, `scripts/test-check-harness-sync.sh`, `scripts/test-modules.sh` | `bash scripts/test-modules.sh` | Medium — downstream `AGENTS.md`/`GEMINI.md` over 24,000 bytes now fail even with a `forgekit-override` marker (intentional: truncation drops rules silently) |
| Server / Frontend / App | Skipped | N/A | N/A | Harness docs/scripts repo only |

## Implementation Notes

- Verified Antigravity (`localharness_external` 1.4.5 / `agy` 1.5.x) rules:
  - Auto-loads `AGENTS.md` and `GEMINI.md` walking from `cwd` up to `.git` root.
  - Deduplicates `AGENTS.md` and `GEMINI.md` by resolved path (`realpath`).
  - Expects standalone Markdown without leading YAML frontmatter (`---`).
  - Enforces a 24,000-byte per-file truncation cap and a 20,000-token aggregate
    always-on rule budget.
  - Natively discovers skills from `.agents/skills/<name>/SKILL.md`.
- Rejected adding a mandatory `GEMINI.md` to `templates/` to avoid duplicating
  entrypoint files across every downstream repo when `AGENTS.md` already works
  natively.
- The host→file→rule table lives at the top of `scripts/check-harness-sync.sh`
  rather than under `modules/host-adapters/`: that module holds runtime hook
  adapters (Codex lifecycle-hook translation), not entrypoint load rules, and
  the sync script must stay usable without optional modules.

### GEMINI.md policy

- Absent: fine (recommended; Antigravity loads `AGENTS.md` natively).
- Symlink: must resolve to `AGENTS.md` (`-ef`). A link to `CLAUDE.md`, any
  other file, outside the repository, or a broken link is `LINK` drift;
  `update-harness.sh` stops before changing files, even with `--force`,
  because `--force` cannot repair it.
- Regular file: project-managed. Its body is not compared with the
  `AGENTS.md` template (warning only) and `update-harness.sh` never writes it,
  but the Antigravity byte cap and frontmatter rule still apply.

### Host load rules vs. forgekit-override

The 24,000-byte cap and the no-frontmatter rule apply only to files
Antigravity auto-loads (`AGENTS.md`, `GEMINI.md`), never to `CLAUDE.md`. A
`forgekit-override` marker exempts only the template comparison: a file the
host truncates loses rules silently, so `SIZE`/`FORMAT` are always drift.
Root entrypoints that are symlinks resolving outside the repository are
`LINK` drift and their content is never printed.

## Documentation Updates

- Updated docs: `README.md`, `AGENTS.md`, `templates/AGENTS.md`,
  `docs/PROJECT_CONTEXT.md`, `docs/BOOTSTRAP.md`, `docs/WORKFLOW.md`,
  `templates/docs/WORKFLOW.md`, `docs/command-skills/README.md`,
  `templates/docs/command-skills/README.md`,
  `docs/command-skills/COMMAND_SKILL_TEMPLATE.md`,
  `templates/docs/command-skills/COMMAND_SKILL_TEMPLATE.md`,
  `docs/review-skills/README.md`, `templates/docs/review-skills/README.md`,
  `docs/EXTERNAL_TOOLS.md`, `docs/HARNESS_NOTES.md`.

## Verification

- Commands run: `bash scripts/test-modules.sh` (includes
  `scripts/check-harness-sync.sh --forgekit`,
  `scripts/test-check-harness-sync.sh`, module tests, and per-file `bash -n`
  syntax checks), run with macOS `/bin/bash` 3.2 first on `PATH`.
- Cycle 2: the `bun` module tests were not run locally (`bun` not installed);
  CI runs them.
- Mutation checks (cycle 2): each mutation applied to a scratch copy made the
  contract tests fail — `-ef` forced true, `SIZE` or `FORMAT` downgraded to a
  warning, bare `return` restored after a missing entrypoint, the outside-repo
  symlink guard disabled, the cap applied to `CLAUDE.md`, template diff
  re-applied to a standalone `GEMINI.md`, the `update-harness.sh` `GEMINI.md`
  pre-check removed, and `bash -n "$@"` restored in `test-modules.sh`.
- Manual checks: Reviewed full `git diff` across root and `templates/`.

## Review Cycles

| Cycle | Type | Findings | Resolution |
| --- | --- | --- | --- |
| 1 | Code + security (self-review) | Verified shell quoting, `mktemp -d` cleanup trap, portable `wc -c` / `-ef` checks, no secret exposure, backward-compatible `forgekit-override` warning behavior. | Clean (0 residual findings) |
| 2 | Cross-review (Codex + Claude) | X1 `bash -n` only parsed the first file; X2/C5 cap applied to `CLAUDE.md`, host logic hard-coded by file name; C1 missing entrypoint aborted the run under `set -e`; C2 standalone `GEMINI.md` forced to match the template, no `update-harness.sh` pre-check, wrong remediation text; C3 `SIZE`/`FORMAT` only warned under override; C4 tests did not catch mutations; C6 host tool names stated as the review binding; C7 outside-repo entrypoint symlinks diffed to stderr. | Fixed in the cycle-2 commit; C6 ships the contract paragraph only, contract and adapters follow up. |

## Branch & Merge Evidence

- Working branch: `agent/antigravity-support`
- Target branch: `main`
- PR URL: TBD (filled on PR creation)

## Residuals

| Source | Finding | Disposition | Link/reason |
| --- | --- | --- | --- |
| Cycle 2 / C6 | Shared review contract and per-host review adapters are described but not implemented | `filed_followup` | `docs/review-skills/README.md` states the contract; adapters land in a follow-up change |
| Cycle 2 | `check_exact` (docs/skill files) still diffs a symlinked file that resolves outside the repository; the outside-repo guard covers root entrypoints only | `filed_followup` | Outside the cycle-2 scope (entrypoints); the same guard can be reused |

## Compound Capture

- Reusable learning captured: Yes — recorded in `docs/HARNESS_NOTES.md`.
