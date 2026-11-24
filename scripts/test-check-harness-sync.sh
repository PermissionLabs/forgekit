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

# 17. Write guard control: symlinks resolving inside the repository are
#     replaced by regular files (the link itself), never written through, so
#     the in-repo files they pointed to keep their content.
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
inside_tree="$(tree_hash "$repo/.harness")"
run_script "update-harness --force replaces in-repo symlinks" \
  "$ROOT/scripts/update-harness.sh" "$repo" --force
expect_rc 0
[ "$(tree_hash "$repo/.harness")" = "$inside_tree" ] \
  || fail "update-harness wrote through an in-repo symlink"
for f in docs/WORKFLOW.md AGENTS.md .gitignore; do
  [ -f "$repo/$f" ] && [ ! -L "$repo/$f" ] || fail "$f is still a symlink"
done
cmp -s "$repo/docs/WORKFLOW.md" "$ROOT/templates/docs/WORKFLOW.md" \
  || fail "docs/WORKFLOW.md does not match the template"
grep -qxF 'node_modules/' "$repo/.gitignore" && grep -qxF '.context/' "$repo/.gitignore" \
  || fail ".gitignore lost its content or the .context/ line"

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

# 18b. bootstrap.sh control: an in-repo symlink is replaced, not written through
dir="$TMP_DIR/boot-inside"
mkdir -p "$dir/.harness"
git -C "$dir" init -q
printf 'project notes\n' > "$dir/.harness/agents.md"
ln -s .harness/agents.md "$dir/AGENTS.md"
inside_hash="$(hash_of "$dir/.harness/agents.md")"
run_script "bootstrap --force replaces in-repo symlink" \
  "$ROOT/scripts/bootstrap.sh" "$dir" --force
expect_rc 0
[ "$(hash_of "$dir/.harness/agents.md")" = "$inside_hash" ] \
  || fail "bootstrap wrote through an in-repo symlink"
[ -f "$dir/AGENTS.md" ] && [ ! -L "$dir/AGENTS.md" ] || fail "AGENTS.md is still a symlink"
cmp -s "$dir/AGENTS.md" "$ROOT/templates/AGENTS.md" || fail "AGENTS.md does not match the template"

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
printf 'node_modules/\n' > "$repo/.harness/gitignore"
rm -f "$repo/.gitignore"
ln -s .harness/gitignore "$repo/.gitignore"
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
[ -f "$repo/.gitignore" ] && [ ! -L "$repo/.gitignore" ] || fail ".gitignore is still a symlink"
expect_planted_intact "$repo"

dir="$TMP_DIR/tmp-canary-boot"
mkdir -p "$dir/.harness" "$dir/.context"
git -C "$dir" init -q
printf 'node_modules/\n' > "$dir/.harness/gitignore"
ln -s .harness/gitignore "$dir/.gitignore"
LABEL="bootstrap ignores pre-placed predictable temp names"
CASES=$((CASES + 1))
capture plant_and_exec "$dir" "$ROOT/scripts/bootstrap.sh" "$dir"
expect_rc 0
grep -qxF '.context/' "$dir/.gitignore" && grep -qxF 'node_modules/' "$dir/.gitignore" \
  || fail ".gitignore lost its content or the .context/ line"
[ "$(cat "$dir/.harness/gitignore")" = "node_modules/" ] || fail "bootstrap wrote through an in-repo .gitignore link"
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

echo "check-harness-sync contract tests passed ($CASES cases)"
