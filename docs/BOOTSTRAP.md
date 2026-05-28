# Bootstrap

This document is the entry point for applying ForgeKit to a product
repository. Both agents and humans follow it.

If you are an agent and the user asks you to "apply ForgeKit", "bootstrap
ForgeKit", or equivalent into a repo, follow this file step by step.

## When to use this

Use this when a repo does not yet have:

- `AGENTS.md` and `CLAUDE.md` at the root
- `docs/AGENT_GUIDE.md`, `docs/WORKFLOW.md`, `docs/PHASE_REFS.json`,
  `docs/PROJECT_CONTEXT.md`
- a gitignored `.context/workflow-state.json`

If the target already has any of these, treat it as already bootstrapped and
ask the user before overwriting.

## Inputs to confirm

Before doing anything, confirm:

1. **Target repo absolute path** (e.g. `/Users/x/code/product-repo`).
2. The target is a git repository (or the user wants you to `git init` it).
3. Whether ForgeKit is already partially applied. Run:
   ```bash
   ls "$TARGET"/AGENTS.md "$TARGET"/CLAUDE.md "$TARGET"/docs/AGENT_GUIDE.md 2>/dev/null
   ```
   If any exist, stop and ask the user how to proceed (`--force` overwrite,
   merge manually, or skip).

## Preferred path: run the script

If a local checkout of forgekit is available, run:

```bash
"$FORGEKIT_ROOT"/scripts/bootstrap.sh "$TARGET"
```

This copies entry points + `docs/`, copies `scripts/worktree-add.sh`, seeds
`.context/workflow-state.json`, and adds `.context/` to the target's
`.gitignore`. It refuses to overwrite without `--force`.
`docs/PROJECT_CONTEXT.md` is never overwritten.

Skip ahead to **Post-bootstrap checklist**.

## Existing repo update path

Use this when a repo already has ForgeKit and should receive newer harness
files. Do **not** use `bootstrap.sh` for routine upgrades; it is intentionally
conservative and will stop on existing harness files.

From a local ForgeKit checkout, run:

```bash
"$FORGEKIT_ROOT"/scripts/update-harness.sh "$TARGET"
```

If the target has drifted harness-owned files, the update helper stops before
changing files and reports each drifted path. Review the diff, then choose
one:

- Re-run with `--force` when the target should match ForgeKit templates:
  ```bash
  "$FORGEKIT_ROOT"/scripts/update-harness.sh "$TARGET" --force
  ```
- Add a `forgekit-override` marker when the target intentionally diverges.
- Merge the file manually when the target has project-specific edits that
  should partly survive.

The update helper:

- preserves `docs/PROJECT_CONTEXT.md`
- preserves existing `.context/workflow-state.json` task details
- adds `resume_protocol.phase_refs_source` to existing workflow state when
  `jq` is available
- copies new harness files such as `docs/PHASE_REFS.json`
- runs `scripts/check-harness-sync.sh "$TARGET"` at the end

Expected PR contents in the target repo:

- copied or updated harness-owned files
- `.gitignore` containing `.context/`
- no unrelated product code changes

Known collision points:

- `docs/PHASE_REFS.json` if the target already has a project-local file with
  that name
- locally edited `docs/AGENT_GUIDE.md` or `docs/WORKFLOW.md`
- custom review/design skill files without a `forgekit-override` marker
- in-progress worktrees whose gitignored `.context/workflow-state.json` must be
  updated separately

## Fallback path: manual steps

Use this when the script is unavailable (different machine, partial copy, or
ForgeKit not checked out locally).

Copy these files from forgekit into the target, preserving paths:

| Source (forgekit)                                            | Destination (target)                  |
| ------------------------------------------------------------ | ------------------------------------- |
| `templates/AGENTS.md`                                        | `AGENTS.md`                           |
| `templates/CLAUDE.md`                                        | `CLAUDE.md`                           |
| `scripts/worktree-add.sh`                                    | `scripts/worktree-add.sh`             |
| `templates/docs/AGENT_GUIDE.md`                              | `docs/AGENT_GUIDE.md`                 |
| `templates/docs/WORKFLOW.md`                                 | `docs/WORKFLOW.md`                    |
| `templates/docs/PHASE_REFS.json`                              | `docs/PHASE_REFS.json`                |
| `templates/docs/PROJECT_CONTEXT.md`                          | `docs/PROJECT_CONTEXT.md` (skip if exists) |
| `templates/docs/HARNESS_NOTES.md`                            | `docs/HARNESS_NOTES.md`               |
| `templates/docs/design-skills/*`                             | `docs/design-skills/*`                |
| `templates/docs/review-skills/*`                             | `docs/review-skills/*`                |
| `templates/docs/solutions/*`                                 | `docs/solutions/*`                    |
| `templates/docs/changes/*`                                   | `docs/changes/*`                      |
| `templates/docs/decisions/*`                                 | `docs/decisions/*`                    |
| `templates/docs/audits/*`                                    | `docs/audits/*`                       |
| `templates/.context/workflow-state.compact.example.json`     | `.context/workflow-state.json`        |

Then add `.context/` to the target's `.gitignore` if it isn't already there:

```bash
grep -qxF ".context/" "$TARGET/.gitignore" 2>/dev/null \
  || echo ".context/" >> "$TARGET/.gitignore"
```

## Post-bootstrap checklist

Before handing back to the user, verify:

- `AGENTS.md` and `CLAUDE.md` both exist at the target root.
- `scripts/worktree-add.sh` exists and is executable.
- `docs/AGENT_GUIDE.md`, `docs/WORKFLOW.md`, `docs/PHASE_REFS.json`,
  `docs/PROJECT_CONTEXT.md` exist.
- `.context/workflow-state.json` exists.
- `.context/` appears in `.gitignore`.
- `docs/PROJECT_CONTEXT.md` still has TBD placeholders the user must fill in
  (stack, commands, important paths, local rules, documentation map).
- The harness sync check passes:
  ```bash
  "$FORGEKIT_ROOT"/scripts/check-harness-sync.sh "$TARGET"
  ```
  `scripts/bootstrap.sh` runs this automatically at the end. Re-run it any
  time to verify the target has not drifted from the harness.

Then suggest to the user:

- Fill in `docs/PROJECT_CONTEXT.md` for the project.
- Remove `docs/` placeholder subdirectories that don't apply yet (e.g. delete
  `docs/decisions/` until the project actually records decisions).
- First commit message:
  ```text
  chore: bootstrap forgekit harness
  ```

## Repo-level enforcement (recommended)

The git write hard gate in `AGENTS.md` and `CLAUDE.md` is a *soft* enforcement:
it tells the agent what not to do, but cannot prevent a misbehaving session from
pushing to `main`. Pair it with repo-level enforcement on the target:

- **GitHub branch protection** on the default branch — require pull requests,
  block direct pushes, and require status checks before merge. Set this up
  immediately after the first push.
- **Local `pre-push` hook** that refuses pushes to `main`/`master` unless an
  override env var is set. Useful when the agent runs locally with full git
  credentials.
- **Harness sync check in CI.** `scripts/check-harness-sync.sh` exits non-zero
  if any harness-owned file has drifted from the templates. Wire it into the
  target repo's CI so silent drift becomes a failing build instead of a
  late-discovered incident. Minimal GitHub Actions example:
  ```yaml
  jobs:
    harness-sync:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
          with: { submodules: recursive }   # if forgekit is a submodule
        - run: .harness/forgekit/scripts/check-harness-sync.sh .
  ```
  Adjust the script path to wherever the target tracks forgekit (submodule,
  vendored copy, or a pinned tag).

If the target repo is missing branch protection at bootstrap time, surface it
as a setup risk in your handback message rather than silently proceeding.

## Intentional deviation (forgekit-override)

If the project legitimately needs to deviate from a harness file, add the
marker `forgekit-override:` to one of the file's first 5 lines and record the
reason inline. Example for a Markdown file:

```markdown
# Workflow
<!-- forgekit-override: project uses a release-train workflow incompatible
     with the default phase loop; see docs/decisions/0007-release-train.md -->
...
```

`check-harness-sync.sh` skips files carrying the marker with a `skip:` note
instead of failing. Use sparingly — every override is a long-term maintenance
debt and a place where downstream agents can diverge from the harness contract.

The same marker also exempts **project-local extensions** — for example, a
custom `docs/review-skills/team-policy-review.md` that templates do not ship.
Without the marker, the sync check flags any file in a harness-owned
directory that templates no longer has as `STALE` (so renamed or removed
upstream files cannot quietly linger in the target).

For JSON harness files such as `docs/PHASE_REFS.json`, use a top-level
`"forgekit-override"` key instead of a comment marker.
Avoid overriding `docs/PHASE_REFS.json` unless the project has a clear
replacement review-routing policy; stale phase refs can cause agents to miss
required review checklists.

## Refusal cases

Stop and ask the user before continuing if:

- The target path does not exist or is not a directory.
- The target is not a git repository and the user did not say to init one.
- The target already contains forgekit files and `--force` was not specified
  or implicitly granted.
- You cannot locate the forgekit `templates/` directory.

## Agent parity check (required)

Codex auto-loads `AGENTS.md`. Claude Code auto-loads `CLAUDE.md` (and, in some
configurations, `AGENTS.md`). If only one of those files exists, that host's
agent will not receive the shared `docs/AGENT_GUIDE.md` pointer.

After bootstrap, verify:

```bash
test -f "$TARGET/AGENTS.md" && test -f "$TARGET/CLAUDE.md"
diff "$TARGET/AGENTS.md" "$TARGET/CLAUDE.md"
# Expected: only the title line differs (e.g. "1c1 / # Codex Entry Point / # Claude Entry Point").

test -f "$TARGET/docs/AGENT_GUIDE.md"
test -f "$TARGET/docs/PROJECT_CONTEXT.md"
test -f "$TARGET/docs/WORKFLOW.md"
test -f "$TARGET/docs/PHASE_REFS.json"
```

If any check fails, fix it before reporting bootstrap as complete.
