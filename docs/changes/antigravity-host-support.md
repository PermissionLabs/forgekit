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
  - Optional `GEMINI.md` parity check (accepting `GEMINI.md -> AGENTS.md`
    symlink) + 24,000-byte cap and YAML frontmatter checks in
    `scripts/check-harness-sync.sh`.
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
| Sync & Tests | Completed | `scripts/check-harness-sync.sh`, `scripts/bootstrap.sh`, `scripts/test-check-harness-sync.sh`, `scripts/test-modules.sh` | `bash scripts/test-modules.sh` | Low — overridden >24 KB files warn rather than breaking existing opt-outs |
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
  `scripts/test-check-harness-sync.sh`, module tests, and `bash -n` syntax
  checks).
- Manual checks: Reviewed full `git diff` across root and `templates/`.

## Review Cycles

| Cycle | Type | Findings | Resolution |
| --- | --- | --- | --- |
| 1 | Code + security (self-review) | Verified shell quoting, `mktemp -d` cleanup trap, portable `wc -c` / `-ef` checks, no secret exposure, backward-compatible `forgekit-override` warning behavior. | Clean (0 residual findings) |

## Branch & Merge Evidence

- Working branch: `agent/antigravity-support`
- Target branch: `main`
- PR URL: TBD (filled on PR creation)

## Residuals

| Source | Finding | Disposition | Link/reason |
| --- | --- | --- | --- |
| None | No open findings | N/A | Clean self-review |

## Compound Capture

- Reusable learning captured: Yes — recorded in `docs/HARNESS_NOTES.md`.
