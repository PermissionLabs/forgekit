# Sourced by bootstrap and update after resolving the target root.
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
for rel in AGENTS.md CLAUDE.md scripts/worktree-add.sh .context/workflow-state.json .gitignore; do
  check_destination "$target/$rel" || exit 1
done
while IFS= read -r -d '' src; do
  check_destination "$target/${src#"$templates"/}" || exit 1
done < <(find "$templates/docs" -type f -print0)
