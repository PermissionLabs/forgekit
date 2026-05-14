# External Tools

ForgeKit should work without requiring any external skill pack or agent plugin.
External tools can still be useful as optional accelerators.

## Policy

- Core ForgeKit templates must stay host-neutral.
- Do not require Claude-only hooks, Codex-only plugins, or one external skill
  ecosystem for all users.
- Absorb durable workflow principles into `docs/AGENT_GUIDE.md` and
  `docs/WORKFLOW.md`.
- Put optional tool recommendations here instead of hardcoding them into the
  required project workflow.

## Superpowers

Use when a team wants a broad skill methodology around brainstorming, planning,
TDD, systematic debugging, code review, and finishing branches.

Good fit:

- teams that want explicit skill-driven behavior
- projects that benefit from TDD and structured debugging enforcement
- multi-host environments where the team is willing to install the same skill
  pack per host

Watch for:

- skills may map differently across hosts
- some workflows can be heavier than needed for small changes
- project instructions should remain higher priority than external skills

## gstack

Use when a team wants opinionated slash-command workflows for product framing,
planning review, design review, QA, security, and shipping.

Good fit:

- founder or product-led teams that want structured product and release gates
- teams that want named commands for review, QA, and ship phases
- projects where browser QA and release discipline need stronger prompts

Watch for:

- command availability varies by host and install path
- the full role/command set may be more opinionated than ForgeKit's default
- do not require gstack in ForgeKit templates unless a product repo chooses it

## Compound Engineering

Use when a team wants a large skill/agent ecosystem for planning, research,
review, audits, PR feedback, and reusable engineering workflows.

Good fit:

- teams already comfortable installing plugins and companion agents
- repos that benefit from specialized reviewer/researcher agents
- teams that want to convert workflows across multiple agent hosts

Watch for:

- Codex support can require an additional install step for custom agents
- the full ecosystem is larger than ForgeKit's v0.1 contract
- dependency on external agent definitions should remain optional

## Recommended Default

For ForgeKit v0.1, use external packs as inspiration and optional team tools.
Keep the required workflow in repository documents:

- `AGENTS.md`
- `CLAUDE.md`
- `docs/AGENT_GUIDE.md`
- `docs/WORKFLOW.md`
- `docs/PROJECT_CONTEXT.md`
- `docs/HARNESS_NOTES.md`

## Layering on ForgeKit

ForgeKit is the source of truth for repository workflow, progress state, docs,
human QA, and merge gates. External packs can sit on top as execution aids.

Suggested mapping:

| ForgeKit moment | Optional tool |
| --- | --- |
| Rough or ambiguous request | Superpowers brainstorming, `/ce-brainstorm`, or gstack product review |
| Plan guardrails | Superpowers planning or `/ce-plan` |
| Implementation | Superpowers execution or `/ce-work` |
| Debug/fix loop | Superpowers debugging or `/ce-debug` |
| Code/security review | `/ce-code-review`, gstack review, or host-native review |
| Design QA | gstack design lens, Compound design agents, or project Figma skill |
| Human QA handoff | gstack QA/release lens, ForgeKit `human_qa` gate |
| Reusable learning | `/ce-compound` or ForgeKit `docs/solutions/` |

External tools must preserve these ForgeKit requirements:

- keep `.context/workflow-state.json` current
- copy durable outputs into `docs/changes/*.md`, `docs/audits/*.md`, or
  `docs/solutions/*.md`
- keep review residuals in `fixed`, `filed_followup`,
  `accepted_with_reason`, or `blocked`
- do not merge or deploy without explicit human approval when the project
  requires it
- treat full autonomous flows as opt-in, not the default ForgeKit workflow
