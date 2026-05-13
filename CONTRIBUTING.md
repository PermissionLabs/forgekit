# Contributing

This harness should improve through real project usage.

## Contribution Rule

Do not add a shared rule because it sounds good. Add it because it improved a real workflow.

Good changes usually come from:

- repeated friction across projects
- missed review or verification steps
- unclear agent behavior
- project setup steps that should be standardized
- patterns that helped humans and agents collaborate faster

## Local-to-Upstream Flow

1. Try the rule in a product repo.
2. Keep project-specific details in `docs/PROJECT_CONTEXT.md`.
3. Record reusable candidates in `docs/HARNESS_NOTES.md`.
4. Promote the smallest reusable version to this repo.
5. Update templates and docs together.

## Editing Templates

When changing expected downstream behavior, update:

- `templates/AGENTS.md`
- `templates/CLAUDE.md`
- `templates/docs/AGENT_GUIDE.md`
- relevant docs in `docs/`

## Review Standard

Before merging harness changes, check:

- Does this apply across more than one project?
- Is the rule concrete enough for agents to follow?
- Does it preserve human control over product direction?
- Does it reduce repeated coordination cost?
- Can it survive context compression?

