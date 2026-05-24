# Change: Add worktree-local state helper

## Intent

Downstream repositories that use ForgeKit require isolated git worktrees for
code and documentation changes, but raw `git worktree add` does not copy
gitignored runtime state such as `.context/workflow-state.json`.

This leaves agents with a predictable failure mode: the new worktree is clean
from git's perspective, but workflow state may continue to be read from the
primary working tree or may be missing entirely unless the agent manually
creates it.

## Change

- Added `scripts/worktree-add.sh` to create a new branch worktree and seed
  `<worktree>/.context/workflow-state.json`.
- Updated bootstrap to copy the helper into downstream repositories and mark
  it executable.
- Updated harness sync checks so downstream helper drift is detected.
- Documented the helper in `README.md`, `docs/BOOTSTRAP.md`,
  `docs/WORKFLOW.md`, `docs/PROJECT_CONTEXT.md`, and
  `templates/docs/WORKFLOW.md`.

## Out of scope

- No host-specific hook integration. ForgeKit remains host-neutral; Claude,
  Codex, OpenCode, and humans can all run the same helper.
- No general ForgeKit CLI. This is a narrow optional script that supports the
  existing worktree requirement.
- No automatic migration for already-bootstrapped downstream repositories.
  They should receive the helper through a normal harness sync PR.

## Verification

- `bash -n scripts/worktree-add.sh`
- `bash -n scripts/bootstrap.sh`
- `bash -n scripts/check-harness-sync.sh`
- `git diff --check`
- Bootstrap smoke target received executable `scripts/worktree-add.sh`.
- `scripts/check-harness-sync.sh` passed against the bootstrap smoke target.
- Helper smoke test created a worktree, seeded worktree-local state, and left
  `.context/workflow-state.json` ignored by git.
