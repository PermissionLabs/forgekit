# Evolution

This harness should improve through real product usage.

## Local First

When a rule is discovered while working in a product repo, apply it locally first if it helps the current work.

Use `docs/HARNESS_NOTES.md` to record whether it should be upstreamed.

## Promote Carefully

Promote a rule to the shared harness when it improves more than one real workflow.

Do not upstream rules that are only about one project, one stack, one user preference, or one temporary bug.

## Keep the Harness Small

Prefer small workflow rules over large personas.

Good harness rules are:

- concrete
- easy to follow
- easy to review
- useful across projects
- resistant to context loss

Weak harness rules are:

- vague
- motivational
- too long to stay in context
- dependent on one agent host
- likely to slow down normal development

## Upstream Flow

Recommended flow:

1. Change the product repo guide.
2. Use the change in a real session.
3. Record the result in `docs/HARNESS_NOTES.md`.
4. If reusable, copy the improvement into the harness templates.
5. Review, commit, and release the harness update.
6. Sync downstream projects.

