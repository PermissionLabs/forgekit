# cross-review (optional module)

A host-neutral cross-review runner. One CLI, one input shape, one output schema, and one adapter per
reviewer host (Claude Code, Codex CLI, Antigravity). Host differences live only in `adapters/`.
Zero runtime dependencies; Node 20 or newer (tests use `node:test`).

```text
modules/cross-review/
  cross-review.mjs        CLI: plan | run
  review-policy.json      pinned models, effort map, grade rules, pace thresholds, per-host usage windows
  lib/policy.mjs          policy loading/validation (model ids live only in the policy)
  lib/plan.mjs            grade, reviewer selection, pace
  lib/inputs.mjs          read-only snapshot at --rev (git objects), common prompt, path checks
  lib/schema.mjs          review / dispositions schemas and validators
  lib/run.mjs             run pipeline, pinned-vs-reported check, evidence, summary
  lib/proc.mjs            child process in its own group, timeout, bypass-flag guard
  adapters/{claude,codex,antigravity}.mjs
  test/                   unit tests and fake-host end-to-end tests (no model calls)
```

## Commands

```sh
# 1. Choose reviewers. usage.json is the saved output of the T3 MCP tool `provider_usage_limits`;
#    the runner never reads tokens or calls provider APIs itself.
node modules/cross-review/cross-review.mjs plan --author claude \
  --dimensions correctness,security --paths-from pr.patch --usage usage.json [--no-user]

# 2. Run one review per selected host.
node modules/cross-review/cross-review.mjs run --host codex --rev <sha> --diff pr.patch \
  --scope scope.txt --brief brief.md --out .context/reviews/r1/codex \
  [--dimensions correctness,security] [--context refs.txt] [--checklist docs/review-skills/code-review.md] \
  [--prior r0/codex/review.json --dispositions dispositions.json] [--id-start 9]
```

`plan` exits 0 (`ok`), 3 (`ask`: print the questions to the human) or 4 (`blocked`: needs a human
decision). `run` exits 0 (`complete`) or 1 (`incomplete`); 2 is a usage error.

`--scope` and `--context` take a file with one repo path per line (`#` comments) or a comma list.
`--out` must be outside the repository or git-ignored.

## Contract

**Input (same for every host).** A fresh read-only snapshot (`0444`/`0555`, outside the repository)
of the scope and context files at `--rev`, built with `git ls-tree`/`git show` from git objects only
(symlinks and submodules are refused, the working tree is never read), plus `__review__/diff.patch`,
`brief.md` and `checklist.md`. The prompt is built once by `lib/inputs.mjs` and its hash recorded;
Antigravity splits it into one turn per dimension group but keeps the same rules.

**Output.**

```json
{ "verdict": "pass|fix|block",
  "coverage": { "<dimension>": "checked | n/a:<reason>" },
  "findings": [{ "id": "C1|X1|A1", "sev": "critical|high|med|low", "loc": "path:line",
                 "claim": "", "evidence": "", "check": "" }],
  "limits": [""],
  "prior_verification": [{ "id": "X8", "verified": true, "note": "" }] }
```

Id prefix by host: Claude `C`, Codex `X`, Antigravity `A`. `loc` must be a scope file and a line
inside it. `verdict` must be `block` with any critical/high finding, `fix` with any other finding or
any unverified prior finding, `pass` otherwise. No length limit. The reply is validated; one
corrective retry is allowed after a normal finish, then the run is `incomplete`.

**Re-review.** `--prior` (a review, an evidence file, or a findings array) plus `--dispositions`
(`[{id, disposition: fixed|followup|accepted|blocked, ref}]`, one per prior id). Pass only the new
commit diff. The output must verify every prior id in `prior_verification`; new ids continue after
the highest prior id of the same prefix (override with `--id-start`). In the change record these map
to `fixed`, `filed_followup`, `accepted_with_reason`, `blocked`.

**Evidence** (`<out>/evidence.json`, plus `review.json`, `prompt.txt`, `raw/`): reviewer id, pinned
model/effort, reported model (and effort where the host reports it), prompt hash, timeout, status
and reasons, token counts, tool/path audit, argv, attempts. Any failure, any audit violation, or a
reported model that differs from (or cannot confirm) the pin makes the run `incomplete` and
withholds the review (`reviewIfIncomplete` keeps the draft for diagnosis). The runner never
switches to another reviewer or model.

## Selection and pace (`plan`)

- The author host is never a reviewer.
- Grade is `high` when a dimension is in `grade.high_dimensions` (security, migration, deployment,
  contract) or a changed path matches `grade.high_path_globs`; otherwise `standard`. Globs are
  matched against the full repo-relative path (`**/` for any depth).
- `standard` needs 1 reviewer, `high` needs 2 different hosts. Too few eligible hosts → `blocked`.
- Pace per window = `remainingFraction / remainingTimeFraction`, where remaining time is
  `(resetsAt − observedAt) / windowDurationSec`. Only the windows listed in
  `hosts.<h>.usage.windows` count (Antigravity's `shared_3p_*` windows meter Claude/GPT, not the
  Gemini reviewer); the worst one decides. A listed window that is missing or has
  `pace.computable=false` → `ask`.
- pace ≥ `use_at_or_above` (1.0): use. Between `high_only_at_or_above` (0.6) and 1.0: use only for
  high grade. Below 0.6, or `expected_cost[kind]` greater than the window's remaining fraction:
  skip with a one-line question. Usage unavailable: `ask`. `--no-user` turns `ask` into `blocked`.
  Thresholds are provisional (`pace.provisional`).

## How each host is held read-only

| Guarantee | Claude (`claude -p`) | Codex (`codex exec`) | Antigravity (ACP) |
| --- | --- | --- | --- |
| Model / effort | `--model`, `--effort` from policy | `-m`, `-c model_reasoning_effort=` | `session/set_config_option` model + thinking level |
| Reported model | stream `init.model` + `modelUsage` keys | stderr header `model:` (client-resolved) | `set_config_option` currentValue + stderr proxy model per call |
| No writes | `--tools Read,Grep,Glob`, `--restricted`, `--permission-mode dontAsk` | `-s read-only`, `approval_policy="never"` | `enabledTools:["view_file"]`, fs/terminal capabilities false, permissions `reject_once` |
| Reads confined | `--restricted` confines file tools to cwd = snapshot; audit of every tool path | **not enforced by the host**: audit of every command in the transcript | audit of every `view_file` path |
| No network beyond the model API | no WebFetch/WebSearch/Bash; `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | read-only sandbox has no network; `web_search="disabled"` | web tools not enabled |
| No MCP | `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`, `--safe-mode` | `--ignore-user-config` (MCP servers live there), `--disable plugins/apps` | `mcpServers: []`, isolated `GEMINI_HOME` without `config/` |
| No delegation | Agent tool not in `--tools` | `--disable multi_agent[_v2]` | `invoke_subagent` not enabled |
| Ignore user settings | `--setting-sources ""`, `--restricted`, `--safe-mode`, `--disable-slash-commands` | `--ignore-user-config`, `--ignore-rules` | isolated `GEMINI_HOME` (only `antigravity-acp/` linked) |
| No session persistence | `--no-session-persistence` | `--ephemeral` | not possible: session files deleted afterwards when `.meta` cwd matches |
| Never | `--dangerously-*`, `bypassPermissions`, `acceptEdits`, `--add-dir` | `--dangerously-*`, `--full-auto`, `workspace-write`, `danger-full-access`, `--add-dir` | `allow_*`, `reject_always` |

Every run checks the final argv against the bypass list, and the snapshot hash before/after. Token
files (`~/.codex/auth.json`, Claude credentials, `acp_token.json`) are never opened by the runner.

Known gaps (also written into each run's `hostLimits`):

- Codex's read-only sandbox does not limit which paths a command may read; out-of-snapshot reads are
  detected from the transcript (conservatively: any absolute path outside the snapshot, `..`, `~`,
  `$HOME`), not prevented. The model is the client-resolved header value, not echoed by the server.
- Claude does not report the effort level it ran at; Claude Code may use a small model for internal
  steps (recorded as a warning; the pinned model must appear in `modelUsage`).
- Antigravity cannot disable session persistence; the model per response is only visible in the
  local proxy's stderr, which may change between runtime versions. Its 300 s per-call
  time-to-first-byte limit is why reviews run in dimension-group turns.

## Tests

```sh
node --test modules/cross-review/test/*.test.mjs
```

The tests use fake `claude`/`codex` binaries (`test/fixtures/`) and never call a model.
