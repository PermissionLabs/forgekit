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

Every path it would write is checked first. If any is a symlink, sits under
a symlinked directory inside the target, is not a regular file, or resolves
outside the target repository (including a `link/..` path), nothing is
written, even with --force. This holds for symlinks that resolve inside the
repository too.
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
# shellcheck source=check-target-paths.sh
. "$forgekit_root/scripts/check-target-paths.sh"

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

copy_entrypoint_preserving_title() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [ ! -e "$dst" ]; then
    safe_copy_file "$src" "$dst"
    return
  fi
  make_sibling_tmp "$dst" || return 1
  # Each step is checked on its own: errexit is off on the left of `||`, so
  # a grouped `{ head; tail; } > tmp || return 1` let a failed head (an
  # unreadable file) commit a body without its title line.
  head -n 1 "$dst" > "$FORGEKIT_TMP" || return 1
  tail -n +2 "$src" >> "$FORGEKIT_TMP" || return 1
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
# A symlink must reach the AGENTS.md path itself (directly or through other
# links): AGENTS.md may be replaced by a new regular file below, so a link
# that only shares its final target (both linking to .harness/AGENTS.md)
# would stop matching. --force cannot repair it, so this blocks even with
# --force, before any file changes. A directory is refused the same way; a
# regular file is project-managed and only warned about. Host load rules
# (byte cap, frontmatter) are enforced by the final check-harness-sync.sh run.
# A chain whose hops pass through another file this script writes (e.g.
# GEMINI.md -> docs/WORKFLOW.md -> ../AGENTS.md) is refused too: that hop is
# replaced by a regular file below, which would break the alias mid-update.

# Physical paths (one per line) of every file this script may write other
# than AGENTS.md: parent resolved with cd -P, final component kept as is, the
# same form link_chain_reaches compares hops in. Missing parents are skipped
# (no existing hop can live there).
managed_write_paths() {
  local rel dir src
  {
    printf '%s\n' CLAUDE.md scripts/worktree-add.sh .context/workflow-state.json .gitignore
    find "$templates/docs" -type f | while IFS= read -r src; do
      printf '%s\n' "${src#$templates/}"
    done
  } | while IFS= read -r rel; do
    dir="$(CDPATH='' cd -P "$(dirname "$target/$rel")" 2>/dev/null && pwd -P)" || continue
    printf '%s\n' "${dir%/}/$(basename "$rel")"
  done
}

# Inode of the directory entry $1 itself (lstat: a final symlink is not
# followed; ls -d does not follow symlink operands on BSD or GNU).
entry_inode() {
  ls -di -- "$1" 2>/dev/null | awk 'NR == 1 { print $1 }'
}

# True when $1 and $2 name the same existing directory entry. Compares
# filesystem identity, not spelling, so case variants on a case-insensitive
# filesystem (docs/workflow.md, DOCS/WORKFLOW.md) match: the parents must be
# the same directory and the entries the same inode, without following a
# final symlink (a link hop is its own entry, distinct from its target).
same_entry() {
  local a="$1" b="$2" ia ib
  { [ -e "$a" ] || [ -L "$a" ]; } || return 1
  { [ -e "$b" ] || [ -L "$b" ]; } || return 1
  [ "$(dirname "$a")" -ef "$(dirname "$b")" ] || return 1
  ia="$(entry_inode "$a")"
  ib="$(entry_inode "$b")"
  [ -n "$ia" ] && [ "$ia" = "$ib" ]
}

# True when a hop of the link chain starting at $1 (before it reaches $2) is
# the same directory entry as one of the newline-separated physical paths in
# $3 (compared by identity, see same_entry). Prints that hop.
link_chain_hop_in() {
  local p="$1" want="$2" set="$3" dir base link m n=0
  while :; do
    dir="$(CDPATH='' cd -P "$(dirname "$p")" 2>/dev/null && pwd -P)" || return 1
    base="$(basename "$p")"
    p="${dir%/}/$base"
    [ "$p" = "$want" ] && return 1
    while IFS= read -r m; do
      [ -n "$m" ] || continue
      if [ "$m" = "$p" ] || same_entry "$p" "$m"; then
        printf '%s\n' "$p"
        return 0
      fi
    done <<EOS
$set
EOS
    [ -L "$p" ] || return 1
    n=$((n + 1))
    [ "$n" -le 40 ] || return 1
    link="$(readlink "$p")" || return 1
    case "$link" in
      /*) p="$link" ;;
      *) p="${dir%/}/$link" ;;
    esac
  done
}

would_keep_gemini_alias() {
  local f="$target/GEMINI.md" root_phys link hop
  if [ -L "$f" ]; then
    root_phys="$(CDPATH='' cd -P "$target" && pwd -P)"
    if link_chain_reaches "$f" "$root_phys/AGENTS.md"; then
      if hop="$(link_chain_hop_in "$f" "$root_phys/AGENTS.md" "$(managed_write_paths)")"; then
        echo "LINK: GEMINI.md reaches AGENTS.md through ${hop#$root_phys/}, which update-harness replaces with a regular file; --force does not fix this. Fix: (cd \"$target\" && ln -sfn AGENTS.md GEMINI.md)" >&2
        return 1
      fi
      return 0
    fi
    link="$(readlink "$f")"
    echo "LINK: GEMINI.md is a symlink (-> $link) that does not resolve through AGENTS.md; --force does not fix this. Fix: (cd \"$target\" && ln -sfn AGENTS.md GEMINI.md), or remove it" >&2
    return 1
  fi
  if [ -e "$f" ] && [ ! -f "$f" ]; then
    echo "LINK: GEMINI.md is not a regular file or a symlink to AGENTS.md; --force does not fix this. Fix: remove it, or (cd \"$target\" && ln -sfn AGENTS.md GEMINI.md)" >&2
    return 1
  fi
  if [ -f "$f" ]; then
    echo "warn: GEMINI.md is a project-managed standalone file; update-harness does not update it (prefer: ln -sfn AGENTS.md GEMINI.md)" >&2
  fi
  return 0
}

drift=0

# Before any managed file is read (has_override/cmp) or written: no symlink
# on a managed path, in-repo or not, and no non-regular file (PR #25).
check_managed_destinations || drift=1

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
  echo "\"error: symlink in managed destination\" / \"not a regular file\" lines: replace that" >&2
  echo "path (or the symlinked directory above it) with a regular file or directory;" >&2
  echo "--force does not override this." >&2
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
    # No `touch` first: under umask 0222 it would create a read-only file
    # the append below cannot open. A missing file is created by the
    # append's own open, which writes it even when its mode is read-only.
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
