#!/usr/bin/env bash
# Update ForgeKit-owned files in an already bootstrapped product repo.
# Preserves project-local context and runtime state.

set -euo pipefail

usage() {
  cat <<'EOF'
usage: scripts/update-harness.sh <target-repo-path> [--force]

Updates ForgeKit-owned files in <target-repo-path> from this checkout's
templates/. Refuses to overwrite drifted files unless --force is passed.

Always preserves:
  - docs/PROJECT_CONTEXT.md
  - existing .context/workflow-state.json task state, while adding
    resume_protocol.phase_refs_source when jq is available

Files carrying a forgekit-override marker are skipped.
EOF
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage >&2
  exit 2
fi

target="$1"
force="${2:-}"

if [ "$force" != "" ] && [ "$force" != "--force" ]; then
  echo "error: unknown second argument: $force" >&2
  usage >&2
  exit 2
fi

if [ ! -d "$target" ]; then
  echo "error: target is not a directory: $target" >&2
  exit 1
fi

forgekit_root="$(cd "$(dirname "$0")/.." && pwd)"
templates="$forgekit_root/templates"

if [ ! -d "$templates" ]; then
  echo "error: templates/ not found at $templates" >&2
  exit 1
fi

target="$(cd "$target" && pwd)"

if [ ! -d "$target/.git" ]; then
  echo "error: target is not a git repository: $target" >&2
  exit 1
fi

has_override() {
  local f="$1"
  [ -f "$f" ] && head -n 5 "$f" 2>/dev/null \
    | grep -qE '^[[:space:]]*((<!--|#|//)[[:space:]]*forgekit-override:|"forgekit-override"[[:space:]]*:)'
}

copy_file() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
}

update_file() {
  local src="$1"
  local rel="$2"
  local dst="$target/$rel"

  if [ "$rel" = "docs/PROJECT_CONTEXT.md" ] && [ -e "$dst" ]; then
    echo "skip: $rel (project-local file preserved)"
    return 0
  fi

  if [ -e "$dst" ]; then
    if has_override "$dst"; then
      echo "skip: $rel (forgekit-override marker)"
      return 0
    fi
    if cmp -s "$src" "$dst"; then
      echo "ok:   $rel"
      return 0
    fi
    if [ "$force" != "--force" ]; then
      echo "DRIFT: $rel (re-run with --force to overwrite, or add forgekit-override)" >&2
      return 1
    fi
  fi

  copy_file "$src" "$dst"
  echo "copy: $rel"
}

drift=0

for rel in AGENTS.md CLAUDE.md; do
  update_file "$templates/$rel" "$rel" || drift=1
done

update_file "$forgekit_root/scripts/worktree-add.sh" "scripts/worktree-add.sh" || drift=1

while IFS= read -r src; do
  rel="${src#$templates/}"
  update_file "$src" "$rel" || drift=1
done < <(find "$templates/docs" -type f | sort)

if [ "$drift" -ne 0 ]; then
  echo "" >&2
  echo "update stopped before overwriting drifted files." >&2
  echo "Review the drift, then re-run with --force if those harness files should match ForgeKit." >&2
  exit 1
fi

chmod +x "$target/scripts/worktree-add.sh"

mkdir -p "$target/.context"
state_file="$target/.context/workflow-state.json"
if [ ! -f "$state_file" ]; then
  copy_file "$templates/.context/workflow-state.compact.example.json" "$state_file"
  echo "copy: .context/workflow-state.json"
elif command -v jq >/dev/null 2>&1; then
  tmp="$state_file.tmp.$$"
  if jq '
    def append_missing($v): if index($v) then . else . + [$v] end;
    .resume_protocol.read_this_file_on = (
      (.resume_protocol.read_this_file_on // [])
      | append_missing("task_start")
      | append_missing("session_resume")
      | append_missing("context_compaction")
      | append_missing("phase_transition")
      | append_missing("before_final_response")
    )
    | .resume_protocol.read_phase_refs = (.resume_protocol.read_phase_refs // "on_phase_entry_only")
    | .resume_protocol.phase_refs_source = (.resume_protocol.phase_refs_source // "docs/PHASE_REFS.json")
  ' "$state_file" > "$tmp"; then
    mv "$tmp" "$state_file"
    echo "update: .context/workflow-state.json resume_protocol"
  else
    rm -f "$tmp"
    echo "warn: could not update .context/workflow-state.json" >&2
  fi
else
  echo "warn: jq not found; leaving existing .context/workflow-state.json unchanged" >&2
fi

gitignore="$target/.gitignore"
touch "$gitignore"
if ! grep -qxF ".context/" "$gitignore"; then
  if [ -s "$gitignore" ] && [ "$(tail -c1 "$gitignore" | wc -l | tr -d ' ')" = "0" ]; then
    printf '\n' >> "$gitignore"
  fi
  echo ".context/" >> "$gitignore"
  echo "update: .gitignore"
fi

echo ""
echo "Verifying harness sync..."
"$forgekit_root/scripts/check-harness-sync.sh" "$target"

cat <<EOF

ForgeKit harness updated in: $target

Next steps:
  - Review git diff in the target repo.
  - Commit the harness update in the target repo.
  - For existing task worktrees, confirm .context/workflow-state.json has
    resume_protocol.phase_refs_source = "docs/PHASE_REFS.json".
EOF
