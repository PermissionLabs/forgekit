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
#   Entrypoints (AGENTS.md, CLAUDE.md): only the title line may differ.
#   Core docs (AGENT_GUIDE.md, WORKFLOW.md): byte-identical.
#   Skill files (design-skills/*, review-skills/*): byte-identical.
#   Template files (CHANGE_TEMPLATE.md, DECISION_TEMPLATE.md,
#                   REVIEW_TEMPLATE.md): byte-identical.
#
# Escape hatch
#   Files containing the marker `forgekit-override:` in their first 5
#   lines are skipped with a note. Use this for intentional local
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
  [ -f "$f" ] && head -n 5 "$f" 2>/dev/null | grep -qE 'forgekit-override:'
}

# Diff that ignores the first line (used for entrypoints where only the
# title legitimately differs between Codex and Claude variants).
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

if [ -n "$mode_internal" ]; then
  echo "ForgeKit internal parity check (root vs templates):"
  check_title_only "$forgekit_root/AGENTS.md" "$templates/AGENTS.md" "AGENTS.md"
  check_title_only "$forgekit_root/CLAUDE.md" "$templates/CLAUDE.md" "CLAUDE.md"
else
  echo "Downstream harness sync check: $mode_target"

  # Entrypoints — title-line diff allowed.
  check_title_only "$mode_target/AGENTS.md" "$templates/AGENTS.md" "AGENTS.md"
  check_title_only "$mode_target/CLAUDE.md" "$templates/CLAUDE.md" "CLAUDE.md"

  # Core docs — exact match.
  check_exact "$mode_target/docs/AGENT_GUIDE.md" "$templates/docs/AGENT_GUIDE.md" "docs/AGENT_GUIDE.md"
  check_exact "$mode_target/docs/WORKFLOW.md" "$templates/docs/WORKFLOW.md" "docs/WORKFLOW.md"

  # Skill files — exact match for every file the template ships.
  for skill_dir in design-skills review-skills; do
    if [ -d "$templates/docs/$skill_dir" ]; then
      while IFS= read -r src; do
        rel="${src#$templates/}"
        check_exact "$mode_target/$rel" "$src" "$rel"
      done < <(find "$templates/docs/$skill_dir" -type f -name '*.md')
    fi
  done

  # Template files — should stay byte-identical so downstream forks have
  # the same starting point.
  for tmpl in \
    docs/changes/CHANGE_TEMPLATE.md \
    docs/decisions/DECISION_TEMPLATE.md \
    docs/audits/REVIEW_TEMPLATE.md
  do
    check_exact "$mode_target/$tmpl" "$templates/$tmpl" "$tmpl"
  done
fi

echo ""
if [ "$drift" -ne 0 ]; then
  echo "drift detected — re-bootstrap (scripts/bootstrap.sh <target> --force)," >&2
  echo "or add a forgekit-override marker if the deviation is intentional." >&2
  exit 1
fi

echo "all checked files in sync"
exit 0
