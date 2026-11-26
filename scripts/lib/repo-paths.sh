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

# Copy $1 to $2 without writing through a symlink at $2: an existing link is
# removed first, so the link itself is replaced by a regular file. Callers
# must have passed $2 through write_target_problem.
safe_copy_file() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [ -L "$dst" ]; then
    rm -f "$dst"
  fi
  cp "$src" "$dst"
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
# the file into that directory. On failure FORGEKIT_TMP is kept set so the
# EXIT trap (forgekit_tmp_cleanup) removes the temp file.
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
  mv "$FORGEKIT_TMP" "$dst" || return 1
  FORGEKIT_TMP=""
}

# Replace a symlink at $1 with a regular file holding its current content
# (empty when the link dangles) so a following in-place edit (append, touch)
# changes $1 itself, not the file the link points to. No-op for non-links.
# An optional line $2 is appended to the copy (after a newline if the content
# lacks one) before it is committed, so the new file never needs a second,
# in-place write: under a umask such as 0222 the committed file is read-only.
# Callers must have passed $1 through write_target_problem.
replace_link_with_copy() {
  local f="$1" line="${2:-}"
  [ -L "$f" ] || return 0
  make_sibling_tmp "$f"
  if [ -f "$f" ]; then
    cat "$f" > "$FORGEKIT_TMP" || return 1
  fi
  if [ -n "$line" ]; then
    if [ -s "$FORGEKIT_TMP" ] && [ "$(tail -c1 "$FORGEKIT_TMP" | wc -l | tr -d ' ')" = "0" ]; then
      printf '\n' >> "$FORGEKIT_TMP" || return 1
    fi
    printf '%s\n' "$line" >> "$FORGEKIT_TMP" || return 1
  fi
  commit_sibling_tmp "$f"
}
