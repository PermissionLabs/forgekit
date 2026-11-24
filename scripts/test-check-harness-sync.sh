#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

CASES=0
OUT=""
RC=0
LABEL=""

new_repo() {
  local dir="$TMP_DIR/$1"
  mkdir -p "$dir"
  git -C "$dir" init -q
  bash "$ROOT/scripts/bootstrap.sh" "$dir" >/dev/null
  printf '%s\n' "$dir"
}

# Run a script, capturing combined stdout+stderr in OUT and the exit code in RC.
capture() {
  if OUT="$("$@" 2>&1)"; then
    RC=0
  else
    RC=$?
  fi
}

run_check() {
  LABEL="$1"
  CASES=$((CASES + 1))
  capture bash "$ROOT/scripts/check-harness-sync.sh" "$2"
}

fail() {
  echo "FAIL [$LABEL]: $*" >&2
  printf '%s\n' "$OUT" | sed 's/^/  | /' >&2
  exit 1
}

expect_rc() {
  [ "$RC" -eq "$1" ] || fail "expected exit $1, got $RC"
}

expect_has() {
  printf '%s\n' "$OUT" | grep -Fq -- "$1" || fail "expected output to contain: $1"
}

expect_lacks() {
  if printf '%s\n' "$OUT" | grep -Fq -- "$1"; then
    fail "expected output not to contain: $1"
  fi
}

# Fails if any output line starts with the given prefix (a drift class tag).
expect_no_line() {
  if printf '%s\n' "$OUT" | grep -q "^$1"; then
    fail "expected no output line starting with: $1"
  fi
}

big_body() {
  printf '%*s\n' 24500 '' | tr ' ' "$1"
}

# 1. Clean bootstrapped repo passes
repo="$(new_repo clean)"
run_check "clean" "$repo"
expect_rc 0

# 2. Optional GEMINI.md symlink to AGENTS.md passes (realpath dedup)
repo="$(new_repo gemini-symlink)"
ln -s AGENTS.md "$repo/GEMINI.md"
run_check "gemini symlink to AGENTS.md" "$repo"
expect_rc 0
expect_has "ok:    GEMINI.md (symlink to AGENTS.md"

# 3. Standalone GEMINI.md is project-managed: body not compared, warning only
repo="$(new_repo gemini-standalone)"
printf '# Gemini Entry Point\n\nProject-managed body.\n' > "$repo/GEMINI.md"
run_check "standalone GEMINI.md warns" "$repo"
expect_rc 0
expect_has "warn:  GEMINI.md is a project-managed standalone file"
expect_lacks "DRIFT: GEMINI.md"

# 4. AGENTS.md exceeding the 24,000-byte cap fails when not overridden
repo="$(new_repo over-cap)"
printf '\n' >> "$repo/AGENTS.md"
big_body x >> "$repo/AGENTS.md"
run_check "over-cap AGENTS.md" "$repo"
expect_rc 1
expect_has "SIZE:  AGENTS.md"

# 5. Overridden AGENTS.md over the cap fails on SIZE alone
repo="$(new_repo over-cap-override)"
{
  printf '# Agent Entry Point\n<!-- forgekit-override: test -->\n'
  big_body y
} > "$repo/AGENTS.md"
run_check "overridden over-cap AGENTS.md fails on SIZE only" "$repo"
expect_rc 1
expect_has "skip:  AGENTS.md (forgekit-override marker)"
expect_has "SIZE:  AGENTS.md"
expect_has "forgekit-override does not exempt host load rules"
expect_no_line "DRIFT:"
expect_no_line "MISSING:"
expect_no_line "FORMAT:"

# 5b. Control: overridden AGENTS.md under the cap passes
repo="$(new_repo under-cap-override)"
printf '# Agent Entry Point\n<!-- forgekit-override: test -->\nLocal body.\n' > "$repo/AGENTS.md"
run_check "overridden under-cap AGENTS.md" "$repo"
expect_rc 0

# 6. AGENTS.md starting with YAML frontmatter fails when not overridden
repo="$(new_repo frontmatter)"
{
  printf -- '---\nactivation: always\n---\n'
  cat "$repo/AGENTS.md"
} > "$repo/AGENTS.md.tmp"
mv "$repo/AGENTS.md.tmp" "$repo/AGENTS.md"
run_check "frontmatter AGENTS.md" "$repo"
expect_rc 1
expect_has "FORMAT: AGENTS.md"

# 6b. Overridden AGENTS.md with frontmatter still fails on FORMAT alone
repo="$(new_repo frontmatter-override)"
printf -- '---\n<!-- forgekit-override: test -->\n---\n# Agent Entry Point\n' > "$repo/AGENTS.md"
run_check "overridden frontmatter AGENTS.md fails on FORMAT only" "$repo"
expect_rc 1
expect_has "FORMAT: AGENTS.md"
expect_no_line "DRIFT:"
expect_no_line "SIZE:"

# 7. CLAUDE.md has no byte cap or frontmatter rule (Antigravity does not load it)
repo="$(new_repo claude-no-cap)"
{
  printf -- '---\n<!-- forgekit-override: test -->\n---\n'
  big_body z
} > "$repo/CLAUDE.md"
run_check "CLAUDE.md exempt from Antigravity rules" "$repo"
expect_rc 0
expect_no_line "SIZE:"
expect_no_line "FORMAT:"

# 8. Standalone GEMINI.md over the cap fails (host rules still apply)
repo="$(new_repo gemini-over-cap)"
{
  printf '# Gemini Entry Point\n'
  big_body g
} > "$repo/GEMINI.md"
run_check "standalone over-cap GEMINI.md" "$repo"
expect_rc 1
expect_has "SIZE:  GEMINI.md"

# 9. GEMINI.md symlink to CLAUDE.md fails
repo="$(new_repo gemini-to-claude)"
ln -s CLAUDE.md "$repo/GEMINI.md"
run_check "GEMINI.md -> CLAUDE.md" "$repo"
expect_rc 1
expect_has "LINK:  GEMINI.md"
expect_has "ln -sfn AGENTS.md GEMINI.md"

# 10. GEMINI.md symlink to another in-repo file fails
repo="$(new_repo gemini-to-other)"
ln -s docs/WORKFLOW.md "$repo/GEMINI.md"
run_check "GEMINI.md -> docs/WORKFLOW.md" "$repo"
expect_rc 1
expect_has "LINK:  GEMINI.md"

# 11. Broken GEMINI.md symlink fails
repo="$(new_repo gemini-broken)"
ln -s does-not-exist.md "$repo/GEMINI.md"
run_check "broken GEMINI.md symlink" "$repo"
expect_rc 1
expect_has "LINK:  GEMINI.md"

# 12. A missing entrypoint does not abort the run: later drift and the
#     remediation footer are still reported
repo="$(new_repo missing-and-drift)"
rm "$repo/CLAUDE.md"
printf '\nlocal edit\n' >> "$repo/docs/WORKFLOW.md"
run_check "missing CLAUDE.md plus docs drift" "$repo"
expect_rc 1
expect_has "MISSING: CLAUDE.md"
expect_has "DRIFT: docs/WORKFLOW.md"
expect_has "drift detected:"
expect_has "scripts/update-harness.sh <target> --force"

# 13. Entrypoint symlinks resolving outside the repository fail without
#     printing the outside file's content
mkdir -p "$TMP_DIR/outside"
printf '# Agent Entry Point\nOUTSIDE_SECRET_7f3a\n' > "$TMP_DIR/outside/secret.md"
for name in AGENTS.md CLAUDE.md GEMINI.md; do
  repo="$(new_repo "outside-$name")"
  rm -f "$repo/$name"
  if [ "$name" = "CLAUDE.md" ]; then
    ln -s "../outside/secret.md" "$repo/$name"
  else
    ln -s "$TMP_DIR/outside/secret.md" "$repo/$name"
  fi
  run_check "$name symlink outside repository" "$repo"
  expect_rc 1
  expect_has "LINK:  $name"
  expect_lacks "OUTSIDE_SECRET_7f3a"
done

# 13b. Control: an entrypoint symlink resolving inside the repository is checked normally
repo="$(new_repo inside-symlink)"
mkdir -p "$repo/.harness"
mv "$repo/AGENTS.md" "$repo/.harness/AGENTS.md"
ln -s .harness/AGENTS.md "$repo/AGENTS.md"
run_check "AGENTS.md symlink inside repository" "$repo"
expect_rc 0

# 14. update-harness.sh pre-check blocks a GEMINI.md symlink that does not
#     resolve to AGENTS.md, even with --force, before changing any file
repo="$(new_repo update-gemini-bad)"
ln -s CLAUDE.md "$repo/GEMINI.md"
printf '\nlocal edit\n' >> "$repo/docs/WORKFLOW.md"
cp "$repo/docs/WORKFLOW.md" "$TMP_DIR/workflow.before"
LABEL="update-harness blocks bad GEMINI.md symlink"
CASES=$((CASES + 1))
capture bash "$ROOT/scripts/update-harness.sh" "$repo" --force
expect_rc 1
expect_has "LINK: GEMINI.md"
expect_has "update stopped before changing files"
cmp -s "$repo/docs/WORKFLOW.md" "$TMP_DIR/workflow.before" \
  || fail "update-harness changed files despite the pre-check failure"

# 14b. update-harness.sh accepts GEMINI.md -> AGENTS.md and a standalone GEMINI.md
repo="$(new_repo update-gemini-ok)"
ln -s AGENTS.md "$repo/GEMINI.md"
LABEL="update-harness accepts GEMINI.md -> AGENTS.md"
CASES=$((CASES + 1))
capture bash "$ROOT/scripts/update-harness.sh" "$repo"
expect_rc 0
repo="$(new_repo update-gemini-standalone)"
printf '# Gemini Entry Point\n\nProject-managed body.\n' > "$repo/GEMINI.md"
LABEL="update-harness warns on standalone GEMINI.md"
CASES=$((CASES + 1))
capture bash "$ROOT/scripts/update-harness.sh" "$repo"
expect_rc 0
expect_has "warn: GEMINI.md is a project-managed standalone file"

echo "check-harness-sync contract tests passed ($CASES cases)"
