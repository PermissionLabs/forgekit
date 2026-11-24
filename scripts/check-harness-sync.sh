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
#   Entrypoints (see ENTRYPOINT_FILES below):
#     AGENTS.md, CLAUDE.md: required; only the title line may differ from
#       templates/.
#     GEMINI.md: optional alias of AGENTS.md. A symlink must resolve to
#       AGENTS.md. A regular file is project-managed: its body is not compared
#       with the template (warning only), but host load rules still apply.
#     Each entrypoint must also satisfy the load rules of every host that
#     auto-loads it (see ENTRYPOINT_HOST_RULES below: per-file byte cap,
#     frontmatter). Entrypoints that are symlinks resolving outside the
#     repository fail without their content being printed.
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
#   deviation and record the reason inline. The marker only exempts the
#   template comparison; it never exempts host load rules (a host that
#   truncates or rejects the file drops rules silently either way).
#
# Exit codes
#   0  in sync
#   1  drift detected
#   2  bad usage or missing inputs

set -euo pipefail

# Host entrypoint load rules: one row per (host, auto-loaded root file).
#   host|file|max_bytes|frontmatter
#   max_bytes    per-file load cap in bytes ('-' = no cap); the host truncates
#                the tail beyond it, so exceeding it is drift.
#   frontmatter  'forbid' = must not start with a YAML '---' line; '-' = no rule.
# Common logic below reads only this table; it never branches on file names.
ENTRYPOINT_HOST_RULES='
claude|CLAUDE.md|-|-
codex|AGENTS.md|-|-
antigravity|AGENTS.md|24000|forbid
antigravity|GEMINI.md|24000|forbid
'

# Root entrypoint files ForgeKit checks.
#   file|policy
#   template    required; body must match templates/<file> (title may differ)
#   alias:<f>   optional; a symlink must resolve to <f>; a regular file is
#               project-managed (warning only) and still gets host rules.
ENTRYPOINT_FILES='
AGENTS.md|template
CLAUDE.md|template
GEMINI.md|alias:AGENTS.md
'

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
template_drift=0
host_rule_drift=0
link_drift=0
report_drift() {
  drift=1
  echo "$@" >&2
}
# Template drift (DRIFT / MISSING / STALE).
note_drift() {
  template_drift=1
  report_drift "$@"
}
# Host load-rule violations (SIZE / FORMAT); forgekit-override never exempts.
note_host_rule_drift() {
  host_rule_drift=1
  report_drift "$@"
}
# Entrypoint symlink problems (LINK); content is never printed.
note_link_drift() {
  link_drift=1
  report_drift "$@"
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
    return 0
  fi
  if [ ! -f "$target_file" ]; then
    note_drift "MISSING: $label"
    return 0
  fi
  if has_override "$target_file"; then
    echo "skip:  $label (forgekit-override marker)"
    return 0
  fi
  if diff_ignore_title "$target_file" "$template_file" > /dev/null; then
    echo "ok:    $label (title-line diff allowed)"
  else
    note_drift "DRIFT: $label — diff beyond title line"
    diff_ignore_title "$target_file" "$template_file" >&2 || true
  fi
}

# Print the physical path a (possibly symlinked) file resolves to. Fails on
# loops or unresolvable parent directories. Portable to macOS bash 3.2
# (no readlink -f / realpath dependency).
resolve_physical() {
  local p="$1" link dir n=0
  while [ -L "$p" ]; do
    n=$((n + 1))
    [ "$n" -le 40 ] || return 1
    link="$(readlink "$p")" || return 1
    case "$link" in
      /*) p="$link" ;;
      *) p="$(dirname "$p")/$link" ;;
    esac
  done
  dir="$(CDPATH='' cd "$(dirname "$p")" 2>/dev/null && pwd -P)" || return 1
  printf '%s/%s\n' "$dir" "$(basename "$p")"
}

# True when $1 is a symlink that resolves outside repo root $2 (or cannot be
# resolved at all).
symlink_escapes_repo() {
  local f="$1" root="$2" root_phys resolved
  [ -L "$f" ] || return 1
  root_phys="$(CDPATH='' cd "$root" && pwd -P)"
  resolved="$(resolve_physical "$f")" || return 0
  case "$resolved" in
    "$root_phys"/*) return 1 ;;
    *) return 0 ;;
  esac
}

# Apply every ENTRYPOINT_HOST_RULES row whose file column is $2.
check_host_rules() {
  local target_file="$1" name="$2"
  local host file max_bytes frontmatter size first_line
  while IFS='|' read -r host file max_bytes frontmatter; do
    [ -n "$host" ] && [ "$file" = "$name" ] || continue
    if [ "$max_bytes" != "-" ]; then
      size="$(wc -c < "$target_file" | tr -d '[:space:]')"
      if [ "$size" -gt "$max_bytes" ]; then
        note_host_rule_drift "SIZE:  $name is ${size} bytes (> ${max_bytes}-byte $host per-file load cap; the tail is truncated silently — move detail into docs/)"
      fi
    fi
    if [ "$frontmatter" = "forbid" ]; then
      first_line="$(head -n 1 "$target_file" 2>/dev/null || true)"
      first_line="${first_line%$'\r'}"
      if [ "$first_line" = "---" ]; then
        note_host_rule_drift "FORMAT: $name starts with YAML frontmatter (---); $host loads it as standalone Markdown — remove the frontmatter"
      fi
    fi
  done <<EOF
$ENTRYPOINT_HOST_RULES
EOF
  return 0
}

check_template_entrypoint() {
  local root="$1" name="$2"
  local f="$root/$name"
  if symlink_escapes_repo "$f" "$root"; then
    note_link_drift "LINK:  $name is a symlink resolving outside the repository (-> $(readlink "$f")); content not shown — replace it with a regular file inside the repository"
    return 0
  fi
  check_title_only "$f" "$templates/$name" "$name"
  [ -f "$f" ] || return 0
  check_host_rules "$f" "$name"
}

check_alias_entrypoint() {
  local root="$1" name="$2" alias_of="$3"
  local f="$root/$name" a="$root/$alias_of"
  if [ -L "$f" ]; then
    if [ -e "$f" ] && [ -e "$a" ] && [ "$f" -ef "$a" ]; then
      echo "ok:    $name (symlink to $alias_of — deduplicated by realpath)"
    else
      note_link_drift "LINK:  $name is a symlink (-> $(readlink "$f")) that does not resolve to $alias_of (broken, other file, or outside the repository); content not shown — fix: (cd \"$root\" && ln -sfn $alias_of $name), or remove it"
    fi
    return 0
  fi
  [ -e "$f" ] || return 0
  if [ ! -f "$f" ]; then
    note_link_drift "LINK:  $name is not a regular file or a symlink to $alias_of — remove it"
    return 0
  fi
  echo "warn:  $name is a project-managed standalone file; its body is not compared with templates/$alias_of (prefer: ln -sfn $alias_of $name)" >&2
  check_host_rules "$f" "$name"
}

check_entrypoints() {
  local root="$1" name policy
  while IFS='|' read -r name policy; do
    [ -n "$name" ] || continue
    case "$policy" in
      template) check_template_entrypoint "$root" "$name" ;;
      alias:*) check_alias_entrypoint "$root" "$name" "${policy#alias:}" ;;
      *) note_drift "unknown entrypoint policy (forgekit bug): $name|$policy" ;;
    esac
  done <<EOF
$ENTRYPOINT_FILES
EOF
  return 0
}

check_exact() {
  local target_file="$1" template_file="$2" label="$3"
  if [ ! -f "$template_file" ]; then
    note_drift "template missing (forgekit bug): $template_file"
    return 0
  fi
  if [ ! -f "$target_file" ]; then
    note_drift "MISSING: $label"
    return 0
  fi
  if has_override "$target_file"; then
    echo "skip:  $label (forgekit-override marker)"
    return 0
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
  [ -d "$target_dir" ] || return 0
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
  check_entrypoints "$forgekit_root"
  check_exact "$forgekit_root/docs/PHASE_REFS.json" "$templates/docs/PHASE_REFS.json" "docs/PHASE_REFS.json"
else
  echo "Downstream harness sync check: $mode_target"

  # Entrypoints — title-line diff allowed, plus host load rules.
  check_entrypoints "$mode_target"

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
  echo "drift detected:" >&2
  if [ "$template_drift" -ne 0 ]; then
    if [ -n "$mode_internal" ]; then
      echo "  - DRIFT/MISSING: make the root file and its templates/ copy agree." >&2
    else
      echo "  - DRIFT/MISSING: run scripts/update-harness.sh <target> --force to restore" >&2
      echo "    ForgeKit-owned files (docs/PROJECT_CONTEXT.md is preserved), or add a" >&2
      echo "    forgekit-override marker if the deviation is intentional." >&2
      echo "  - STALE: delete the stale file, or add a forgekit-override marker if it" >&2
      echo "    is an intentional project extension." >&2
    fi
  fi
  if [ "$host_rule_drift" -ne 0 ]; then
    echo "  - SIZE/FORMAT: shrink the entrypoint (move detail into docs/) or remove" >&2
    echo "    leading YAML frontmatter; forgekit-override does not exempt host load rules." >&2
  fi
  if [ "$link_drift" -ne 0 ]; then
    echo "  - LINK: apply the fix named on each LINK line; update-harness.sh --force" >&2
    echo "    does not repair entrypoint symlinks." >&2
  fi
  exit 1
fi

echo "all checked files in sync"
exit 0
