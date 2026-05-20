# Codex Entry Point

## Git Write Hard Gate (read before any commit, push, or merge)

These rules apply even if no other doc has been read yet:

- Before commit, push, merge, or post-merge work, run `git status` and `git branch --show-current`. Confirm you are on a non-default branch (unless the human explicitly asked for direct-main work in the current task).
- Do not commit or push on `main` (or the default branch) unless the human explicitly requested direct-main work in the current task. Default to a branch or isolated worktree.
- Merge is human-owned. Do not mark `merge` or `post_merge` complete without a PR URL, recorded human acceptance, and the merged target-branch state.
- If branch protection is missing on the default branch, report it as a setup risk and recommend enabling it before any push to the default branch.

## Reading Order

Before making changes in this repository, read and follow `docs/AGENT_GUIDE.md`.

Also read `docs/PROJECT_CONTEXT.md` when the task depends on stack, product, domain, deployment, or local workflow details.

Read `docs/WORKFLOW.md` when the task involves a code change, documentation change, PR, review, merge, or post-merge follow-up.

The shared guide is the source of truth for agent behavior. Project-specific context belongs in `docs/PROJECT_CONTEXT.md`.
