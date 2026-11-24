#!/usr/bin/env bash
# Update ForgeKit-owned files in an already bootstrapped product repo.
# Preserves project-local context and runtime state.

set -euo pipefail

usage() {
  cat <<'EOF'
usage: scripts/update-harness.sh <target-repo-path> [--force]

Updates ForgeKit-owned files in <target-repo-path> from this checkout's
templates/. Refuses to change files when drift is present unless --force is
passed.

Always preserves:
  - docs/PROJECT_CONTEXT.md
  - existing .context/workflow-state.json task state, while adding
    resume_protocol.phase_refs_source when jq is available

Files carrying a forgekit-override marker are skipped.

Every path it would write is checked first. If any resolves outside the
target repository (its own symlink, a symlinked parent directory, or a
`link/..` path), nothing is written, even with --force. A symlink that
resolves inside the repository is replaced by a regular file, never written
through.
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

if [ -L "$target" ]; then
  echo "error: target is a symlink" >&2
  exit 1
fi
target="$(cd "$target" && pwd -P)"
source "$forgekit_root/scripts/check-target-paths.sh"

# shellcheck source=lib/repo-paths.sh
. "$forgekit_root/scripts/lib/repo-paths.sh"
trap forgekit_tmp_cleanup EXIT
trap 'exit 1' HUP INT TERM

if ! git -C "$target" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: target is not a git repository: $target" >&2
  exit 1
fi

has_override() {
  local f="$1"
  [ -f "$f" ] && head -n 5 "$f" 2>/dev/null \
    | grep -qE '^[[:space:]]*((<!--|#|//)[[:space:]]*forgekit-override:|"forgekit-override"[[:space:]]*:)'
}

# Pre-check for one write target (relative path $1). Reports the path and
# the reason only; content is never read.
guard_write_target() {
  local rel="$1" why
  why="$(write_target_problem "$target/$rel" "$target")" || return 0
  echo "LINK: $rel $why; --force does not override this. Fix: replace it with a regular file inside the repository" >&2
  return 1
}

copy_file() {
  safe_copy_file "$1" "$2"
}

same_entrypoint_body() {
  diff <(tail -n +2 "$1") <(tail -n +2 "$2") >/dev/null
}

preserve_mode() {
  local mode
  mode="$(stat -c %a "$1" 2>/dev/null)" || mode="$(stat -f %Lp "$1")"
  chmod "$mode" "$2"
}

copy_entrypoint_preserving_title() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [ ! -e "$dst" ]; then
    safe_copy_file "$src" "$dst"
    return
  fi
  make_sibling_tmp "$dst"
  # Explicit status check: bash 3.2 does not apply errexit to a failed
  # redirection on a compound command, which would commit an empty file.
  {
    head -n 1 "$dst"
    tail -n +2 "$src"
  } > "$FORGEKIT_TMP" || return 1
  preserve_mode "$dst" "$FORGEKIT_TMP"
  # Replaces an in-repo symlink itself, never the file it points to.
  commit_sibling_tmp "$dst"
}

would_update_file() {
  local src="$1"
  local rel="$2"
  local mode="${3:-exact}"
  local dst="$target/$rel"

  if [ "$rel" = "docs/PROJECT_CONTEXT.md" ] && [ -e "$dst" ]; then
    return 0
  fi

  # Before has_override/cmp so an outside file is never read.
  guard_write_target "$rel" || return 1

  if [ -e "$dst" ]; then
    if has_override "$dst"; then
      return 0
    fi
    if [ "$mode" = "entrypoint" ] && same_entrypoint_body "$src" "$dst"; then
      return 0
    fi
    if [ "$mode" = "exact" ] && cmp -s "$src" "$dst"; then
      return 0
    fi
    if [ "$force" != "--force" ]; then
      echo "DRIFT: $rel (re-run with --force to overwrite, or add forgekit-override)" >&2
      return 1
    fi
  fi

  return 0
}

update_file() {
  local src="$1"
  local rel="$2"
  local mode="${3:-exact}"
  local dst="$target/$rel"
  local existed=""

  if [ "$rel" = "docs/PROJECT_CONTEXT.md" ] && [ -e "$dst" ]; then
    echo "skip: $rel (project-local file preserved)"
    return 0
  fi

  if [ -e "$dst" ]; then
    if has_override "$dst"; then
      echo "skip: $rel (forgekit-override marker)"
      return 0
    fi
    if [ "$mode" = "entrypoint" ] && same_entrypoint_body "$src" "$dst"; then
      echo "ok:   $rel (title-line diff allowed)"
      return 0
    fi
    if [ "$mode" = "exact" ] && cmp -s "$src" "$dst"; then
      echo "ok:   $rel"
      return 0
    fi
  fi

  [ -e "$dst" ] && existed=1

  if [ "$mode" = "entrypoint" ]; then
    copy_entrypoint_preserving_title "$src" "$dst"
    if [ -n "$existed" ]; then
      echo "copy: $rel (body updated, title preserved)"
    else
      echo "copy: $rel"
    fi
  else
    copy_file "$src" "$dst"
    echo "copy: $rel"
  fi
}

# GEMINI.md is an optional alias of AGENTS.md that this script never writes.
# A symlink must resolve to AGENTS.md (--force cannot repair it, so this
# blocks even with --force); a regular file is project-managed and only
# warned about. Host load rules (byte cap, frontmatter) are enforced by the
# final check-harness-sync.sh run.
would_keep_gemini_alias() {
  local f="$target/GEMINI.md" a="$target/AGENTS.md" link
  if [ -L "$f" ]; then
    if [ -e "$f" ] && [ -e "$a" ] && [ "$f" -ef "$a" ]; then
      return 0
    fi
    link="$(readlink "$f")"
    # AGENTS.md is about to be created; a relative link to it will resolve.
    if [ ! -e "$a" ] && { [ "$link" = "AGENTS.md" ] || [ "$link" = "./AGENTS.md" ]; }; then
      return 0
    fi
    echo "LINK: GEMINI.md is a symlink (-> $link) that does not resolve to AGENTS.md; --force does not fix this. Fix: (cd \"$target\" && ln -sfn AGENTS.md GEMINI.md), or remove it" >&2
    return 1
  fi
  if [ -f "$f" ]; then
    echo "warn: GEMINI.md is a project-managed standalone file; update-harness does not update it (prefer: ln -sfn AGENTS.md GEMINI.md)" >&2
  fi
  return 0
}

drift=0

for rel in AGENTS.md CLAUDE.md; do
  would_update_file "$templates/$rel" "$rel" entrypoint || drift=1
done
would_keep_gemini_alias || drift=1

would_update_file "$forgekit_root/scripts/worktree-add.sh" "scripts/worktree-add.sh" || drift=1

while IFS= read -r src; do
  rel="${src#$templates/}"
  would_update_file "$src" "$rel" || drift=1
done < <(find "$templates/docs" -type f | sort)

# Other files this script writes or appends to.
guard_write_target ".context/workflow-state.json" || drift=1
guard_write_target ".gitignore" || drift=1

if [ "$drift" -ne 0 ]; then
  echo "" >&2
  echo "update stopped before changing files." >&2
  echo "Review the drift. DRIFT lines: re-run with --force if those harness files should match ForgeKit." >&2
  echo "LINK lines: apply the fix named on the line first (--force does not repair symlinks" >&2
  echo "or allow writes that resolve outside the repository)." >&2
  exit 1
fi

for rel in AGENTS.md CLAUDE.md; do
  update_file "$templates/$rel" "$rel" entrypoint
done

update_file "$forgekit_root/scripts/worktree-add.sh" "scripts/worktree-add.sh"

while IFS= read -r src; do
  rel="${src#$templates/}"
  update_file "$src" "$rel"
done < <(find "$templates/docs" -type f | sort)

chmod +x "$target/scripts/worktree-add.sh"

mkdir -p "$target/.context"
state_file="$target/.context/workflow-state.json"
if [ ! -f "$state_file" ]; then
  copy_file "$templates/.context/workflow-state.compact.example.json" "$state_file"
  echo "copy: .context/workflow-state.json"
elif command -v jq >/dev/null 2>&1; then
  make_sibling_tmp "$state_file"
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
  ' "$state_file" > "$FORGEKIT_TMP"; then
    if cmp -s "$FORGEKIT_TMP" "$state_file"; then
      forgekit_tmp_cleanup
      echo "ok:   .context/workflow-state.json resume_protocol"
    else
      preserve_mode "$state_file" "$FORGEKIT_TMP"
      commit_sibling_tmp "$state_file"
      echo "update: .context/workflow-state.json resume_protocol"
    fi
  else
    forgekit_tmp_cleanup
    echo "warn: could not update .context/workflow-state.json" >&2
  fi
else
  echo "warn: jq not found; leaving existing .context/workflow-state.json unchanged" >&2
fi

gitignore="$target/.gitignore"
if [ ! -e "$gitignore" ] || ! grep -qxF ".context/" "$gitignore"; then
  if [ -L "$gitignore" ]; then
    # Write .gitignore itself, not the file an in-repo link points to: the
    # link becomes a regular copy with the line added in the same temp write.
    replace_link_with_copy "$gitignore" ".context/"
  else
    touch "$gitignore"
    if [ -s "$gitignore" ] && [ "$(tail -c1 "$gitignore" | wc -l | tr -d ' ')" = "0" ]; then
      printf '\n' >> "$gitignore"
    fi
    echo ".context/" >> "$gitignore"
  fi
  echo "update: .gitignore"
fi

echo ""
echo "Verifying harness sync..."
if sync_out="$("$forgekit_root/scripts/check-harness-sync.sh" "$target" 2>&1)"; then
  printf '%s\n' "$sync_out"
else
  printf '%s\n' "$sync_out" >&2
  cat <<EOF >&2

ForgeKit harness files were updated in: $target

Harness sync still reports drift. Fix each cause listed above:
EOF
  # Hints follow the checker's drift classes; forgekit-override only helps
  # template drift, never host load rules or symlinks.
  if printf '%s\n' "$sync_out" | grep -Eq '^(DRIFT|MISSING|STALE):'; then
    echo "hint: DRIFT/MISSING/STALE: remove stale harness files, or add a forgekit-override" >&2
    echo "      marker where the target should intentionally diverge." >&2
  fi
  if printf '%s\n' "$sync_out" | grep -Eq '^(SIZE|FORMAT):'; then
    echo "hint: SIZE/FORMAT: shrink the entrypoint (move detail into docs/) or remove its" >&2
    echo "      leading YAML frontmatter; forgekit-override does not exempt host load rules." >&2
  fi
  if printf '%s\n' "$sync_out" | grep -Eq '^LINK:'; then
    echo "hint: LINK: apply the fix named on each LINK line; forgekit-override and --force" >&2
    echo "      do not repair symlinks." >&2
  fi
  exit 1
fi

cat <<EOF

ForgeKit harness updated in: $target

Next steps:
  - Review git diff in the target repo.
  - Commit the harness update in the target repo.
  - For existing task worktrees, confirm .context/workflow-state.json has
    resume_protocol.phase_refs_source = "docs/PHASE_REFS.json".
EOF
