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

# Content hash of a file (sha256; portable between macOS and Linux CI).
hash_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 < "$1"
  else
    sha256sum < "$1"
  fi
}

# Hash of every file under a directory, by relative path.
tree_hash() {
  (cd "$1" && find . -type f | sort | while IFS= read -r f; do
    printf '%s %s\n' "$f" "$(hash_of "$f")"
  done)
}

run_script() {
  LABEL="$1"
  shift
  CASES=$((CASES + 1))
  capture bash "$@"
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

# 13c. X3: an intermediate directory symlink plus `..` (redirect/../file)
#      resolves physically outside the repository; the logical path looks
#      in-repo. Must fail as LINK without printing the outside content.
mkdir -p "$TMP_DIR/outside-x3/child"
printf '# Agent Entry Point\nOUTSIDE_X3_MARK_b41c\n' > "$TMP_DIR/outside-x3/fixture.md"
repo="$(new_repo outside-dotdot)"
ln -s "../outside-x3/child" "$repo/redirect"
rm -f "$repo/AGENTS.md"
ln -s "redirect/../fixture.md" "$repo/AGENTS.md"
run_check "AGENTS.md -> redirect/../fixture.md resolves outside" "$repo"
expect_rc 1
expect_has "LINK:  AGENTS.md"
expect_lacks "OUTSIDE_X3_MARK_b41c"
expect_no_line "DRIFT: AGENTS.md"

# 13d. C7: docs and skill files compared by check_exact get the same guard —
#      a direct symlink, a redirect/../ symlink, and a symlinked parent
#      directory all fail as LINK and never diff the outside content.
mkdir -p "$TMP_DIR/outside-c7/child" "$TMP_DIR/outside-c7/review-skills"
printf 'OUTSIDE_DOC_MARK_9d2e\n' > "$TMP_DIR/outside-c7/doc.md"
printf 'OUTSIDE_DOC_MARK_9d2e\n' > "$TMP_DIR/outside-c7/via.md"
repo="$(new_repo outside-docs)"
for f in "$repo"/docs/review-skills/*.md; do
  cp "$f" "$TMP_DIR/outside-c7/review-skills/"
  printf 'OUTSIDE_DOC_MARK_9d2e\n' >> "$TMP_DIR/outside-c7/review-skills/$(basename "$f")"
done
rm -f "$repo/docs/WORKFLOW.md" "$repo/docs/AGENT_GUIDE.md"
ln -s "$TMP_DIR/outside-c7/doc.md" "$repo/docs/WORKFLOW.md"
ln -s "../outside-c7/child" "$repo/redirect"
ln -s "../redirect/../via.md" "$repo/docs/AGENT_GUIDE.md"
rm -rf "$repo/docs/review-skills"
ln -s "$TMP_DIR/outside-c7/review-skills" "$repo/docs/review-skills"
run_check "docs/skill files resolving outside the repository" "$repo"
expect_rc 1
expect_has "LINK:  docs/WORKFLOW.md"
expect_has "LINK:  docs/AGENT_GUIDE.md"
expect_has "LINK:  docs/review-skills/README.md resolves outside the repository (through a symlinked parent directory)"
expect_lacks "OUTSIDE_DOC_MARK_9d2e"
expect_no_line "DRIFT: docs/"

# 13e. Control: a docs file symlinked to an identical in-repo copy passes
repo="$(new_repo docs-inside-symlink)"
mkdir -p "$repo/.harness"
mv "$repo/docs/WORKFLOW.md" "$repo/.harness/WORKFLOW.md"
ln -s ../.harness/WORKFLOW.md "$repo/docs/WORKFLOW.md"
run_check "docs file symlink inside repository" "$repo"
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

# 14c. X4: when the final sync check fails, update-harness.sh hints follow the
#      drift class. SIZE (not exempted by forgekit-override) must not be told
#      to add a forgekit-override marker.
repo="$(new_repo update-size)"
{
  printf '# Agent Entry Point\n<!-- forgekit-override: test -->\n'
  big_body s
} > "$repo/AGENTS.md"
LABEL="update-harness SIZE failure hint"
CASES=$((CASES + 1))
capture bash "$ROOT/scripts/update-harness.sh" "$repo"
expect_rc 1
expect_has "SIZE:  AGENTS.md"
expect_has "hint: SIZE/FORMAT: shrink the entrypoint"
expect_lacks "hint: DRIFT/MISSING/STALE:"
expect_lacks "hint: LINK:"
expect_lacks "forgekit-override marker where the target should diverge"

# 14d. X4: a STALE file keeps the forgekit-override hint
repo="$(new_repo update-stale)"
printf '# Old skill\n' > "$repo/docs/review-skills/retired-skill.md"
LABEL="update-harness STALE failure hint"
CASES=$((CASES + 1))
capture bash "$ROOT/scripts/update-harness.sh" "$repo"
expect_rc 1
expect_has "STALE: docs/review-skills/retired-skill.md"
expect_has "hint: DRIFT/MISSING/STALE: remove stale harness files, or add a forgekit-override"
expect_lacks "hint: SIZE/FORMAT:"

# 15. Write guard: update-harness.sh --force refuses a harness file that is a
#     symlink resolving outside the repository. The outside file keeps its
#     hash, its content is not printed, and no other file is written (another
#     drifted file that --force would restore stays as it was).
mkdir -p "$TMP_DIR/outside-w1"
printf 'OUTSIDE_WRITE_MARK_51aa\n' > "$TMP_DIR/outside-w1/workflow.md"
outside_hash="$(hash_of "$TMP_DIR/outside-w1/workflow.md")"
repo="$(new_repo write-outside-file)"
rm -f "$repo/docs/WORKFLOW.md"
ln -s "$TMP_DIR/outside-w1/workflow.md" "$repo/docs/WORKFLOW.md"
printf '\nlocal edit\n' >> "$repo/docs/AGENT_GUIDE.md"
guide_hash="$(hash_of "$repo/docs/AGENT_GUIDE.md")"
run_script "update-harness --force refuses outside symlink target" \
  "$ROOT/scripts/update-harness.sh" "$repo" --force
expect_rc 1
expect_has "LINK: docs/WORKFLOW.md symlink -> $TMP_DIR/outside-w1/workflow.md resolves outside the repository"
expect_has "--force does not override this"
expect_has "update stopped before changing files"
expect_lacks "OUTSIDE_WRITE_MARK_51aa"
[ "$(hash_of "$TMP_DIR/outside-w1/workflow.md")" = "$outside_hash" ] \
  || fail "outside file changed"
[ -L "$repo/docs/WORKFLOW.md" ] || fail "symlink was replaced despite the refusal"
[ "$(hash_of "$repo/docs/AGENT_GUIDE.md")" = "$guide_hash" ] \
  || fail "partial update: docs/AGENT_GUIDE.md was written despite the refusal"

# 15b. Write guard: a dangling symlink to an outside path must not create the
#      outside file (cp would create it through the link).
repo="$(new_repo write-outside-dangling)"
rm -f "$repo/docs/PROJECT_CONTEXT.md"
ln -s "$TMP_DIR/outside-w1/created-by-cp.md" "$repo/docs/PROJECT_CONTEXT.md"
run_script "update-harness --force refuses dangling outside symlink" \
  "$ROOT/scripts/update-harness.sh" "$repo" --force
expect_rc 1
expect_has "LINK: docs/PROJECT_CONTEXT.md symlink ->"
[ ! -e "$TMP_DIR/outside-w1/created-by-cp.md" ] \
  || fail "file created outside the repository through a dangling symlink"

# 15c. Write guard: appended/rewritten non-harness files (.gitignore) get the
#      same refusal.
printf 'node_modules/\n' > "$TMP_DIR/outside-w1/gitignore"
outside_hash="$(hash_of "$TMP_DIR/outside-w1/gitignore")"
repo="$(new_repo write-outside-gitignore)"
rm -f "$repo/.gitignore"
ln -s "$TMP_DIR/outside-w1/gitignore" "$repo/.gitignore"
run_script "update-harness refuses outside .gitignore symlink" \
  "$ROOT/scripts/update-harness.sh" "$repo" --force
expect_rc 1
expect_has "LINK: .gitignore symlink ->"
[ "$(hash_of "$TMP_DIR/outside-w1/gitignore")" = "$outside_hash" ] \
  || fail "outside .gitignore changed"

# 16. Write guard: a symlinked parent directory resolving outside the
#     repository. Existing files with drift (review-skills) and files that
#     would be newly created inside it (design-skills, empty outside dir)
#     are both refused; the outside trees keep their hashes.
mkdir -p "$TMP_DIR/outside-w2/review-skills" "$TMP_DIR/outside-w2/design-skills"
repo="$(new_repo write-outside-parent)"
for f in "$repo"/docs/review-skills/*.md; do
  { cat "$f"; printf 'OUTSIDE_PARENT_MARK_c3d0\n'; } \
    > "$TMP_DIR/outside-w2/review-skills/$(basename "$f")"
done
rm -rf "$repo/docs/review-skills" "$repo/docs/design-skills"
ln -s "$TMP_DIR/outside-w2/review-skills" "$repo/docs/review-skills"
ln -s "../../outside-w2/design-skills" "$repo/docs/design-skills"
before_tree="$(tree_hash "$TMP_DIR/outside-w2")"
run_script "update-harness --force refuses symlinked parent directory" \
  "$ROOT/scripts/update-harness.sh" "$repo" --force
expect_rc 1
expect_has "LINK: docs/review-skills/README.md resolves outside the repository through a symlinked parent directory"
expect_has "LINK: docs/design-skills/FIGMA.md parent directory resolves outside the repository"
expect_lacks "OUTSIDE_PARENT_MARK_c3d0"
[ "$(tree_hash "$TMP_DIR/outside-w2")" = "$before_tree" ] \
  || fail "files outside the repository changed through a symlinked parent"

# 17. PR #25: a symlink on a managed path is refused even when it resolves
#     inside the repository (check-target-paths.sh). Nothing is written: the
#     links stay links and the in-repo files they point to keep their content.
repo="$(new_repo write-inside-links)"
mkdir -p "$repo/.harness"
mv "$repo/docs/WORKFLOW.md" "$repo/.harness/WORKFLOW.md"
printf '\nlocal edit\n' >> "$repo/.harness/WORKFLOW.md"
ln -s ../.harness/WORKFLOW.md "$repo/docs/WORKFLOW.md"
mv "$repo/AGENTS.md" "$repo/.harness/AGENTS.md"
printf '\nlocal edit\n' >> "$repo/.harness/AGENTS.md"
ln -s .harness/AGENTS.md "$repo/AGENTS.md"
printf 'node_modules/\n' > "$repo/.harness/gitignore"
rm -f "$repo/.gitignore"
ln -s .harness/gitignore "$repo/.gitignore"
repo_tree="$(tree_hash "$repo")"
run_script "update-harness --force refuses in-repo symlinks on managed paths" \
  "$ROOT/scripts/update-harness.sh" "$repo" --force
expect_rc 1
for f in AGENTS.md .gitignore docs/WORKFLOW.md; do
  expect_has "error: symlink in managed destination: "
  printf '%s\n' "$OUT" | grep -Fq -- "/write-inside-links/$f" || fail "no refusal for $f"
  [ -L "$repo/$f" ] || fail "$f was replaced despite the refusal"
done
expect_has "update stopped before changing files"
[ "$(tree_hash "$repo")" = "$repo_tree" ] \
  || fail "partial update: files written despite the refusal"

# 17b. PR #25: a symlinked directory inside the repository above a managed
#      path is refused too (the destination's ancestors are checked up to the
#      target root), by both writers.
repo="$(new_repo write-inside-dirlink)"
mkdir -p "$repo/.harness"
mv "$repo/docs/review-skills" "$repo/.harness/review-skills"
ln -s ../.harness/review-skills "$repo/docs/review-skills"
repo_tree="$(tree_hash "$repo")"
run_script "update-harness --force refuses an in-repo symlinked directory" \
  "$ROOT/scripts/update-harness.sh" "$repo" --force
expect_rc 1
expect_has "error: symlink in managed destination: "
printf '%s\n' "$OUT" | grep -Fq -- "/write-inside-dirlink/docs/review-skills" \
  || fail "no refusal for docs/review-skills"
[ "$(tree_hash "$repo")" = "$repo_tree" ] || fail "files written despite the refusal"
run_script "bootstrap --force refuses an in-repo symlinked directory" \
  "$ROOT/scripts/bootstrap.sh" "$repo" --force
expect_rc 1
expect_has "error: symlink in managed destination: "
expect_has "bootstrap stopped before changing files"
[ "$(tree_hash "$repo")" = "$repo_tree" ] || fail "files written despite the refusal"

# 17c. PR #25: a symlinked target root is refused by both writers before
#      anything is checked or written.
repo="$(new_repo target-real)"
ln -s "$repo" "$TMP_DIR/target-link"
printf '\nlocal edit\n' >> "$repo/CLAUDE.md"
repo_tree="$(tree_hash "$repo")"
run_script "update-harness refuses a symlinked target" \
  "$ROOT/scripts/update-harness.sh" "$TMP_DIR/target-link" --force
expect_rc 1
expect_has "error: target is a symlink"
run_script "bootstrap refuses a symlinked target" \
  "$ROOT/scripts/bootstrap.sh" "$TMP_DIR/target-link" --force
expect_rc 1
expect_has "error: target is a symlink"
[ "$(tree_hash "$repo")" = "$repo_tree" ] || fail "files written through a symlinked target"
# X10/A12/A14: [ -L ] follows the link when the name ends in "/" or "/.", so
# these spellings must be normalised before the check, for both writers.
# "target-link/docs/.." is caught only by the logical-path (pwd -L) check:
# cd folds it to target-link, while lstat resolves it to the real repo.
for spelling in "target-link/" "target-link//" "target-link/." "target-link/./" "target-link/docs/.."; do
  for writer in update-harness bootstrap; do
    run_script "$writer refuses a symlinked target spelled $spelling" \
      "$ROOT/scripts/$writer.sh" "$TMP_DIR/$spelling" --force
    expect_rc 1
    expect_has "error: target is a symlink"
    [ "$(tree_hash "$repo")" = "$repo_tree" ] \
      || fail "files written through a symlinked target spelled $spelling"
  done
done

# The logical check must not depend on the caller's shell mode: with an
# inherited `set -P` (SHELLOPTS=physical) a plain cd resolves physically.
for writer in update-harness bootstrap; do
  LABEL="$writer refuses target-link/docs/.. under SHELLOPTS=physical"
  CASES=$((CASES + 1))
  capture env SHELLOPTS=physical bash "$ROOT/scripts/$writer.sh" "$TMP_DIR/target-link/docs/.." --force
  expect_rc 1
  expect_has "error: target is a symlink"
  [ "$(tree_hash "$repo")" = "$repo_tree" ] || fail "files written through target-link/docs/.. (physical mode)"
done

# r11 A15: the resolving cd must be logical too. box is a real directory and
# box/sub links into the symlinked target, so box/sub/.. is box logically but
# the linked repository physically; the writers must never reach the repo.
for writer in update-harness bootstrap; do
  LABEL="$writer resolves box/sub/.. to box under SHELLOPTS=physical"
  CASES=$((CASES + 1))
  mkdir "$TMP_DIR/box-$writer"
  ln -s "$TMP_DIR/target-link/docs" "$TMP_DIR/box-$writer/sub"
  capture env SHELLOPTS=physical bash "$ROOT/scripts/$writer.sh" "$TMP_DIR/box-$writer/sub/.." --force
  [ "$(tree_hash "$repo")" = "$repo_tree" ] || fail "files written into the linked repo through box/sub/.. (physical mode)"
done

# 17c-2. X11: a target directory literally named "-" (spelled "-", "-/" or
#        "-/.") is that directory, never $OLDPWD (cd's "-" operand). OLDPWD
#        names another repository with drift that must stay untouched.
mkdir -p "$TMP_DIR/dash"
dash_repo="$(new_repo dash/-)"
old_repo="$(new_repo dash-oldpwd)"
printf '\nlocal edit\n' >> "$old_repo/CLAUDE.md"
old_tree="$(tree_hash "$old_repo")"
for spelling in "-" "-/" "-/."; do
  for writer in update-harness bootstrap; do
    printf '\nlocal edit\n' >> "$dash_repo/CLAUDE.md"
    LABEL="$writer treats a target spelled $spelling as the directory named -"
    CASES=$((CASES + 1))
    capture bash -c 'cd "$1" && OLDPWD="$2" exec bash "$3" "$4" --force' _ \
      "$TMP_DIR/dash" "$old_repo" "$ROOT/scripts/$writer.sh" "$spelling"
    expect_rc 0
    diff <(tail -n +2 "$dash_repo/CLAUDE.md") <(tail -n +2 "$ROOT/templates/CLAUDE.md") >/dev/null \
      || fail "CLAUDE.md in the \"-\" repository not updated"
    [ "$(tree_hash "$old_repo")" = "$old_tree" ] || fail "$writer wrote into \$OLDPWD"
  done
done

# 17d. PR #25: a managed destination that exists but is not a regular file
#      (a directory) is refused by both writers.
repo="$(new_repo write-nonregular)"
rm -f "$repo/CLAUDE.md"
mkdir "$repo/CLAUDE.md"
run_script "update-harness --force refuses a non-regular managed destination" \
  "$ROOT/scripts/update-harness.sh" "$repo" --force
expect_rc 1
expect_has "error: managed destination is not a regular file: "
[ -d "$repo/CLAUDE.md" ] || fail "CLAUDE.md directory was replaced"
run_script "bootstrap --force refuses a non-regular managed destination" \
  "$ROOT/scripts/bootstrap.sh" "$repo" --force
expect_rc 1
expect_has "error: managed destination is not a regular file: "
[ -d "$repo/CLAUDE.md" ] || fail "CLAUDE.md directory was replaced"

# 17e. PR #25: rewriting an existing file through a temp file keeps the
#      file's own mode (title-preserving entrypoint copy, workflow-state
#      resume_protocol update); only new files get the umask default.
repo="$(new_repo mode-preserved)"
printf '\nlocal edit\n' >> "$repo/CLAUDE.md"
chmod 600 "$repo/CLAUDE.md"
printf '\nlocal edit\n' >> "$repo/AGENTS.md"
chmod 755 "$repo/AGENTS.md"
if command -v jq >/dev/null 2>&1; then
  jq 'del(.resume_protocol.phase_refs_source)' "$repo/.context/workflow-state.json" > "$TMP_DIR/mode-state.json"
  cat "$TMP_DIR/mode-state.json" > "$repo/.context/workflow-state.json"
  chmod 640 "$repo/.context/workflow-state.json"
fi
run_script "update-harness --force preserves file modes" \
  "$ROOT/scripts/update-harness.sh" "$repo" --force
expect_rc 0
expect_has "copy: CLAUDE.md (body updated, title preserved)"
expect_has "copy: AGENTS.md (body updated, title preserved)"
file_mode() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then stat -f '%Lp' "$1"; else stat -c '%a' "$1"; fi
}
[ "$(file_mode "$repo/CLAUDE.md")" = "600" ] || fail "CLAUDE.md mode $(file_mode "$repo/CLAUDE.md"), want 600"
[ "$(file_mode "$repo/AGENTS.md")" = "755" ] || fail "AGENTS.md mode $(file_mode "$repo/AGENTS.md"), want 755"
if command -v jq >/dev/null 2>&1; then
  expect_has "update: .context/workflow-state.json resume_protocol"
  [ "$(file_mode "$repo/.context/workflow-state.json")" = "640" ] \
    || fail "workflow-state.json mode $(file_mode "$repo/.context/workflow-state.json"), want 640"
fi

# 18. bootstrap.sh --force gets the same write guard: an outside file
#     symlink and an outside parent directory are refused before anything is
#     written (no partial bootstrap); outside files keep their hashes.
mkdir -p "$TMP_DIR/outside-b1/docs"
printf 'OUTSIDE_BOOT_MARK_e8f1\n' > "$TMP_DIR/outside-b1/agents.md"
before_tree="$(tree_hash "$TMP_DIR/outside-b1")"
dir="$TMP_DIR/boot-outside"
mkdir -p "$dir"
git -C "$dir" init -q
ln -s "$TMP_DIR/outside-b1/agents.md" "$dir/AGENTS.md"
ln -s "$TMP_DIR/outside-b1/docs" "$dir/docs"
run_script "bootstrap --force refuses outside write targets" \
  "$ROOT/scripts/bootstrap.sh" "$dir" --force
expect_rc 1
expect_has "LINK: AGENTS.md symlink -> $TMP_DIR/outside-b1/agents.md resolves outside the repository"
expect_has "LINK: docs/WORKFLOW.md parent directory resolves outside the repository"
expect_has "bootstrap stopped before changing files"
expect_lacks "OUTSIDE_BOOT_MARK_e8f1"
[ "$(tree_hash "$TMP_DIR/outside-b1")" = "$before_tree" ] \
  || fail "bootstrap changed files outside the target"
[ ! -e "$dir/CLAUDE.md" ] && [ ! -e "$dir/.gitignore" ] \
  || fail "partial bootstrap: files written despite the refusal"

# 18b. PR #25: bootstrap refuses an in-repo symlink on a managed path too;
#      the link and the file it points to are left as they were.
dir="$TMP_DIR/boot-inside"
mkdir -p "$dir/.harness"
git -C "$dir" init -q
printf 'project notes\n' > "$dir/.harness/agents.md"
ln -s .harness/agents.md "$dir/AGENTS.md"
repo_tree="$(tree_hash "$dir")"
run_script "bootstrap --force refuses an in-repo symlink" \
  "$ROOT/scripts/bootstrap.sh" "$dir" --force
expect_rc 1
expect_has "error: symlink in managed destination: "
expect_has "bootstrap stopped before changing files"
[ -L "$dir/AGENTS.md" ] || fail "AGENTS.md link was replaced despite the refusal"
[ "$(tree_hash "$dir")" = "$repo_tree" ] || fail "partial bootstrap: files written despite the refusal"

# 19. X5: temp files are created exclusively (mktemp), never at the old
#     predictable "<file>.tmp.<PID>" / "<file>.forgekit-tmp.<PID>" names.
#     `exec` keeps the wrapper's PID, so the script's $$ is known here and
#     canary links at every old name point outside. The outside canary keeps
#     its hash, the planted links stay untouched, and no temp file is left.
mkdir -p "$TMP_DIR/outside-x5"
printf 'OUTSIDE_TMP_CANARY_5c0e\n' > "$TMP_DIR/outside-x5/canary"
canary_hash="$(hash_of "$TMP_DIR/outside-x5/canary")"
# plant_and_exec <repo> <script> [args...]: plant canary links for this PID,
# then exec the script under the same PID.
plant_and_exec() {
  # shellcheck disable=SC2016
  bash -c '
    repo="$1" canary="$2"; shift 2
    for n in AGENTS.md CLAUDE.md .context/workflow-state.json .gitignore; do
      ln -s "$canary" "$repo/$n.tmp.$$"
      ln -s "$canary" "$repo/$n.forgekit-tmp.$$"
      printf "%s\n" "$repo/$n.tmp.$$" "$repo/$n.forgekit-tmp.$$" >> "$repo.planted"
    done
    exec bash "$@"
  ' _ "$1" "$TMP_DIR/outside-x5/canary" "${@:2}"
}
expect_planted_intact() {
  local l
  while IFS= read -r l; do
    [ -L "$l" ] && [ "$(readlink "$l")" = "$TMP_DIR/outside-x5/canary" ] \
      || fail "planted link was replaced or removed: $l"
  done < "$1.planted"
  [ "$(hash_of "$TMP_DIR/outside-x5/canary")" = "$canary_hash" ] \
    || fail "outside canary changed through a predictable temp name"
  if find "$1" ! -type l \( -name '*forgekit-tmp*' -o -name '.workflow-state.json.tmp.*' \) | grep -q .; then
    fail "temp file left behind: $(find "$1" ! -type l -name '*tmp*')"
  fi
}
repo="$(new_repo tmp-canary-update)"
mkdir -p "$repo/.harness"
printf '\nlocal edit\n' >> "$repo/AGENTS.md"
printf '\nlocal edit\n' >> "$repo/CLAUDE.md"
# A plain .gitignore without .context/ (a .gitignore link is refused since
# PR #25, so the in-place append path is exercised here).
printf 'node_modules/\n' > "$repo/.gitignore"
if command -v jq >/dev/null 2>&1; then
  jq 'del(.resume_protocol.phase_refs_source)' "$repo/.context/workflow-state.json" \
    > "$repo/.harness/state" && mv "$repo/.harness/state" "$repo/.context/workflow-state.json"
fi
LABEL="update-harness ignores pre-placed predictable temp names"
CASES=$((CASES + 1))
capture plant_and_exec "$repo" "$ROOT/scripts/update-harness.sh" "$repo" --force
expect_rc 0
expect_has "copy: AGENTS.md (body updated, title preserved)"
expect_has "update: .gitignore"
if command -v jq >/dev/null 2>&1; then
  expect_has "update: .context/workflow-state.json resume_protocol"
  [ "$(jq -r .resume_protocol.phase_refs_source "$repo/.context/workflow-state.json")" = "docs/PHASE_REFS.json" ] \
    || fail "workflow-state.json was not updated"
fi
same_entry_body() { diff <(tail -n +2 "$1") <(tail -n +2 "$2") >/dev/null; }
same_entry_body "$repo/AGENTS.md" "$ROOT/templates/AGENTS.md" || fail "AGENTS.md body not updated"
grep -qxF '.context/' "$repo/.gitignore" && grep -qxF 'node_modules/' "$repo/.gitignore" \
  || fail ".gitignore lost its content or the .context/ line"
expect_planted_intact "$repo"

dir="$TMP_DIR/tmp-canary-boot"
mkdir -p "$dir/.harness" "$dir/.context"
git -C "$dir" init -q
printf 'node_modules/\n' > "$dir/.gitignore"
LABEL="bootstrap ignores pre-placed predictable temp names"
CASES=$((CASES + 1))
capture plant_and_exec "$dir" "$ROOT/scripts/bootstrap.sh" "$dir"
expect_rc 0
grep -qxF '.context/' "$dir/.gitignore" && grep -qxF 'node_modules/' "$dir/.gitignore" \
  || fail ".gitignore lost its content or the .context/ line"
expect_planted_intact "$dir"

# 19b. X5: a failed state update removes its temp file (the EXIT trap and the
#      explicit cleanup), and leaves the state file as it was.
if command -v jq >/dev/null 2>&1; then
  repo="$(new_repo tmp-cleanup)"
  printf 'not json\n' > "$repo/.context/workflow-state.json"
  run_script "update-harness cleans its temp file when jq fails" \
    "$ROOT/scripts/update-harness.sh" "$repo"
  expect_has "warn: could not update .context/workflow-state.json"
  [ "$(cat "$repo/.context/workflow-state.json")" = "not json" ] || fail "state file changed"
  ! find "$repo" -name '*forgekit-tmp*' | grep -q . || fail "temp file left behind"
fi

# 20. Write guard resolves `..` physically (m8): redirect -> ../outside/child,
#     so redirect/../X is outside/X on disk but repo/X logically. A decoy
#     in-repo dskills/ makes the logical reading look valid. Both writers must
#     refuse before writing anything (no partial update) and the outside tree
#     keeps its hash.
mkdir -p "$TMP_DIR/outside-w3/child" "$TMP_DIR/outside-w3/dskills"
printf '# Agent Entry Point\nOUTSIDE_W3_MARK_2d7a\n' > "$TMP_DIR/outside-w3/fixture.md"
printf 'keep\n' > "$TMP_DIR/outside-w3/dskills/.keep"
plant_dotdot() {
  ln -s "../outside-w3/child" "$1/redirect"
  mkdir -p "$1/dskills" "$1/docs"
  printf 'decoy\n' > "$1/dskills/.keep"
  rm -f "$1/AGENTS.md"
  ln -s "redirect/../fixture.md" "$1/AGENTS.md"
  rm -rf "$1/docs/design-skills"
  ln -s "../redirect/../dskills" "$1/docs/design-skills"
}
before_tree="$(tree_hash "$TMP_DIR/outside-w3")"
repo="$(new_repo write-dotdot)"
printf '\nlocal edit\n' >> "$repo/CLAUDE.md"
plant_dotdot "$repo"
repo_tree="$(tree_hash "$repo")"
run_script "update-harness --force refuses redirect/../ write targets" \
  "$ROOT/scripts/update-harness.sh" "$repo" --force
expect_rc 1
expect_has "LINK: AGENTS.md symlink -> redirect/../fixture.md resolves outside the repository"
expect_has "LINK: docs/design-skills/FIGMA.md parent directory resolves outside the repository"
expect_lacks "OUTSIDE_W3_MARK_2d7a"
[ "$(tree_hash "$TMP_DIR/outside-w3")" = "$before_tree" ] \
  || fail "update-harness changed files outside the repository through redirect/../"
[ "$(tree_hash "$repo")" = "$repo_tree" ] \
  || fail "partial update: files written despite the refusal"

dir="$TMP_DIR/boot-dotdot"
mkdir -p "$dir"
git -C "$dir" init -q
plant_dotdot "$dir"
repo_tree="$(tree_hash "$dir")"
run_script "bootstrap --force refuses redirect/../ write targets" \
  "$ROOT/scripts/bootstrap.sh" "$dir" --force
expect_rc 1
expect_has "LINK: AGENTS.md symlink -> redirect/../fixture.md resolves outside the repository"
expect_has "LINK: docs/design-skills/FIGMA.md parent directory resolves outside the repository"
[ "$(tree_hash "$TMP_DIR/outside-w3")" = "$before_tree" ] \
  || fail "bootstrap changed files outside the target through redirect/../"
[ "$(tree_hash "$dir")" = "$repo_tree" ] \
  || fail "partial bootstrap: files written despite the refusal"

# 21. X6: under umask 0222 the temp files must stay writable until their
#     content is complete; the final mode is applied just before the rename.
#     Applying it first made every temp write fail. The final mode is the
#     replaced file's own mode (PR #25 preserve_mode: 0644 here), or the
#     umask default (0444) for a new file.
mode_of() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}
expect_no_tmp() {
  ! find "$1" \( -name '*forgekit-tmp*' -o -name '.workflow-state.json.tmp.*' \) | grep -q . \
    || fail "temp file left behind"
}
if command -v jq >/dev/null 2>&1; then
  repo="$(new_repo umask-update)"
  printf '\nlocal edit\n' >> "$repo/CLAUDE.md"
  jq '.resume_protocol.read_this_file_on = []' "$repo/.context/workflow-state.json" > "$TMP_DIR/umask-state.json"
  cat "$TMP_DIR/umask-state.json" > "$repo/.context/workflow-state.json"
  LABEL="update-harness --force under umask 0222"
  CASES=$((CASES + 1))
  capture bash -c 'umask 0222; exec bash "$0" "$1" --force' "$ROOT/scripts/update-harness.sh" "$repo"
  expect_rc 0
  expect_has "copy: CLAUDE.md (body updated, title preserved)"
  expect_has "update: .context/workflow-state.json resume_protocol"
  same_entry_body "$repo/CLAUDE.md" "$ROOT/templates/CLAUDE.md" || fail "CLAUDE.md body not updated"
  [ "$(mode_of "$repo/CLAUDE.md")" = "644" ] || fail "CLAUDE.md mode $(mode_of "$repo/CLAUDE.md"), want 644 (preserved)"
  [ "$(mode_of "$repo/.context/workflow-state.json")" = "644" ] \
    || fail "workflow-state.json mode $(mode_of "$repo/.context/workflow-state.json"), want 644 (preserved)"
  [ "$(jq -r .resume_protocol.phase_refs_source "$repo/.context/workflow-state.json")" = "docs/PHASE_REFS.json" ] \
    || fail "workflow-state.json was not updated"
  expect_no_tmp "$repo"
fi

# 21b. X6/A13: an existing read-only (0444) regular file is rewritten through
#      a temp file and keeps 0444. The temp must stay 0600 while it is written:
#      applying the final (preserved) mode in make_sibling_tmp instead of
#      commit_sibling_tmp makes the temp read-only and the write fails.
if command -v jq >/dev/null 2>&1; then
  repo="$(new_repo readonly-update)"
  printf '\nlocal edit\n' >> "$repo/CLAUDE.md"
  chmod 444 "$repo/CLAUDE.md"
  jq '.resume_protocol.read_this_file_on = []' "$repo/.context/workflow-state.json" > "$TMP_DIR/ro-state.json"
  cat "$TMP_DIR/ro-state.json" > "$repo/.context/workflow-state.json"
  chmod 444 "$repo/.context/workflow-state.json"
  run_script "update-harness --force rewrites read-only (0444) files and keeps 0444" \
    "$ROOT/scripts/update-harness.sh" "$repo" --force
  expect_rc 0
  expect_has "copy: CLAUDE.md (body updated, title preserved)"
  expect_has "update: .context/workflow-state.json resume_protocol"
  same_entry_body "$repo/CLAUDE.md" "$ROOT/templates/CLAUDE.md" || fail "CLAUDE.md body not updated"
  [ "$(mode_of "$repo/CLAUDE.md")" = "444" ] || fail "CLAUDE.md mode $(mode_of "$repo/CLAUDE.md"), want 444 (preserved)"
  [ "$(mode_of "$repo/.context/workflow-state.json")" = "444" ] \
    || fail "workflow-state.json mode $(mode_of "$repo/.context/workflow-state.json"), want 444 (preserved)"
  [ "$(jq -r .resume_protocol.phase_refs_source "$repo/.context/workflow-state.json")" = "docs/PHASE_REFS.json" ] \
    || fail "workflow-state.json was not updated"
  expect_no_tmp "$repo"
fi

repo="$(new_repo umask-boot)"
mkdir -p "$repo/.harness"
printf 'node_modules/' > "$repo/.harness/gitignore"
rm -f "$repo/.gitignore"
ln -s .harness/gitignore "$repo/.gitignore"
LABEL="bootstrap --force under umask 0222 refuses a .gitignore link"
CASES=$((CASES + 1))
capture bash -c 'umask 0222; exec bash "$0" "$1" --force' "$ROOT/scripts/bootstrap.sh" "$repo"
expect_rc 1
expect_has "error: symlink in managed destination: "
[ -L "$repo/.gitignore" ] || fail ".gitignore link was replaced despite the refusal"
[ "$(cat "$repo/.harness/gitignore")" = "node_modules/" ] || fail "bootstrap wrote through the .gitignore link"
expect_no_tmp "$repo"

# worktree-add: git itself cannot create .git/worktrees/<name> or checkout
# directories under umask 0222, so a shim runs git with umask 022 and the
# checkout tracks .context/ (mkdir -p under 0222 would make it read-only).
# Only the state seed then runs under umask 0222.
if command -v jq >/dev/null 2>&1; then
  wt_src="$TMP_DIR/umask-wt-src"
  mkdir -p "$wt_src/scripts" "$wt_src/.context" "$TMP_DIR/umask-git-shim"
  cp "$ROOT/scripts/worktree-add.sh" "$wt_src/scripts/worktree-add.sh"
  printf 'keep\n' > "$wt_src/.context/.keep"
  git -C "$wt_src" init -q
  git -C "$wt_src" add -A
  git -C "$wt_src" -c user.name=t -c user.email=t@example.invalid commit -qm init
  real_git="$(command -v git)"
  printf '#!/bin/sh\numask 022\nexec "%s" "$@"\n' "$real_git" > "$TMP_DIR/umask-git-shim/git"
  chmod +x "$TMP_DIR/umask-git-shim/git"
  wt_path="$TMP_DIR/umask-wt"
  LABEL="worktree-add seeds state under umask 0222"
  CASES=$((CASES + 1))
  capture env PATH="$TMP_DIR/umask-git-shim:$PATH" bash -c 'umask 0222; exec bash "$0" "$1" -b umask-task HEAD' \
    "$wt_src/scripts/worktree-add.sh" "$wt_path"
  expect_rc 0
  expect_has "Seeded state:"
  [ "$(jq -r .branch "$wt_path/.context/workflow-state.json")" = "umask-task" ] || fail "state not seeded"
  [ "$(mode_of "$wt_path/.context/workflow-state.json")" = "444" ] \
    || fail "seeded state mode $(mode_of "$wt_path/.context/workflow-state.json"), want 444"
  expect_no_tmp "$wt_path/.context"

  # A failed rename removes the incomplete worktree (the temp-file cleanup
  # itself is asserted in a kept worktree further below: here `worktree
  # remove` deletes the seed directory either way).
  mkdir -p "$TMP_DIR/failing-mv-shim"
  printf '#!/bin/sh\nexit 1\n' > "$TMP_DIR/failing-mv-shim/mv"
  chmod +x "$TMP_DIR/failing-mv-shim/mv"
  wt_path="$TMP_DIR/mvfail-wt"
  LABEL="worktree-add removes the incomplete worktree when the rename fails"
  CASES=$((CASES + 1))
  capture env PATH="$TMP_DIR/failing-mv-shim:$PATH" bash "$wt_src/scripts/worktree-add.sh" "$wt_path" -b mvfail-task HEAD
  expect_rc 1
  expect_has "error: failed to seed workflow state"
  [ ! -e "$wt_path" ] || fail "incomplete worktree left behind"
fi

# ── r5 (A1–A9) ────────────────────────────────────────────────────────────
# Every entry under a directory (links included, with their targets) plus
# regular-file hashes, so a new temp file, a replaced link or a changed
# file outside the repository all change the value.
tree_state() {
  (cd "$1" && find . -print | sort && find . -type l -exec readlink {} \; | sort)
  tree_hash "$1"
}

# 22. A1: an outside-linked parent directory holding a symlink back inside
#     the repository. resolve_physical of the final target lands inside, but
#     the write (unlink + copy, or sibling temp + rename) happens in the
#     outside directory. Both writers must refuse, even without --force.
mkdir -p "$TMP_DIR/outside-a1u" "$TMP_DIR/outside-a1b"
repo="$(new_repo a1-update)"
rm -rf "$repo/.context"
ln -s "$TMP_DIR/outside-a1u" "$repo/.context"
ln -s "$repo/a1-inside-dangling" "$TMP_DIR/outside-a1u/workflow-state.json"
before_tree="$(tree_state "$TMP_DIR/outside-a1u")"
run_script "update-harness refuses an outside parent holding a link back inside" \
  "$ROOT/scripts/update-harness.sh" "$repo"
expect_rc 1
expect_has "LINK: .context/workflow-state.json"
expect_has "update stopped before changing files"
[ "$(tree_state "$TMP_DIR/outside-a1u")" = "$before_tree" ] \
  || fail "update-harness wrote into an outside parent directory"

dir="$TMP_DIR/a1-boot"
mkdir -p "$dir/docs"
git -C "$dir" init -q
printf '{}\n' > "$dir/docs/inside.json"
ln -s "$TMP_DIR/outside-a1b" "$dir/.context"
ln -s "$dir/docs/inside.json" "$TMP_DIR/outside-a1b/workflow-state.json"
before_tree="$(tree_state "$TMP_DIR/outside-a1b")"
repo_tree="$(tree_state "$dir")"
run_script "bootstrap refuses an outside parent holding a link back inside" \
  "$ROOT/scripts/bootstrap.sh" "$dir"
expect_rc 1
expect_has "LINK: .context/workflow-state.json"
expect_has "bootstrap stopped before changing files"
[ "$(tree_state "$TMP_DIR/outside-a1b")" = "$before_tree" ] \
  || fail "bootstrap wrote into an outside parent directory"
[ "$(tree_state "$dir")" = "$repo_tree" ] || fail "partial bootstrap despite the refusal"

# 22b. A8: .context/workflow-state.json and scripts/worktree-add.sh as
#      direct outside links are refused by both writers.
mkdir -p "$TMP_DIR/outside-a8"
printf '{"outside":true}\n' > "$TMP_DIR/outside-a8/state.json"
printf 'OUTSIDE_A8_SCRIPT\n' > "$TMP_DIR/outside-a8/wt.sh"
before_tree="$(tree_state "$TMP_DIR/outside-a8")"
repo="$(new_repo a8-update)"
rm -f "$repo/.context/workflow-state.json" "$repo/scripts/worktree-add.sh"
ln -s "$TMP_DIR/outside-a8/state.json" "$repo/.context/workflow-state.json"
ln -s "$TMP_DIR/outside-a8/wt.sh" "$repo/scripts/worktree-add.sh"
run_script "update-harness --force refuses outside state and helper links" \
  "$ROOT/scripts/update-harness.sh" "$repo" --force
expect_rc 1
expect_has "LINK: .context/workflow-state.json symlink ->"
expect_has "LINK: scripts/worktree-add.sh symlink ->"
expect_lacks "OUTSIDE_A8_SCRIPT"
[ "$(tree_state "$TMP_DIR/outside-a8")" = "$before_tree" ] || fail "outside files changed"

dir="$TMP_DIR/a8-boot"
mkdir -p "$dir/.context" "$dir/scripts"
git -C "$dir" init -q
ln -s "$TMP_DIR/outside-a8/state.json" "$dir/.context/workflow-state.json"
ln -s "$TMP_DIR/outside-a8/wt.sh" "$dir/scripts/worktree-add.sh"
run_script "bootstrap --force refuses outside state and helper links" \
  "$ROOT/scripts/bootstrap.sh" "$dir" --force
expect_rc 1
expect_has "LINK: .context/workflow-state.json symlink ->"
expect_has "LINK: scripts/worktree-add.sh symlink ->"
[ "$(tree_state "$TMP_DIR/outside-a8")" = "$before_tree" ] || fail "outside files changed"

# 23. A3: the checker never lists or reads files of a docs/ directory that
#     resolves outside the repository (stale scan and *_TEMPLATE.md scan).
mkdir -p "$TMP_DIR/outside-a3/docs/review-skills" "$TMP_DIR/outside-a3/docs/changes"
printf '<!-- forgekit-override: x -->\nA3_PRIVATE\n' > "$TMP_DIR/outside-a3/docs/review-skills/private-a3.md"
printf 'secret\n' > "$TMP_DIR/outside-a3/docs/changes/SECRET_A3_TEMPLATE.md"
repo="$(new_repo a3-docs-outside)"
rm -rf "$repo/docs"
ln -s "$TMP_DIR/outside-a3/docs" "$repo/docs"
run_check "checker does not scan an outside docs/ directory" "$repo"
expect_rc 1
expect_has "LINK:  docs/review-skills resolves outside the repository"
expect_lacks "private-a3.md"
expect_lacks "SECRET_A3_TEMPLATE"

# 24. A4/A9: a missing .gitignore is created under umask 0222.
repo="$(new_repo a4-update)"
rm -f "$repo/.gitignore"
LABEL="update-harness creates a missing .gitignore under umask 0222"
CASES=$((CASES + 1))
capture bash -c 'umask 0222; exec bash "$0" "$1"' "$ROOT/scripts/update-harness.sh" "$repo"
expect_rc 0
expect_has "update: .gitignore"
[ "$(cat "$repo/.gitignore")" = ".context/" ] || fail ".gitignore content wrong"

repo="$(new_repo a4-boot)"
rm -f "$repo/.gitignore"
LABEL="bootstrap --force creates a missing .gitignore under umask 0222"
CASES=$((CASES + 1))
capture bash -c 'umask 0222; exec bash "$0" "$1" --force' "$ROOT/scripts/bootstrap.sh" "$repo"
expect_rc 0
[ "$(cat "$repo/.gitignore")" = ".context/" ] || fail ".gitignore content wrong"

# 25. A5: a failed read of the current entrypoint title aborts the update;
#     nothing is committed and no temp file is left. An in-repo symlink to a
#     directory is refused by the pre-check.
repo="$(new_repo a5-unreadable)"
printf '\nlocal edit\n' >> "$repo/AGENTS.md"
chmod 000 "$repo/AGENTS.md"
if [ ! -r "$repo/AGENTS.md" ]; then
  run_script "update-harness --force aborts when the title cannot be read" \
    "$ROOT/scripts/update-harness.sh" "$repo" --force
  [ "$RC" -ne 0 ] || fail "expected a non-zero exit"
  expect_lacks "copy: AGENTS.md"
  chmod 644 "$repo/AGENTS.md"
  [ "$(head -n 1 "$repo/AGENTS.md")" = "# Agent Entry Point" ] || fail "AGENTS.md title lost"
  expect_no_tmp "$repo"
fi
chmod 644 "$repo/AGENTS.md"

repo="$(new_repo a5-dirlink)"
rm -f "$repo/AGENTS.md"
ln -s docs "$repo/AGENTS.md"
run_script "update-harness --force refuses an entrypoint linked to a directory" \
  "$ROOT/scripts/update-harness.sh" "$repo" --force
expect_rc 1
expect_has "LINK: AGENTS.md"
expect_has "update stopped before changing files"
[ -L "$repo/AGENTS.md" ] || fail "AGENTS.md link was changed"

# 26. A6: GEMINI.md that cannot stay a valid alias is refused before any
#     file changes: a directory, and a link that bypasses AGENTS.md to the
#     same in-repo file AGENTS.md links to (AGENTS.md becomes a regular file).
repo="$(new_repo a6-dir)"
mkdir "$repo/GEMINI.md"
printf '\nlocal edit\n' >> "$repo/CLAUDE.md"
repo_tree="$(tree_state "$repo")"
run_script "update-harness --force refuses GEMINI.md directory" \
  "$ROOT/scripts/update-harness.sh" "$repo" --force
expect_rc 1
expect_has "LINK: GEMINI.md"
expect_has "update stopped before changing files"
[ "$(tree_state "$repo")" = "$repo_tree" ] || fail "files changed despite the refusal"

repo="$(new_repo a6-double-link)"
mkdir -p "$repo/.harness"
mv "$repo/AGENTS.md" "$repo/.harness/AGENTS.md"
printf '\nlocal edit\n' >> "$repo/.harness/AGENTS.md"
ln -s .harness/AGENTS.md "$repo/AGENTS.md"
ln -s .harness/AGENTS.md "$repo/GEMINI.md"
repo_tree="$(tree_state "$repo")"
run_script "update-harness --force refuses GEMINI.md bypassing AGENTS.md" \
  "$ROOT/scripts/update-harness.sh" "$repo" --force
expect_rc 1
expect_has "LINK: GEMINI.md"
expect_has "update stopped before changing files"
[ "$(tree_state "$repo")" = "$repo_tree" ] || fail "files changed despite the refusal"

repo="$(new_repo a6-chain-control)"
mkdir -p "$repo/.harness"
mv "$repo/AGENTS.md" "$repo/.harness/AGENTS.md"
printf '\nlocal edit\n' >> "$repo/.harness/AGENTS.md"
ln -s .harness/AGENTS.md "$repo/AGENTS.md"
ln -s AGENTS.md "$repo/GEMINI.md"
repo_tree="$(tree_state "$repo")"
# Since PR #25 the AGENTS.md link itself is refused (managed destination);
# GEMINI.md passes its own check, so only the managed-destination line shows.
run_script "update-harness --force refuses AGENTS.md link under GEMINI.md -> AGENTS.md" \
  "$ROOT/scripts/update-harness.sh" "$repo" --force
expect_rc 1
expect_has "error: symlink in managed destination: "
expect_lacks "LINK: GEMINI.md"
[ "$(tree_state "$repo")" = "$repo_tree" ] || fail "files changed despite the refusal"

# 26b. X7: a GEMINI.md chain that reaches AGENTS.md only through a file the
#      updater replaces (docs/WORKFLOW.md becomes a regular template copy)
#      would stop being an alias after the update; refuse before any change.
repo="$(new_repo x7-managed-hop)"
rm "$repo/docs/WORKFLOW.md"
ln -s ../AGENTS.md "$repo/docs/WORKFLOW.md"
ln -s docs/WORKFLOW.md "$repo/GEMINI.md"
repo_tree="$(tree_state "$repo")"
run_script "update-harness --force refuses GEMINI.md chain through a managed file" \
  "$ROOT/scripts/update-harness.sh" "$repo" --force
expect_rc 1
expect_has "LINK: GEMINI.md"
expect_has "update stopped before changing files"
[ "$(tree_state "$repo")" = "$repo_tree" ] || fail "files changed despite the refusal"
[ -L "$repo/docs/WORKFLOW.md" ] || fail "docs/WORKFLOW.md link was replaced"

# 26c. X8: on a case-insensitive filesystem the same managed hop can be
#      spelled differently (docs/workflow.md, DOCS/WORKFLOW.md); the pre-check
#      must match it by entry identity, not spelling, and still refuse first.
mkdir -p "$TMP_DIR/case-probe"
: > "$TMP_DIR/case-probe/CaseProbe"
if [ -e "$TMP_DIR/case-probe/caseprobe" ]; then
  x8_n=0
  for variant in docs/workflow.md DOCS/WORKFLOW.md; do
    x8_n=$((x8_n + 1))
    repo="$(new_repo "x8-case-$x8_n")"
    rm "$repo/docs/WORKFLOW.md"
    ln -s ../AGENTS.md "$repo/docs/WORKFLOW.md"
    ln -s "$variant" "$repo/GEMINI.md"
    repo_tree="$(tree_state "$repo")"
    run_script "update-harness --force refuses GEMINI.md -> $variant (case variant of a managed file)" \
      "$ROOT/scripts/update-harness.sh" "$repo" --force
    expect_rc 1
    expect_has "LINK: GEMINI.md"
    expect_has "update stopped before changing files"
    [ "$(tree_state "$repo")" = "$repo_tree" ] || fail "files changed despite the refusal"
    [ -L "$repo/docs/WORKFLOW.md" ] || fail "docs/WORKFLOW.md link was replaced"
  done
else
  echo "skip: X8 case-variant tests (temp filesystem is case-sensitive)"
fi

# 26d. A11: the same refusal for a hard-coded managed path (CLAUDE.md) and
#      for an absolute link hop; a multi-hop chain through unmanaged paths
#      that reaches AGENTS.md is still accepted (control).
repo="$(new_repo a11-claude-hop)"
rm "$repo/CLAUDE.md"
ln -s AGENTS.md "$repo/CLAUDE.md"
ln -s CLAUDE.md "$repo/GEMINI.md"
repo_tree="$(tree_state "$repo")"
run_script "update-harness --force refuses GEMINI.md chain through CLAUDE.md" \
  "$ROOT/scripts/update-harness.sh" "$repo" --force
expect_rc 1
expect_has "LINK: GEMINI.md reaches AGENTS.md through CLAUDE.md"
expect_has "update stopped before changing files"
[ "$(tree_state "$repo")" = "$repo_tree" ] || fail "files changed despite the refusal"

repo="$(new_repo a11-absolute-hop)"
rm "$repo/docs/WORKFLOW.md"
ln -s ../AGENTS.md "$repo/docs/WORKFLOW.md"
ln -s "$repo/docs/WORKFLOW.md" "$repo/GEMINI.md"
repo_tree="$(tree_state "$repo")"
run_script "update-harness --force refuses an absolute GEMINI.md link to a managed file" \
  "$ROOT/scripts/update-harness.sh" "$repo" --force
expect_rc 1
expect_has "LINK: GEMINI.md reaches AGENTS.md through docs/WORKFLOW.md"
expect_has "update stopped before changing files"
[ "$(tree_state "$repo")" = "$repo_tree" ] || fail "files changed despite the refusal"

repo="$(new_repo a11-unmanaged-chain)"
mkdir -p "$repo/alias"
ln -s ../AGENTS.md "$repo/alias/one.md"
ln -s one.md "$repo/alias/two.md"
ln -s alias/two.md "$repo/GEMINI.md"
run_script "update-harness --force keeps GEMINI.md chain through unmanaged links" \
  "$ROOT/scripts/update-harness.sh" "$repo" --force
expect_rc 0
[ -L "$repo/GEMINI.md" ] && [ -L "$repo/alias/two.md" ] && [ -L "$repo/alias/one.md" ] \
  || fail "the unmanaged alias chain was replaced"
[ "$repo/GEMINI.md" -ef "$repo/AGENTS.md" ] || fail "GEMINI.md no longer resolves to AGENTS.md"

# 27. A9: CRLF frontmatter and frontmatter on a standalone GEMINI.md.
repo="$(new_repo crlf-frontmatter)"
{
  printf -- '---\r\nactivation: always\r\n---\r\n'
  cat "$repo/AGENTS.md"
} > "$repo/AGENTS.md.new"
mv "$repo/AGENTS.md.new" "$repo/AGENTS.md"
run_check "CRLF frontmatter AGENTS.md" "$repo"
expect_rc 1
expect_has "FORMAT: AGENTS.md"

repo="$(new_repo gemini-frontmatter)"
printf -- '---\nactivation: always\n---\n# Gemini Entry Point\n' > "$repo/GEMINI.md"
run_check "standalone GEMINI.md with frontmatter" "$repo"
expect_rc 1
expect_has "FORMAT: GEMINI.md"

# 28. A7: the bootstrap/update-harness EXIT traps remove the owned temp file
#     when the process is terminated mid-write (an mv shim sends TERM to the
#     script, whose TERM trap exits; only the EXIT trap can clean up).
mkdir -p "$TMP_DIR/term-mv-shim"
printf '#!/bin/sh\nkill -TERM "$PPID"\nexit 1\n' > "$TMP_DIR/term-mv-shim/mv"
chmod +x "$TMP_DIR/term-mv-shim/mv"
repo="$(new_repo a7-update-trap)"
printf '\nlocal edit\n' >> "$repo/CLAUDE.md"
LABEL="update-harness EXIT trap removes its temp file"
CASES=$((CASES + 1))
capture env PATH="$TMP_DIR/term-mv-shim:$PATH" bash "$ROOT/scripts/update-harness.sh" "$repo" --force
[ "$RC" -ne 0 ] || fail "expected a non-zero exit"
expect_no_tmp "$repo"

# Since PR #25 a .gitignore link is refused before any write, so the writers'
# .gitignore temp path (replace_link_with_copy, kept as defence in depth) is
# reached only when the link appears after the pre-check. A chmod shim
# simulates that race: on the writers' `chmod +x .../worktree-add.sh` (after
# the pre-check, before the .gitignore step) it swaps .gitignore for an
# in-repo link whose target lacks .context/.
real_chmod="$(command -v chmod)"
mkdir -p "$TMP_DIR/race-chmod-shim"
cat > "$TMP_DIR/race-chmod-shim/chmod" <<SHIM
#!/bin/sh
if [ "\$1" = "+x" ] && [ -n "\${RACE_REPO:-}" ]; then
  case "\$2" in */scripts/worktree-add.sh)
    rm -f "\$RACE_REPO/.gitignore"
    ln -s .harness/gitignore "\$RACE_REPO/.gitignore" ;;
  esac
fi
exec "$real_chmod" "\$@"
SHIM
"$real_chmod" +x "$TMP_DIR/race-chmod-shim/chmod"
mkdir -p "$TMP_DIR/term-mv-marker-shim"
printf '#!/bin/sh\n: > "%s"\nkill -TERM "$PPID"\nexit 1\n' "$TMP_DIR/term-mv-reached" \
  > "$TMP_DIR/term-mv-marker-shim/mv"
chmod +x "$TMP_DIR/term-mv-marker-shim/mv"

repo="$(new_repo a7-boot-trap)"
mkdir -p "$repo/.harness"
printf 'node_modules/\n' > "$repo/.harness/gitignore"
rm -f "$TMP_DIR/term-mv-reached"
LABEL="bootstrap EXIT trap removes its temp file"
CASES=$((CASES + 1))
capture env RACE_REPO="$repo" PATH="$TMP_DIR/race-chmod-shim:$TMP_DIR/term-mv-marker-shim:$PATH" \
  bash "$ROOT/scripts/bootstrap.sh" "$repo" --force
[ "$RC" -ne 0 ] || fail "expected a non-zero exit"
[ -e "$TMP_DIR/term-mv-reached" ] || fail "the .gitignore temp write was not reached (race shim did not apply)"
[ "$(cat "$repo/.harness/gitignore")" = "node_modules/" ] || fail "bootstrap wrote through the .gitignore link"
expect_no_tmp "$repo"

# Control for the same race without TERM: each writer replaces the new link
# with a regular .gitignore holding the line, and never writes through it.
for writer in bootstrap update-harness; do
  repo="$(new_repo "race-gitignore-$writer")"
  mkdir -p "$repo/.harness"
  printf 'node_modules/\n' > "$repo/.harness/gitignore"
  printf '\nlocal edit\n' >> "$repo/CLAUDE.md"
  LABEL="$writer replaces a .gitignore link that appears after the pre-check"
  CASES=$((CASES + 1))
  capture env RACE_REPO="$repo" PATH="$TMP_DIR/race-chmod-shim:$PATH" \
    bash "$ROOT/scripts/$writer.sh" "$repo" --force
  expect_rc 0
  { [ -f "$repo/.gitignore" ] && [ ! -L "$repo/.gitignore" ]; } || fail ".gitignore is not a regular file"
  [ "$(cat "$repo/.gitignore")" = "$(printf 'node_modules/\n.context/')" ] \
    || fail ".gitignore content: $(cat "$repo/.gitignore")"
  [ "$(cat "$repo/.harness/gitignore")" = "node_modules/" ] || fail "$writer wrote through the .gitignore link"
  expect_no_tmp "$repo"
done

if command -v jq >/dev/null 2>&1; then
  # A7: worktree-add's own cleanup, observed in a worktree that is kept: a
  #     git shim turns `worktree remove` into a no-op so the seed directory
  #     survives, and the failed rename must still remove the temp file.
  mkdir -p "$TMP_DIR/keep-wt-shim"
  printf '#!/bin/sh\nif [ "$3" = worktree ] && [ "$4" = remove ]; then exit 0; fi\nexec "%s" "$@"\n' \
    "$real_git" > "$TMP_DIR/keep-wt-shim/git"
  chmod +x "$TMP_DIR/keep-wt-shim/git"
  wt_path="$TMP_DIR/mvfail-kept-wt"
  LABEL="worktree-add removes its temp file when the rename fails"
  CASES=$((CASES + 1))
  capture env PATH="$TMP_DIR/failing-mv-shim:$TMP_DIR/keep-wt-shim:$PATH" \
    bash "$wt_src/scripts/worktree-add.sh" "$wt_path" -b mvfail-kept HEAD
  expect_rc 1
  [ -d "$wt_path/.context" ] || fail "kept worktree missing (shim did not apply)"
  expect_no_tmp "$wt_path/.context"

  # A7: worktree-add's EXIT trap (TERM during the rename).
  wt_path="$TMP_DIR/term-wt"
  LABEL="worktree-add EXIT trap removes its temp file"
  CASES=$((CASES + 1))
  capture env PATH="$TMP_DIR/term-mv-shim:$PATH" \
    bash "$wt_src/scripts/worktree-add.sh" "$wt_path" -b term-task HEAD
  [ "$RC" -ne 0 ] || fail "expected a non-zero exit"
  [ -d "$wt_path/.context" ] || fail "worktree missing"
  expect_no_tmp "$wt_path/.context"

  # A2 / A8: worktree-add refuses to seed through a committed
  #     .context/workflow-state.json link to a directory (outside or inside),
  #     and through a committed .context link resolving outside.
  # wt_case <name> <setup-in-src>: fresh source repo with the setup committed.
  wt_case_src() {
    local src="$TMP_DIR/$1-src"
    mkdir -p "$src/scripts" "$src/.context"
    cp "$ROOT/scripts/worktree-add.sh" "$src/scripts/worktree-add.sh"
    git -C "$src" init -q
    printf '%s\n' "$src"
  }
  commit_all() {
    git -C "$1" add -A
    git -C "$1" -c user.name=t -c user.email=t@example.invalid commit -qm init
  }
  mkdir -p "$TMP_DIR/outside-a2"
  before_tree="$(tree_state "$TMP_DIR/outside-a2")"

  src="$(wt_case_src a2-state-dirlink)"
  ln -s "$TMP_DIR/outside-a2" "$src/.context/workflow-state.json"
  commit_all "$src"
  run_script "worktree-add refuses a state link to an outside directory" \
    "$src/scripts/worktree-add.sh" "$TMP_DIR/a2-wt1" -b a2-one HEAD
  expect_rc 1
  expect_has "refusing to seed"
  [ "$(tree_state "$TMP_DIR/outside-a2")" = "$before_tree" ] \
    || fail "worktree-add wrote into an outside directory"

  src="$(wt_case_src a2-state-inside-dirlink)"
  mkdir -p "$src/somedir"
  printf 'keep\n' > "$src/somedir/.keep"
  ln -s ../somedir "$src/.context/workflow-state.json"
  commit_all "$src"
  run_script "worktree-add refuses a state link to an in-repo directory" \
    "$src/scripts/worktree-add.sh" "$TMP_DIR/a2-wt2" -b a2-two HEAD
  expect_rc 1
  expect_has "refusing to seed"

  src="$(wt_case_src a2-ctx-outside)"
  rmdir "$src/.context"
  ln -s "$TMP_DIR/outside-a2" "$src/.context"
  commit_all "$src"
  run_script "worktree-add refuses a .context link resolving outside" \
    "$src/scripts/worktree-add.sh" "$TMP_DIR/a2-wt3" -b a2-three HEAD
  expect_rc 1
  expect_has "refusing to seed"
  [ "$(tree_state "$TMP_DIR/outside-a2")" = "$before_tree" ] \
    || fail "worktree-add wrote into an outside .context"

  # A9: X5 regression for worktree-add. A committed link at the old
  #     predictable "$STATE_FILE.tmp.<PID>" name points at an outside canary;
  #     `exec` keeps the PID, so the link is committed for the script's $$.
  src="$(wt_case_src x5-wt)"
  printf 'keep\n' > "$src/.context/.keep"
  commit_all "$src"
  LABEL="worktree-add ignores a pre-placed predictable temp name"
  CASES=$((CASES + 1))
  # shellcheck disable=SC2016
  capture bash -c '
    src="$1" canary="$2" wt="$3"
    ln -s "$canary" "$src/.context/workflow-state.json.tmp.$$"
    git -C "$src" add -A
    git -C "$src" -c user.name=t -c user.email=t@example.invalid commit -qm plant
    exec bash "$src/scripts/worktree-add.sh" "$wt" -b x5-task HEAD
  ' _ "$src" "$TMP_DIR/outside-x5/canary" "$TMP_DIR/x5-wt"
  expect_rc 0
  [ "$(hash_of "$TMP_DIR/outside-x5/canary")" = "$canary_hash" ] \
    || fail "outside canary changed through worktree-add's predictable temp name"
  [ "$(jq -r .branch "$TMP_DIR/x5-wt/.context/workflow-state.json")" = "x5-task" ] \
    || fail "state not seeded"
fi

echo "check-harness-sync contract tests passed ($CASES cases)"
