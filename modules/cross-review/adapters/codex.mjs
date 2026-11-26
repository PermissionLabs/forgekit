// Codex reviewer adapter: `codex exec` in the read-only sandbox, ephemeral, user config/rules ignored.
// Flags verified against `codex exec --help` (codex-cli 0.167.0) and live runs on 2026-11-26.
// Plain (non --json) mode is used on purpose: only the stderr header reports the resolved model, effort,
// sandbox and approval policy; --json omits them. Commands are audited from the same transcript.
//
// Audit stance: conservative. Every `exec` block is parsed in full (multi-line commands included) and shell-
// tokenized; anything the auditor cannot confidently read (unbalanced quotes, unknown variable expansions,
// a missing or outside cwd, a prompt echo that does not match what was sent) makes the run incomplete.
import * as fs from "node:fs";
import * as path from "node:path";
import { insideRoot, realish, redact } from "../lib/inputs.mjs";
import { runProcess, scrubEnv } from "../lib/proc.mjs";

// Features that add tools beyond shell reads (delegation, connectors, browser, MCP-bearing plugins, ...).
// Overridable per policy (hosts.codex.disabled_features) when a Codex release renames one.
export const DISABLED_FEATURES = ["multi_agent", "multi_agent_v2", "apps", "plugins", "hooks", "browser_use", "browser_use_external", "computer_use", "image_generation", "memories", "standalone_web_search"];

export function buildArgv(pin, { snapshot, schemaPath, lastMessagePath }) {
  const features = pin.config?.disabled_features ?? DISABLED_FEATURES;
  return [
    "exec",
    "-m", pin.model,
    "-c", `model_reasoning_effort="${pin.effort}"`,
    "-s", "read-only",                    // model-run commands cannot write or reach the network
    "-c", 'approval_policy="never"',      // never escalate out of the sandbox; failing commands just fail
    "-c", 'web_search="disabled"',
    ...features.flatMap((f) => ["--disable", f]),
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
 * the prompt echo or mid-paragraph of command output. Every `exec` line starts a command, wherever it appears:
 * a fabricated one can only add audit work, never hide a real command.
 */
export function parseTranscript(stderr, { prompt } = {}) {
  const lines = String(stderr).split("\n");
  const header = {};
  const unauditable = [];
  const commands = [];
  const suspicious = [];
  let tokens = null;
  const version = lines[0]?.match(/^OpenAI Codex v(\S+)/)?.[1] ?? null;
  const open = lines.findIndex((l) => l.trim() === "--------");
  let j = -1;
  if (open !== -1) {
    for (j = open + 1; j < lines.length && lines[j].trim() !== "--------"; j++) {
      const m = lines[j].match(/^([a-z][a-z ]*?):\s*(.*)$/);
      if (m) header[m[1]] = m[2].trim();
    }
  }
  if (open === -1 || j >= lines.length) return { header, commands, suspicious, tokens, version, unauditable: ["transcript header missing"] };
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
        if (CMD_END.test(lines[k]) && (k + 1 >= lines.length || STATUS.test(lines[k + 1]) || MARKERS.has(lines[k + 1]))) { end = k; break; }
      }
      if (end === -1) {
        unauditable.push(`exec block at line ${j + 1} has no "in <cwd>" terminator`);
        commands.push({ command: lines.slice(j + 1).join("\n"), cwd: null, line: j + 1 });
        break;
      }
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
  return { header, commands, suspicious, tokens, version, unauditable };
}

// ---------------------------------------------------------------- shell audit
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
    if ((m = rest.match(/^\{([A-Za-z_][A-Za-z0-9_]*)/))) return m[1];
    if (rest[0] === "{") return "${";
    if ((m = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)/))) return m[1];
    if (rest[0] && "?#".includes(rest[0])) return rest[0];
    if (rest[0] === undefined || /[\s"'/;|&)]/.test(rest[0])) return null; // literal $
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
      end();
      let op = c;
      while (i + 1 < s.length && ";|&<>".includes(s[i + 1]) && op.length < 3) op += s[++i];
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
const ALLOWED_ABS = [/^\/dev\/null$/, /^\/dev\/std(in|out|err)$/, /^\/dev\/fd\/\d+$/, /^\/(usr\/)?(local\/)?s?bin\//, /^\/opt\/homebrew\/bin\//, /^\/opt\/local\/bin\//, /^\/home\/linuxbrew\/\.linuxbrew\/bin\//];
const ABS_IN_WORD = /(?:^|[\s=:,@"'(\[{<>|])(\/[^\s,:'"`;|&()<>\[\]{}]*)/g;
const isOp = (t) => t?.type === "op";
// Words after which the next word is still a command (keywords and command prefixes).
const PREFIX_WORDS = new Set(["command", "builtin", "time", "nice", "nohup", "sudo", "!", "do", "then", "else", "elif", "if", "while", "until", "{", "}"]);

/**
 * auditCommand(command, cwd, snapshot, { allowCodeExecution }) ->
 *   { outside[], unauditable[], codeExecution[], cwdInside }
 * outside: tokens that point outside the snapshot (absolute paths incl. flag-attached ones, ~, .., bare/odd cd).
 * unauditable: the command could not be read confidently (quoting, unknown $VAR expansion, extra wrapper args).
 * codeExecution: interpreters / command substitution seen (allowed only when the policy allows code execution).
 */
export function auditCommand(command, cwd, snapshot, { allowCodeExecution = true } = {}) {
  const outside = [], unauditable = [], codeExecution = [];
  const cwdInside = typeof cwd === "string" && cwd.startsWith("/") && insideRoot(snapshot, cwd);
  const top = shellTokens(command);
  if (top.error) return { outside, unauditable: [top.error], codeExecution, cwdInside };
  let script = command;
  const tw = top.tokens;
  if (tw.length >= 2 && tw[0].type === "word" && SHELL.test(tw[0].text) && /^-l?c$|^-cl$/.test(tw[1].text ?? "")) {
    if (tw.length !== 3 || tw[2].type !== "word") return { outside, unauditable: ["shell wrapper with extra arguments"], codeExecution, cwdInside };
    if (tw[0].exps.length || tw[1].exps.length) unauditable.push("expansion in shell wrapper");
    script = tw[2].text;
  }
  const inner = shellTokens(script);
  if (inner.error) return { outside, unauditable: [inner.error], codeExecution, cwdInside };
  const toks = inner.tokens;
  // Names assigned inside the script itself (NAME=..., for NAME in ..., read NAME) may be expanded.
  const assigned = new Set();
  toks.forEach((t, i) => {
    if (t.type !== "word") return;
    const m = t.text.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (m) assigned.add(m[1]);
    if ((t.text === "for" || t.text === "read") && toks[i + 1]?.type === "word") assigned.add(toks[i + 1].text);
  });
  let cmdPos = true;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (isOp(t)) { cmdPos = !/^[<>]/.test(t.text) && !/^\d*>/.test(t.text); continue; }
    const text = t.text;
    for (const e of t.exps) {
      if (e === "$(" || e === "`") codeExecution.push(`command substitution in ${JSON.stringify(text.slice(0, 80))}`);
      else if (/^[A-Za-z_]/.test(e)) { if (!assigned.has(e)) unauditable.push(`expansion $${e}`); }
      else if (!"?#".includes(e)) unauditable.push(`expansion ${e}`);
    }
    if (/(?:^|[\s=:,@])~/.test(text)) outside.push(text);
    if (/(?:^|[\s/=:,@"'])\.\.(?:$|[\s/,:"'])/.test(text)) outside.push(text);
    const cands = [...text.matchAll(ABS_IN_WORD)].map((m) => m[1]);
    const flagAttached = text.match(/^-[A-Za-z]+(\/.*)$/);
    if (flagAttached) cands.push(flagAttached[1]);
    for (const c of cands) {
      // "/\\d", "/^x": regex fragments, not paths. "/" alone and "/*" stay (they name the root).
      if (c.length > 1 && !/^\/[A-Za-z0-9._~+@*\/-]/.test(c)) continue;
      const abs = path.posix.normalize(c);
      if (!ALLOWED_ABS.some((re) => re.test(abs)) && !insideRoot(snapshot, abs)) outside.push(c);
    }
    if (cmdPos) {
      const name = path.posix.basename(text);
      if (text === "cd" || text === "pushd") {
        const arg = toks[i + 1];
        if (!arg || isOp(arg)) outside.push(`${text} without a target (changes to $HOME)`);
        else if (arg.text === "-" || arg.text.startsWith("-") || arg.text.startsWith("~") || arg.exps.length) outside.push(`${text} ${arg.text}`);
      } else if (text === "popd") outside.push("popd");
      if (CODE_RUNNERS.has(name) || (name === "find" && toks.slice(i + 1).some((x) => x.type === "word" && /^-(exec|execdir|ok|okdir)$/.test(x.text)))) codeExecution.push(name);
      // `command`, `builtin`, `time`, `nice`, `sudo` keep the next word in command position.
      cmdPos = PREFIX_WORDS.has(text) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(text);
    }
  }
  if (!allowCodeExecution && codeExecution.length) unauditable.push(...codeExecution.map((x) => `code execution not allowed by policy: ${x}`));
  return { outside: [...new Set(outside)], unauditable, codeExecution, cwdInside };
}

/** Paths in a shell command that point outside the snapshot (compat helper for tests and tooling). */
export function outsidePaths(command, snapshot) {
  return auditCommand(command, snapshot, snapshot).outside;
}

const samePath = (a, b) => { const x = realish(a), y = realish(b); return !!x && x === y; };

export function audit(transcript, snapshot, pin, { allowCodeExecution = pin?.allowCodeExecution ?? true } = {}) {
  const reasons = [];
  const h = transcript.header;
  if (!h.model) reasons.push("reported_model_unavailable");
  if (h.sandbox !== "read-only") reasons.push(`sandbox_not_read_only:${h.sandbox ?? "unreported"}`);
  if (h.approval !== "never") reasons.push(`approval_not_never:${h.approval ?? "unreported"}`);
  if (!h["reasoning effort"]) reasons.push("reported_effort_unavailable");
  else if (h["reasoning effort"] !== pin.effort) reasons.push(`effort_mismatch:${h["reasoning effort"]}`);
  if (!h.workdir) reasons.push("workdir_unreported");
  else if (!samePath(h.workdir, snapshot)) reasons.push("workdir_not_snapshot");
  if (transcript.unauditable?.length) reasons.push(`unauditable_transcript:${transcript.unauditable.join("; ")}`);
  const cmdAudit = transcript.commands.map((c) => ({ ...c, ...auditCommand(c.command, c.cwd, snapshot, { allowCodeExecution }) }));
  const outside = cmdAudit.filter((c) => c.outside.length || !c.cwdInside);
  if (outside.length) reasons.push(`tool_read_outside_snapshot:${outside.length}`);
  const unaud = cmdAudit.filter((c) => c.unauditable.length);
  if (unaud.length) reasons.push(`unauditable_command:${unaud.length}`);
  if (transcript.suspicious.length) reasons.push(`non_read_tool_calls:${transcript.suspicious.length}`);
  return {
    reasons, commands: cmdAudit,
    codeExecution: cmdAudit.flatMap((c) => c.codeExecution),
    reported: { model: h.model ?? null, effort: h["reasoning effort"] ?? null, sandbox: h.sandbox ?? null, approval: h.approval ?? null, source: "codex exec stderr header (client-resolved)" },
  };
}

const sumTokens = (attempts) => attempts.reduce((s, x) => s + (x.tokensUsed ?? 0), 0) || null;

export async function run(ctx) {
  const { input, pin, prompt, jsonSchema, validate, log, workDir } = ctx;
  const bin = pin.config.bin ?? "codex";
  const schemaPath = path.join(workDir, "codex-output-schema.json");
  fs.writeFileSync(schemaPath, JSON.stringify(jsonSchema, null, 2));
  const out = { attempts: [], reasons: [], warnings: [], toolAudit: [], codeExecution: [] };
  const deadline = Date.now() + pin.timeoutMs;
  const env = buildEnv(process.env, pin.envPassthrough ?? pin.config.env_passthrough ?? []);
  let text = prompt;
  for (let attempt = 0; attempt < 2; attempt++) {
    const label = attempt ? "retry" : "first";
    const lastMessagePath = path.join(workDir, `codex-${label}-last.txt`);
    fs.rmSync(lastMessagePath, { force: true }); // never read a stale -o file from an earlier run in this --out
    const argv = buildArgv(pin, { snapshot: input.snapshot, schemaPath, lastMessagePath });
    out.argv = [bin, ...argv];
    const remaining = deadline - Date.now();
    if (attempt > 0 && remaining < 30_000) { out.reasons.push("timeout_before_retry"); break; }
    const p = await runProcess({ bin, args: argv, cwd: input.snapshot, env, input: text, timeoutMs: remaining });
    log(`${label}.stdout.txt`, redact(p.stdout));
    log(`${label}.stderr.log`, redact(p.stderr));
    const tr = parseTranscript(p.stderr, { prompt: text });
    const a = audit(tr, input.snapshot, pin);
    const rec = { label, code: p.code, signal: p.signal, timedOut: p.timedOut, durationMs: p.durationMs, spawnError: p.spawnError, pipesAbandoned: p.pipesAbandoned, leftoversKilled: p.leftoversKilled, signals: p.signals, auditReasons: a.reasons, tokensUsed: tr.tokens, reported: a.reported };
    out.attempts.push(rec);
    out.toolAudit.push({ attempt: label, commands: a.commands, suspiciousLines: tr.suspicious, unauditable: tr.unauditable });
    out.codeExecution.push(...a.codeExecution.map((x) => `${label}: ${x}`));
    if (!out.reported || attempt === 0) out.reported = a.reported;
    if (tr.version) out.hostVersion = `codex-cli ${tr.version}`;
    out.usage = { total_tokens: sumTokens(out.attempts), per_attempt: out.attempts.map((x) => ({ label: x.label, tokens: x.tokensUsed ?? null })) };
    if (p.spawnError) { out.reasons.push(`spawn_error:${p.spawnError}`); break; }
    if (p.timedOut) { out.reasons.push("timeout"); break; }
    if (p.pipesAbandoned) { out.reasons.push("pipes_abandoned: a descendant kept the host's stdout/stderr open; the transcript may be truncated"); break; }
    if (a.reasons.length) { out.reasons.push(...a.reasons); break; }
    if (a.reported.model !== pin.model) { out.reported = a.reported; out.reasons.push(`reported_model_mismatch:${a.reported.model}`); break; } // never retried on another model
    if (p.code !== 0) { out.reasons.push(`exit_code:${p.code}`); break; }
    let last = null;
    try { last = fs.readFileSync(lastMessagePath, "utf8"); } catch {}
    const reply = last?.trim() ? last : p.stdout;
    const v = validate(reply);
    rec.validation = v.errors;
    if (!v.errors.length) { out.review = v.value; out.reported = a.reported; break; }
    if (attempt === 1) { out.reasons.push("schema_invalid_after_retry"); break; }
    text = `${prompt}\n\n=== CORRECTION ===\nA previous attempt at this review returned output that failed validation:\n- ${v.errors.join("\n- ")}\nPrevious output:\n${reply}\nReturn the corrected review JSON only.`;
  }
  if (out.codeExecution.length) out.warnings.push(`model-run commands executed code inside the read-only sandbox (allowed by policy): ${out.codeExecution.length}`);
  out.limits = [
    "Codex's read-only sandbox blocks writes and network for model-run commands but does not restrict which paths they can read; reads outside the snapshot are detected from the transcript, not prevented.",
    "When code execution is allowed (hosts.codex.allow_code_execution, default true), a program run inside the sandbox can read files without naming them literally; the audit checks literal paths, cwd and expansions only.",
    "The reported model is the client-resolved value from the codex exec header; the server does not echo the model per request.",
  ];
  return out;
}
