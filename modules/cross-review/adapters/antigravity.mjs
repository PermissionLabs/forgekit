// Antigravity reviewer adapter: the runner is the ACP client of the T3-managed `agy_acp_server`.
// Ported from the proven view_file runner (ag-review-vf.ts, cycles r5-r8). Rules it enforces:
//  - Isolated GEMINI_HOME holding only an `antigravity-acp` symlink to the T3 profile (no config/, so no global
//    MCP config is merged). Token files are never opened. mcpServers: [].
//  - Client capabilities fs/terminal false; every session/request_permission -> reject_once (never allow_*, never
//    reject_always); any other client request -> -32601 and the run is incomplete.
//  - Session _meta.antigravity.enabledTools = ["view_file"]; cwd = the read-only snapshot. Every tool call's
//    locations[].path and rawInput path fields must resolve inside the snapshot; otherwise incomplete.
//  - Model pin: set_config_option model + thinking level, verified from the response and from the stderr
//    "Proxy extracted model from path: <model>-<thinking>" line on every model call.
//  - The local proxy aborts a model call whose first byte takes > 300 s (HTTP 502), so the review is split into one
//    turn per dimension group in the same session and merged. The first upstream failure cancels the run.
//  - Per-group schema validation with at most one corrective re-ask (only after end_turn).
//  - Process-group cleanup; session files removed only when the .meta cwd equals this run's cwd.
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expandHome } from "../lib/policy.mjs";
import { insideRoot, redact, sha256 } from "../lib/inputs.mjs";

export const ENABLED_TOOLS = ["view_file"];
export const CLIENT_CAPABILITIES = { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { notices: {} } };
const ALLOWED_TOOL_TITLE = /^(Running |Ran )?view_file\b/;
const SESSION_SUFFIXES = [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const REMOVED_ENV = new Set([
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION", "GOOGLE_CLOUD_QUOTA_PROJECT", "GOOGLE_GENAI_USE_VERTEXAI", "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT", "AGY_ACP_CCPA_PROJECT", "AGY_ACP_ENABLE_OAUTH", "GEMINI_HOME",
  "AGY_ACP_FORCE_FILE_STORAGE", "ANTIGRAVITY_HARNESS_PATH", "BROWSER", "PYTHONUNBUFFERED", "ELECTRON_RUN_AS_NODE",
]);
const BROWSER_MARKER = "__CROSS_REVIEW_AUTH_URL__";
const AUTH_PREFIX = "Open the following link to authenticate the ACP server: ";
const sleep = (n) => new Promise((r) => setTimeout(r, n));

/** Permission answer: always reject_once; if the server offers none, cancel. Never allow, never persist. */
export function permissionOutcome(options) {
  const rej = (options ?? []).find((o) => o.kind === "reject_once");
  return rej ? { outcome: "selected", optionId: rej.optionId } : { outcome: "cancelled" };
}

export function sessionNewParams(cwd) {
  return { cwd, mcpServers: [], _meta: { antigravity: { enabledTools: ENABLED_TOOLS } } };
}

export function buildEnv(base, { geminiHome, tmpDir, harness }) {
  const q = (s) => `'${s.replaceAll("'", `'"'"'`)}'`;
  const helper = `process.stderr.on("error",()=>process.exit(0)).write("${BROWSER_MARKER}"+"\\n",()=>process.exit(0))`;
  const env = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !REMOVED_ENV.has(k.toUpperCase())) env[k] = v;
  return Object.assign(env, {
    GEMINI_HOME: geminiHome,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    BROWSER: [process.execPath, "-e", helper, "--", "%s"].map(q).join(" "), // an auth URL is never opened or logged
    PYTHONUNBUFFERED: "1",
    ELECTRON_RUN_AS_NODE: "1",
    TMPDIR: tmpDir,
    ANTIGRAVITY_HARNESS_PATH: harness,
  });
}

/** Turn groups for this run: the policy groups restricted to the run's dimensions, leftovers as one more group. */
export function groupsFor(dimensions, policyGroups) {
  const groups = (policyGroups ?? []).map((g) => g.filter((d) => dimensions.includes(d))).filter((g) => g.length);
  const seen = new Set(groups.flat());
  const rest = dimensions.filter((d) => !seen.has(d));
  if (rest.length) groups.push(rest);
  return groups.length ? groups : [dimensions];
}

function findProfile(profileRoot) {
  const cands = fs.readdirSync(profileRoot).filter((d) => fs.existsSync(path.join(profileRoot, d, "antigravity-acp")));
  if (cands.length !== 1) throw new Error(`expected exactly one Antigravity profile under ${profileRoot}, found ${cands.length}; set hosts.antigravity.runtime.profile`);
  return path.join(profileRoot, cands[0]);
}
const psList = () => execFileSync("ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" }).split("\n")
  .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: +m[1], pgid: +m[2], cmd: m[3].slice(0, 160) }));
const isAgy = (cmd) => /agy_acp_server|localharness_external/.test(cmd);

export async function run(ctx) {
  const { input, pin, validateGroup, log, prefix, idStart, priorIds, dimensions } = ctx;
  const cfg = pin.config;
  const rt = cfg.runtime ?? {};
  const out = { attempts: [], reasons: [], warnings: [], toolAudit: null, reported: { model: null, effort: null, source: "set_config_option currentValue; stderr proxy model per call", proxyModels: [] } };
  const reasons = out.reasons;
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  const thinking = pin.effort;
  const expectedProxyModel = `${pin.model}-${thinking}`;
  const groups = groupsFor(dimensions, cfg.groups);
  out.groups = groups;

  // ---- runtime + profile (directory names only; files inside are never opened, except a session's .meta)
  const runtimeRoot = expandHome(rt.runtime_root ?? "~/.t3/tools/antigravity-acp/darwin-arm64/versions");
  const version = fs.existsSync(runtimeRoot) ? fs.readdirSync(runtimeRoot).find((d) => fs.existsSync(path.join(runtimeRoot, d, "agy_acp_server.par"))) : null;
  if (!version) { reasons.push(`runtime_not_found:${runtimeRoot}`); return out; }
  const runtimeDir = path.join(runtimeRoot, version);
  let profile;
  try { profile = rt.profile ? expandHome(rt.profile) : findProfile(expandHome(rt.profile_root ?? "~/.t3/userdata/providers/antigravity")); }
  catch (e) { reasons.push(`profile_not_found:${e.message}`); return out; }
  const acpDir = path.join(profile, "antigravity-acp");
  if (!fs.existsSync(acpDir) || !fs.statSync(acpDir).isDirectory()) { reasons.push("profile_acp_dir_missing"); return out; }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-gemini-home-"));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-agy-tmp-"));
  fs.symlinkSync(acpDir, path.join(home, "antigravity-acp"));
  const cwd = input.snapshot;
  out.isolation = { geminiHome: home, antigravityAcpLink: acpDir, cwd, clientCapabilities: CLIENT_CAPABILITIES, sessionMeta: { antigravity: { enabledTools: ENABLED_TOOLS } }, permissionPolicy: "reject_once", runtime: version };

  const msgLines = [];
  const errChunks = [];
  const psBefore = psList().filter((p) => isAgy(p.cmd)).map((p) => p.pid);
  const env = buildEnv(process.env, { geminiHome: home, tmpDir, harness: path.join(runtimeDir, "localharness_external") });
  let exitInfo = null, authRequired = false, sessionId, nextId = 1, collecting = null, upstreamFailures = 0;
  const pending = new Map();
  const agentErrors = [];
  const toolItems = [];
  const toolInputs = [];
  const permissionRequests = [];
  const clientRequests = [];
  const promptUsage = [];
  const child = spawn(path.join(runtimeDir, "agy_acp_server.par"), [], { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const childExited = new Promise((res) => child.on("exit", (code, signal) => {
    exitInfo = { code, signal, atMs: ms() };
    for (const p of pending.values()) p.reject(new Error(`agent exited (${code ?? signal})`));
    pending.clear();
    res();
  }));
  child.on("error", (e) => { reasons.push(`spawn_error:${e.message}`); });
  child.stdin.on("error", () => {});

  const slim = (m) => (m?.method === "session/prompt" && Array.isArray(m.params?.prompt))
    ? { ...m, params: { ...m.params, prompt: m.params.prompt.map((b) => ({ type: b.type, sha256: sha256(b.text ?? b.resource?.text ?? ""), chars: (b.text ?? b.resource?.text ?? "").length })) } } : m;
  const logMsg = (dir, m) => msgLines.push(redact(JSON.stringify({ t: ms(), dir, m: slim(m) })));
  const send = (m) => { logMsg("out", m); try { child.stdin.write(JSON.stringify(m) + "\n"); } catch {} };
  const request = (method, params, timeoutMs = 120_000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, timeoutMs);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    send({ jsonrpc: "2.0", id, method, params });
  });
  const onClientRequest = (m) => {
    if (m.method === "session/request_permission") {
      const outcome = permissionOutcome(m.params?.options);
      permissionRequests.push({ atMs: ms(), title: m.params?.toolCall?.title, kind: m.params?.toolCall?.kind, answered: outcome });
      send({ jsonrpc: "2.0", id: m.id, result: { outcome } });
      return;
    }
    clientRequests.push({ atMs: ms(), method: m.method });
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `client does not support ${m.method}` } });
  };
  const onNotification = (m) => {
    if (m.method !== "session/update") return;
    const u = m.params?.update ?? {};
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text" && collecting) collecting.push(u.content.text);
    if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
      toolItems.push({ update: u.sessionUpdate, id: u.toolCallId, title: u.title, kind: u.kind, status: u.status });
      if (u.rawInput || u.locations) toolInputs.push({ id: u.toolCallId,
        rawInput: u.rawInput && typeof u.rawInput === "object" ? Object.fromEntries(Object.entries(u.rawInput).map(([k, x]) => [k, typeof x === "string" ? x.slice(0, 500) : x])) : undefined,
        locations: Array.isArray(u.locations) ? u.locations.map((l) => l.path) : undefined });
    }
  };
  let buf = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      if (line.startsWith(AUTH_PREFIX)) { authRequired = true; for (const p of pending.values()) p.reject(new Error("AUTH_REQUIRED")); pending.clear(); continue; }
      let m;
      try { m = JSON.parse(line); } catch { msgLines.push(redact(line.slice(0, 500))); continue; }
      logMsg("in", m);
      if (m.id !== undefined && m.method === undefined) {
        const p = pending.get(m.id);
        if (!p) continue;
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message ?? "rpc error")); else p.resolve(m.result);
      } else if (m.id !== undefined && m.method) onClientRequest(m);
      else if (m.method) onNotification(m);
    }
  });
  let errBuf = "";
  child.stderr.setEncoding("utf8").on("data", (s) => {
    if (s.includes(BROWSER_MARKER) || s.includes(AUTH_PREFIX)) authRequired = true;
    errChunks.push(redact(s));
    errBuf += s;
    let nl;
    while ((nl = errBuf.indexOf("\n")) !== -1) {
      const line = errBuf.slice(0, nl);
      errBuf = errBuf.slice(nl + 1);
      const pm = line.match(/Proxy extracted model from path: (\S+)/);
      if (pm) out.reported.proxyModels.push(pm[1]);
      if (/Proxy failed to connect to CCPA API|System step error \(HTTP 5\d\d\)|received model response error: Error 5\d\d/.test(line)) upstreamFailures++;
      if (/^E\d{4}\s/.test(line) || /Agent run failed|AntigravityExecutionError|MCP load failed|RESOURCE_EXHAUSTED/.test(line)) agentErrors.push(redact(line).slice(0, 400));
    }
  });
  const isFatal = (l) => /Agent run failed|AntigravityExecutionError|MCP load failed|RESOURCE_EXHAUSTED/.test(l);

  const runPrompt = async (blocks, label, timeoutMs) => {
    collecting = [];
    const started = ms();
    const failBefore = upstreamFailures;
    const errBefore = agentErrors.length;
    let timedOut = false, upstream = false;
    const watchdog = setInterval(() => {
      if (timedOut || upstream) return;
      if (ms() - started > timeoutMs) { timedOut = true; send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }); }
      else if (upstreamFailures > failBefore) { upstream = true; send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }); }
    }, 1000);
    let resp, err;
    try { resp = await request("session/prompt", { sessionId, prompt: blocks }, timeoutMs + 60_000); } catch (e) { err = e; }
    clearInterval(watchdog);
    const text = collecting.join("");
    collecting = null;
    if (resp?.usage) promptUsage.push({ label, ...resp.usage });
    const rec = { label, durationMs: ms() - started, timedOut, upstreamFailure: upstream, stopReason: resp?.stopReason ?? null, error: err ? String(err.message ?? err) : null, agentErrors: agentErrors.slice(errBefore), outputChars: text.length, promptSha256: sha256(JSON.stringify(blocks)) };
    out.attempts.push(rec);
    return { rec, text };
  };

  const fatalReasons = (rec, label) => {
    const r = [];
    if (rec.timedOut) r.push(`timeout:${label}`);
    if (rec.upstreamFailure) r.push(`upstream_502:${label} (first upstream failure; not retried, reviewer not switched)`);
    if (rec.error) r.push(`prompt_error:${label}:${rec.error}`);
    if (rec.stopReason && rec.stopReason !== "end_turn") r.push(`stop_reason:${label}:${rec.stopReason}`);
    if (rec.agentErrors.some(isFatal)) r.push(`agent_error:${label}`);
    if (authRequired) r.push("auth_required");
    return r;
  };

  const main = async () => {
    const init = await request("initialize", { protocolVersion: 2, clientCapabilities: CLIENT_CAPABILITIES, clientInfo: { name: "zed", version: "0.0.0" } });
    out.agent = { name: init?.agentInfo?.name ?? null, version: init?.agentInfo?.version ?? null, runtimeDir: version };
    if (rt.expect_agent_version && out.agent.version !== rt.expect_agent_version) { reasons.push(`agent_version_mismatch:${out.agent.version}`); return; }
    try { await request("authenticate", { methodId: "oauth-personal" }, 60_000); }
    catch (e) { reasons.push(authRequired || e.message === "AUTH_REQUIRED" ? "auth_required" : `authenticate_failed:${e.message}`); return; }
    const ns = await request("session/new", sessionNewParams(cwd), 120_000);
    sessionId = ns.sessionId;
    out.sessionId = sessionId;
    let opts = ns.configOptions ?? [];
    const r1 = await request("session/set_config_option", { sessionId, configId: "model", value: pin.model });
    opts = r1?.configOptions ?? opts;
    const thinkingOpt = opts.find((o) => o.category === "thought_level");
    if (!thinkingOpt) { reasons.push("no_thought_level_option"); return; }
    const r2 = await request("session/set_config_option", { sessionId, configId: thinkingOpt.id, value: thinking });
    opts = r2?.configOptions ?? opts;
    out.reported.model = opts.find((o) => o.id === "model")?.currentValue ?? null;
    out.reported.effort = opts.find((o) => o.id === thinkingOpt.id)?.currentValue ?? null;
    if (out.reported.model !== pin.model || out.reported.effort !== thinking) { reasons.push("model_pin_not_applied"); return; }

    const deadline = t0 + pin.timeoutMs;
    const remaining = () => deadline - Date.now();
    const turnMs = (cfg.turn_timeout_sec ?? 600) * 1000;
    const retryMs = (cfg.retry_timeout_sec ?? 280) * 1000;
    const fileList = input.files.map((f) => `${path.join(cwd, f.path)}  (${f.lines} lines${f.kind === "context" ? ", context only" : ""})`).join("\n");
    const toolNote = `You have exactly ONE tool: view_file. Read files with view_file using the absolute paths listed below (snapshot root ${cwd}); read only those files, in several small steps. No shell, no web, no writes.`;
    const parts = [];
    const priorSeen = new Set();
    for (const [gi, dims] of groups.entries()) {
      const label = `group:${dims.join("+")}`;
      const last = gi === groups.length - 1;
      const mustCover = last ? priorIds.filter((x) => !priorSeen.has(x)) : [];
      const turnRule = `THIS TURN covers only these dimensions: ${dims.join(", ")}. Report only findings for them; coverage keys are exactly these.` +
        (priorIds.length ? (last ? ` THIS IS THE LAST TURN: prior_verification must cover every earlier id not reported in previous turns (${mustCover.join(", ") || "none left"}).` : " prior_verification may be [] in this turn if no earlier finding concerns these dimensions.") : "");
      const core = ctx.promptFor({ dimensions: dims, toolNote, includeDiff: false });
      const blocks = gi === 0 ? [
        { type: "text", text: `${core}\n\n${turnRule}` },
        { type: "resource", resource: { uri: `file://${path.join(cwd, "__review__", "diff.patch")}`, mimeType: "text/x-diff", text: input.diffText } },
        { type: "text", text: `=== FILES YOU MAY READ (absolute paths) ===\n${fileList}` },
      ] : [{ type: "text", text: `Next turn. The brief, rules, diff and file list from the first turn still apply.\n${turnRule}\nRespond with ONLY one JSON object of the same shape, with coverage keys ${dims.join(", ")}.` }];
      const budget = Math.min(turnMs, remaining() - 30_000);
      if (budget < 60_000) { reasons.push(`total_timeout_before:${label}`); break; }
      const first = await runPrompt(blocks, label, budget);
      let v = validateGroup(first.text, dims, mustCover);
      first.rec.validation = v.errors;
      if (v.errors.length) {
        const fatal = fatalReasons(first.rec, label);
        if (fatal.length) { reasons.push(...fatal); break; }
        const rb = Math.min(retryMs, remaining() - 30_000);
        if (rb < 60_000) { reasons.push(`total_timeout_before_retry:${label}`); break; }
        const retry = await runPrompt([{ type: "text", text: `Your previous reply failed validation:\n- ${v.errors.join("\n- ")}\nReply again with ONLY the corrected JSON object for dimensions ${dims.join(", ")} (no prose, no code fences, no tool calls).` }], `${label}:retry`, rb);
        v = validateGroup(retry.text, dims, mustCover);
        retry.rec.validation = v.errors;
        if (v.errors.length) { reasons.push(...fatalReasons(retry.rec, `${label}:retry`), `schema_invalid_after_retry:${label}`); break; }
      }
      for (const p of v.value.prior_verification ?? []) priorSeen.add(p.id);
      parts.push({ dims, value: v.value });
    }
    if (parts.length !== groups.length) return;
    // Merge: renumber ids in group order, union coverage, concat limits, recompute verdict.
    const findings = parts.flatMap((p) => p.value.findings).map((f, i) => ({ ...f, id: `${prefix}${idStart + i}` }));
    const merged = { verdict: "pass", coverage: Object.assign({}, ...parts.map((p) => p.value.coverage)), findings, limits: [...new Set(parts.flatMap((p) => p.value.limits))] };
    if (priorIds.length) merged.prior_verification = priorIds.map((id) => {
      const es = parts.flatMap((p) => (p.value.prior_verification ?? []).filter((x) => x.id === id));
      return { id, verified: es.length > 0 && es.every((e) => e.verified), note: es.map((e) => e.note).join(" | ") || "not reported" };
    });
    const sevBlock = findings.some((f) => f.sev === "critical" || f.sev === "high");
    merged.verdict = sevBlock ? "block" : findings.length || (merged.prior_verification ?? []).some((p) => !p.verified) ? "fix" : "pass";
    out.review = merged;
    out.groupVerdicts = parts.map((p) => ({ dims: p.dims, verdict: p.value.verdict }));
  };

  let cleaned = false;
  const finish = async () => {
    if (cleaned) return;
    cleaned = true;
    const pid = child.pid;
    if (pid) {
      if (exitInfo === null) { try { child.stdin.end(); } catch {} await Promise.race([childExited, sleep(3000)]); }
      if (exitInfo === null) { try { process.kill(-pid, "SIGTERM"); } catch {} await Promise.race([childExited, sleep(5000)]); }
      if (exitInfo === null) { try { process.kill(-pid, "SIGKILL"); } catch {} await Promise.race([childExited, sleep(3000)]); }
      try { process.kill(-pid, "SIGTERM"); } catch {}
      await sleep(1500);
      const left = psList().filter((p) => (p.pgid === pid || isAgy(p.cmd)) && !psBefore.includes(p.pid));
      if (left.length) { try { process.kill(-pid, "SIGKILL"); } catch {} }
      out.process = { exit: exitInfo, leftoversAfterGraceful: left.length };
    }
    // Session files: only when the .meta cwd is this run's snapshot.
    const sc = { sessionId: sessionId ?? null, removed: [], skipped: null };
    try {
      if (!sessionId || !UUID_V4.test(sessionId)) sc.skipped = "no native session id";
      else {
        const base = path.join(acpDir, "conversations", sessionId);
        const brain = path.join(acpDir, "brain", sessionId);
        let metaCwd;
        if (!fs.existsSync(`${base}.meta`)) sc.skipped = ".meta missing";
        else {
          try { metaCwd = JSON.parse(fs.readFileSync(`${base}.meta`, "utf8"))?.cwd; } catch (e) { sc.skipped = `.meta unreadable: ${e.message}`; }
          if (!sc.skipped && metaCwd !== cwd) sc.skipped = ".meta cwd differs from runner cwd";
          if (!sc.skipped) {
            for (const s of SESSION_SUFFIXES) if (fs.existsSync(base + s)) { fs.rmSync(base + s, { force: true }); sc.removed.push(sessionId + s); }
            if (fs.existsSync(brain)) { fs.rmSync(brain, { recursive: true, force: true }); sc.removed.push(`brain/${sessionId}/`); }
          }
        }
      }
    } catch (e) { sc.error = e.message; }
    out.sessionCleanup = sc;
    if (sc.skipped && sessionId) out.warnings.push(`session files not removed: ${sc.skipped}`);
    // Tool/path audit (snapshot still exists; the runner removes it after this adapter returns).
    const pathsOf = (t) => [...(t.locations ?? []), ...Object.entries(t.rawInput ?? {}).filter(([k, x]) => typeof x === "string" && /path|file|uri|dir/i.test(k)).map(([, x]) => x)].filter(Boolean);
    const all = [...new Set(toolInputs.flatMap(pathsOf))];
    const callIds = [...new Set(toolItems.filter((t) => t.update === "tool_call").map((t) => t.id))];
    const withPath = new Set(toolInputs.filter((t) => pathsOf(t).length).map((t) => t.id));
    const badTitles = toolItems.filter((t) => t.update === "tool_call" && !ALLOWED_TOOL_TITLE.test(String(t.title ?? ""))).map((t) => t.title);
    const outside = all.filter((p) => !insideRoot(cwd, p));
    out.toolAudit = { enabledTools: ENABLED_TOOLS, toolCallCount: callIds.length, pathsTouched: all, outsideSnapshot: outside, nonViewFileCalls: badTitles, callsWithoutAuditablePath: callIds.filter((id) => !withPath.has(id)), permissionRequests, clientRequests };
    if (outside.length) reasons.push(`tool_read_outside_snapshot:${outside.length}`);
    if (badTitles.length) reasons.push(`non_view_file_tool_calls:${badTitles.length}`);
    if (out.toolAudit.callsWithoutAuditablePath.length) reasons.push(`unauditable_tool_calls:${out.toolAudit.callsWithoutAuditablePath.length}`);
    if (clientRequests.length) reasons.push(`unexpected_client_requests:${clientRequests.length}`);
    if (permissionRequests.length) out.warnings.push(`permission requests rejected (reject_once): ${permissionRequests.length}`);
    const pm = out.reported.proxyModels;
    if (!pm.length) out.warnings.push("no 'Proxy extracted model' line on stderr; per-request model unconfirmed");
    else if (!pm.every((m) => m === expectedProxyModel)) reasons.push(`proxy_model_mismatch:${[...new Set(pm)].join(",")}`);
    const keys = ["totalTokens", "inputTokens", "outputTokens", "thoughtTokens", "cachedReadTokens", "cachedWriteTokens"];
    out.usage = Object.fromEntries(keys.map((k) => [k, promptUsage.reduce((a, u) => a + (Number(u[k]) || 0), 0)]));
    out.authRequired = authRequired;
    // Isolated home: unlink the symlink itself (never recurse through it), then remove the rest.
    try {
      const link = path.join(home, "antigravity-acp");
      out.isolation.configDirCreatedByServer = fs.existsSync(path.join(home, "config"));
      if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
      for (const e of fs.readdirSync(home)) fs.rmSync(path.join(home, e), { recursive: true, force: true });
      fs.rmdirSync(home);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      out.isolation.profileAcpDirIntact = fs.existsSync(acpDir);
    } catch (e) { out.warnings.push(`isolation cleanup: ${e.message}`); }
    log("messages.jsonl", msgLines.join("\n") + "\n");
    log("stderr.log", errChunks.join(""));
  };

  const hard = setTimeout(() => { reasons.push("hard_timeout"); for (const p of pending.values()) p.reject(new Error("hard_timeout")); }, pin.timeoutMs + 120_000);
  try { await main(); } catch (e) { reasons.push(`fatal:${String(e?.message ?? e)}`); }
  clearTimeout(hard);
  await finish();
  out.limits = [
    "Antigravity does not report the model per response; the pin is checked from set_config_option and the local proxy's stderr line, which may change between runtime versions.",
    "Session persistence cannot be disabled; session files are deleted after the run when their .meta cwd matches.",
  ];
  return out;
}
