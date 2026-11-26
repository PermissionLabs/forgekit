# shellcheck shell=bash
# Sourced by bootstrap and update. Defines functions only: callers run
# resolve_target_root first (it sets $target, physical via pwd -P), then
# check_managed_destinations (which also needs $templates) before writing any
# managed path.

# Set $target to the physical path of the target argument $1, refusing a
# target that is a symlink. [ -L ] follows a link when the name ends in "/"
# or "/." (lstat resolves "link/"), so "link/", "link//" or "link/." passed a
# check on the raw argument while `cd` + `pwd -P` still landed in the link's
# destination. Trailing "/" and "/." are stripped first ("/" itself is kept),
# and the logical path `cd` resolves (pwd -L) is checked too: cd folds
# "link/sub/.." to "link", while lstat resolves it to the link's destination
# (not a link). The strip alone is redundant with that check but keeps the
# raw-argument test meaningful. --force does not override this.
resolve_target_root() {
  local arg="$1" logical
  while :; do
    case "$arg" in
      /) break ;;
      */) arg="${arg%/}" ;;
      */.) arg="${arg%/.}"; [ -n "$arg" ] || arg=/ ;;
      *) break ;;
    esac
  done
  # cd treats a bare "-" as $OLDPWD (even after --), so a directory named
  # "-" (spelled "-", "-/" or "-/.") is passed as "./-".
  [ "$arg" != "-" ] || arg="./-"
  # Explicit -L: an inherited `set -P` (SHELLOPTS=physical) would make a
  # plain cd physical and pwd -L would then see the resolved path.
  logical="$(CDPATH='' cd -L -- "$arg" && pwd -L)" || return 1
  if [ -L "$arg" ] || [ -L "$logical" ]; then
    echo "error: target is a symlink" >&2
    return 1
  fi
  # -L again, so the checked and the resolved directory are the same one: a
  # physical cd would apply ".." after following a link inside the path
  # (box/sub/.. with box/sub -> target-link/docs lands in the linked repo).
  target="$(CDPATH='' cd -L -- "$arg" && pwd -P)" || return 1
}

#
# A managed destination is refused when it exists and is not a regular file,
# or when it or any directory between it and $target is a symlink, even one
# that resolves inside the target. --force does not override this.
check_destination() {
  local path="$1"
  if [ -e "$path" ] && [ ! -f "$path" ]; then
    echo "error: managed destination is not a regular file: $path" >&2
    return 1
  fi
  while [ "$path" != "$target" ]; do
    if [ -L "$path" ]; then
      echo "error: symlink in managed destination: $path" >&2
      return 1
    fi
    path="$(dirname "$path")"
  done
}

# Check every path bootstrap/update may write (docs/PROJECT_CONTEXT.md
# included, even when it is kept). Reports each refused path, then returns 1
# if there was any.
check_managed_destinations() {
  local rel src rc=0
  for rel in AGENTS.md CLAUDE.md scripts/worktree-add.sh .context/workflow-state.json .gitignore; do
    check_destination "$target/$rel" || rc=1
  done
  while IFS= read -r -d '' src; do
    check_destination "$target/${src#"$templates"/}" || rc=1
  done < <(find "$templates/docs" -type f -print0)
  return "$rc"
}
