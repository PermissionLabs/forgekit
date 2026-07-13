# Command Skills

Command skills are named procedures that drive existing `docs/WORKFLOW.md` phases. They orchestrate
rules; they do not duplicate workflow, review, release, or product contracts.

## Canonical Layout

```text
.agents/skills/<name>/
├── SKILL.md                    # discovery metadata + short execution contract
├── agents/openai.yaml          # Codex UI metadata
└── references/procedure.md     # long procedure, loaded only after invocation
```

The skill directory is the single source of truth. Keep trigger phrases in `SKILL.md` frontmatter,
essential routing in its body, and detailed steps in `references/procedure.md`. Do not copy procedure
steps into host bindings or entry files.

## Host Bindings

| Host | Binding | Invocation |
| --- | --- | --- |
| Codex | native discovery from `.agents/skills/<name>/SKILL.md` | `$name args` or matching natural language |
| Claude Code | `.claude/commands/<name>.md` compatibility stub | `/name args` |
| Other agents | `AGENTS.md` skill table | read canonical `SKILL.md` |

Legacy `docs/command-skills/<name>.md` files may remain for one release cycle as link-only stubs.
They are not procedure sources.

## Required Contract

Each canonical skill must define:

1. Precise positive and negative trigger context in frontmatter description.
2. Inputs and no-argument behavior.
3. Required tools, connectors, credentials, and host limitations.
4. Phase-mapped procedure and artifact outputs.
5. Human gates and termination conditions.
6. A thin Claude binding when slash compatibility is required.

Push, PR, merge, production writes, releases, destructive cleanup, and foreign-task recovery retain
their repository gates. Skill invocation is not approval for those actions.

## Authoring And Validation

1. Use the host's skill-creation procedure to initialize `.agents/skills/<name>`.
2. Write one canonical procedure and convert older sources into link-only compatibility stubs.
3. Add positive and negative trigger fixtures to the project's deterministic harness tests.
4. Run the host's official skill validator plus the project harness gate.

Validation should reject duplicated procedure bodies, stale host paths, incomplete discovery metadata,
and compatibility bindings that do more than route arguments.

## Intentional Host-Only Exceptions

An exception must name the unavailable capability, document the supported host, and set a concrete
re-evaluation condition. Review exceptions when connector or host inventory changes; do not preserve
them as permanent host folklore.
