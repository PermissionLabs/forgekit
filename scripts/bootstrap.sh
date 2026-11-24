#!/usr/bin/env bash
# ForgeKit bootstrap: copy the harness templates into a target product repo.
# See docs/BOOTSTRAP.md for the full procedure (used by agents and humans).

set -euo pipefail

usage() {
  cat <<'EOF'
usage: scripts/bootstrap.sh <target-repo-path> [--force]

Copies AGENTS.md, CLAUDE.md, docs/, and seeds .context/workflow-state.json
into <target-repo-path>. Copies scripts/worktree-add.sh. Adds .context/ to the
target's .gitignore.

Refuses to overwrite existing harness files unless --force is passed.
docs/PROJECT_CONTEXT.md is never overwritten (project-local content).

Every path it would write is checked first. If any resolves outside the
target (its own symlink, a symlinked parent directory, or a `link/..` path),
nothing is written, even with --force. A symlink that resolves inside the
target is replaced by a regular file, never written through.
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

# Outside-target guard: check every path this script writes before writing
# any of them, so a rejected path never leaves a partial bootstrap behind.
write_targets=(
  "AGENTS.md"
  "CLAUDE.md"
  "scripts/worktree-add.sh"
  ".context/workflow-state.json"
  ".gitignore"
)
while IFS= read -r src; do
  rel="${src#$templates/}"
  if [ "$rel" = "docs/PROJECT_CONTEXT.md" ] && [ -e "$target/$rel" ]; then
    continue
  fi
  write_targets+=("$rel")
done < <(find "$templates/docs" -type f | sort)

unsafe=0
for rel in "${write_targets[@]}"; do
  if why="$(write_target_problem "$target/$rel" "$target")"; then
    echo "LINK: $rel $why; --force does not override this" >&2
    unsafe=1
  fi
done
if [ "$unsafe" -ne 0 ]; then
  echo "error: bootstrap stopped before changing files. Replace each LINK path with a" >&2
  echo "       regular file inside the target (or remove it), then re-run." >&2
  exit 1
fi

# Conflict check.
conflicts=()
check_paths=(
  "AGENTS.md"
  "CLAUDE.md"
  "scripts/worktree-add.sh"
  "docs/AGENT_GUIDE.md"
  "docs/WORKFLOW.md"
  "docs/PHASE_REFS.json"
  "docs/HARNESS_NOTES.md"
  "docs/design-skills"
  "docs/review-skills"
  "docs/command-skills"
  "docs/solutions"
  "docs/changes"
  "docs/decisions"
  "docs/audits"
)
for p in "${check_paths[@]}"; do
  if [ -e "$target/$p" ]; then
    conflicts+=("$p")
  fi
done

if [ "${#conflicts[@]}" -gt 0 ] && [ "$force" != "--force" ]; then
  echo "error: target already contains forgekit files. Re-run with --force to overwrite." >&2
  echo "conflicting paths:" >&2
  for c in "${conflicts[@]}"; do
    echo "  - $c" >&2
  done
  exit 3
fi

copy_file() {
  safe_copy_file "$1" "$2"
}

# Top-level entry points (Codex, Antigravity, and OpenCode read AGENTS.md; Claude reads CLAUDE.md).
copy_file "$templates/AGENTS.md" "$target/AGENTS.md"
copy_file "$templates/CLAUDE.md" "$target/CLAUDE.md"

# Optional helper scripts.
copy_file "$forgekit_root/scripts/worktree-add.sh" "$target/scripts/worktree-add.sh"
chmod +x "$target/scripts/worktree-add.sh"

# Shared docs. Walk templates/docs and copy each file, but never overwrite
# PROJECT_CONTEXT.md if it already exists in the target.
while IFS= read -r src; do
  rel="${src#$templates/}"
  dst="$target/$rel"
  if [ "$rel" = "docs/PROJECT_CONTEXT.md" ] && [ -e "$dst" ]; then
    echo "skip: $rel (existing project content preserved)"
    continue
  fi
  copy_file "$src" "$dst"
done < <(find "$templates/docs" -type f)

# Seed compact workflow-state.
copy_file "$templates/.context/workflow-state.compact.example.json" "$target/.context/workflow-state.json"

# Idempotently add .context/ to .gitignore.
gitignore="$target/.gitignore"
if [ ! -e "$gitignore" ] || ! grep -qxF ".context/" "$gitignore"; then
  # Append to .gitignore itself, not to the file an in-repo link points to.
  replace_link_with_copy "$gitignore"
  touch "$gitignore"
  if [ -s "$gitignore" ] && [ "$(tail -c1 "$gitignore" | wc -l | tr -d ' ')" = "0" ]; then
    printf '\n' >> "$gitignore"
  fi
  echo ".context/" >> "$gitignore"
fi

# Parity check before declaring success — AGENTS.md and CLAUDE.md must
# both exist; deeper byte-identical verification is done by
# scripts/check-harness-sync.sh below.
if [ ! -f "$target/AGENTS.md" ] || [ ! -f "$target/CLAUDE.md" ]; then
  echo "error: parity check failed — AGENTS.md or CLAUDE.md missing in target" >&2
  exit 4
fi

# Harness sync verification — confirms every harness-owned file in the
# target is byte-identical to templates/. Surfaces silent drift early.
echo ""
echo "Verifying harness sync..."
if ! "$forgekit_root/scripts/check-harness-sync.sh" "$target"; then
  echo "warn: harness sync check reported drift after bootstrap. This usually" >&2
  echo "      means --force overwrote a file the user had locally modified;" >&2
  echo "      review the diff above before continuing." >&2
fi

cat <<EOF

ForgeKit bootstrapped into: $target

Next steps (see docs/BOOTSTRAP.md "Post-bootstrap checklist"):
  - Fill in $target/docs/PROJECT_CONTEXT.md (stack, commands, paths, local rules).
  - Remove unused placeholder dirs under docs/ if they don't apply yet.
  - Suggested first commit: chore: bootstrap forgekit harness
  - Re-run scripts/check-harness-sync.sh "$target" any time to verify sync.
EOF
