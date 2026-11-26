// Codex reviewer adapter: `codex exec` in the read-only sandbox, ephemeral, user config/rules ignored.
// Flags verified against `codex exec --help` (codex-cli 0.167.0) and live runs on 2026-11-26.
// Plain (non --json) mode is used on purpose: only the stderr header reports the resolved model, effort,
// sandbox and approval policy; --json omits them. Commands are audited from the same transcript.
import * as fs from "node:fs";
import * as path from "node:path";
import { redact } from "../lib/inputs.mjs";
import { runProcess } from "../lib/proc.mjs";

// Features that add tools beyond shell reads (delegation, connectors, browser, MCP-bearing plugins, ...).
export const DISABLED_FEATURES = ["multi_agent", "multi_agent_v2", "apps", "plugins", "hooks", "browser_use", "browser_use_external", "computer_use", "image_generation", "memories", "standalone_web_search"];

export function buildArgv(pin, { snapshot, schemaPath, lastMessagePath }) {
  return [
    "exec",
    "-m", pin.model,
    "-c", `model_reasoning_effort="${pin.effort}"`,
    "-s", "read-only",                    // model-run commands cannot write or reach the network
    "-c", 'approval_policy="never"',      // never escalate out of the sandbox; failing commands just fail
    "-c", 'web_search="disabled"',
    ...DISABLED_FEATURES.flatMap((f) => ["--disable", f]),
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

/** Parse the plain-mode stderr transcript. Pure; used by tests with fixtures. */
export function parseTranscript(stderr) {
  const lines = stderr.split("\n");
  const header = {};
  let i = lines.findIndex((l) => l.trim() === "--------");
  if (i !== -1) {
    for (i = i + 1; i < lines.length && lines[i].trim() !== "--------"; i++) {
      const m = lines[i].match(/^([a-z][a-z ]*?):\s*(.*)$/);
      if (m) header[m[1]] = m[2].trim();
    }
  }
  const commands = [];
  const suspicious = [];
  let tokens = null;
  for (let j = Math.max(i, 0); j < lines.length; j++) {
    const l = lines[j];
    if (l === "exec" && j + 1 < lines.length) {
      const m = lines[j + 1].match(/^(.*) in (\/.*)$/);
      commands.push(m ? { command: m[1], cwd: m[2] } : { command: lines[j + 1], cwd: null });
    } else if (/^(tool|mcp|web_search|web search)\b/i.test(l) || /^🌐/.test(l) || /^apply_patch\b|^file update\b/i.test(l)) suspicious.push(l.slice(0, 200));
    else if (l === "tokens used" && j + 1 < lines.length) tokens = Number(lines[j + 1].replace(/[^0-9]/g, "")) || null;
  }
  return { header, commands, suspicious, tokens };
}

const ALLOWED_ABS = [/^\/dev\/null$/, /^\/dev\/std(in|out|err)$/, /^\/(usr\/)?(local\/)?s?bin\//, /^\/opt\/homebrew\/bin\//];
/** Paths in a shell command that point outside the snapshot. Heuristic, conservative. */
export function outsidePaths(command, snapshot) {
  const inner = command.replace(/^\/bin\/(?:ba|z)?sh -lc /, "").replace(/^'(.*)'$/s, "$1").replace(/^"(.*)"$/s, "$1");
  const tokens = inner.split(/[\s;|&()<>=,'"`]+/).filter(Boolean);
  const bad = [];
  for (const t of tokens) {
    if (/^~|\$\{?HOME\b|\$\{?CODEX_HOME\b|\$\{?TMPDIR\b/.test(t)) bad.push(t);
    else if (t.split("/").includes("..")) bad.push(t);
    else if (t.startsWith("/")) {
      const abs = path.resolve(t);
      if (!(abs === snapshot || abs.startsWith(snapshot + path.sep)) && !ALLOWED_ABS.some((re) => re.test(abs))) bad.push(t);
    }
  }
  return bad;
}

export function audit(transcript, snapshot, pin) {
  const reasons = [];
  const h = transcript.header;
  if (!h.model) reasons.push("reported_model_unavailable");
  if (h.sandbox !== "read-only") reasons.push(`sandbox_not_read_only:${h.sandbox ?? "unreported"}`);
  if (h.approval !== "never") reasons.push(`approval_not_never:${h.approval ?? "unreported"}`);
  if (h["reasoning effort"] && h["reasoning effort"] !== pin.effort) reasons.push(`effort_mismatch:${h["reasoning effort"]}`);
  if (h.workdir && h.workdir !== snapshot) reasons.push("workdir_not_snapshot");
  const cmdAudit = transcript.commands.map((c) => ({ ...c, outside: outsidePaths(c.command, snapshot), cwdInside: !c.cwd || c.cwd === snapshot || c.cwd.startsWith(snapshot + path.sep) }));
  const outside = cmdAudit.filter((c) => c.outside.length || !c.cwdInside);
  if (outside.length) reasons.push(`tool_read_outside_snapshot:${outside.length}`);
  if (transcript.suspicious.length) reasons.push(`non_read_tool_calls:${transcript.suspicious.length}`);
  return { reasons, commands: cmdAudit, reported: { model: h.model ?? null, effort: h["reasoning effort"] ?? null, sandbox: h.sandbox ?? null, approval: h.approval ?? null, source: "codex exec stderr header (client-resolved)" } };
}

export async function run(ctx) {
  const { input, pin, prompt, jsonSchema, validate, log, workDir } = ctx;
  const bin = pin.config.bin ?? "codex";
  const schemaPath = path.join(workDir, "codex-output-schema.json");
  fs.writeFileSync(schemaPath, JSON.stringify(jsonSchema, null, 2));
  const out = { attempts: [], reasons: [], warnings: [], toolAudit: [] };
  const deadline = Date.now() + pin.timeoutMs;
  let text = prompt;
  for (let attempt = 0; attempt < 2; attempt++) {
    const label = attempt ? "retry" : "first";
    const lastMessagePath = path.join(workDir, `codex-${label}-last.txt`);
    const argv = buildArgv(pin, { snapshot: input.snapshot, schemaPath, lastMessagePath });
    out.argv = [bin, ...argv];
    const remaining = deadline - Date.now();
    if (remaining < 30_000) { out.reasons.push("timeout_before_retry"); break; }
    const p = await runProcess({ bin, args: argv, cwd: input.snapshot, env: { ...process.env }, input: text, timeoutMs: remaining });
    log(`${label}.stdout.txt`, redact(p.stdout));
    log(`${label}.stderr.log`, redact(p.stderr));
    const tr = parseTranscript(p.stderr);
    const a = audit(tr, input.snapshot, pin);
    const rec = { label, code: p.code, signal: p.signal, timedOut: p.timedOut, durationMs: p.durationMs, spawnError: p.spawnError, auditReasons: a.reasons, tokensUsed: tr.tokens };
    out.attempts.push(rec);
    out.toolAudit.push({ attempt: label, commands: a.commands, suspiciousLines: tr.suspicious });
    out.reported = a.reported;
    out.usage = { total_tokens: out.attempts.reduce((s, x) => s + (x.tokensUsed ?? 0), 0) || null };
    if (p.spawnError) { out.reasons.push(`spawn_error:${p.spawnError}`); break; }
    if (p.timedOut) { out.reasons.push("timeout"); break; }
    if (a.reasons.length) { out.reasons.push(...a.reasons); break; }
    if (p.code !== 0) { out.reasons.push(`exit_code:${p.code}`); break; }
    let last = null;
    try { last = fs.readFileSync(lastMessagePath, "utf8"); } catch {}
    const v = validate(last ?? p.stdout);
    rec.validation = v.errors;
    if (!v.errors.length) { out.review = v.value; break; }
    if (attempt === 1) { out.reasons.push("schema_invalid_after_retry"); break; }
    text = `${prompt}\n\n=== CORRECTION ===\nA previous attempt at this review returned output that failed validation:\n- ${v.errors.join("\n- ")}\nPrevious output:\n${last ?? p.stdout}\nReturn the corrected review JSON only.`;
  }
  out.limits = [
    "Codex's read-only sandbox blocks writes and network for model-run commands but does not restrict which paths they can read; reads outside the snapshot are detected from the transcript, not prevented.",
    "The reported model is the client-resolved value from the codex exec header; the server does not echo the model per request.",
  ];
  return out;
}
