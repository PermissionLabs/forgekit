# shellcheck shell=bash
# Physical-path guards shared by check-harness-sync.sh (reads),
# bootstrap.sh and update-harness.sh (writes). Source this file; it defines
# functions only. Portable to macOS bash 3.2 and BSD (no readlink -f /
# realpath): every resolution goes through cd -P / pwd -P.

# Print the physical path $1 resolves to. Symlinks are followed in the final
# component and in every parent directory, and `..` is applied after the
# link it follows is resolved (cd -P / pwd -P), so `link/../file` lands where
# the kernel would open it. Fails on loops or unresolvable directories.
resolve_physical() {
  local p="$1" dir base link n=0
  while :; do
    dir="$(CDPATH='' cd -P "$(dirname "$p")" 2>/dev/null && pwd -P)" || return 1
    base="$(basename "$p")"
    case "$base" in
      .|..)
        (CDPATH='' cd -P "$dir/$base" 2>/dev/null && pwd -P)
        return
        ;;
    esac
    p="${dir%/}/$base"
    [ -L "$p" ] || break
    n=$((n + 1))
    [ "$n" -le 40 ] || return 1
    link="$(readlink "$p")" || return 1
    case "$link" in
      /*) p="$link" ;;
      *) p="${dir%/}/$link" ;;
    esac
  done
  printf '%s\n' "$p"
}

# True when the symlink chain starting at $1 passes through the physical
# path $2 (checked at every hop, $1 included, before the hop is followed),
# so `GEMINI.md -> AGENTS.md -> elsewhere` reaches AGENTS.md while a link
# that bypasses it to the same final file does not. $2 need not exist.
link_chain_reaches() {
  local p="$1" want="$2" dir base link n=0
  while :; do
    dir="$(CDPATH='' cd -P "$(dirname "$p")" 2>/dev/null && pwd -P)" || return 1
    base="$(basename "$p")"
    case "$base" in
      .|..) return 1 ;;
    esac
    p="${dir%/}/$base"
    [ "$p" = "$want" ] && return 0
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

# True when $1 exists (or is a dangling symlink) and physically resolves
# outside repo root $2, through a symlink in the file itself or in any parent
# directory, or cannot be resolved at all.
path_escapes_repo() {
  local f="$1" root="$2" root_phys resolved
  [ -e "$f" ] || [ -L "$f" ] || return 1
  root_phys="$(CDPATH='' cd -P "$root" 2>/dev/null && pwd -P)" || return 0
  resolved="$(resolve_physical "$f")" || return 0
  case "$resolved" in
    "$root_phys"/*) return 1 ;;
    *) return 0 ;;
  esac
}

# Write-side guard. Prints a one-line reason and returns 0 when writing a
# regular file at $1 could change anything outside repo root $2:
#   - $1 exists (or is a dangling symlink) and resolves outside the repo;
#   - $1 exists and its physical parent directory (where the writers unlink
#     it, create the sibling temp file and rename) is outside the repo, even
#     when $1 itself is a link pointing back inside;
#   - $1 exists and is not a regular file, or is a symlink to an existing
#     non-regular file (a directory: mv onto it would move into it);
#   - $1 does not exist and its nearest existing ancestor (the directory
#     mkdir -p would descend into) resolves outside the repo, cannot be
#     resolved, or is not a directory.
# Returns 1 (prints nothing) when the write is confined to the repository.
# Never reads file content. A symlink that resolves to a regular file (or
# dangles) inside the repo passes; callers replace the link itself
# (safe_copy_file / commit_sibling_tmp) instead of writing through it.
write_target_problem() {
  local f="$1" root="$2" root_phys p resolved parent_phys
  root_phys="$(CDPATH='' cd -P "$root" 2>/dev/null && pwd -P)" || {
    echo "repository root cannot be resolved"
    return 0
  }
  if [ -e "$f" ] || [ -L "$f" ]; then
    if path_escapes_repo "$f" "$root"; then
      if [ -L "$f" ]; then
        echo "symlink -> $(readlink "$f") resolves outside the repository"
      else
        echo "resolves outside the repository through a symlinked parent directory"
      fi
      return 0
    fi
    parent_phys="$(CDPATH='' cd -P "$(dirname "$f")" 2>/dev/null && pwd -P)" || {
      echo "parent directory cannot be resolved"
      return 0
    }
    case "$parent_phys" in
      "$root_phys"|"$root_phys"/*) ;;
      *)
        echo "parent directory resolves outside the repository (the link is replaced there)"
        return 0
        ;;
    esac
    if [ -L "$f" ]; then
      if [ -e "$f" ] && [ ! -f "$f" ]; then
        echo "symlink -> $(readlink "$f") resolves to a non-regular file"
        return 0
      fi
    elif [ ! -f "$f" ]; then
      echo "exists and is not a regular file"
      return 0
    fi
    return 1
  fi
  p="$(dirname "$f")"
  while [ ! -e "$p" ] && [ ! -L "$p" ]; do
    p="$(dirname "$p")"
  done
  resolved="$(resolve_physical "$p")" || {
    echo "parent directory cannot be resolved (broken symlink or loop)"
    return 0
  }
  case "$resolved" in
    "$root_phys"|"$root_phys"/*) ;;
    *)
      echo "parent directory resolves outside the repository"
      return 0
      ;;
  esac
  if [ ! -d "$resolved" ]; then
    echo "parent path is not a directory"
    return 0
  fi
  return 1
}

# Copy $1 to $2 through a sibling temp file renamed onto $2, never writing
# through a symlink at $2 (the link itself is replaced by a regular file) and
# never opening $2 for writing, so an existing read-only (0444/0555) managed
# file is replaced like the entrypoints are instead of failing mid-run with a
# partial update. An existing regular file keeps its own mode; a new file (or
# a replaced link) gets the umask default (the templates are not executable;
# the writers chmod +x scripts/worktree-add.sh after copying it). Callers
# must have passed $2 through write_target_problem.
safe_copy_file() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")" || return 1
  make_sibling_tmp "$dst" || return 1
  cat "$src" > "$FORGEKIT_TMP" || return 1
  commit_sibling_tmp "$dst"
}

# Exclusive sibling temp files. FORGEKIT_TMP holds the temp file this
# process currently owns; callers that source this file install
#   trap forgekit_tmp_cleanup EXIT
# so a failure between creation and the final mv never leaves it behind.
FORGEKIT_TMP=""

forgekit_tmp_cleanup() {
  if [ -n "${FORGEKIT_TMP:-}" ]; then
    rm -f "$FORGEKIT_TMP"
    FORGEKIT_TMP=""
  fi
}

# Mode a plain `> file` redirect would give a new file under the current umask.
forgekit_default_file_mode() {
  printf '%o' $((0666 & ~0$(umask)))
}

# Create a new, empty temp file next to $1 (same directory, so the final mv
# is a rename) and store its path in FORGEKIT_TMP. mktemp opens it with
# O_CREAT|O_EXCL under a random name, so a pre-placed file or symlink is
# never opened or truncated (the old "$dst.tmp.$$" name was predictable).
# BSD mktemp needs the template to end in X. The file is held at 0600 while
# callers write it (set explicitly: mktemp's own mode is masked by the umask,
# so umask 0222 would give 0400), and commit_sibling_tmp applies the umask
# default only after the content is complete. Applying the final mode first
# made the temp file read-only under umask 0222 and the later write failed.
make_sibling_tmp() {
  local dst="$1"
  FORGEKIT_TMP="$(mktemp "$(dirname "$dst")/.$(basename "$dst").forgekit-tmp.XXXXXX")" || {
    FORGEKIT_TMP=""
    return 1
  }
  chmod 600 "$FORGEKIT_TMP" || return 1
}

# Copy the permission bits of $1 onto $2 (GNU stat, then BSD stat).
preserve_mode() {
  local mode
  mode="$(stat -c %a "$1" 2>/dev/null)" || mode="$(stat -f %Lp "$1")" || return 1
  chmod "$mode" "$2"
}

# Apply the final mode to FORGEKIT_TMP and rename it onto $1. The final mode
# is that of the regular file being replaced (so a 0600 or 0755 file keeps
# it), or the umask default for a new file or a replaced link. An existing
# symlink at $1 is removed first: mv onto a link to a directory would move
# the file into that directory. mv -f: without it, mv asks before replacing
# a destination without write permission (0444/0555) when stdin is a
# terminal, and a "no" leaves the old file and an orphaned temp while mv
# still exits 0. On failure FORGEKIT_TMP is kept set so the EXIT trap
# (forgekit_tmp_cleanup) removes the temp file.
commit_sibling_tmp() {
  local dst="$1"
  if [ -f "$dst" ] && [ ! -L "$dst" ]; then
    preserve_mode "$dst" "$FORGEKIT_TMP" || return 1
  else
    chmod "$(forgekit_default_file_mode)" "$FORGEKIT_TMP" || return 1
  fi
  if [ -L "$dst" ]; then
    rm -f "$dst"
  fi
  mv -f "$FORGEKIT_TMP" "$dst" || return 1
  FORGEKIT_TMP=""
}

# Add line $2 to $1 (after a newline if the content lacks one) through a
# sibling temp file holding the current content (empty when $1 is missing or
# dangles), so $1 is never opened for writing: a read-only (0444) file is
# replaced keeping its mode, and a symlink at $1 is replaced by a regular
# file instead of being written through. A symlink is re-checked against
# repo root $3 with write_target_problem first (it may have appeared after
# the writers' pre-check, which refuses .gitignore links); one that resolves
# outside the repository, or to a non-regular file, is refused (returns 1)
# before its content is read.
append_line_via_tmp() {
  local f="$1" line="$2" root="$3" why
  if [ -L "$f" ] && why="$(write_target_problem "$f" "$root")"; then
    echo "LINK: $f $why; refusing to write it" >&2
    return 1
  fi
  make_sibling_tmp "$f" || return 1
  if [ -f "$f" ]; then
    cat "$f" > "$FORGEKIT_TMP" || return 1
  fi
  if [ -s "$FORGEKIT_TMP" ] && [ "$(tail -c1 "$FORGEKIT_TMP" | wc -l | tr -d ' ')" = "0" ]; then
    printf '\n' >> "$FORGEKIT_TMP" || return 1
  fi
  printf '%s\n' "$line" >> "$FORGEKIT_TMP" || return 1
  commit_sibling_tmp "$f"
}

# Print $1 as an operand cd takes literally: trailing "/" and "/." are
# stripped ("/" itself is kept) and a bare "-" (cd's $OLDPWD operand, even
# after --) becomes "./-". Callers still pass it after `CDPATH='' cd -L --`.
literal_dir_operand() {
  local arg="$1"
  while :; do
    case "$arg" in
      /) break ;;
      */) arg="${arg%/}" ;;
      */.) arg="${arg%/.}"; [ -n "$arg" ] || arg=/ ;;
      *) break ;;
    esac
  done
  [ "$arg" != "-" ] || arg="./-"
  printf '%s\n' "$arg"
}
