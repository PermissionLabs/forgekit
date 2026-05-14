# Harness Notes

Use this file to capture possible improvements to ForgeKit discovered while
working in real projects.

## Compound Loop

ForgeKit should improve through repeated real workflow friction, not speculative
rules.

When a repeated task, debugging loop, review failure, or documentation gap shows
up:

1. Fix the local project workflow first.
2. Record the pattern here.
3. Note whether it helped in practice.
4. Promote only the smallest reusable version into `templates/`.

## Upstream Candidates

Add notes here when a local workflow rule seems reusable across projects.

Suggested format:

```markdown
### YYYY-MM-DD - Short title

- Source project:
- Problem repeated:
- Local fix tried:
- Evidence it helped:
- Candidate ForgeKit change:
```

### 2026-05-14 - bootstrap entry point

- Source project: forgekit itself
- Problem repeated: New repos miss `.context/` or `.gitignore` step when
  applying templates manually; agents re-derive the procedure from README each
  time.
- Local fix tried: Added `docs/BOOTSTRAP.md` (agent-facing primary procedure)
  and `scripts/bootstrap.sh` (deterministic shortcut). README Quick Start now
  points at both.
- Evidence it helped: Pending — first downstream application.
- Candidate ForgeKit change: Already in this repo; promote pattern (doc + thin
  script) to any future spin-off harnesses.

## Rejected Ideas

Add notes here when an idea was tested and did not improve real development.

## Project-Only Rules

Add notes here when a rule is useful locally but should not be upstreamed.
