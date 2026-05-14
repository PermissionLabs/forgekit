# Bootstrap

This document is the entry point for applying ForgeKit to a product
repository. Both agents and humans follow it.

If you are an agent and the user asks you to "apply ForgeKit", "bootstrap
ForgeKit", or equivalent into a repo, follow this file step by step.

## When to use this

Use this when a repo does not yet have:

- `AGENTS.md` and `CLAUDE.md` at the root
- `docs/AGENT_GUIDE.md`, `docs/WORKFLOW.md`, `docs/PROJECT_CONTEXT.md`
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

This copies entry points + `docs/` + seeds `.context/workflow-state.json` and
adds `.context/` to the target's `.gitignore`. It refuses to overwrite without
`--force`. `docs/PROJECT_CONTEXT.md` is never overwritten.

Skip ahead to **Post-bootstrap checklist**.

## Fallback path: manual steps

Use this when the script is unavailable (different machine, partial copy, or
ForgeKit not checked out locally).

Copy these files from forgekit into the target, preserving paths:

| Source (forgekit)                                            | Destination (target)                  |
| ------------------------------------------------------------ | ------------------------------------- |
| `templates/AGENTS.md`                                        | `AGENTS.md`                           |
| `templates/CLAUDE.md`                                        | `CLAUDE.md`                           |
| `templates/docs/AGENT_GUIDE.md`                              | `docs/AGENT_GUIDE.md`                 |
| `templates/docs/WORKFLOW.md`                                 | `docs/WORKFLOW.md`                    |
| `templates/docs/PROJECT_CONTEXT.md`                          | `docs/PROJECT_CONTEXT.md` (skip if exists) |
| `templates/docs/HARNESS_NOTES.md`                            | `docs/HARNESS_NOTES.md`               |
| `templates/docs/design-skills/*`                             | `docs/design-skills/*`                |
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
- `docs/AGENT_GUIDE.md`, `docs/WORKFLOW.md`, `docs/PROJECT_CONTEXT.md` exist.
- `.context/workflow-state.json` exists.
- `.context/` appears in `.gitignore`.
- `docs/PROJECT_CONTEXT.md` still has TBD placeholders the user must fill in
  (stack, commands, important paths, local rules, documentation map).

Then suggest to the user:

- Fill in `docs/PROJECT_CONTEXT.md` for the project.
- Remove `docs/` placeholder subdirectories that don't apply yet (e.g. delete
  `docs/decisions/` until the project actually records decisions).
- First commit message:
  ```text
  chore: bootstrap forgekit harness
  ```

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
```

If any check fails, fix it before reporting bootstrap as complete.
