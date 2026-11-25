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
| Sync & Tests | Completed | `scripts/check-harness-sync.sh`, `scripts/update-harness.sh`, `scripts/bootstrap.sh`, `scripts/lib/repo-paths.sh`, `scripts/test-check-harness-sync.sh`, `scripts/test-modules.sh` | `bash scripts/test-modules.sh` | Medium — downstream `AGENTS.md`/`GEMINI.md` over 24,000 bytes now fail even with a `forgekit-override` marker (intentional: truncation drops rules silently) |
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
Any checked file (root entrypoints, docs, skill and template files) that
physically resolves outside the repository — through its own symlink, a
symlinked parent directory, or a `link/../file` target — is `LINK` drift,
reported by path before any comparison; its content is never printed. The
resolver follows links with `cd -P` / `pwd -P` (portable to macOS bash 3.2,
no `readlink -f` / `realpath`). When the final sync check inside
`update-harness.sh` fails, its hints follow the checker's drift classes:
only `DRIFT`/`MISSING`/`STALE` suggest a `forgekit-override` marker.

### Write guard (bootstrap.sh / update-harness.sh)

`copy_file` used a plain `cp`, so with `--force` a harness file that is a
symlink to a path outside the target repository (or sits under a symlinked
parent directory) overwrote the outside file; a dangling outside link even
created one, and `.gitignore` / `.context/workflow-state.json` were appended
or rewritten through links the same way.

- The resolver (`resolve_physical`, `path_escapes_repo`) moved to
  `scripts/lib/repo-paths.sh`, sourced by all three scripts, so reads and
  writes share one `cd -P` implementation. `write_target_problem` adds the
  write-side rule: an existing (or dangling) target must resolve inside the
  repository and be a regular file or symlink; a missing target's nearest
  existing ancestor (what `mkdir -p` descends into) must resolve inside the
  repository and be a directory.
- Both scripts check every path they would write (harness files,
  `.context/workflow-state.json`, `.gitignore`) before writing any of them.
  One failing path stops the run with a `LINK:` line naming the path and
  reason only, even with `--force`, so a refusal never leaves a partial
  update. In `update-harness.sh` the guard runs before `has_override`/`cmp`,
  so an outside file is not read either.
- A symlink that resolves inside the repository is replaced by a regular
  file (the link is removed, then the file written; `.gitignore` is
  materialised from its current content before the append). Writing through
  the link would change a different in-repo file than the one named — for
  example a project-owned file the link points to — and the sync check reads
  the named path either way, so replacing the link is the only behaviour
  that keeps writes confined to the harness path.
- Compatibility change for downstream projects: an in-repo symlinked harness
  file (e.g. `AGENTS.md -> .harness/AGENTS.md`) used to be written through,
  updating the link target; it is now replaced by a regular file, leaving
  the old target stale, and git shows a `typechange`. `docs/BOOTSTRAP.md`
  ("Compatibility note for downstream projects") tells projects how to pick
  the canonical copy and what to review before committing.
- Temp files (X5): every temp file the writers create (`AGENTS.md` /
  `CLAUDE.md` title-preserving copy, `.context/workflow-state.json` jq
  rewrite, `.gitignore` link materialisation, and the state seed in
  `scripts/worktree-add.sh`) is created with `mktemp` in the destination's
  directory (`.<name>.forgekit-tmp.XXXXXX`; BSD `mktemp` needs the trailing
  `X`s), so the old predictable `<file>.tmp.$$` name can no longer be a
  pre-placed link that `> "$tmp"` truncates through. `make_sibling_tmp` /
  `commit_sibling_tmp` in `scripts/lib/repo-paths.sh` own the temp path, and
  both writers install `trap forgekit_tmp_cleanup EXIT` so a failure between
  creation and the rename removes it (`scripts/worktree-add.sh` has its own
  EXIT trap for the seed temp).
- Temp file mode (X6): temp files are held at `0600` (set explicitly;
  `mktemp`'s own mode is masked by the umask) until their content is
  complete, and the umask default a plain redirect would give is applied in
  `commit_sibling_tmp` / just before the seed `mv`. Applying it at creation
  made the temp read-only under umask `0222`, so the following write failed;
  under bash 3.2 the failed `{ ... } > "$tmp"` redirect also escaped
  `errexit` and an empty `CLAUDE.md` was committed, so those writes now
  check their status. A `.gitignore` link is materialised with `.context/`
  added in the same temp write, because the committed `0444` copy cannot be
  appended to.

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
- Cycles 2 and 3: the `bun` module tests were not run locally (`bun` not
  installed); CI runs them.
- Mutation checks (cycle 2): each mutation applied to a scratch copy made the
  contract tests fail — `-ef` forced true, `SIZE` or `FORMAT` downgraded to a
  warning, bare `return` restored after a missing entrypoint, the outside-repo
  symlink guard disabled, the cap applied to `CLAUDE.md`, template diff
  re-applied to a standalone `GEMINI.md`, the `update-harness.sh` `GEMINI.md`
  pre-check removed, and `bash -n "$@"` restored in `test-modules.sh`.
- Mutation checks (cycle 3): `cd -P` replaced by a logical `cd` in the
  physical-path resolver, the guard removed from `check_exact`, and the old
  generic `update-harness.sh` failure hint restored each made the contract
  tests fail.
- Mutation checks (write guard): the new tests fail with the HEAD scripts and
  with each of these mutations — `write_target_problem` always passing, the
  link removed before `cp` dropped (writes through in-repo links), the guard
  call removed from `would_update_file`, the missing-target parent branch
  removed, `replace_link_with_copy` made a no-op, the `bootstrap.sh`
  refusal disabled, the `.gitignore` pre-check removed, `cd -P` replaced by a
  logical `cd` in the shared resolver, and the guard moved from the
  pre-check to write time (partial update).
- Mutation checks (cycle 5, X5 and write-path `..`): the new tests fail with
  the cycle-4 temp code, and with each temp path alone reverted to the
  predictable `<file>.tmp.$$` name (state rewrite, entrypoint copy,
  `.gitignore` materialisation). With `cd -P` replaced by a logical `cd` in
  the shared resolver (m8), the new `redirect/../` write cases fail on their
  own (missing `LINK`, outside tree hash changed through a real write, partial
  update) for both `update-harness.sh` and `bootstrap.sh`, independent of the
  read-side cases.
- Mutation checks (cycle 6, X6): the umask `0222` tests fail with the final
  mode applied in `make_sibling_tmp` before the write (update-harness, and
  bootstrap's `.gitignore` link run by hand), with the explicit `chmod 600`
  removed (mktemp then gives `0400`), and with `worktree-add.sh` applying the
  final mode before `jq` writes the seed.
- Manual checks: Reviewed full `git diff` across root and `templates/`.

## Review Cycles

| Cycle | Type | Findings | Resolution |
| --- | --- | --- | --- |
| 1 | Code + security (self-review) | Verified shell quoting, `mktemp -d` cleanup trap, portable `wc -c` / `-ef` checks, no secret exposure, backward-compatible `forgekit-override` warning behavior. | Clean (0 residual findings) |
| 2 | Cross-review (Codex + Claude) | X1 `bash -n` only parsed the first file; X2/C5 cap applied to `CLAUDE.md`, host logic hard-coded by file name; C1 missing entrypoint aborted the run under `set -e`; C2 standalone `GEMINI.md` forced to match the template, no `update-harness.sh` pre-check, wrong remediation text; C3 `SIZE`/`FORMAT` only warned under override; C4 tests did not catch mutations; C6 host tool names stated as the review binding; C7 outside-repo entrypoint symlinks diffed to stderr. | Fixed in the cycle-2 commit; C6 ships the contract paragraph only, contract and adapters follow up. |
| 3 | Cross-review (Codex) | X3 the outside-repo guard normalised paths logically, so `redirect/../file` through a directory symlink escaped it and outside content was diffed; X4 the `update-harness.sh` final failure hint suggested `forgekit-override` for `SIZE`/`FORMAT`; C7 residual `check_exact` diffed docs/skill files resolving outside the repository. | Fixed in the cycle-3 commit: physical-path resolver, guard before every diff, cause-specific hints. |
| 4 | Follow-up (found during cycle 3, out of its scope) | `update-harness.sh` / `bootstrap.sh` wrote through symlinks resolving outside the target repository with `--force` (plain `cp`, `>>`, `touch`). | Fixed in the write-guard commit: shared `scripts/lib/repo-paths.sh`, all-paths pre-check, in-repo links replaced instead of followed. |
| 5 | Cross-review (Codex) | X5 the `.context/workflow-state.json` temp path `$state_file.tmp.$$` was predictable and outside the pre-check, so a pre-placed outside link was truncated by `> "$tmp"`; the write-path tests did not cover `redirect/../file` (m8 caught only on the read side). | Fixed in the X5 commit: `mktemp` sibling temps for every writer plus an EXIT cleanup trap, canary tests at the old PID names, `redirect/../` write tests for both writers. |
| 6 | Cross-review (Codex) | X6 temp files got their final (umask) mode before being written, so under umask `0222` every temp write failed with `Permission denied` (a regression from the X5 commit). | Fixed in the X6 commit: final mode applied after the content is written, explicit `0600` while writing, write-status checks, `worktree-add.sh` EXIT trap, umask `0222` tests for update-harness, bootstrap and worktree-add. |
| 7 | Cross-review (Antigravity, r5) | A1 the write guard checked only the final target of an existing path, so an outside-linked `.context/` holding a link back inside let the writers unlink/temp/rename inside the outside directory; A2 `worktree-add.sh` renamed onto a committed state link to a directory (moving the temp into it); A3 the stale scans listed an outside-linked `docs/`; A4 a missing `.gitignore` under umask `0222` failed (`touch` then `>>`); A5 a failed title `head` was swallowed; A6 the `GEMINI.md` pre-check missed a directory and a link bypassing `AGENTS.md`; A7–A9 vacuous cleanup test and missing guard/edge-case tests. | Fixed in the r5 commit: physical-parent check plus link-to-non-regular refusal in `write_target_problem`, inline seed guard in `worktree-add.sh` (also covers the cycle-6 `.context` follow-up), guarded stale scans, single-open `.gitignore` creation, per-step title copy, link-chain `GEMINI.md` check, kept-worktree and TERM/EXIT-trap cleanup tests, A1/A8 write-guard tests, umask/CRLF/`GEMINI.md` frontmatter/`worktree-add` X5 tests, each mutation-checked. |
| 8 | Cross-review (Codex, r6) | X7 the `GEMINI.md` pre-check accepted a link chain reaching `AGENTS.md` through a file the updater replaces (`GEMINI.md -> docs/WORKFLOW.md -> ../AGENTS.md`), so `update-harness.sh --force` rewrote `docs/WORKFLOW.md` and only then failed with `LINK: GEMINI.md`. | Fixed in the r6 commit: the pre-check refuses any chain whose hops pass through a path in the updater's write set (`CLAUDE.md`, `scripts/worktree-add.sh`, template `docs/`, `.context/workflow-state.json`, `.gitignore`), before any file changes; the `GEMINI.md -> AGENTS.md -> link` control still passes. Regression test 26b fails before the fix. |

## Branch & Merge Evidence

- Working branch: `agent/antigravity-support`
- Target branch: `main`
- PR URL: TBD (filled on PR creation)

## Residuals

| Source | Finding | Disposition | Link/reason |
| --- | --- | --- | --- |
| Cycle 2 / C6 | Shared review contract and per-host review adapters are described but not implemented | `filed_followup` | `docs/review-skills/README.md` states the contract; adapters land in a follow-up change |
| Cycle 5 / review notes | TOCTOU between the all-paths pre-check and the later writes (a path swapped for a link after the check) | `accepted` | Reviewer judgement: acceptable for a single-user local harness, not an adversarial boundary. Exclusive `mktemp` temp files remove the predictable-name case; the remaining window needs a concurrent writer in the target repo. |
| Cycle 6 / X6 review | `scripts/worktree-add.sh` does not check whether `$CTX_DIR` (`<worktree>/.context`) is a link resolving outside the repository before seeding state into it (pre-existing, not introduced by this change) | `fixed` | Fixed in cycle 7 (r5 A2): inline `seed_target_problem` guard in `worktree-add.sh`; test "worktree-add refuses a .context link resolving outside" |

## Compound Capture

- Reusable learning captured: Yes — recorded in `docs/HARNESS_NOTES.md`.
