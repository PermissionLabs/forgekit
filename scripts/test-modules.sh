#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

run() {
  local label="$1"
  shift
  if "$@"; then
    PASS=$((PASS + 1))
    printf 'PASS: %s\n' "$label"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s\n' "$label" >&2
  fi
}

run "internal template parity" bash "$ROOT/scripts/check-harness-sync.sh" --forgekit
run "harness sync script contract" bash "$ROOT/scripts/test-check-harness-sync.sh"
run "workflow-state tests" bun test "$ROOT/modules/workflow-state/state.test.ts"
run "docs-index tests" bun test "$ROOT/modules/docs-index/docs-index.test.ts"
run "Codex hook adapter contract" bash "$ROOT/modules/host-adapters/test-codex-hook-adapter.sh"
run "cross-review runner tests" node --test "$ROOT"/modules/cross-review/test/*.test.mjs
run "cross-review policy JSON" jq -e . "$ROOT/modules/cross-review/review-policy.json" >/dev/null
run "manifest JSON" jq -e . "$ROOT/modules/manifest.json" >/dev/null
run "workflow-state schema JSON" jq -e . "$ROOT/modules/workflow-state/schema.json" >/dev/null
run "docs registry schema JSON" jq -e . "$ROOT/modules/docs-index/registry.schema.json" >/dev/null
# `bash -n a b c` only parses `a` (the rest become positional parameters),
# so parse each file separately.
syntax_check_each() {
  local f rc=0
  for f in "$@"; do
    if ! bash -n "$f"; then
      printf '  syntax error: %s\n' "$f" >&2
      rc=1
    fi
  done
  return "$rc"
}

# Self-test: a syntax error in a later file must still fail the check.
syntax_check_catches_later_file() {
  printf 'echo ok\n' > "$TMP_DIR/good.sh"
  printf 'echo ok\nfi\n' > "$TMP_DIR/bad.sh"
  syntax_check_each "$TMP_DIR/good.sh" "$TMP_DIR/good.sh" || return 1
  ! syntax_check_each "$TMP_DIR/good.sh" "$TMP_DIR/bad.sh" 2>/dev/null
}

run "syntax check fails on a later file" syntax_check_catches_later_file
run "module shell syntax" syntax_check_each \
  "$ROOT/modules/host-adapters/codex-hook-adapter.sh" \
  "$ROOT/modules/host-adapters/test-codex-hook-adapter.sh" \
  "$ROOT/scripts/bootstrap.sh" \
  "$ROOT/scripts/check-harness-sync.sh" \
  "$ROOT/scripts/check-target-paths.sh" \
  "$ROOT/scripts/lib/repo-paths.sh" \
  "$ROOT/scripts/test-check-harness-sync.sh" \
  "$ROOT/scripts/update-harness.sh" \
  "$ROOT/scripts/worktree-add.sh" \
  "$ROOT/scripts/test-modules.sh"

if ! grep -E 'uses:' \
  "$ROOT/.github/workflows/quality.yml" \
  "$ROOT/modules/quality/harness-quality.yml" \
  | grep -Ev '@[0-9a-f]{40}([[:space:]]|$)' >/dev/null \
  && grep -Fq 'contents: read' "$ROOT/.github/workflows/quality.yml" \
  && grep -Fq 'persist-credentials: false' "$ROOT/modules/quality/harness-quality.yml"; then
  printf 'PASS: quality workflows pin actions and stay read-only\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: quality workflow policy\n' >&2
  FAIL=$((FAIL + 1))
fi

if grep -rE -n 'RevenueCat|Amplitude|mobile:ota' \
  "$ROOT/modules/workflow-state" \
  "$ROOT/modules/host-adapters" \
  "$ROOT/modules/docs-index" \
  "$ROOT/modules/quality" \
  "$ROOT/modules/cross-review" >/dev/null; then
  printf 'FAIL: project-specific policy leaked into promoted modules\n' >&2
  FAIL=$((FAIL + 1))
else
  printf 'PASS: promoted modules are project-neutral\n'
  PASS=$((PASS + 1))
fi

printf '\nRESULT: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
