# Change: Require isolated worktree for code changes

## Intent

Plain branch checkout in the primary working tree does not isolate untracked
files — they leak across branch switches. The 2026-05-22 incident in
downstream `wildfolio-server` (PermissionLabs/wildfolio-server#27) showed the
failure mode: untracked files created on one branch survived a `checkout
main`, then rode along through six subsequent branch checkouts before a
human spotted them in `git status` the next morning. Every commit went
through a branch + PR. The leak was entirely in the shared primary tree.

Tighten the workflow rule to MUST-worktree so the failure mode is
structurally prevented rather than left to discipline.

## Change

`templates/docs/WORKFLOW.md` Git Write Discipline (L142):

- "branch **or** isolated worktree (when host supports it)" → **isolated
  worktree required**.
- Added co-working clarification: each task gets its own worktree; multiple
  agents on the same task may share that worktree; the primary working tree
  is for reads and task-switching, not for committing.
- Cleaned up "if a worktree was used" wording (L156) — worktree is no
  longer optional.

Synced the same change to:

- `docs/WORKFLOW.md` (forgekit's own copy — eat-your-own-dogfood)
- `templates/docs/AGENT_GUIDE.md` Implementation bullet (L81) — replaces
  "branch or isolated worktree" with the MUST wording and a pointer to
  WORKFLOW.md. Agents read AGENT_GUIDE first, so this is the file that
  actually changes behavior.
- `docs/AGENT_GUIDE.md` — same.

## Out of scope

- **Tooling enforcement** (pre-commit hook, harness PreToolUse gate). The
  co-working clarification carves out the legitimate shared-worktree case so
  a future hard gate can be added without breaking Codex + Claude
  collaboration on the same task. Not adding the gate in this PR.
- **Entrypoint `AGENTS.md` / `CLAUDE.md` hard gate** unchanged. Those pin
  only the main-write rule; the worktree rule stays in WORKFLOW/AGENT_GUIDE
  to keep the entrypoint hard gate minimal.
- **`check-harness-sync.sh --forgekit` mode** still only checks AGENTS/CLAUDE
  title-line parity, not AGENT_GUIDE/WORKFLOW parity. The project copies of
  those two docs are kept in sync by hand (with intentional title and intro
  differences). Tightening `--forgekit` parity is a separate cleanup.

## Verification

- `diff templates/docs/WORKFLOW.md docs/WORKFLOW.md` — only the
  pre-existing intentional title/intro differences remain; no new drift in
  the Git Write Discipline section.
- `diff templates/docs/AGENT_GUIDE.md docs/AGENT_GUIDE.md` — bullet L80/81
  now identical between template and project copy; other pre-existing diffs
  untouched.
- Downstream `wildfolio-server` will show drift on `docs/WORKFLOW.md` and
  `docs/AGENT_GUIDE.md` under `check-harness-sync.sh` after merge — resolve
  via a follow-up sync PR.

## Review Cycles

| Cycle | Reviewer | Findings | Disposition |
| --- | --- | --- | --- |
| 1 | Claude (self) | AGENT_GUIDE.md not updated; forgekit's own docs/WORKFLOW.md not updated; co-working tension with Out-of-scope justification; L156 wording stale; no changes doc | All fixed in this revision |
