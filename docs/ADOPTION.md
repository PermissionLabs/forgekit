# Adoption

This is the intended workflow for adding the harness to a new project.

## Bootstrap

Future command:

```bash
git submodule add git@github.com:permissionlabs/<repo-name>.git .harness/agent-harness
.harness/agent-harness/scripts/init
```

Until a CLI exists, copy the files from `templates/` into the project root.

## Required Files

```text
AGENTS.md
CLAUDE.md
docs/AGENT_GUIDE.md
docs/PROJECT_CONTEXT.md
docs/HARNESS_NOTES.md
```

## Required Project Customization

Every product repo should fill in `docs/PROJECT_CONTEXT.md` with:

- install command
- dev server command
- lint command
- test command
- build command
- important paths
- product/domain context
- deployment notes

## Required Agent Behavior

Agents should:

- read `docs/AGENT_GUIDE.md` before making changes
- read `docs/PROJECT_CONTEXT.md` when project-specific context matters
- keep work scoped to the current request
- ask before broad architecture changes
- review diffs before final response
- report what was and was not verified

