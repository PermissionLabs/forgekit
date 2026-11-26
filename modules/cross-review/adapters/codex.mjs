// Codex reviewer adapter: `codex exec`, ephemeral, user config/rules ignored, every model-run command confined
// by an OS-enforced Seatbelt profile that the runner generates (lib/sandbox.mjs): reads only from the snapshot,
// the platform set and the runtimes; no writes; no network. Enforcement is self-tested before each run.
// Flags verified against `codex exec --help` (codex-cli 0.167.0) and live runs on 2026-11-26; the OS sandbox
// (permission profile, `codex sandbox` self-test) re-verified with codex-cli 0.172.0 the same day.
// Plain (non --json) mode is used on purpose: only the stderr header reports the resolved model, effort,
// sandbox and approval policy; --json omits them. Commands are audited from the same transcript.
//
// Audit stance (r3 simplification): the OS sandbox is the control, proven by a self-test before codex exec
// starts; without it the run is incomplete (no_os_sandbox / os_sandbox_not_enforced). The shell-command audit is
// evidence only: every finding (outside paths, cwd, expansions, code execution) is a warning and never makes the
// run incomplete. Hard reasons come only from the transcript header (model, effort, sandbox, approval, workdir),
// an unparseable transcript and non-shell tool sections (MCP, web search, apply_patch), which the sandbox does not
// govern.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { insideRoot, realish, redact, sha256 } from "../lib/inputs.mjs";
import { runProcess, scrubEnv } from "../lib/proc.mjs";
import * as sandbox from "../lib/sandbox.mjs";

// Features that add tools beyond shell reads (delegation, connectors, browser, MCP-bearing plugins, ...).
// Overridable per policy (hosts.codex.disabled_features) when a Codex release renames one.
export const DISABLED_FEATURES = ["multi_agent", "multi_agent_v2", "apps", "plugins", "hooks", "browser_use", "browser_use_external", "computer_use", "image_generation", "memories", "standalone_web_search"];

/**
 * Config flags shared by `codex exec` and the `codex sandbox` self-test, so both run under the same settings:
 * the generated permission profile (`-c default_permissions=...`, replacing `-s read-only`, which would override
 * the profile with full-disk read access), approval never, web search off, disabled features.
 */
export function configArgs(pin, permissionArgs) {
  if (!Array.isArray(permissionArgs) || !permissionArgs.length) throw new Error("codex runs only under a generated permission profile");
  const features = pin.config?.disabled_features ?? DISABLED_FEATURES;
  return [
    ...permissionArgs,                    // model-run commands: no writes, no network; reads confined by the profile
    "-c", 'approval_policy="never"',      // never escalate out of the sandbox; failing commands just fail
    "-c", 'web_search="disabled"',
    ...features.flatMap((f) => ["--disable", f]),
  ];
}

/** The exact `-c` values the runner generates for one run (A50: the bypass guard accepts no other sensitive -c). */
export function allowedConfig(pin, permissionArgs) {
  const a = ["-c", `model_reasoning_effort="${pin.effort}"`, ...configArgs(pin, permissionArgs)];
  return a.filter((x, i) => i > 0 && a[i - 1] === "-c");
}

/** argv for one attempt. */
export function buildArgv(pin, { snapshot, schemaPath, lastMessagePath, permissionArgs }) {
  return [
    "exec",
    "-m", pin.model,
    "-c", `model_reasoning_effort="${pin.effort}"`,
    ...configArgs(pin, permissionArgs),
    "--ephemeral",                        // no session files
    "--ignore-user-config",               // $CODEX_HOME/config.toml (and its MCP servers) not loaded; auth still works
    "--ignore-rules",
    "--skip-git-repo-check",              // the snapshot is not a git checkout
    "-C", snapshot,
    "--color", "never",
    "--output-schema", schemaPath,
    "-o", lastMessagePath,
    "-",                                  // prompt from stdin
  ];
}

/** Minimal child environment: BASE_ENV, CODEX_HOME (auth location) and hosts.codex.env_passthrough. */
export function buildEnv(base = process.env, passthrough = []) {
  return scrubEnv(base, ["CODEX_HOME", ...passthrough]);
}

// ---------------------------------------------------------------- transcript
const MARKERS = new Set(["user", "codex", "exec", "thinking", "tokens used"]);
const STATUS = /^ (succeeded|exited -?\d+|failed|declined|timed out)\b.*$/;
const CMD_END = /^.* in \/.*$/;
const SUSPICIOUS = /^(tool|mcp|web_search|web search|apply_patch|file update)\b|^🌐/i;

/**
 * Parse the plain-mode stderr transcript. Pure; used by tests with fixtures.
 * prompt: the exact stdin text; its echo after `user` is skipped only when it matches byte for byte.
 * Tool-like lines (mcp/tool/web/apply_patch) are flagged only at block starts (after a blank line), never inside
 * the prompt echo or mid-paragraph of command output. An `exec` line starts a command only when a complete block
 * follows (command lines, then `... in /<cwd>` followed by a status line, a marker or the end); any other `exec`
 * line is command output and only counted (execLinesIgnored).
 */
export function parseTranscript(stderr, { prompt } = {}) {
  const lines = String(stderr).split("\n");
  const header = {};
  const unauditable = [];
  const commands = [];
  const suspicious = [];
  let tokens = null, execLinesIgnored = 0;
  const version = lines.map((l) => l.match(/^OpenAI Codex v(\S+)/)?.[1]).find(Boolean) ?? null;
  const open = lines.findIndex((l) => l.trim() === "--------");
  let j = -1;
  if (open !== -1) {
    for (j = open + 1; j < lines.length && lines[j].trim() !== "--------"; j++) {
      const m = lines[j].match(/^([a-z][a-z ]*?):\s*(.*)$/);
      if (m) header[m[1]] = m[2].trim();
    }
  }
  if (open === -1 || j >= lines.length) return { header, commands, suspicious, tokens, version, execLinesIgnored, unauditable: ["transcript header missing"] };
  j++;
  if (lines[j] !== "user") unauditable.push("no prompt echo after the header");
  else if (typeof prompt === "string") {
    const rest = lines.slice(j + 1).join("\n");
    if (!rest.startsWith(prompt)) unauditable.push("prompt echo does not match the prompt sent");
    else j = j + 1 + prompt.replace(/\n$/, "").split("\n").length;
  } else {
    // No prompt to compare (tests): skip the echo up to the first marker after a blank line.
    for (j = j + 1; j < lines.length && !(lines[j - 1] === "" && MARKERS.has(lines[j])); j++);
  }
  let prevBlank = true;
  for (; j < lines.length; j++) {
    const l = lines[j];
    if (l === "exec") {
      let end = -1;
      for (let k = j + 1; k < lines.length; k++) {
        if (lines[k] === "exec") break; // X6: never search past the next exec marker (a stray exec is output)
        if (CMD_END.test(lines[k]) && (k + 1 >= lines.length || STATUS.test(lines[k + 1]) || MARKERS.has(lines[k + 1]))) { end = k; break; }
      }
      if (end === -1) { execLinesIgnored++; prevBlank = false; continue; }
      const block = lines.slice(j + 1, end + 1).join("\n");
      const m = block.match(/^([\s\S]*) in (\/[^\n]*)$/);
      commands.push({ command: m[1], cwd: m[2], line: j + 1 });
      j = end;
      if (STATUS.test(lines[j + 1] ?? "")) j++;
      prevBlank = false;
      continue;
    }
    if (l === "tokens used" && j + 1 < lines.length) { tokens = Number(lines[j + 1].replace(/[^0-9]/g, "")) || null; j++; prevBlank = false; continue; }
    if (prevBlank && SUSPICIOUS.test(l)) suspicious.push(l.slice(0, 200));
    prevBlank = l.trim() === "";
  }
  return { header, commands, suspicious, tokens, version, execLinesIgnored, unauditable };
}

// ---------------------------------------------------------------- shell audit (evidence warnings only)
/** Shell tokenizer (POSIX quoting subset). Returns { tokens: [{type:"word", text, exps[]} | {type:"op", text}] } or { error }. */
export function shellTokens(s) {
  const toks = [];
  let cur = null, i = 0;
  const word = () => { if (!cur) cur = { type: "word", text: "", exps: [] }; return cur; };
  const end = () => { if (cur) { toks.push(cur); cur = null; } };
  const dollar = (at) => {
    const rest = s.slice(at + 1);
    let m;
    if (rest[0] === "(") return "$(";
    if (rest[0] === "'" || rest[0] === '"') return `$${rest[0]}`; // ANSI-C / locale quoting: escapes the tokenizer does not decode
    if ((m = rest.match(/^\{([A-Za-z_][A-Za-z0-9_]*)/))) return m[1];
    if (rest[0] === "{") return "${";
    if ((m = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)/))) return m[1];
    if (rest[0] && "?#".includes(rest[0])) return rest[0];
    if (rest[0] === undefined || /[\s/;|&)]/.test(rest[0])) return null; // literal $
    return `$${rest[0]}`;
  };
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      const e = s.indexOf("'", i + 1);
      if (e === -1) return { error: "unterminated single quote" };
      word().text += s.slice(i + 1, e);
      i = e + 1;
      continue;
    }
    if (c === '"') {
      const w = word();
      i++;
      let closed = false;
      while (i < s.length) {
        const d = s[i];
        if (d === '"') { closed = true; i++; break; }
        if (d === "\\" && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1])) { if (s[i + 1] !== "\n") w.text += s[i + 1]; i += 2; continue; }
        if (d === "$") { const x = dollar(i); if (x) w.exps.push(x); }
        if (d === "`") w.exps.push("`");
        w.text += d;
        i++;
      }
      if (!closed) return { error: "unterminated double quote" };
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= s.length) return { error: "trailing backslash" };
      if (s[i + 1] !== "\n") word().text += s[i + 1];
      i += 2;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n") { end(); if (c === "\n") toks.push({ type: "op", text: "\n" }); i++; continue; }
    if (";|&()<>".includes(c)) {
      // `2>file`: an all-digit word glued to a redirection is its file descriptor, not a command word.
      let op = c;
      if ((c === "<" || c === ">") && cur && /^\d+$/.test(cur.text) && !cur.exps.length) { op = cur.text + c; cur = null; }
      end();
      while (i + 1 < s.length && ";|&<>".includes(s[i + 1]) && op.length < 4) op += s[++i];
      toks.push({ type: "op", text: op });
      i++;
      continue;
    }
    if (c === "$") { const x = dollar(i); if (x) word().exps.push(x); }
    if (c === "`") word().exps.push("`");
    word().text += c;
    i++;
  }
  end();
  return { tokens: toks };
}

const SHELL = /^(?:\/usr)?\/bin\/(?:ba|z|da|k)?sh$|^(?:ba|z|da|k)?sh$/;
// Interpreters and command runners: their arguments are programs the auditor cannot read.
const CODE_RUNNERS = new Set(["node", "nodejs", "python", "python2", "python3", "perl", "ruby", "php", "deno", "bun", "sh", "bash", "zsh", "dash", "ksh", "fish", "osascript", "eval", "source", ".", "exec", "xargs", "env", "awk", "gawk", "mawk", "nawk", "lua", "tclsh", "Rscript", "jshell", "swift"]);
// Commands whose first operand (or -e value) is a pattern or script, not a path. Their -f/--file value IS a path.
const PATTERN_FIRST = new Set(["grep", "egrep", "fgrep", "rg", "ag", "sed"]);
// Commands that only print their operands.
const PRINTERS = new Set(["echo", "printf"]);
const ALLOWED_ABS = [/^\/dev\/null$/, /^\/dev\/std(in|out|err)$/, /^\/dev\/fd\/\d+$/, /^\/(usr\/)?(local\/)?s?bin\//, /^\/opt\/homebrew\/bin\//, /^\/opt\/local\/bin\//, /^\/home\/linuxbrew\/\.linuxbrew\/bin\//];
const ABS_IN_WORD = /(?:^|[\s=:,@"'(\[{<>|])(\/[^\s,:'"`;|&()<>\[\]{}]*)/g;
const isOp = (t) => t?.type === "op";
const isRedirect = (t) => isOp(t) && /^\d*[<>]/.test(t.text);
// Words after which the next word is still a command (keywords and command prefixes).
const PREFIX_WORDS = new Set(["command", "builtin", "time", "nice", "nohup", "sudo", "!", "do", "then", "else", "elif", "if", "while", "until", "{", "}"]);
// Prefix options that take a separate value (`nice -n 5 cmd`, `sudo -u root cmd`).
const PREFIX_OPT_VALUE = { nice: ["-n"], sudo: ["-u", "-g", "-h", "-C", "-p"], time: ["-o"] };

/**
 * auditCommand(command, cwd, snapshot, { allowCodeExecution }) ->
 *   { outside[], hard[], unauditable[], codeExecution[], cwdInside, wellFormed }
 * outside: every word pointing outside the snapshot (absolute paths incl. flag-attached and glob ones, ~, .., cd).
 * hard: the literal reads among them: a literal outside path given to a file-reading command (not as its
 *   pattern; a -f/--file pattern file is a read), a redirection, cd/pushd/popd leaving the snapshot. Literal paths
 *   inside interpreter programs, patterns or echo/printf operands are not. All of it is evidence (warnings).
 * unauditable: the command could not be read confidently (quoting, unknown $VAR / $'..' expansion, wrapper args).
 * codeExecution: interpreters / command substitution seen.
 * wellFormed: the command is one `<shell> -c '<script>'` wrapper (or a plain command) that tokenized cleanly.
 */
export function auditCommand(command, cwd, snapshot, { allowCodeExecution = true } = {}) {
  const outside = [], hard = [], unauditable = [], codeExecution = [];
  const cwdInside = typeof cwd === "string" && cwd.startsWith("/") && insideRoot(snapshot, cwd);
  const ret = (wellFormed) => {
    if (!allowCodeExecution && codeExecution.length) unauditable.push(...codeExecution.map((x) => `code execution not allowed by policy: ${x}`));
    return { outside: [...new Set(outside)], hard: [...new Set(hard)], unauditable, codeExecution, cwdInside, wellFormed };
  };
  const top = shellTokens(command);
  if (top.error) { unauditable.push(top.error); return ret(false); }
  let script = command;
  const tw = top.tokens;
  if (tw.length >= 2 && tw[0].type === "word" && SHELL.test(tw[0].text) && /^-l?c$|^-cl$/.test(tw[1].text ?? "")) {
    if (tw.length !== 3 || tw[2].type !== "word") { unauditable.push("shell wrapper with extra arguments"); return ret(false); }
    if (tw[0].exps.length || tw[1].exps.length) unauditable.push("expansion in shell wrapper");
    script = tw[2].text;
  }
  const inner = shellTokens(script);
  if (inner.error) { unauditable.push(inner.error); return ret(false); }
  const toks = inner.tokens;
  // Names assigned by the script itself, in order and only in command position (NAME=..., for NAME, read NAME).
  const assigned = new Set();
  let cmdPos = true, redirTarget = false, prefix = null, skipValue = false, prevWord = null;
  // The current simple command: its name and whether its operands are a program or patterns.
  let cmdName = null, operandIndex = 0, patternSeen = false, patternOpt = false, fileOpt = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (isRedirect(t)) { redirTarget = true; continue; }                 // command position survives a redirection
    if (isOp(t)) { cmdPos = true; prefix = null; cmdName = null; operandIndex = 0; patternSeen = false; patternOpt = false; fileOpt = false; prevWord = null; continue; }
    const text = t.text;
    for (const e of t.exps) {
      if (e === "$(" || e === "`") codeExecution.push(`command substitution in ${JSON.stringify(text.slice(0, 80))}`);
      else if (/^[A-Za-z_]/.test(e)) { if (!assigned.has(e)) unauditable.push(`expansion $${e}`); }
      else if (!"?#".includes(e)) unauditable.push(`expansion ${e}`);
    }
    const wordOutside = [];
    if (/(?:^|[\s=:,@])~/.test(text)) wordOutside.push(text);
    if (/(?:^|[\s/=:,@"'])\.\.(?:$|[\s/,:"'])/.test(text)) wordOutside.push(text);
    const cands = [...text.matchAll(ABS_IN_WORD)].map((m) => m[1]);
    const flagAttached = text.match(/^-[A-Za-z]+(\/.*)$/);
    if (flagAttached) cands.push(flagAttached[1]);
    for (const c of cands) {
      // "/\\d", "/^x", "/$", "/(a|b)": regex fragments, not paths. "/" alone, "/*", "/?tc" and non-ASCII names stay.
      if (c.length > 1 && /^\/[\\^$(|)]/.test(c)) continue;
      const abs = path.posix.normalize(c);
      if (!ALLOWED_ABS.some((re) => re.test(abs)) && !insideRoot(snapshot, abs)) wordOutside.push(c);
    }
    outside.push(...wordOutside);
    if (redirTarget) {                                                  // a redirection's file: a literal path
      if (wordOutside.length && !t.exps.length) hard.push(...wordOutside);
      redirTarget = false;
      continue;
    }
    if (skipValue) { skipValue = false; prevWord = text; continue; }
    if (cmdPos && prefix && text.startsWith("-")) {                     // `nice -n 5`, `command -p`, `sudo -u x`
      if ((PREFIX_OPT_VALUE[prefix] ?? []).includes(text)) skipValue = true;
      continue;
    }
    if (cmdPos) {
      const name = path.posix.basename(text);
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) { assigned.add(text.slice(0, text.indexOf("="))); continue; }
      if (text === "cd" || text === "pushd") {
        let arg = null;
        for (let k = i + 1; k < toks.length; k++) { if (isRedirect(toks[k])) { k++; continue; } arg = toks[k]; break; }
        if (!arg || isOp(arg)) { outside.push(`${text} without a target (changes to $HOME)`); hard.push(`${text} without a target (changes to $HOME)`); }
        else if (arg.text === "-" || arg.text.startsWith("-") || arg.text.startsWith("~") || arg.exps.length) { outside.push(`${text} ${arg.text}`); hard.push(`${text} ${arg.text}`); }
      } else if (text === "popd") { outside.push("popd"); hard.push("popd"); }
      if (CODE_RUNNERS.has(name) || (name === "find" && toks.slice(i + 1).some((x) => x.type === "word" && /^-(exec|execdir|ok|okdir)$/.test(x.text)))) codeExecution.push(name);
      if (PREFIX_WORDS.has(text)) { prefix = text; prevWord = text; continue; }  // the next word is still a command
      cmdPos = false;
      prefix = null;
      cmdName = name;
      operandIndex = 0;
      patternSeen = false;
      patternOpt = false;
      fileOpt = false;
      prevWord = text;
      continue;
    }
    if (prevWord === "for" || prevWord === "read") assigned.add(text);
    prevWord = text;
    // An operand of the current simple command.
    if (cmdName === "cd" || cmdName === "pushd") { if (wordOutside.length) hard.push(...wordOutside); continue; }
    if (cmdName && (CODE_RUNNERS.has(cmdName) || cmdName === "for")) continue; // program text / loop words: warnings only
    if (patternOpt) { patternOpt = false; patternSeen = true; continue; }
    if (fileOpt) { fileOpt = false; if (wordOutside.length && !t.exps.length) hard.push(...wordOutside); continue; }
    if (cmdName && PRINTERS.has(cmdName)) continue;                     // echo/printf print literals (X21)
    if (cmdName && PATTERN_FIRST.has(cmdName)) {
      if (/^(-e|--regexp|--expression)$/.test(text)) { patternOpt = true; continue; }
      if (/^(-f|--file)$/.test(text)) { fileOpt = true; patternSeen = true; continue; }  // X20: -f FILE reads FILE
      if (/^(-e|--regexp=|--expression=)/.test(text)) { patternSeen = true; continue; }
      if (/^(-f.|--file=)/.test(text)) { patternSeen = true; if (wordOutside.length && !t.exps.length) hard.push(...wordOutside); continue; }
      if (!text.startsWith("-") && !patternSeen) { patternSeen = true; operandIndex++; continue; }
    }
    operandIndex++;
    if (wordOutside.length && !t.exps.length) hard.push(...wordOutside);
  }
  return ret(true);
}

/** Paths in a shell command that point outside the snapshot (compat helper for tests and tooling). */
export function outsidePaths(command, snapshot) {
  return auditCommand(command, snapshot, snapshot).outside;
}

const samePath = (a, b) => { const x = realish(a), y = realish(b); return !!x && x === y; };
const clip = (s, n = 120) => { const t = String(s).replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const listOf = (items, n = 3) => `${items.slice(0, n).join(" | ")}${items.length > n ? ` (+${items.length - n} more)` : ""}`;

/**
 * audit(transcript, snapshot, pin) -> { reasons[] (incomplete), warnings[] (evidence), commands[], codeExecution[], reported }
 * Reasons come only from the header, the transcript structure and non-shell tool sections. The shell-command audit
 * (paths, cwd, expansions, code execution) only produces warnings: the self-tested OS sandbox decided what any
 * model-run command could read.
 */
export function audit(transcript, snapshot, pin, { allowCodeExecution = pin?.allowCodeExecution ?? true } = {}) {
  const reasons = [], warnings = [];
  const h = transcript.header;
  if (!h.model) reasons.push("reported_model_unavailable");
  if (h.sandbox !== "read-only") reasons.push(`sandbox_not_read_only:${h.sandbox ?? "unreported"}`);
  if (h.approval !== "never") reasons.push(`approval_not_never:${h.approval ?? "unreported"}`);
  if (!h["reasoning effort"]) reasons.push("reported_effort_unavailable");
  else if (h["reasoning effort"] !== pin.effort) reasons.push(`effort_mismatch:${h["reasoning effort"]}`);
  if (!h.workdir) reasons.push("workdir_unreported");
  else if (!samePath(h.workdir, snapshot)) reasons.push("workdir_not_snapshot");
  if (transcript.unauditable?.length) reasons.push(`unauditable_transcript:${transcript.unauditable.join("; ")}`);
  if (transcript.suspicious.length) reasons.push(`non_read_tool_calls:${listOf(transcript.suspicious.map((l) => clip(l)))}`);
  const cmdAudit = transcript.commands.map((c) => ({ ...c, ...auditCommand(c.command, c.cwd, snapshot, { allowCodeExecution }) }));
  for (const c of cmdAudit) {
    const notes = [
      ...(c.cwdInside ? [] : [`cwd ${clip(c.cwd ?? "none", 80)}`]),
      ...c.hard.map((x) => `literal read outside ${x}`),
      ...c.outside.filter((x) => !c.hard.includes(x)).map((x) => `outside ${x}`),
      ...c.unauditable,
      ...(c.wellFormed ? [] : ["not well-formed"]),
    ];
    if (notes.length) warnings.push(`shell audit (evidence only): ${clip(c.command)}: ${clip(notes.join("; "), 160)}`);
  }
  if (transcript.execLinesIgnored) warnings.push(`transcript: ${transcript.execLinesIgnored} "exec" line(s) inside command output not parsed as commands`);
  return {
    reasons, warnings, commands: cmdAudit,
    codeExecution: cmdAudit.flatMap((c) => c.codeExecution),
    reported: { model: h.model ?? null, effort: h["reasoning effort"] ?? null, sandbox: h.sandbox ?? null, approval: h.approval ?? null, source: "codex exec stderr header (client-resolved)" },
  };
}

const matchesPin = (r, pin) => r?.model === pin.model && r?.effort === pin.effort;
const sumTokens = (attempts) => attempts.reduce((s, x) => s + (x.tokensUsed ?? 0), 0) || null;
const codexHomeOf = (env) => path.resolve(env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex"));

/**
 * OS sandbox for this run: generate the permission profile and self-test it with the exact config flags of
 * codex exec (no model call). Returns { permissionArgs, exe, record } or { reasons } when the run must be
 * incomplete. There is no fallback: without a working OS sandbox codex never runs.
 * deps (tests): { sandboxAvailable, selfTest, home }.
 */
export function prepareSandbox({ pin, input, env, log, deps = {} }) {
  const available = (deps.sandboxAvailable ?? sandbox.sandboxAvailable)();
  if (!available) return { reasons: [`no_os_sandbox:${process.platform} has no supported OS sandbox for codex (macOS Seatbelt required)`] };
  const rt = sandbox.codexRuntime(pin.config.bin ?? "codex", env.PATH);
  if (rt.error) return { reasons: [`os_sandbox_unavailable:${rt.error}`] };
  const node = pin.allowCodeExecution || rt.script ? sandbox.nodeRuntime(env.PATH) : null;
  const home = deps.home ?? env.HOME ?? os.homedir();
  const codexHome = codexHomeOf(env);
  let profile;
  try { profile = sandbox.permissionProfile({ snapshot: input.snapshot, codexRoot: rt.root, nodeRoot: node?.root, home, codexHome }); }
  catch (e) { return { reasons: [`os_sandbox_profile_refused:${e.message}`] }; }
  const permissionArgs = sandbox.profileArgs(profile);
  const toml = sandbox.profileToml(profile);
  log("sandbox-profile.toml", toml);
  const probe = sandbox.makeProbe({ home });
  let st;
  try {
    st = (deps.selfTest ?? sandbox.selfTest)({ exe: rt.exe, args: configArgs(pin, permissionArgs), cwd: input.snapshot, probes: probe.probes, codexHome, insideFile: path.join(input.snapshot, input.files[0].path), env });
  } finally { probe.cleanup(); }
  const record = {
    mechanism: "macOS Seatbelt applied by codex to every model-run command, from a runner-generated permission profile (default_permissions); codex exec runs without -s",
    codexExe: rt.exe, profile: toml, profileSha256: sha256(toml),
    readRoots: Object.entries(profile.filesystem).filter(([, v]) => v === "read").map(([k]) => k),
    deniedRoots: Object.entries(profile.filesystem).filter(([, v]) => v === "none").map(([k]) => k),
    writeRoots: [], network: "denied (no network entry in the profile)",
    deniedOps: "not counted: the plain codex transcript has no marker that separates a sandbox denial from command output text",
    selfTest: st,
  };
  if (probe.errors?.length) record.probeErrors = probe.errors;
  // A53/A61: a probe that could not be created (or a missing self-test result) is never counted as a pass.
  const unavailable = st ? (st.unavailable ?? sandbox.SELF_TEST_KEYS.filter((k) => st[k] === null || st[k] === undefined)) : ["self-test result missing"];
  if (unavailable.length) return { reasons: [`os_sandbox_selftest_unavailable:${unavailable.join(",")}`], record };
  if (!st.ok) {
    const failed = sandbox.SELF_TEST_KEYS.filter((k) => st[k] !== true);
    return { reasons: [`os_sandbox_not_enforced:${failed.join(",") || "self-test failed"}`], record };
  }
  return { permissionArgs, exe: rt.exe, record };
}

export async function run(ctx) {
  const { input, pin, prompt, jsonSchema, validate, log, workDir } = ctx;
  const out = { attempts: [], reasons: [], warnings: [], toolAudit: [], codeExecution: [], isolation: {} };
  out.limits = [
    "Model-run commands run under a Seatbelt profile generated by the runner (reads: :minimal platform set, snapshot, codex/node package dirs or binaries, never a shared prefix; /private/tmp and /private/var/tmp denied; no writes; no network). The codex process itself is not confined; it reads its own auth file, which the runner never opens.",
    "The :minimal set is codex's built-in platform allowance (system libraries/frameworks, /bin, /usr/bin, /etc, /Library/Preferences, /System); those system files are readable by model-run commands.",
    "The shell-command audit is evidence only (warnings): the self-tested OS sandbox decides what model-run commands could read. Sandbox denials are not counted (no reliable marker in the transcript).",
    "The reported model is the client-resolved value from the codex exec header; the server does not echo the model per request.",
  ];
  const env = buildEnv(process.env, pin.envPassthrough ?? pin.config.env_passthrough ?? []);
  const sbx = prepareSandbox({ pin, input, env, log, deps: ctx.deps ?? {} });
  if (sbx.record) out.isolation.osSandbox = sbx.record;
  if (sbx.reasons) { out.reasons.push(...sbx.reasons); return out; }
  const bin = sbx.exe;
  const schemaPath = path.join(workDir, "codex-output-schema.json");
  fs.writeFileSync(schemaPath, JSON.stringify(jsonSchema, null, 2));
  const deadline = Date.now() + pin.timeoutMs;
  let text = prompt;
  out.allowedConfig = allowedConfig(pin, sbx.permissionArgs);
  out.argvShape = "codex"; // A50/A59: run.mjs re-checks the reported argv against the exact codex shape
  for (let attempt = 0; attempt < 2; attempt++) {
    const label = attempt ? "retry" : "first";
    const lastMessagePath = path.join(workDir, `codex-${label}-last.txt`);
    fs.rmSync(lastMessagePath, { force: true }); // never read a stale -o file from an earlier run in this --out
    const argv = buildArgv(pin, { snapshot: input.snapshot, schemaPath, lastMessagePath, permissionArgs: sbx.permissionArgs });
    out.argv = [bin, ...argv];
    const remaining = deadline - Date.now();
    if (attempt > 0 && remaining < 30_000) { out.reasons.push("timeout_before_retry"); break; }
    const p = await runProcess({ bin, args: argv, cwd: input.snapshot, env, input: text, timeoutMs: remaining, allowedConfig: out.allowedConfig, shape: "codex" });
    log(`${label}.stdout.txt`, redact(p.stdout));
    log(`${label}.stderr.log`, redact(p.stderr));
    const tr = parseTranscript(p.stderr, { prompt: text });
    const a = audit(tr, input.snapshot, pin);
    const rec = { label, code: p.code, signal: p.signal, timedOut: p.timedOut, durationMs: p.durationMs, spawnError: p.spawnError, pipesAbandoned: p.pipesAbandoned, leftoversKilled: p.leftoversKilled, signals: p.signals, auditReasons: a.reasons, auditWarnings: a.warnings.length, tokensUsed: tr.tokens, reported: a.reported };
    out.attempts.push(rec);
    out.toolAudit.push({ attempt: label, commands: a.commands, suspiciousLines: tr.suspicious, unauditable: tr.unauditable, execLinesIgnored: tr.execLinesIgnored });
    out.codeExecution.push(...a.codeExecution.map((x) => `${label}: ${x}`));
    out.warnings.push(...a.warnings.map((w) => `${label}: ${w}`));
    // A56: the latest attempt's report, unless an earlier attempt already reported a mismatch (kept visible).
    if (!out.reported || matchesPin(out.reported, pin)) out.reported = a.reported;
    if (tr.version) out.hostVersion = `codex-cli ${tr.version}`;
    out.usage = { total_tokens: sumTokens(out.attempts), per_attempt: out.attempts.map((x) => ({ label: x.label, tokens: x.tokensUsed ?? null })) };
    if (p.spawnError) { out.reasons.push(`spawn_error:${p.spawnError}`); break; }
    // The -o reply is read after the audit, whatever its outcome: a withheld draft is kept as reviewIfIncomplete.
    let last = null;
    try { last = fs.readFileSync(lastMessagePath, "utf8"); } catch {}
    const reply = last?.trim() ? last : p.stdout;
    const v = reply?.trim() ? validate(reply) : { errors: ["empty reply"] };
    rec.validation = v.errors;
    const keepDraft = () => {
      if (!v.errors.length) out.review = v.value;
      else if (reply?.trim()) out.draftRaw = redact(reply).slice(0, 200_000);
    };
    if (p.timedOut) { out.reasons.push("timeout"); keepDraft(); break; }
    if (p.pipesAbandoned) { out.reasons.push("pipes_abandoned: a descendant kept the host's stdout/stderr open; the transcript may be truncated"); keepDraft(); break; }
    if (a.reasons.length) { out.reasons.push(...a.reasons); keepDraft(); break; }
    if (a.reported.model !== pin.model) { out.reasons.push(`reported_model_mismatch:${a.reported.model}`); keepDraft(); break; } // never retried on another model
    if (p.code !== 0) { out.reasons.push(`exit_code:${p.code}`); keepDraft(); break; }
    if (!v.errors.length) { out.review = v.value; break; }
    if (attempt === 1) { out.reasons.push("schema_invalid_after_retry"); keepDraft(); break; }
    text = `${prompt}\n\n=== CORRECTION ===\nA previous attempt at this review returned output that failed validation:\n- ${v.errors.join("\n- ")}\nPrevious output:\n${reply}\nReturn the corrected review JSON only.`;
  }
  if (out.codeExecution.length) out.warnings.push(`model-run commands executed code inside the OS sandbox (allowed by policy): ${out.codeExecution.length}`);
  if (out.warnings.length > 40) out.warnings.splice(40, out.warnings.length - 40, `(+${out.warnings.length - 40} more warnings; see toolAudit)`);
  return out;
}
