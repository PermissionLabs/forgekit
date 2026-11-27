# cross-review (optional module)

A host-neutral cross-review runner. One CLI, one input shape, one output schema, and one adapter per
reviewer host (Claude Code, Codex CLI, Antigravity). Host differences live only in `adapters/`.
Zero runtime dependencies; Node 20 or newer (tests use `node:test`). The Antigravity 1.5 runtime path
reads the session database with `node:sqlite`, so it needs Node 22.13 or newer (older Node: every 1.5
run is `incomplete` with `model_unconfirmed`; its tests are skipped).

```text
modules/cross-review/
  cross-review.mjs        CLI: plan | run | merge
  review-policy.json      pinned models, effort map, grade rules, pace thresholds, per-host usage windows
  lib/policy.mjs          policy loading/validation (model ids live only in the policy)
  lib/plan.mjs            grade, reviewer selection, pace, Antigravity budget estimate
  lib/turns.mjs           Antigravity turn groups / file chunks / total budget (shared by plan and the adapter)
  lib/diff.mjs            diff path extraction (hunk-aware, git-quoted paths decoded)
  lib/merge.mjs           multi-host review merge (grouping by place + claim similarity)
  lib/inputs.mjs          read-only snapshot at --rev (git objects), common prompt, path checks
  lib/schema.mjs          review / dispositions schemas and validators
  lib/run.mjs             run pipeline, pinned-vs-reported check, evidence, summary
  lib/proc.mjs            child process in its own group, timeout, bypass-flag guard, minimal env
  lib/sandbox.mjs         Codex OS sandbox: permission profile generation, self-test, runtime discovery
  adapters/{claude,codex,antigravity}.mjs
  test/                   unit tests and fake-host end-to-end tests (no model calls)
```

## Commands

```sh
# 1. Choose reviewers. usage.json is the saved output of the T3 MCP tool `provider_usage_limits`;
#    the runner never reads tokens or calls provider APIs itself.
node modules/cross-review/cross-review.mjs plan --author claude \
  --dimensions correctness,security --paths-from pr.patch --usage usage.json [--prior findings.json] [--no-user] [--out plan.json]

# 2. Run one review per selected host, with the same --dimensions as the plan.
node modules/cross-review/cross-review.mjs run --host codex --rev <sha> --diff pr.patch \
  --dimensions correctness,security --scope @scope.txt --brief brief.md --out .context/reviews/r1/codex \
  [--context @refs.txt] [--checklist docs/review-skills/code-review.md --checklist docs/review-skills/security-review.md] \
  [--prior r0/codex/review.json --dispositions dispositions.json] [--id-start 9]

# 3. Merge the hosts' reviews into one deduplicated summary (run directories or their evidence.json).
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
- `--out` (and `plan --out`, `merge --out`) must be outside every repository it could land in, or
  git-ignored there: the repository containing the output path itself and `--repo` (also accepted
  by `plan`/`merge`) are both checked. A tracked path, an output directory that holds tracked
  (e.g. force-added) files, or anything under `.git/` is refused.
- `run` writes `evidence.json`, `review.json`, `summary.txt` (the printed summary), `prompt.txt` and
  `raw/` under `--out`.
- `merge` groups findings from different hosts that point at the same file within `--line-window`
  lines and have similar claim+evidence wording (word Jaccard ≥ 0.2, ≥ 0.1 when the line ranges
  overlap); each group keeps every host's own id (e.g. `X1=A11`). Only runs whose `evidence.json`
  says `status: complete` and whose review is a `{ verdict, findings[] }` object are merged; a bare
  `review.json` without evidence, an incomplete run, or any other JSON is listed as incomplete
  (also when an entry claims complete but its review is malformed: never shown as complete).

## Contract

**Input (same for every host).** A fresh read-only snapshot (a private `mkdtemp` directory, `0500`
dirs / `0400` files, owner only, outside the repository) of the scope and context files at `--rev`,
built with `git ls-tree`/`git show` from git objects only (symlinks and submodules are refused, the
working tree is never read), plus `__review__/diff.patch`, `brief.md` and `checklist.md`. The prompt
is built once by `lib/inputs.mjs` and its hash recorded; Antigravity runs it as one turn on runtime
1.5 (split into scope-file chunks only for a large scope; on ≤1.4, one turn per dimension group and
chunk, see Antigravity turns) but keeps the same rules. Each
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
withholds the review: `review.json` is `null`, and `evidence.reviewIfIncomplete` keeps the
schema-valid draft for diagnosis (all three hosts: Codex reads its `-o` reply after the audit
whatever the outcome; Claude keeps it on timeout and abandoned pipes too; Antigravity keeps the
merged accepted turns, with unreviewed dimensions marked `n/a:not reviewed`; an unparseable reply is
kept as `reviewDraftRawIfIncomplete`). Incomplete reasons name the
offending command or path (truncated, first three plus a count). The runner never switches to
another reviewer or model.

## Selection and pace (`plan`)

- The author host is never a reviewer.
- Grade is `high` when a dimension is in `grade.high_dimensions` (security, migration, deployment,
  contract) or a changed path matches `grade.high_path_globs`; otherwise `standard`. Globs are
  matched against the full repo-relative path (`**/` for any depth). `gradeReasons` lists every
  matched file and ends with `paths: <m> of <n> matched a high glob, <n-m> unmatched`.
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
  (waiting for the reset is an option), unless another window fails its cost or pace: every window
  is evaluated and skip beats ask.
- Antigravity budget (not reported when Antigravity is the author): `plan` estimates its turns with
  the adapter's own helper (`lib/turns.mjs`), for the layout of the installed runtime
  (`budget.layout`; `cli` when none is found): dimension groups (none on 1.5; on ≤1.4 the `par_layout`
  groups + the leftover group, or one group for a small `--prior` re-review, then `budget.singleGroup`
  says so) × scope-file chunks by `max_files_per_turn` and, with sizes read from the working tree,
  `max_bytes_per_turn` (without sizes it is a lower bound). `hosts.antigravity.budget.totalSec` =
  `per_turn_budget_sec` × turns, at least `min_total_sec` (else `turn_timeout_sec`, else 1200),
  capped by `max_total_sec`; when the cap cuts it, `warnings[]` says so (see Antigravity turns below).
- pace ≥ `use_at_or_above` (1.0): use. Between `high_only_at_or_above` (0.6) and 1.0: use only for
  high grade. Below 0.6: skip with a one-line question. Usage unavailable: `ask`. `--no-user` turns
  `ask` into `blocked`. Thresholds and cost estimates are provisional (`pace.provisional`).

## How each host is held read-only

| Guarantee | Claude (`claude -p`) | Codex (`codex exec`) | Antigravity (ACP) |
| --- | --- | --- | --- |
| Model / effort | `--model`, `--effort` from policy | `-m`, `-c model_reasoning_effort=` | `session/set_config_option` model + thinking level |
| Reported model | stream `init.model` + `modelUsage` keys | stderr header `model:` (client-resolved) | `set_config_option` currentValue + per turn: runtime 1.5 session-database `gen_metadata` model (every generation), runtime ≤1.4 stderr proxy model |
| No writes | `--tools Read,Grep,Glob`, `--restricted`, `--permission-mode dontAsk` | OS sandbox profile with no write entry (header must say `sandbox: read-only`), `approval_policy="never"` | fs/terminal capabilities false, permissions `reject_once`, session mode `default` (1.5); `enabledTools:["view_file"]` (≤1.4 only: 1.5 ignores it, so non-read tools are caught by the audit) |
| Reads confined | `--restricted` confines file tools to cwd = snapshot; audit of every tool path, Glob patterns (each brace alternative; over 64 alternatives an automaton decides whether any alternative is absolute, `~` or has `..`: if so the run is `incomplete` with `tool_glob_unauditable`, otherwise it is a relative glob) and Grep `path`/`glob` (Grep's regex `pattern` is not a path); `~` paths are outside | **OS-enforced** (macOS Seatbelt, see below); the shell-command audit is evidence only (warnings) | audit of every `read_file`/`view_file` path (full `rawInput`/`args`, `tool_call_update` names and titles); any other tool except `update_steps` → `incomplete`; `~` paths are outside |
| Code execution | none (no Bash) | interpreters / command substitution may run, always under the same OS sandbox; `hosts.codex.allow_code_execution` (default `true`) only decides whether node's package dir is granted; code execution is recorded as a warning | none (commands need a permission, always rejected; any command tool call → `incomplete`) |
| No network beyond the model API | no WebFetch/WebSearch/Bash; `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | the profile has no network entry (model commands have no network); `web_search="disabled"` | ≤1.4: web tools not enabled; 1.5: `search_web` is available and can run before the audit makes the run `incomplete` |
| No MCP | `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`, `--safe-mode` | `--ignore-user-config` (MCP servers live there), `--disable plugins/apps` | `mcpServers: []`, isolated `GEMINI_HOME` without `config/` |
| No delegation | Agent tool not in `--tools` | `--disable multi_agent[_v2]` | ≤1.4: `invoke_subagent` not enabled; 1.5: available, caught after the fact by the audit (`incomplete`) |
| Ignore user settings | `--setting-sources ""`, `--restricted`, `--safe-mode`, `--disable-slash-commands` | `--ignore-user-config`, `--ignore-rules` | isolated `GEMINI_HOME` (only `antigravity-acp/` linked) |
| No session persistence | `--no-session-persistence` | `--ephemeral` | not possible: session files deleted afterwards when `.meta` cwd (≤1.4) or every session-database workspace URI (1.5) matches |
| Never | `--dangerously-*`, `bypassPermissions`, `acceptEdits`, `--add-dir` | anything outside the exact argv shape the runner builds (flag allowlist; every `-c` byte-identical to a runner-generated value); in particular `-s`/`--sandbox`/`sandbox_mode` in any form, `-p`/`--profile`/`-c profile=`, `--include-managed-config*`, `-P…`, `-a…`, `--enable`, `--sandbox-state*`, `--full-auto`, `--add-dir`, `--dangerously-*` | `allow_*`, `reject_always` |

Every spawned host argv (full, untruncated) is checked against the bypass list before anything is
executed (`refused before spawn`). For every host: `-s`/`--sandbox` (any form, including `-sX` and
`--sandbox=`), `sandbox_mode`, `--profile`, `--include-managed-config*`, attached `-P…`/`-a…` are
refused (no host needs them), and a `-c`/`--config` key is decoded as TOML (bare, dotted, quoted keys,
`\u`/`\U` escapes; an undecodable key counts as sensitive): a key touching permissions,
`default_permissions`, sandbox, approval, profile, managed config, network, features, `web_search`, ...
is accepted only when the value is byte-for-byte one the runner generated for this run
(`allowedConfig`). For Codex the guard is an allowlist of the whole argv shape `codex.buildArgv`
produces (`exec`, `-m`, `-c` = exactly the `allowedConfig` values and all of them, `--disable <name>`,
`--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--skip-git-repo-check`, `-C <abs>`,
`--color never`, `--output-schema`, `-o`, trailing `-`); any other token, or a missing generated value
(e.g. the permission profile), is refused. The reported argv is re-checked the same way after the run. Antigravity ≤1.4 has no argv beyond the
server binary; the 1.5 argv (`acp --gemini-dir … --app-data-dir antigravity-acp --log-file … --disable-telemetry`)
is checked against the bypass list before spawn. The
snapshot hash is compared before/after. Token files (`~/.codex/auth.json`, Claude credentials,
`acp_token.json`) are never opened by the runner.

**Codex OS sandbox (primary control).** Codex runs every model command under its own macOS
Seatbelt profile. The runner generates that profile as a Codex permission profile and passes it
with `-c default_permissions="cross_review_<random>"` and
`-c permissions.<name>.filesystem={...}` (`codex exec` gets no `-s`: `-s read-only` overrides a
permission profile with full-disk read, verified). The profile is:

| | |
| --- | --- |
| Read | `:minimal` (Codex's built-in platform set: system libraries/frameworks, `/bin`, `/usr/bin`, `/etc`, `/Library/Preferences`, `/System`, `/dev`), the snapshot, the codex runtime grant, the node runtime grant (when `allow_code_execution`, or when codex is a node script) |
| Runtime grant | the nearest versioned package directory of the resolved binary (basename starts with a version, at most 3 levels up: e.g. `~/.codex/packages/standalone/releases/0.172.0-aarch64-apple-darwin`, `~/.local/share/node/v22.23.5`, `Cellar/node/22.1.0`, `.nvm/versions/node/v22.0.0`), or the npm package dir (`node_modules/@openai/codex`), otherwise **the binary file itself**; never a shared prefix (`/usr/local`, `/opt/homebrew`, `~/.local`, `$HOME`, `/`) |
| Refused grants | any grant that is or contains `/`, `$HOME`, the Codex home or a denied path, and any runtime grant inside a denied path (`os_sandbox_profile_refused`); both sides are compared canonicalized (symlinks resolved, also for a nonexistent tail; `..` removed) and case-folded on macOS (case-insensitive APFS), and the profile records the canonical grant paths |
| Denied explicitly | `/private/tmp`, `/private/var/tmp` (in `:minimal` otherwise), written after every grant so nothing can overwrite them; everything else (home directories, the Codex home and its auth file, other temp dirs, `/Volumes`, `/opt`, `/Applications`) is denied by default |
| Write | none |
| Network | none (no network entry) |

Before the review the runner self-tests the profile without a model call, through
`codex sandbox <exact codex exec config flags> -- <cmd>` (permission profile, `approval_policy`,
`web_search`, every `--disable`; `codex sandbox` has no `--ignore-user-config`, so it runs with
`CODEX_HOME` set to an empty private directory: no user `config.toml` can be merged). Reading
harmless probe files the runner created in `os.tmpdir()`, `/private/tmp`, `/private/var/tmp` and
`$HOME`, listing the Codex home (names only, discarded) and writing inside the snapshot must fail with
EPERM, and reading a snapshot file must succeed. Any failed probe makes the run `incomplete`
(`os_sandbox_not_enforced:<probes>`); a probe file the runner could not create is never a pass
(`os_sandbox_selftest_unavailable:<probes>`, creation errors in `osSandbox.probeErrors`). Either way
codex exec is never started. The profile (TOML) and its
sha256, the read/denied roots and the self-test result are in `evidence.isolation.osSandbox`; the
profile is also `raw/codex-sandbox-profile.toml`. Sandbox denials are not counted (`deniedOps:
"not counted ..."`): the plain codex transcript has no marker that separates a real denial from
command output that merely contains "Operation not permitted" (r3 counted 8 such false positives).

Why not an outer `sandbox-exec` around `codex exec`: macOS refuses a nested `sandbox_apply` inside
any restrictive profile (an outer profile whose only rule is `(deny file-write*) (allow file-write*
(subpath "/"))` already makes the inner `sandbox-exec` fail with EPERM / exit 71), and Codex starts
every model command through `sandbox-exec`, so an outer profile breaks every command.

No Seatbelt (not macOS, or no `/usr/bin/sandbox-exec`): the run is always `incomplete`
(`no_os_sandbox`) and codex exec never starts. There is no audit-only mode (removed in r3; the
policy loader rejects `os_sandbox: "audit_only"`).

The codex process itself is not confined (it reads its own auth file and writes its state in the
Codex home); the runner never opens token files.

**Codex transcript audit.** Incomplete reasons come only from what the OS sandbox does not govern:
the header (model, effort, `sandbox: read-only`, `approval: never`, workdir = snapshot), a
transcript whose header or prompt echo cannot be read, and tool-like lines (`mcp`, `tool`, web
search, `apply_patch`) at block starts. The **shell-command audit is evidence only** (r3
simplification): once the self-test has proven the sandbox, no command finding makes a run
`incomplete`. Each `exec` block is parsed in full, including multi-line commands, up to its `in
<cwd>` line followed by a status line or a marker, never past the next `exec` marker; an `exec`
line without such a block is command output and is only counted. Commands are shell-tokenized
(wrapper `sh|bash|zsh -lc` unwrapped; `$'..'`/`$".."`, unassigned `$VAR`, redirections and prefix
options keep command position, glob and non-ASCII root paths are paths, `grep/rg/sed -f FILE` reads
FILE, `echo`/`printf` operands are literals). Literal outside reads, cwd outside the snapshot,
`cd` out of it, expansions and code execution are listed as `shell audit (evidence only)` warnings.
This ends the false positives (r3: `ls -l` of the allowed node binary made the run incomplete) and
the cat-and-mouse over audit bypasses (A36/X10/A49/A51/X21): what a command could read is what the
profile allowed.

**Process groups.** A host runs in its own process group. While the child is not reaped it holds
the group id, so signalling the group is safe. After it exits, a numeric pgid match is never taken
as membership: `ps -eo pid,pgid,lstart` is read right before each signal and only members whose
start time lies between the child's spawn and exit are signalled, each by pid. ps reports start
times floored to the second, so the window is [spawn second, exit] with no slack after the exit: a
process started after the exit is never signalled, except one started within the same wall-clock
second as the exit, which ps cannot tell apart (accepted residual, as is pid reuse between the ps
read and the kill). A descendant that keeps the host's
pipes open after exit makes the run `incomplete` (`pipes_abandoned`).

**Antigravity turns.** Every turn (first and corrective retry) is checked for timeout, upstream
failure, RPC error, a stop reason other than `end_turn`, fatal agent errors and auth prompts before
its text is used; after the last turn the unterminated last stderr line is flushed and checked
again, and an upstream 5xx seen outside any turn (e.g. during session setup) is a reason too; a
server exit with a non-zero code, or with a signal other than the one the runner sent to the live
group after cleanup started (a crash before cleanup, or a different signal), makes the run
`incomplete`; each turn must carry a matching model record (1.5: at least one `gen_metadata` row, and
every row must be the pinned model at the pinned thinking level; ≤1.4: a `Proxy extracted model`
line); finding ids continue
across turns; a spawn failure or early server exit fails at once.
Turn split by runtime layout (`lib/turns.mjs` `layoutConfig`). Runtime 1.5 (`cli`, the policy's
top-level values): ONE turn reviews every dimension (`groups: []`), and the scope is split into
file chunks only above `max_files_per_turn` (32) / `max_bytes_per_turn` (400000). Measured on 1.5.18
(2026-11-27): no first-byte wall (longest silent gap 20 s; a single 495 s turn over the full 24-file,
215 KB PR #26 succeeded), and one turn was faster (498 s vs 726 s) and used about 3.5x fewer tokens
(516K vs 1835K) than the 6-turn group/chunk split. Runtime ≤1.4 (`par`): its local proxy aborts a
model call whose first byte takes > 300 s, so `par_layout` (over the top-level values, defaults in
`PAR_LAYOUT_DEFAULTS`) keeps one turn per dimension group (`security`, `correctness`, `tests` +
`contract_docs`) and 8-file / 120 KB chunks with the old timings. Keys missing from the policy fall
back to `TURN_DEFAULTS` (32 files, 400000 bytes, `turn_timeout_sec` 1200, `retry_timeout_sec` 600).
`runtime_root` accepts `{platform}-{arch}`; the highest valid version of either layout is used:
1.5 directories hold `.install-complete.json` naming the executable (a regular executable file of the
recorded size, run as `antigravity acp --gemini-dir <isolated home> --app-data-dir antigravity-acp
--log-file <tmp> --disable-telemetry`, whose log is checked like the old stderr), ≤1.4 directories
hold `agy_acp_server.par`. On 1.5, `open`/`xdg-open` on the child's `PATH` are shims that record a
browser launch as `auth_required` instead of opening a sign-in URL. Leftover agy processes outside
the run's group are reported, never signalled.
The total budget is `per_turn_budget_sec` × planned turns, at least `min_total_sec` (default
`turn_timeout_sec`) so a short run is never squeezed below one turn's timeout, capped by
`max_total_sec` (3600) (`timeout_sec` applies only without `per_turn_budget_sec`). 1.5: 600 s per
turn, floor 1200 s, `turn_timeout_sec` 1200, so one turn gets 1200 s and a 2–6 chunk run 1200–3600 s.
≤1.4: 180 s per turn, floor 600 s, `turn_timeout_sec` 600 (r3's 16-turn plan died at the old fixed
1500 s after 11 turns). `plan` estimates the turns with the adapter's own helper (`lib/turns.mjs`:
groups + the leftover group, file chunks by count and, with sizes from the working tree, by bytes)
and reports no Antigravity budget when Antigravity is the author.
Speed knob (only for a layout with groups, i.e. ≤1.4): a re-review (`--prior`) whose diff is at most
`rereview_single_group_max_diff_bytes` (120000) runs one group with every dimension per file chunk
(`rereview_single_group`, default `true`), cutting the turns by the number of groups; `plan --prior`
estimates the same way.

Known gaps (also written into each run's `hostLimits`):

- Codex model commands can read Codex's `:minimal` platform set (system files under `/etc`,
  `/Library/Preferences`, `/System`, `/usr`); `none` entries cannot narrow it and Codex aborts at
  start without it. The codex process itself is unconfined. Commands Codex refuses before running
  them (e.g. `ls ~`) may not appear in the transcript at all. On macOS only; elsewhere always
  `no_os_sandbox`. The model is the client-resolved header value, not echoed by the server.
- A versioned runtime grant exposes that whole package directory (e.g. all of a codex release dir
  or a node version dir, including its `lib/node_modules`); a bare binary is granted as one file.
- Claude does not report the effort level it ran at; Claude Code may use a small model for internal
  steps (recorded as a warning; the pinned model must appear in `modelUsage`).
- Antigravity cannot disable session persistence; the model per response is only visible in the
  session database (1.5) or the local proxy's stderr (≤1.4), whose formats may change between
  runtime versions. The ≤1.4 proxy's 300 s per-call time-to-first-byte limit is why reviews on that
  runtime run in dimension-group turns; 1.5 has no such wall and runs one turn.
- Antigravity 1.5 ignores the `enabledTools` allowlist: the tool restriction is the audit (after the
  fact) plus rejected permissions for edits and commands. 1.5 signs in through the OS keyring entry T3
  uses, not through files in the linked profile.

## Tests

```sh
node --test modules/cross-review/test/*.test.mjs
```

The tests use fake `claude`/`codex` binaries and an ACP stub for Antigravity (`test/fixtures/`) and
never call a model. On macOS the fake codex's `sandbox` subcommand enforces the generated profile
with a real `sandbox-exec` SBPL profile that follows codex's semantics (`:minimal` includes the
shared temp areas, entries in profile order, last match wins, so only the `none` entries deny them), `test/sandbox.test.mjs` proves Seatbelt denies a harmless
outside file and allows a snapshot file, and, when a native codex is installed, runs the real
`codex sandbox` self-test with the exact exec config flags (no model call). The generic codex run tests
use an explicit self-test stand-in on every platform, so their results never depend on the platform. Fixture repositories commit with `-c commit.gpgsign=false` so a global signing
setting cannot break them.
