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

default_branch() {
  # $1 = repo dir. origin 의 default 브랜치명(예: main)을 출력. 못 구하면 main 폴백.
  # origin/HEAD 가 set 안 돼 있으면(흔함) 폴백이 결국 main 이라 main 레포에선 동일,
  # 다른 레포에선 올바른 브랜치로 동작(이식성).
  local d b
  d="${1:-.}"
  b="$(git -C "$d" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  b="${b#origin/}"
  [ -n "$b" ] || b="main"
  printf '%s\n' "$b"
}
DEFAULT_BRANCH="$(default_branch "$REPO_ROOT")"

if [ "${2:-}" = "-b" ]; then
  if [ "$#" -lt 3 ]; then
    usage >&2
    exit 2
  fi
  BRANCH="$3"
  BASE_REF="${4:-origin/$DEFAULT_BRANCH}"
else
  BRANCH="$2"
  BASE_REF="${3:-origin/$DEFAULT_BRANCH}"
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required to seed workflow-state.json safely" >&2
  exit 1
fi

# ── Root freshness: worktree 생성 = 루트 최신화 지점 ────────────────────────────
# 새 worktree 는 BASE_REF(기본 origin/$DEFAULT_BRANCH)에서 분기한다. 분기 기준이 stale
# 하면 "task 시작 시 최신" 이 깨지므로 먼저 그 ref 를 fetch 한다(이것만으로 분기는 최신).
# 추가로, 루트 체크아웃이 default 브랜치·ff-가능(로컬 커밋 없음)이면 fast-forward 까지
# 해 루트가 origin 뒤로 표류하는 걸 막는다. 단 루트가 default 브랜치가 아니거나 ff
# 불가/로컬 커밋이면 *건너뛴다* — 공유 루트 체크아웃을 강제로 yank 하면 루트에서 보고
# 있는 다른 세션을 깬다(격리 모델: 작업은 worktree 에서). pull 이 아니라 merge --ff-only
# 로 방금 fetch 한 ref 에 ff 해 upstream-config 의존/하프머지 dirty 를 피한다.
warn_root() { echo "[worktree-add] $1" >&2; }

refresh_root_before_branch() {
  # 분기에 필요한 ref(BASE_REF) + 루트 ff 에 필요한 default 브랜치만 좁혀 fetch.
  local fetch_refs="$DEFAULT_BRANCH"
  case "$BASE_REF" in
    origin/*) [ "${BASE_REF#origin/}" = "$DEFAULT_BRANCH" ] || fetch_refs="$fetch_refs ${BASE_REF#origin/}" ;;
  esac
  # shellcheck disable=SC2086 — fetch_refs 는 공백분리 ref 목록(의도된 word splitting).
  if ! git -C "$REPO_ROOT" fetch origin $fetch_refs --quiet 2>/dev/null; then
    warn_root "git fetch origin 실패(오프라인?) — 로컬 ref 기준으로 분기합니다."
    return 0
  fi
  local cur
  cur="$(git -C "$REPO_ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null || echo '(detached)')"
  if [ "$cur" != "$DEFAULT_BRANCH" ]; then
    warn_root "루트가 $DEFAULT_BRANCH 이 아님($cur) — 루트 최신화 생략(fetch 만). worktree 는 $BASE_REF 에서 분기."
    return 0
  fi
  if ! git -C "$REPO_ROOT" merge-base --is-ancestor HEAD "origin/$DEFAULT_BRANCH" 2>/dev/null; then
    warn_root "루트 $DEFAULT_BRANCH 이 origin/$DEFAULT_BRANCH 으로 ff 불가(로컬 커밋/분기?) — 최신화 생략."
    return 0
  fi
  if git -C "$REPO_ROOT" merge --ff-only --quiet "origin/$DEFAULT_BRANCH" 2>/dev/null; then
    warn_root "루트 $DEFAULT_BRANCH fast-forward 완료."
  else
    if ! git -C "$REPO_ROOT" merge-base --is-ancestor HEAD "origin/$DEFAULT_BRANCH" 2>/dev/null; then
      warn_root "루트 fast-forward 불가 — 그 사이 origin/$DEFAULT_BRANCH 가 진전(경합)했거나 로컬이 분기. worktree 는 $BASE_REF 에서 분기."
    else
      warn_root "루트 fast-forward 실패(로컬 working-tree 변경?) — 최신화 생략. worktree 는 $BASE_REF 에서 분기."
    fi
  fi
}

refresh_root_before_branch

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
