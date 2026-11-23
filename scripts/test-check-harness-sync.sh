#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

new_repo() {
  local dir="$TMP_DIR/$1"
  mkdir -p "$dir"
  git -C "$dir" init -q
  bash "$ROOT/scripts/bootstrap.sh" "$dir" >/dev/null
  printf '%s\n' "$dir"
}

# 1. Clean bootstrapped repo passes
repo1="$(new_repo clean)"
bash "$ROOT/scripts/check-harness-sync.sh" "$repo1" >/dev/null

# 2. Optional GEMINI.md symlink to AGENTS.md passes (Antigravity realpath dedup)
repo2="$(new_repo gemini-symlink)"
ln -s AGENTS.md "$repo2/GEMINI.md"
out="$(bash "$ROOT/scripts/check-harness-sync.sh" "$repo2")"
printf '%s\n' "$out" | grep -Fq "GEMINI.md (symlink to AGENTS.md"

# 3. Standalone GEMINI.md with drifted body fails
repo3="$(new_repo gemini-drift)"
printf '# Gemini Entry Point\n\nDrifted body.\n' > "$repo3/GEMINI.md"
if bash "$ROOT/scripts/check-harness-sync.sh" "$repo3" >/dev/null 2>&1; then
  echo "expected drifted standalone GEMINI.md to fail" >&2
  exit 1
fi

# 4. AGENTS.md exceeding Antigravity 24,000-byte cap fails when not overridden
repo4="$(new_repo over-cap)"
printf '\n%*s\n' 24500 '' | tr ' ' 'x' >> "$repo4/AGENTS.md"
err4="$(bash "$ROOT/scripts/check-harness-sync.sh" "$repo4" 2>&1 >/dev/null || true)"
printf '%s\n' "$err4" | grep -Fq "SIZE:  AGENTS.md"
if bash "$ROOT/scripts/check-harness-sync.sh" "$repo4" >/dev/null 2>&1; then
  echo "expected over-cap AGENTS.md without override to fail" >&2
  exit 1
fi

# 5. Overridden AGENTS.md > 24,000 bytes still warns without breaking opt-out
repo5="$(new_repo over-cap-override)"
{
  printf '# Agent Entry Point\n<!-- forgekit-override: test -->\n'
  printf '%*s\n' 24500 '' | tr ' ' 'y'
} > "$repo5/AGENTS.md"
err5="$(bash "$ROOT/scripts/check-harness-sync.sh" "$repo5" 2>&1 >/dev/null)"
printf '%s\n' "$err5" | grep -Fq "warn:  AGENTS.md"

# 6. AGENTS.md starting with YAML frontmatter fails when not overridden
repo6="$(new_repo frontmatter)"
{
  printf -- '---\nactivation: always\n---\n'
  cat "$repo6/AGENTS.md"
} > "$repo6/AGENTS.md.tmp"
mv "$repo6/AGENTS.md.tmp" "$repo6/AGENTS.md"
err6="$(bash "$ROOT/scripts/check-harness-sync.sh" "$repo6" 2>&1 >/dev/null || true)"
printf '%s\n' "$err6" | grep -Fq "FORMAT: AGENTS.md"
if bash "$ROOT/scripts/check-harness-sync.sh" "$repo6" >/dev/null 2>&1; then
  echo "expected frontmatter AGENTS.md without override to fail" >&2
  exit 1
fi

echo "check-harness-sync contract tests passed (6 cases)"
