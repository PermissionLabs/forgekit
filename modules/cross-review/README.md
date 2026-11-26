# cross-review (optional module)

A host-neutral cross-review runner. One CLI, one input shape, one output schema, and one adapter per
reviewer host (Claude Code, Codex CLI, Antigravity). Host differences live only in `adapters/`.
Zero runtime dependencies; Node 20 or newer (tests use `node:test`).

```text
modules/cross-review/
  cross-review.mjs        CLI: plan | run | merge
  review-policy.json      pinned models, effort map, grade rules, pace thresholds, per-host usage windows
  lib/policy.mjs          policy loading/validation (model ids live only in the policy)
  lib/plan.mjs            grade, reviewer selection, pace
  lib/diff.mjs            diff path extraction (hunk-aware, git-quoted paths decoded)
  lib/merge.mjs           multi-host review merge (grouping by place + claim similarity)
  lib/inputs.mjs          read-only snapshot at --rev (git objects), common prompt, path checks
  lib/schema.mjs          review / dispositions schemas and validators
  lib/run.mjs             run pipeline, pinned-vs-reported check, evidence, summary
  lib/proc.mjs            child process in its own group, timeout, bypass-flag guard, minimal env
  adapters/{claude,codex,antigravity}.mjs
  test/                   unit tests and fake-host end-to-end tests (no model calls)
```

## Commands

```sh
# 1. Choose reviewers. usage.json is the saved output of the T3 MCP tool `provider_usage_limits`;
#    the runner never reads tokens or calls provider APIs itself.
node modules/cross-review/cross-review.mjs plan --author claude \
  --dimensions correctness,security --paths-from pr.patch --usage usage.json [--no-user] [--out plan.json]

# 2. Run one review per selected host, with the same --dimensions as the plan.
node modules/cross-review/cross-review.mjs run --host codex --rev <sha> --diff pr.patch \
  --dimensions correctness,security --scope @scope.txt --brief brief.md --out .context/reviews/r1/codex \
  [--context @refs.txt] [--checklist docs/review-skills/code-review.md --checklist docs/review-skills/security-review.md] \
  [--prior r0/codex/review.json --dispositions dispositions.json] [--id-start 9]

# 3. Merge the hosts' reviews into one deduplicated summary.
node modules/cross-review/cross-review.mjs merge --review .context/reviews/r1/codex \
  --review .context/reviews/r1/antigravity [--out .context/reviews/r1/merged.json] [--line-window 3]
```

`plan` exits 0 (`ok`), 3 (`ask`: print the questions to the human) or 4 (`blocked`: needs a human
decision). `run` exits 0 (`complete`) or 1 (`incomplete`). `merge` exits 0 when every input run is
complete, 1 otherwise. 2 is a usage error (including unknown or repeated options).

- `--scope` and `--context`: a comma list of repo paths, or `@<file>` with one repo path per line
  (`#` comments). A bare file name is always a repo path, never a list file.
- `--checklist` (repeatable, one path each): a relative path, or an absolute path inside the
  repository, is read from the git object at `--rev` (never the working tree); an absolute path
  outside the repository is read from disk. Each checklist's source and sha256 are in the evidence.
- `--out` (and `plan --out`, `merge --out`) must be outside the repository or git-ignored; a tracked
  path or anything under `.git/` is refused.
- `run` writes `evidence.json`, `review.json`, `summary.txt` (the printed summary), `prompt.txt` and
  `raw/` under `--out`.
- `merge` groups findings from different hosts that point at the same file within `--line-window`
  lines and have similar claim+evidence wording (word Jaccard ≥ 0.2, ≥ 0.1 when the line ranges
  overlap); each group keeps every host's own id (e.g. `X1=A11`). Incomplete runs are listed, never merged.

## Contract

**Input (same for every host).** A fresh read-only snapshot (a private `mkdtemp` directory, `0500`
dirs / `0400` files, owner only, outside the repository) of the scope and context files at `--rev`,
built with `git ls-tree`/`git show` from git objects only (symlinks and submodules are refused, the
working tree is never read), plus `__review__/diff.patch`, `brief.md` and `checklist.md`. The prompt
is built once by `lib/inputs.mjs` and its hash recorded; Antigravity splits it into turns (one per
dimension group, and per scope-file chunk when the scope is large) but keeps the same rules. Each
reviewer child gets a minimal environment (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`,
`LANG`, `LC_*`, `TZ`, `TMPDIR`, plus `CODEX_HOME` / `CLAUDE_CONFIG_DIR` and
`hosts.<h>.env_passthrough`); Antigravity keeps its own provider-credential denylist.

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

**Evidence** (`<out>/evidence.json`, plus `review.json`, `summary.txt`, `prompt.txt`, `raw/`):
reviewer id, pinned model/effort, reported model and effort (`effortCheck`: verified, or
`unreported` for Claude, which never reports it; a host that reports effort but omits it is
`incomplete`), prompt hash, timeout, status and reasons, token counts summed over attempts,
tool/path audit, argv, attempts (each with its own reported model and signal log). Any failure, any audit violation, or a
reported model that differs from (or cannot confirm) the pin makes the run `incomplete` and
withholds the review (`reviewIfIncomplete` keeps the draft for diagnosis). The runner never
switches to another reviewer or model.

## Selection and pace (`plan`)

- The author host is never a reviewer.
- Grade is `high` when a dimension is in `grade.high_dimensions` (security, migration, deployment,
  contract) or a changed path matches `grade.high_path_globs`; otherwise `standard`. Globs are
  matched against the full repo-relative path (`**/` for any depth).
- `standard` needs 1 reviewer, `high` needs 2 different hosts. Too few eligible hosts → `blocked`.
- `host_order` must list configured hosts without duplicates (checked by the policy loader; the
  planner also de-duplicates).
- Pace per window = `remainingFraction / remainingTimeFraction`, where remaining time is
  `(resetsAt − observedAt) / windowDurationSec`. Only the windows listed in
  `hosts.<h>.usage.windows` count (Antigravity's `shared_3p_*` windows meter Claude/GPT, not the
  Gemini reviewer); the worst one decides. A listed window that is missing, has
  `pace.computable=false`, or a `remainingFraction` that is not a number in [0, 1] → `ask`.
- `hosts.<h>.expected_cost` is keyed by window kind (`session` = the 5 h window, `weekly`) and is
  checked against every listed window: cost greater than the remaining fraction → skip.
- A window that resets within `pace.reset_soon_minutes` (60) is not paced (a nearly reset window
  would show a pace of 60+): it only has to cover its expected cost. If it cannot, the plan asks
  (waiting for the reset is an option) instead of skipping.
- pace ≥ `use_at_or_above` (1.0): use. Between `high_only_at_or_above` (0.6) and 1.0: use only for
  high grade. Below 0.6: skip with a one-line question. Usage unavailable: `ask`. `--no-user` turns
  `ask` into `blocked`. Thresholds and cost estimates are provisional (`pace.provisional`).

## How each host is held read-only

| Guarantee | Claude (`claude -p`) | Codex (`codex exec`) | Antigravity (ACP) |
| --- | --- | --- | --- |
| Model / effort | `--model`, `--effort` from policy | `-m`, `-c model_reasoning_effort=` | `session/set_config_option` model + thinking level |
| Reported model | stream `init.model` + `modelUsage` keys | stderr header `model:` (client-resolved) | `set_config_option` currentValue + stderr proxy model per call |
| No writes | `--tools Read,Grep,Glob`, `--restricted`, `--permission-mode dontAsk` | `-s read-only`, `approval_policy="never"` | `enabledTools:["view_file"]`, fs/terminal capabilities false, permissions `reject_once` |
| Reads confined | `--restricted` confines file tools to cwd = snapshot; audit of every tool path and of absolute/`..`/`~` Glob/Grep patterns | **not enforced by the host**: audit of every command in the transcript | audit of every `view_file` path (full `rawInput`, `tool_call_update` titles) |
| Code execution | none (no Bash) | `hosts.codex.allow_code_execution` (default `true`): interpreters / command substitution may run, only inside the read-only sandbox; `false` makes any such command `incomplete` | none (`view_file` only) |
| No network beyond the model API | no WebFetch/WebSearch/Bash; `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | read-only sandbox has no network; `web_search="disabled"` | web tools not enabled |
| No MCP | `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`, `--safe-mode` | `--ignore-user-config` (MCP servers live there), `--disable plugins/apps` | `mcpServers: []`, isolated `GEMINI_HOME` without `config/` |
| No delegation | Agent tool not in `--tools` | `--disable multi_agent[_v2]` | `invoke_subagent` not enabled |
| Ignore user settings | `--setting-sources ""`, `--restricted`, `--safe-mode`, `--disable-slash-commands` | `--ignore-user-config`, `--ignore-rules` | isolated `GEMINI_HOME` (only `antigravity-acp/` linked) |
| No session persistence | `--no-session-persistence` | `--ephemeral` | not possible: session files deleted afterwards when `.meta` cwd matches |
| Never | `--dangerously-*`, `bypassPermissions`, `acceptEdits`, `--add-dir` | `--dangerously-*`, `--full-auto`, `workspace-write`, `danger-full-access`, `--add-dir` | `allow_*`, `reject_always` |

Every spawned host argv (full, untruncated) is checked against the bypass list before anything is
executed (`refused before spawn`); any `approval_policy` other than `never` or `sandbox_mode` other
than `read-only` counts, quoted either way. Antigravity has no argv beyond the server binary. The
snapshot hash is compared before/after. Token files (`~/.codex/auth.json`, Claude credentials,
`acp_token.json`) are never opened by the runner.

**Codex transcript audit (conservative).** Each `exec` block is parsed in full, including multi-line
commands, up to its `in <cwd>` line; the command is shell-tokenized (wrapper `sh|bash|zsh -lc`
unwrapped). The run is `incomplete` when the auditor cannot read a command confidently (unbalanced
quotes, a `$VAR` not assigned in the same script, a missing terminator, a prompt echo that differs
from the prompt sent), when a cwd is missing or outside the snapshot (realpath, so `/tmp` and
`/private/tmp` agree), or when a command names a path outside the snapshot: absolute paths
including flag-attached forms (`-C/x`, `-f/x`, `--file=/x`), `~`, `..`, bare `cd`, `cd ~`, `cd -`.
Tool-like lines (`mcp`, `tool`, web search, `apply_patch`) are flagged at block starts only; the
prompt echo is skipped by exact match.

**Process groups.** A host runs in its own process group. While the child is not reaped it holds
the group id, so signalling is safe; after it exits, `ps -eo pid,pgid` must show a live member right
before each signal, otherwise no signal is sent (the id may already be reused). A descendant that
keeps the host's pipes open after exit makes the run `incomplete` (`pipes_abandoned`).

**Antigravity turns.** Every turn (first and corrective retry) is checked for timeout, upstream
failure, RPC error, a stop reason other than `end_turn`, fatal agent errors and auth prompts before
its text is used; each turn must carry a matching `Proxy extracted model` line; finding ids continue
across turns; a spawn failure or early server exit fails at once. `max_files_per_turn` (8) and
`max_bytes_per_turn` (120000) split each dimension group into scope-file chunks so a turn stays well
under the proxy's 300 s first-byte wall. `runtime_root` accepts `{platform}-{arch}`; the highest
version present is used. Leftover agy processes outside the run's group are reported, never signalled.

Known gaps (also written into each run's `hostLimits`):

- Codex's read-only sandbox does not limit which paths a command may read; out-of-snapshot reads are
  detected from the transcript, not prevented. With code execution allowed, a program can read a
  file without naming it literally (e.g. a computed path); only literal paths, cwd and expansions
  are audited. Set `allow_code_execution: false` to forbid interpreters and command substitution.
  The model is the client-resolved header value, not echoed by the server.
- Claude does not report the effort level it ran at; Claude Code may use a small model for internal
  steps (recorded as a warning; the pinned model must appear in `modelUsage`).
- Antigravity cannot disable session persistence; the model per response is only visible in the
  local proxy's stderr, which may change between runtime versions. Its 300 s per-call
  time-to-first-byte limit is why reviews run in dimension-group turns.

## Tests

```sh
node --test modules/cross-review/test/*.test.mjs
```

The tests use fake `claude`/`codex` binaries and an ACP stub for Antigravity (`test/fixtures/`) and
never call a model. Fixture repositories commit with `-c commit.gpgsign=false` so a global signing
setting cannot break them.
