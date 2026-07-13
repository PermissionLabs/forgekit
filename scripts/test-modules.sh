#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0

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
run "workflow-state tests" bun test "$ROOT/modules/workflow-state/state.test.ts"
run "docs-index tests" bun test "$ROOT/modules/docs-index/docs-index.test.ts"
run "Codex hook adapter contract" bash "$ROOT/modules/host-adapters/test-codex-hook-adapter.sh"
run "manifest JSON" jq -e . "$ROOT/modules/manifest.json" >/dev/null
run "workflow-state schema JSON" jq -e . "$ROOT/modules/workflow-state/schema.json" >/dev/null
run "docs registry schema JSON" jq -e . "$ROOT/modules/docs-index/registry.schema.json" >/dev/null
run "module shell syntax" bash -n \
  "$ROOT/modules/host-adapters/codex-hook-adapter.sh" \
  "$ROOT/modules/host-adapters/test-codex-hook-adapter.sh" \
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
  "$ROOT/modules/quality" >/dev/null; then
  printf 'FAIL: project-specific policy leaked into promoted modules\n' >&2
  FAIL=$((FAIL + 1))
else
  printf 'PASS: promoted modules are project-neutral\n'
  PASS=$((PASS + 1))
fi

printf '\nRESULT: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
