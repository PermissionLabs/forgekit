// Claude Code reviewer adapter: `claude -p` with read-only built-in tools, no MCP, no settings, no session file.
// Flags verified against `claude --help` (Claude Code 2.1.332) and one live run on 2026-11-26.
import { insideRoot, realish, redact, sha256 } from "../lib/inputs.mjs";
import { runProcess, scrubEnv } from "../lib/proc.mjs";

export const READ_TOOLS = ["Read", "Grep", "Glob"];
// StructuredOutput is how --json-schema returns the answer; it is not a file or network tool.
const ALLOWED_RUNTIME_TOOLS = [...READ_TOOLS, "StructuredOutput"];

/** argv for one attempt. The prompt goes on stdin, never on the command line. */
export function buildArgv(pin, jsonSchema) {
  return [
    "-p",
    "--model", pin.model,
    "--effort", pin.effort,
    "--output-format", "stream-json", "--verbose",          // per-event audit: init (tools, MCP, model), tool_use, result
    "--tools", READ_TOOLS.join(","),                         // only these built-in tools exist in the session
    "--allowedTools", READ_TOOLS.join(","),
    "--permission-mode", "dontAsk",                          // anything not allowed is denied, never prompted
    "--permission-prompts", "none",
    "--restricted",                                          // no code-running tools/WebFetch, ignore user/project/local settings, file tools confined to cwd
    "--safe-mode",                                           // no CLAUDE.md, skills, plugins, hooks, MCP, custom agents
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--setting-sources", "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--json-schema", JSON.stringify(jsonSchema),
  ];
}

/** Minimal child environment: BASE_ENV, CLAUDE_CONFIG_DIR (auth location) and hosts.claude.env_passthrough. */
export function buildEnv(base = process.env, passthrough = []) {
  const env = scrubEnv(base, ["CLAUDE_CONFIG_DIR", ...passthrough]);
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"; // no telemetry/autoupdate/error reporting traffic
  env.DISABLE_AUTOUPDATER = "1";
  return env;
}

/** Parse stream-json output into an audit record. Pure; used by tests with fixtures. */
export function auditStream(stdout, snapshot, pin) {
  const a = { init: null, toolUses: [], denials: [], result: null, parseErrors: 0, reasons: [], warnings: [] };
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { a.parseErrors++; continue; }
    if (m.type === "system" && m.subtype === "init") a.init = m;
    else if (m.type === "assistant") {
      for (const c of m.message?.content ?? []) if (c.type === "tool_use") a.toolUses.push({ id: c.id, name: c.name, input: c.input });
    } else if (m.type === "result") a.result = m;
  }
  if (a.parseErrors) a.reasons.push(`stream_parse_errors:${a.parseErrors}`); // a dropped line could be a tool_use
  const init = a.init;
  if (!init) a.reasons.push("no_init_event");
  else {
    if (!Array.isArray(init.tools)) a.reasons.push("init_tools_unreported");
    else {
      const extraTools = init.tools.filter((t) => !ALLOWED_RUNTIME_TOOLS.includes(t));
      if (extraTools.length) a.reasons.push(`tools_not_read_only:${extraTools.join(",")}`);
    }
    if (!Array.isArray(init.mcp_servers)) a.reasons.push("init_mcp_servers_unreported");
    else if (init.mcp_servers.length) a.reasons.push(`mcp_servers_present:${init.mcp_servers.map((s) => s.name ?? s).join(",")}`);
    if (init.permissionMode !== "dontAsk") a.reasons.push(`permission_mode:${init.permissionMode}`);
    if (typeof init.cwd !== "string") a.reasons.push("init_cwd_unreported");
    else if (realish(init.cwd) !== realish(snapshot)) a.reasons.push("cwd_not_snapshot");
  }
  const denied = new Set((a.result?.permission_denials ?? []).map((d) => d.tool_use_id));
  const paths = [];
  for (const t of a.toolUses) {
    if (!ALLOWED_RUNTIME_TOOLS.includes(t.name)) { a.reasons.push(`non_read_tool_call:${t.name}`); continue; }
    // Glob/Grep patterns can name directories too: an absolute, ~ or .. pattern is audited like a path.
    const pat = typeof t.input?.pattern === "string" && /^(\/|~)|(^|\/)\.\.(\/|$)/.test(t.input.pattern) ? ["pattern"] : [];
    for (const k of ["file_path", "path", "notebook_path", ...pat]) if (typeof t.input?.[k] === "string") {
      const v = t.input[k];
      const inside = !/(^|\/)\.\.(\/|$)/.test(v) && !v.startsWith("~") && insideRoot(snapshot, v);
      paths.push({ tool: t.name, path: t.input[k], inside, denied: denied.has(t.id) });
      if (!inside && !denied.has(t.id)) a.reasons.push(`tool_read_outside_snapshot:${t.input[k]}`);
      if (!inside && denied.has(t.id)) a.warnings.push(`outside-snapshot read attempt denied by the host: ${t.input[k]}`);
    }
  }
  a.paths = paths;
  const r = a.result;
  if (!r) a.reasons.push("no_result_event");
  else if (r.is_error || r.subtype !== "success") a.reasons.push(`host_error:${r.subtype ?? "error"}`);
  const modelUsage = r?.modelUsage ?? {};
  a.reported = {
    model: init?.model ?? null,
    effort: null,
    source: "stream-json init.model; result.modelUsage keys",
    modelUsageKeys: Object.keys(modelUsage),
  };
  if (r && !Object.keys(modelUsage).includes(pin.model)) a.reasons.push(`pinned_model_not_in_modelUsage:${Object.keys(modelUsage).join(",")}`);
  const others = Object.keys(modelUsage).filter((k) => k !== pin.model);
  if (others.length) a.warnings.push(`host also used ${others.join(", ")} for internal steps (not the review model)`);
  a.usage = r ? { ...(r.usage ?? {}), total_cost_usd: r.total_cost_usd ?? null, num_turns: r.num_turns ?? null } : null;
  a.output = r?.structured_output ?? r?.result ?? null;
  return a;
}

/** Numeric usage fields summed over attempts (first-attempt usage is never dropped). */
export function sumUsage(list) {
  const out = {};
  for (const u of list.filter(Boolean)) for (const [k, v] of Object.entries(u)) if (typeof v === "number") out[k] = (out[k] ?? 0) + v;
  return Object.keys(out).length ? out : null;
}

export async function run(ctx) {
  const { input, pin, prompt, jsonSchema, validate, log } = ctx;
  const bin = pin.config.bin ?? "claude";
  const argv = buildArgv(pin, jsonSchema);
  // Evidence keeps long values as length + hash; the bypass guard in runProcess sees the full argv before spawn.
  const out = { argv: [bin, ...argv.map((x) => (x.length > 200 ? `<${x.length} chars sha256:${sha256(x)}>` : x))], attempts: [], reasons: [], warnings: [], toolAudit: [] };
  const deadline = Date.now() + pin.timeoutMs;
  const env = buildEnv(process.env, pin.envPassthrough ?? pin.config.env_passthrough ?? []);
  let text = prompt;
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (attempt > 0 && remaining < 30_000) { out.reasons.push("timeout_before_retry"); break; }
    const label = attempt ? "retry" : "first";
    const p = await runProcess({ bin, args: argv, cwd: input.snapshot, env, input: text, timeoutMs: remaining });
    log(`${label}.stdout.jsonl`, redact(p.stdout));
    log(`${label}.stderr.log`, redact(p.stderr));
    const a = auditStream(p.stdout, input.snapshot, pin);
    const rec = { label, code: p.code, signal: p.signal, timedOut: p.timedOut, durationMs: p.durationMs, spawnError: p.spawnError, pipesAbandoned: p.pipesAbandoned, leftoversKilled: p.leftoversKilled, signals: p.signals, auditReasons: a.reasons, warnings: a.warnings, usage: a.usage, reported: a.reported };
    out.attempts.push(rec);
    out.toolAudit.push({ attempt: label, initTools: a.init?.tools ?? null, mcpServers: a.init?.mcp_servers ?? null, permissionMode: a.init?.permissionMode ?? null, toolCalls: a.toolUses.map((t) => t.name), paths: a.paths });
    if (!out.reported || a.reported.model !== pin.model) out.reported = a.reported; // a mismatch on any attempt stays visible
    out.usage = sumUsage(out.attempts.map((x) => x.usage));
    out.warnings.push(...a.warnings);
    if (p.spawnError) { out.reasons.push(`spawn_error:${p.spawnError}`); break; }
    if (p.timedOut) { out.reasons.push("timeout"); break; }
    if (p.pipesAbandoned) { out.reasons.push("pipes_abandoned: a descendant kept the host's stdout/stderr open; the stream may be truncated"); break; }
    if (a.reasons.length) { out.reasons.push(...a.reasons); break; }   // audit failures are never retried
    if (a.reported.model !== pin.model) { out.reasons.push(`reported_model_mismatch:${a.reported.model}`); break; } // never retried on another model
    if (p.code !== 0) { out.reasons.push(`exit_code:${p.code}`); break; }
    const v = validate(a.output);
    rec.validation = v.errors;
    if (!v.errors.length) { out.review = v.value; break; }
    if (attempt === 1) { out.reasons.push("schema_invalid_after_retry"); break; }
    text = `${prompt}\n\n=== CORRECTION ===\nA previous attempt at this review returned output that failed validation:\n- ${v.errors.join("\n- ")}\nPrevious output:\n${typeof a.output === "string" ? a.output : JSON.stringify(a.output)}\nReturn the corrected review JSON only.`;
  }
  out.effortReported = false;
  out.limits = ["Claude Code does not report the effort level it ran at; --effort is recorded as pinned only."];
  return out;
}
