#!/usr/bin/env bash
# ForgeKit harness sync check: verify a target repo's harness-owned files
# are byte-identical to templates/. Built for issue #3 — downstream repos
# were drifting from the harness silently after bootstrap.
#
# Usage:
#   scripts/check-harness-sync.sh <target-repo-path>
#   scripts/check-harness-sync.sh --forgekit
#
# What gets checked
#   Entrypoints (AGENTS.md, CLAUDE.md, and optional GEMINI.md): only the title
#     line may differ (GEMINI.md -> AGENTS.md symlink is accepted as-is).
#     Entrypoints are also checked against Antigravity's 24,000-byte per-file
#     rule cap and standalone Markdown format (no leading YAML frontmatter).
#   Helper scripts (scripts/worktree-add.sh): byte-identical.
#   Core docs (AGENT_GUIDE.md, WORKFLOW.md, PHASE_REFS.json): byte-identical.
#   Skill files (design-skills/*, review-skills/*): byte-identical.
#   Command-skill convention (command-skills/README.md): byte-identical.
#     (Project command skills under command-skills/ are NOT checked.)
#   Template files (CHANGE_TEMPLATE.md, DECISION_TEMPLATE.md,
#                   REVIEW_TEMPLATE.md): byte-identical.
#
# Escape hatch
#   Files containing the marker `forgekit-override:` in their first 5
#   lines are skipped with a note. JSON files may use a top-level
#   `"forgekit-override"` key instead. Use this for intentional local
#   deviation and record the reason inline.
#
# Exit codes
#   0  in sync
#   1  drift detected
#   2  bad usage or missing inputs

set -euo pipefail

usage() {
  cat <<'EOF'
usage: scripts/check-harness-sync.sh <target-repo-path>
       scripts/check-harness-sync.sh --forgekit

Checks that the target's harness-owned files are byte-identical to the
ForgeKit templates. See the file header for what is checked and how to
opt out per-file via a `forgekit-override:` marker.
EOF
}

if [ "$#" -ne 1 ]; then
  usage >&2
  exit 2
fi

forgekit_root="$(cd "$(dirname "$0")/.." && pwd)"
templates="$forgekit_root/templates"

if [ ! -d "$templates" ]; then
  echo "error: templates/ not found at $templates" >&2
  exit 2
fi

mode_internal=""
mode_target=""

case "$1" in
  -h|--help)
    usage
    exit 0
    ;;
  --forgekit)
    mode_internal=1
    ;;
  *)
    if [ ! -d "$1" ]; then
      echo "error: target is not a directory: $1" >&2
      exit 2
    fi
    mode_target="$(cd "$1" && pwd)"
    ;;
esac

drift=0
note_drift() {
  drift=1
  echo "$@" >&2
}

has_override() {
  local f="$1"
  # Require a comment prefix, or a JSON key for JSON files, so that prose
  # documenting the marker (e.g. BOOTSTRAP.md, a future runbook template)
  # cannot accidentally bypass the check by mentioning the literal string.
  [ -f "$f" ] && head -n 5 "$f" 2>/dev/null \
    | grep -qE '^[[:space:]]*((<!--|#|//)[[:space:]]*forgekit-override:|"forgekit-override"[[:space:]]*:)'
}

# Diff that ignores the first line (used for entrypoints where only the
# title legitimately differs between host variants).
diff_ignore_title() {
  diff <(tail -n +2 "$1") <(tail -n +2 "$2")
}

check_title_only() {
  local target_file="$1" template_file="$2" label="$3"
  if [ ! -f "$template_file" ]; then
    note_drift "template missing (forgekit bug): $template_file"
    return
  fi
  if [ ! -f "$target_file" ]; then
    note_drift "MISSING: $label"
    return
  fi
  if has_override "$target_file"; then
    echo "skip:  $label (forgekit-override marker)"
    return
  fi
  if diff_ignore_title "$target_file" "$template_file" > /dev/null; then
    echo "ok:    $label (title-line diff allowed)"
  else
    note_drift "DRIFT: $label — diff beyond title line"
    diff_ignore_title "$target_file" "$template_file" >&2 || true
  fi
}

ANTIGRAVITY_RULE_MAX_BYTES=24000

check_entrypoint_antigravity() {
  local target_file="$1" label="$2"
  [ -f "$target_file" ] || return
  local size
  size="$(wc -c < "$target_file" | tr -d '[:space:]')"
  if [ "$size" -gt "$ANTIGRAVITY_RULE_MAX_BYTES" ]; then
    if has_override "$target_file"; then
      echo "warn:  $label is ${size} bytes (> ${ANTIGRAVITY_RULE_MAX_BYTES}-byte Antigravity cap; tail will be truncated — move detail into docs/)" >&2
    else
      note_drift "SIZE:  $label is ${size} bytes (> ${ANTIGRAVITY_RULE_MAX_BYTES}-byte Antigravity cap; move detail into docs/)"
    fi
  fi
  if [ "$label" != "CLAUDE.md" ]; then
    local first_line
    first_line="$(head -n 1 "$target_file" 2>/dev/null || true)"
    first_line="${first_line%$'\r'}"
    if [ "$first_line" = "---" ]; then
      if has_override "$target_file"; then
        echo "warn:  $label starts with YAML frontmatter (---); Antigravity loads $label as standalone Markdown without frontmatter" >&2
      else
        note_drift "FORMAT: $label starts with YAML frontmatter (---); Antigravity expects standalone Markdown"
      fi
    fi
  fi
}

check_optional_gemini_entrypoint() {
  local target_dir="$1"
  local gemini_file="$target_dir/GEMINI.md"
  local agents_file="$target_dir/AGENTS.md"
  if [ ! -e "$gemini_file" ] && [ ! -L "$gemini_file" ]; then
    return
  fi
  if [ -L "$gemini_file" ] && [ -f "$agents_file" ] && [ "$gemini_file" -ef "$agents_file" ]; then
    echo "ok:    GEMINI.md (symlink to AGENTS.md — deduplicated by Antigravity)"
    return
  fi
  check_title_only "$gemini_file" "$templates/AGENTS.md" "GEMINI.md"
  check_entrypoint_antigravity "$gemini_file" "GEMINI.md"
}

check_exact() {
  local target_file="$1" template_file="$2" label="$3"
  if [ ! -f "$template_file" ]; then
    note_drift "template missing (forgekit bug): $template_file"
    return
  fi
  if [ ! -f "$target_file" ]; then
    note_drift "MISSING: $label"
    return
  fi
  if has_override "$target_file"; then
    echo "skip:  $label (forgekit-override marker)"
    return
  fi
  if cmp -s "$target_file" "$template_file"; then
    echo "ok:    $label"
  else
    note_drift "DRIFT: $label"
    diff "$target_file" "$template_file" >&2 || true
  fi
}

# Flag downstream files in a harness-owned directory that no longer
# exist in templates/. These are stale rules — templates renamed or
# removed the file, but the downstream copy survives and agents may
# still read it. Project-local extensions can be exempted with a
# forgekit-override marker.
check_no_stale_in_dir() {
  local target_dir="$1" template_dir="$2" label_prefix="$3"
  [ -d "$target_dir" ] || return
  while IFS= read -r target_file; do
    rel="${target_file#$target_dir/}"
    if [ -f "$template_dir/$rel" ]; then
      continue
    fi
    if has_override "$target_file"; then
      echo "skip:  $label_prefix/$rel (project extension, forgekit-override)"
    else
      note_drift "STALE: $label_prefix/$rel (file not present in templates)"
    fi
  done < <(find "$target_dir" -type f -name '*.md')
}

if [ -n "$mode_internal" ]; then
  echo "ForgeKit internal parity check (root vs templates):"
  check_title_only "$forgekit_root/AGENTS.md" "$templates/AGENTS.md" "AGENTS.md"
  check_entrypoint_antigravity "$forgekit_root/AGENTS.md" "AGENTS.md"
  check_title_only "$forgekit_root/CLAUDE.md" "$templates/CLAUDE.md" "CLAUDE.md"
  check_entrypoint_antigravity "$forgekit_root/CLAUDE.md" "CLAUDE.md"
  check_optional_gemini_entrypoint "$forgekit_root"
  check_exact "$forgekit_root/docs/PHASE_REFS.json" "$templates/docs/PHASE_REFS.json" "docs/PHASE_REFS.json"
else
  echo "Downstream harness sync check: $mode_target"

  # Entrypoints — title-line diff allowed.
  check_title_only "$mode_target/AGENTS.md" "$templates/AGENTS.md" "AGENTS.md"
  check_entrypoint_antigravity "$mode_target/AGENTS.md" "AGENTS.md"
  check_title_only "$mode_target/CLAUDE.md" "$templates/CLAUDE.md" "CLAUDE.md"
  check_entrypoint_antigravity "$mode_target/CLAUDE.md" "CLAUDE.md"
  check_optional_gemini_entrypoint "$mode_target"

  # Helper scripts — exact match.
  check_exact "$mode_target/scripts/worktree-add.sh" "$forgekit_root/scripts/worktree-add.sh" "scripts/worktree-add.sh"

  # Core docs — exact match.
  check_exact "$mode_target/docs/AGENT_GUIDE.md" "$templates/docs/AGENT_GUIDE.md" "docs/AGENT_GUIDE.md"
  check_exact "$mode_target/docs/WORKFLOW.md" "$templates/docs/WORKFLOW.md" "docs/WORKFLOW.md"
  check_exact "$mode_target/docs/PHASE_REFS.json" "$templates/docs/PHASE_REFS.json" "docs/PHASE_REFS.json"

  # Skill files — exact match for every file the template ships, and
  # nothing in the downstream skill dirs that templates no longer has.
  for skill_dir in design-skills review-skills; do
    if [ -d "$templates/docs/$skill_dir" ]; then
      while IFS= read -r src; do
        rel="${src#$templates/}"
        check_exact "$mode_target/$rel" "$src" "$rel"
      done < <(find "$templates/docs/$skill_dir" -type f -name '*.md')
    fi
    check_no_stale_in_dir \
      "$mode_target/docs/$skill_dir" \
      "$templates/docs/$skill_dir" \
      "docs/$skill_dir"
  done

  # Command-skill convention README is harness-owned guidance. The command
  # skills themselves are project-local (e.g. docs/command-skills/pick.md), so
  # this dir is NOT stale-checked — only the README is held byte-identical.
  # COMMAND_SKILL_TEMPLATE.md is covered by the *_TEMPLATE.md loop below.
  check_exact \
    "$mode_target/docs/command-skills/README.md" \
    "$templates/docs/command-skills/README.md" \
    "docs/command-skills/README.md"

  # Template files — should stay byte-identical so downstream forks have
  # the same starting point. Auto-discovered to avoid the same drift
  # class this script exists to prevent. Also check for *_TEMPLATE.md
  # files in the target that templates no longer ships (renames/removes).
  while IFS= read -r src; do
    rel="${src#$templates/}"
    check_exact "$mode_target/$rel" "$src" "$rel"
  done < <(find "$templates/docs" -type f -name '*_TEMPLATE.md')

  while IFS= read -r target_file; do
    rel="${target_file#$mode_target/}"
    if [ -f "$templates/$rel" ]; then
      continue
    fi
    if has_override "$target_file"; then
      echo "skip:  $rel (project extension, forgekit-override)"
    else
      note_drift "STALE: $rel (template file not present in templates/)"
    fi
  done < <(find "$mode_target/docs" -type f -name '*_TEMPLATE.md' 2>/dev/null)
fi

echo ""
if [ "$drift" -ne 0 ]; then
  echo "drift detected — re-bootstrap (scripts/bootstrap.sh <target> --force)," >&2
  echo "or add a forgekit-override marker if the deviation is intentional." >&2
  exit 1
fi

echo "all checked files in sync"
exit 0
