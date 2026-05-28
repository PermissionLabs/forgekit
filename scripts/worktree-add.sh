#!/usr/bin/env bash
# Create an isolated git worktree and seed its local ForgeKit workflow state.
#
# Usage:
#   scripts/worktree-add.sh <worktree-path> -b <branch-name> [base-ref]
#   scripts/worktree-add.sh <worktree-path> <branch-name> [base-ref]
#
# This supports the standard "new branch" flow. Use raw `git worktree` for
# unusual operations, then seed `.context/workflow-state.json` manually.

set -euo pipefail

usage() {
  cat <<'EOF'
usage:
  scripts/worktree-add.sh <worktree-path> -b <branch-name> [base-ref]
  scripts/worktree-add.sh <worktree-path> <branch-name> [base-ref]

Creates the worktree and writes <worktree>/.context/workflow-state.json.
Default base-ref: origin/main
EOF
}

if [ "$#" -lt 2 ] || [ "$#" -gt 4 ]; then
  usage >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKTREE_PATH="$1"

if [ "${2:-}" = "-b" ]; then
  if [ "$#" -lt 3 ]; then
    usage >&2
    exit 2
  fi
  BRANCH="$3"
  BASE_REF="${4:-origin/main}"
else
  BRANCH="$2"
  BASE_REF="${3:-origin/main}"
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required to seed workflow-state.json safely" >&2
  exit 1
fi

git -C "$REPO_ROOT" worktree add "$WORKTREE_PATH" -b "$BRANCH" "$BASE_REF"

cleanup_incomplete_worktree() {
  echo "error: failed to seed workflow state; removing incomplete worktree" >&2
  git -C "$REPO_ROOT" worktree remove "${ABS_WORKTREE:-$WORKTREE_PATH}" --force >/dev/null 2>&1 || true
  git -C "$REPO_ROOT" branch -D "$BRANCH" >/dev/null 2>&1 || true
}

if ! ABS_WORKTREE="$(cd "$WORKTREE_PATH" && pwd -P)"; then
  cleanup_incomplete_worktree
  exit 1
fi

CTX_DIR="$ABS_WORKTREE/.context"
STATE_FILE="$CTX_DIR/workflow-state.json"

if ! mkdir -p "$CTX_DIR"; then
  cleanup_incomplete_worktree
  exit 1
fi

if [ -f "$STATE_FILE" ]; then
  echo "warn: workflow state already exists, leaving it unchanged: $STATE_FILE" >&2
else
  STATE_TMP="$STATE_FILE.tmp.$$"
  if ! jq -n \
    --arg task "$BRANCH" \
    --arg branch "$BRANCH" \
    --arg path "$ABS_WORKTREE" \
    --arg updated_at "$(date -Iseconds)" \
    '{
      version: 2,
      task: $task,
      phase: "plan",
      branch: $branch,
      isolation: {
        mode: "worktree",
        path: $path,
        branch: $branch,
        verified_before_edit: true
      },
      resume_protocol: {
        read_this_file_on: [
          "task_start",
          "session_resume",
          "context_compaction",
          "phase_transition",
          "before_final_response"
        ],
        read_phase_refs: "on_phase_entry_only",
        phase_refs_source: "docs/PHASE_REFS.json"
      },
      tracks: {},
      reviews: [],
      reviews_open: 0,
      residuals: [],
      verification: {
        passed: ["git worktree add"],
        pending: [],
        skipped: []
      },
      next_step: "Update this workflow state with the concrete task plan before editing files.",
      updated_at: $updated_at
    }' > "$STATE_TMP"; then
    rm -f "$STATE_TMP"
    cleanup_incomplete_worktree
    exit 1
  fi
  if ! mv "$STATE_TMP" "$STATE_FILE"; then
    rm -f "$STATE_TMP"
    cleanup_incomplete_worktree
    exit 1
  fi
fi

echo "Created worktree: $ABS_WORKTREE"
echo "Seeded state:     $STATE_FILE"
echo ""
git -C "$REPO_ROOT" worktree list
echo ""
git -C "$ABS_WORKTREE" status --short --branch
