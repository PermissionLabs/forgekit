# shellcheck shell=bash
# Sourced by bootstrap and update after resolving the target root ($target,
# physical via pwd -P) and $templates. Defines functions only; callers run
# check_managed_destinations before reading or writing any managed path.
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
