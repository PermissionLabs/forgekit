// Antigravity reviewer adapter: the runner is the ACP client of the T3-managed `agy_acp_server`.
// Ported from the proven view_file runner (ag-review-vf.ts, cycles r5-r8). Rules it enforces:
//  - Isolated GEMINI_HOME holding only an `antigravity-acp` symlink to the T3 profile (no config/, so no global
//    MCP config is merged). Token files are never opened. mcpServers: [].
//  - Client capabilities fs/terminal false; every session/request_permission -> reject_once (never allow_*, never
//    reject_always); any other client request -> -32601 and the run is incomplete.
//  - Session _meta.antigravity.enabledTools = ["view_file"]; cwd = the read-only snapshot. Every tool call's
//    locations[].path and rawInput path fields must resolve inside the snapshot; otherwise incomplete.
//  - Model pin: set_config_option model + thinking level, verified from the response and from the stderr
//    "Proxy extracted model from path: <model>-<thinking>" line, which every turn must carry (missing -> incomplete).
//  - The local proxy aborts a model call whose first byte takes > 300 s (HTTP 502), so the review is split into one
//    turn per dimension group, and a large scope is further split into file chunks per turn
//    (max_files_per_turn / max_bytes_per_turn), in the same session, then merged. The first upstream failure
//    cancels the run.
//  - Every turn (first and retry) is checked for timeout, upstream failure, RPC error, non-end_turn stop reason,
//    fatal agent errors and auth prompts before its text is used; any of them withholds the review.
//  - Per-turn schema validation with contiguous ids across turns and at most one corrective re-ask.
//  - Process-group cleanup signals the group only while it is provably ours; session files removed only when
//    the .meta cwd equals this run's cwd.
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expandHome } from "../lib/policy.mjs";
import { insideRoot, redact, sha256 } from "../lib/inputs.mjs";
import { groupMembers, ownedMembers } from "../lib/proc.mjs";

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
/** Process table via POSIX `ps -eo`; [] when unreadable (callers then never signal). */
export function psList() {
  try {
    return execFileSync("ps", ["-eo", "pid=,pgid=,args="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n")
      .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: +m[1], pgid: +m[2], cmd: m[3].slice(0, 160) }));
  } catch { return []; }
}
const isAgy = (cmd) => /agy_acp_server|localharness_external/.test(cmd);

/** Runtime directory: `{platform}-{arch}` placeholders expanded; the highest version holding agy_acp_server.par. */
export function findRuntime(runtimeRootSetting) {
  const root = expandHome(String(runtimeRootSetting ?? "~/.t3/tools/antigravity-acp/{platform}-{arch}/versions").replaceAll("{platform}", process.platform).replaceAll("{arch}", process.arch));
  if (!fs.existsSync(root)) return { root, version: null };
  const cmp = (a, b) => {
    const pa = a.split(/[.\-+_]/), pb = b.split(/[.\-+_]/);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] ?? "", y = pb[i] ?? "";
      const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
      const d = nx && ny ? Number(x) - Number(y) : x.localeCompare(y);
      if (d) return d;
    }
    return 0;
  };
  const versions = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, "agy_acp_server.par"))).sort(cmp);
  return { root, version: versions.at(-1) ?? null, candidates: versions };
}

/**
 * Turns: each dimension group, split into chunks of scope files so no turn exceeds maxFiles / maxBytes
 * (a single file larger than maxBytes gets its own chunk). One chunk -> the turn lists no file restriction.
 */
export function planTurns(groups, scopeFiles, { maxFiles, maxBytes } = {}) {
  const chunks = [];
  let cur = [], bytes = 0;
  for (const f of scopeFiles) {
    if (cur.length && ((maxFiles && cur.length >= maxFiles) || (maxBytes && bytes + f.bytes > maxBytes))) { chunks.push(cur); cur = []; bytes = 0; }
    cur.push(f);
    bytes += f.bytes;
  }
  if (cur.length) chunks.push(cur);
  const split = chunks.length > 1;
  return groups.flatMap((dims) => (split ? chunks : [null]).map((files, ci) => ({ dims, files: files?.map((f) => f.path) ?? null, label: `group:${dims.join("+")}${split ? `:files${ci + 1}/${chunks.length}` : ""}` })));
}

/**
 * Stop the server's process group. While the child is not reaped it holds the pgid, so signalling the group is
 * safe. After it exited, a numeric pgid match is never enough: `ps` is re-read right before each signal and only
 * members started between spawn and exit (ownedMembers) are signalled, each by pid.
 * deps: { pid, spawnedAt, exitedAt(), exited(), waitExit(ms), members(pid) -> [{pid,startMs}], kill(pid, sig), sleep(ms) }.
 * Returns the signal log.
 */
export async function stopGroup({ pid, spawnedAt = 0, exitedAt = () => Date.now(), exited, waitExit, members, kill, sleep: nap = sleep }) {
  const log = [];
  const sig = (target, s, why) => { try { kill(target, s); log.push({ sig: s, why, target }); } catch (e) { log.push({ sig: s, why, target, error: e.code ?? String(e) }); } };
  if (!exited()) await waitExit(3000);
  if (!exited()) { sig(-pid, "SIGTERM", "child alive"); await waitExit(5000); }
  if (!exited()) { sig(-pid, "SIGKILL", "child alive"); await waitExit(3000); }
  if (!exited()) return log; // still holding the group; nothing else can be done safely
  const owned = () => { const all = members(pid); return { all, mine: ownedMembers(all, { spawnedAt, exitedAt: exitedAt() }) }; };
  let { all, mine } = owned();
  if (!mine.length) { log.push({ skipped: all.length ? `no group member provably ours after exit (${all.length} in group)` : "no live group member after exit" }); return log; }
  for (const p of mine) sig(p, "SIGTERM", `group member after exit`);
  await nap(1500);
  ({ mine } = owned());
  for (const p of mine) sig(p, "SIGKILL", `group member after exit`);
  return log;
}

export async function run(ctx) {
  const { input, pin, validateGroup, log, prefix, idStart, priorIds, dimensions } = ctx;
  const cfg = pin.config;
  const rt = cfg.runtime ?? {};
  const out = { attempts: [], reasons: [], warnings: [], toolAudit: null, reported: { model: null, effort: null, source: "set_config_option currentValue; stderr proxy model on every turn", proxyModels: [] } };
  const reasons = out.reasons;
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  const thinking = pin.effort;
  const expectedProxyModel = `${pin.model}-${thinking}`;
  const groups = groupsFor(dimensions, cfg.groups);
  out.groups = groups;
  const scopeFiles = input.files.filter((f) => f.kind === "scope");
  const turns = planTurns(groups, scopeFiles, { maxFiles: cfg.max_files_per_turn, maxBytes: cfg.max_bytes_per_turn });
  out.turns = turns.map((t) => t.label);

  // ---- runtime + profile (directory names only; files inside are never opened, except a session's .meta)
  const { root: runtimeRoot, version } = findRuntime(rt.runtime_root);
  if (!version) { reasons.push(`runtime_not_found:${runtimeRoot}`); return out; }
  const runtimeDir = path.join(runtimeRoot, version);
  const serverBin = path.join(runtimeDir, "agy_acp_server.par");
  out.argv = [serverBin];
  let profile;
  try { profile = rt.profile ? expandHome(rt.profile) : findProfile(expandHome(rt.profile_root ?? "~/.t3/userdata/providers/antigravity")); }
  catch (e) { reasons.push(`profile_not_found:${e.message}`); return out; }
  const acpDir = path.join(profile, "antigravity-acp");
  if (!fs.existsSync(acpDir) || !fs.statSync(acpDir).isDirectory()) { reasons.push("profile_acp_dir_missing"); return out; }

  const cwd = input.snapshot;
  let home = null, tmpDir = null, child = null, exitInfo = null, spawnFailed = null, sessionId, spawnedWall = 0;
  let authRequired = false, nextId = 1, collecting = null, upstreamFailures = 0, upstreamCounted = 0;
  const msgLines = [];
  let errAll = "", errBuf = "";
  const pending = new Map();
  const agentErrors = [];
  const toolItems = [];
  const toolInputs = [];
  const permissionRequests = [];
  const clientRequests = [];
  const promptUsage = [];
  const proxyModels = out.reported.proxyModels;
  let psBefore = [];
  let resolveExited;
  const childExited = new Promise((res) => { resolveExited = res; });
  let resolveErrClosed;
  const errClosed = new Promise((res) => { resolveErrClosed = res; });
  const failPending = (msg) => { for (const p of pending.values()) p.reject(new Error(msg)); pending.clear(); };

  const slim = (m) => (m?.method === "session/prompt" && Array.isArray(m.params?.prompt))
    ? { ...m, params: { ...m.params, prompt: m.params.prompt.map((b) => ({ type: b.type, sha256: sha256(b.text ?? b.resource?.text ?? ""), chars: (b.text ?? b.resource?.text ?? "").length })) } } : m;
  const logMsg = (dir, m) => msgLines.push(redact(JSON.stringify({ t: ms(), dir, m: slim(m) })));
  const send = (m) => { logMsg("out", m); try { child.stdin.write(JSON.stringify(m) + "\n"); } catch {} };
  const request = (method, params, timeoutMs = 120_000) => new Promise((resolve, reject) => {
    // A dead or never-started server fails at once instead of waiting for the RPC timeout.
    if (spawnFailed) return reject(new Error(`spawn failed: ${spawnFailed}`));
    if (exitInfo) return reject(new Error(`agent exited (${exitInfo.code ?? exitInfo.signal})`));
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
      // Full values are audited; only the messages log is size-limited.
      if (u.rawInput || u.locations) toolInputs.push({ id: u.toolCallId,
        rawInput: u.rawInput && typeof u.rawInput === "object" ? u.rawInput : undefined,
        locations: Array.isArray(u.locations) ? u.locations.map((l) => l?.path) : undefined });
    }
  };
  const onStdoutLine = (line) => {
    if (!line.trim()) return;
    if (line.startsWith(AUTH_PREFIX)) { authRequired = true; failPending("AUTH_REQUIRED"); return; }
    let m;
    try { m = JSON.parse(line); } catch { msgLines.push(redact(line.slice(0, 500))); return; }
    logMsg("in", m);
    if (m.id !== undefined && m.method === undefined) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message ?? "rpc error")); else p.resolve(m.result);
    } else if (m.id !== undefined && m.method) onClientRequest(m);
    else if (m.method) onNotification(m);
  };
  const onStderrLine = (line) => {
    const pm = line.match(/Proxy extracted model from path: (\S+)/);
    if (pm) proxyModels.push(pm[1]);
    if (/Proxy failed to connect to CCPA API|System step error \(HTTP 5\d\d\)|received model response error: Error 5\d\d/.test(line)) upstreamFailures++;
    if (/^E\d{4}\s/.test(line) || /Agent run failed|AntigravityExecutionError|MCP load failed|RESOURCE_EXHAUSTED/.test(line)) agentErrors.push(redact(line).slice(0, 400));
  };
  const isFatal = (l) => /Agent run failed|AntigravityExecutionError|MCP load failed|RESOURCE_EXHAUSTED/.test(l);

  const runPrompt = async (blocks, label, timeoutMs) => {
    collecting = [];
    const started = ms();
    const failBefore = upstreamFailures;
    const errBefore = agentErrors.length;
    const proxyStart = proxyModels.length;
    let timedOut = false, upstream = false;
    const watchdog = setInterval(() => {
      if (timedOut || upstream) return;
      if (ms() - started > timeoutMs) { timedOut = true; send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }); }
      else if (upstreamFailures > failBefore) { upstream = true; send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }); }
    }, 1000);
    let resp, err;
    try { resp = await request("session/prompt", { sessionId, prompt: blocks }, timeoutMs + 60_000); } catch (e) { err = e; }
    clearInterval(watchdog);
    if (!upstream && upstreamFailures > failBefore) upstream = true;
    upstreamCounted = upstreamFailures;
    const text = collecting.join("");
    collecting = null;
    if (resp?.usage) promptUsage.push({ label, ...resp.usage });
    const rec = { label, durationMs: ms() - started, timedOut, upstreamFailure: upstream, stopReason: resp?.stopReason ?? null, error: err ? String(err.message ?? err) : null, agentErrors: agentErrors.slice(errBefore), outputChars: text.length, promptSha256: sha256(JSON.stringify(blocks)), proxyStart };
    out.attempts.push(rec);
    return { rec, text };
  };

  const fatalReasons = (rec, label) => {
    const r = [];
    if (rec.timedOut) r.push(`timeout:${label}`);
    if (rec.upstreamFailure) r.push(`upstream_502:${label} (first upstream failure; not retried, reviewer not switched)`);
    if (rec.error) r.push(`prompt_error:${label}:${rec.error}`);
    if (rec.stopReason !== "end_turn") r.push(`stop_reason:${label}:${rec.stopReason ?? "none"}`);
    if (rec.agentErrors.some(isFatal)) r.push(`agent_error:${label}`);
    if (authRequired) r.push("auth_required");
    return r;
  };

  const main = async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-gemini-home-"));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-agy-tmp-"));
    fs.symlinkSync(acpDir, path.join(home, "antigravity-acp"));
    out.isolation = { geminiHome: home, antigravityAcpLink: acpDir, cwd, clientCapabilities: CLIENT_CAPABILITIES, sessionMeta: { antigravity: { enabledTools: ENABLED_TOOLS } }, permissionPolicy: "reject_once", runtime: version };
    psBefore = psList().filter((p) => isAgy(p.cmd)).map((p) => p.pid);
    const env = buildEnv(process.env, { geminiHome: home, tmpDir, harness: path.join(runtimeDir, "localharness_external") });
    spawnedWall = Date.now();
    child = spawn(serverBin, [], { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    child.on("exit", (code, signal) => { exitInfo = { code, signal, atMs: ms(), wall: Date.now(), duringCleanup: cleaned }; failPending(`agent exited (${code ?? signal})`); resolveExited(); });
    child.on("error", (e) => { spawnFailed = e.message; reasons.push(`spawn_error:${e.message}`); failPending(`spawn failed: ${e.message}`); resolveExited(); resolveErrClosed(); });
    child.stdin.on("error", () => {});
    let buf = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) { const line = buf.slice(0, nl).replace(/\r$/, ""); buf = buf.slice(nl + 1); onStdoutLine(line); }
    });
    child.stderr.setEncoding("utf8").on("data", (s) => {
      errAll += s;
      // Markers are checked on the accumulated text, so a marker split across chunks is still seen.
      if (errAll.includes(BROWSER_MARKER) || errAll.includes(AUTH_PREFIX)) authRequired = true;
      errBuf += s;
      let nl;
      while ((nl = errBuf.indexOf("\n")) !== -1) { const line = errBuf.slice(0, nl); errBuf = errBuf.slice(nl + 1); onStderrLine(line); }
    });
    child.stderr.on("close", () => { if (errBuf) { onStderrLine(errBuf); errBuf = ""; } resolveErrClosed(); });

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
    let nextFinding = idStart;
    for (const [ti, turn] of turns.entries()) {
      const { dims, files, label } = turn;
      const last = ti === turns.length - 1;
      const mustCover = last ? priorIds.filter((x) => !priorSeen.has(x)) : [];
      const turnStart = nextFinding;
      const turnRule = `THIS TURN covers only these dimensions: ${dims.join(", ")}. Report only findings for them; coverage keys are exactly these.` +
        (files ? ` THIS TURN reviews only these scope files (other listed files may be read for context): ${files.join(", ")}.` : "") +
        ` New finding ids in this turn start at ${prefix}${turnStart} and continue in order.` +
        (priorIds.length ? (last ? ` THIS IS THE LAST TURN: prior_verification must cover every earlier id not reported in previous turns (${mustCover.join(", ") || "none left"}).` : " prior_verification may be [] in this turn if no earlier finding concerns these dimensions or files.") : "");
      const core = ctx.promptFor({ dimensions: dims, toolNote, includeDiff: false, idStart: turnStart });
      const blocks = ti === 0 ? [
        { type: "text", text: `${core}\n\n${turnRule}` },
        { type: "resource", resource: { uri: `file://${path.join(cwd, "__review__", "diff.patch")}`, mimeType: "text/x-diff", text: input.diffText } },
        { type: "text", text: `=== FILES YOU MAY READ (absolute paths) ===\n${fileList}` },
      ] : [{ type: "text", text: `Next turn. The brief, rules, diff and file list from the first turn still apply.\n${turnRule}\nRespond with ONLY one JSON object of the same shape, with coverage keys ${dims.join(", ")}.` }];
      const budget = Math.min(turnMs, remaining() - 30_000);
      if (budget < 60_000) { reasons.push(`total_timeout_before:${label}`); break; }
      const first = await runPrompt(blocks, label, budget);
      // A failed turn never contributes, even if its text happens to be schema-valid.
      const f1 = fatalReasons(first.rec, label);
      if (f1.length) { reasons.push(...f1); break; }
      let v = validateGroup(first.text, dims, mustCover, turnStart);
      first.rec.validation = v.errors;
      if (v.errors.length) {
        const rb = Math.min(retryMs, remaining() - 30_000);
        if (rb < 60_000) { reasons.push(`total_timeout_before_retry:${label}`); break; }
        const retry = await runPrompt([{ type: "text", text: `Your previous reply failed validation:\n- ${v.errors.join("\n- ")}\nReply again with ONLY the corrected JSON object for dimensions ${dims.join(", ")} (no prose, no code fences, no tool calls). Finding ids start at ${prefix}${turnStart}.` }], `${label}:retry`, rb);
        const f2 = fatalReasons(retry.rec, `${label}:retry`);
        if (f2.length) { reasons.push(...f2); break; }
        v = validateGroup(retry.text, dims, mustCover, turnStart);
        retry.rec.validation = v.errors;
        if (v.errors.length) { reasons.push(`schema_invalid_after_retry:${label}`); break; }
      }
      for (const p of v.value.prior_verification ?? []) priorSeen.add(p.id);
      nextFinding += v.value.findings.length;
      parts.push({ dims, files, value: v.value });
    }
    if (parts.length !== turns.length) return;
    // Merge: ids are already contiguous; coverage per dimension is "checked" if any chunk checked it.
    const findings = parts.flatMap((p) => p.value.findings).map((f, i) => ({ ...f, id: `${prefix}${idStart + i}` }));
    const coverage = {};
    for (const p of parts) for (const [k, x] of Object.entries(p.value.coverage)) if (coverage[k] === undefined || x === "checked") coverage[k] = x;
    const merged = { verdict: "pass", coverage, findings, limits: [...new Set(parts.flatMap((p) => p.value.limits))] };
    if (priorIds.length) merged.prior_verification = priorIds.map((id) => {
      const es = parts.flatMap((p) => (p.value.prior_verification ?? []).filter((x) => x.id === id));
      return { id, verified: es.length > 0 && es.every((e) => e.verified), note: es.map((e) => e.note).join(" | ") || "not reported" };
    });
    const sevBlock = findings.some((f) => f.sev === "critical" || f.sev === "high");
    merged.verdict = sevBlock ? "block" : findings.length || (merged.prior_verification ?? []).some((p) => !p.verified) ? "fix" : "pass";
    out.review = merged;
    out.groupVerdicts = parts.map((p) => ({ dims: p.dims, files: p.files, verdict: p.value.verdict }));
  };

  let cleaned = false;
  const finish = async () => {
    if (cleaned) return;
    cleaned = true;
    const pid = child?.pid;
    if (pid && !spawnFailed) {
      try { child.stdin.end(); } catch {}
      const signals = await stopGroup({
        pid, spawnedAt: spawnedWall, exitedAt: () => exitInfo?.wall ?? Date.now(),
        exited: () => exitInfo !== null, waitExit: (n) => Promise.race([childExited, sleep(n)]),
        members: groupMembers, kill: (p, s) => process.kill(p, s),
      });
      await Promise.race([errClosed, sleep(2000)]);
      // An unterminated last stderr line (e.g. RESOURCE_EXHAUSTED at exit) is flushed and checked here, before
      // the review can be accepted: any fatal agent error or upstream failure seen anywhere invalidates the run.
      if (errBuf) { onStderrLine(errBuf); errBuf = ""; }
      if (agentErrors.some(isFatal) && !reasons.some((r) => r.startsWith("agent_error:"))) reasons.push(`agent_error:stderr (${agentErrors.filter(isFatal).at(-1).slice(0, 120)})`);
      if (upstreamFailures > upstreamCounted && !reasons.some((r) => r.startsWith("upstream_502:"))) reasons.push("upstream_502:stderr after the last turn");
      // The server must exit cleanly after stdin closes; a non-zero code, or a signal we did not send, is a failure.
      const ourSignal = signals.some((x) => x.sig && !x.error);
      if (exitInfo && exitInfo.code !== null && exitInfo.code !== 0) reasons.push(`agent_exit_nonzero:${exitInfo.code}`);
      else if (exitInfo && exitInfo.signal && !ourSignal) reasons.push(`agent_exit_signal:${exitInfo.signal}`);
      // agy processes outside our group may belong to another session: reported, never signalled.
      const strays = psList().filter((p) => isAgy(p.cmd) && p.pgid !== pid && !psBefore.includes(p.pid)).map((p) => p.pid);
      if (strays.length) out.warnings.push(`agy processes outside this run's process group (not signalled): ${strays.join(",")}`);
      out.process = { exit: exitInfo, signals, straysOutsideGroup: strays.length };
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
    const callIds = [...new Set(toolItems.map((t) => t.id).filter((x) => x !== undefined))];
    const withPath = new Set(toolInputs.filter((t) => pathsOf(t).length).map((t) => t.id));
    // Titles from tool_call and tool_call_update: an update may introduce or change the tool.
    const badTitles = toolItems.filter((t) => (t.update === "tool_call" || t.title !== undefined) && !ALLOWED_TOOL_TITLE.test(String(t.title ?? ""))).map((t) => t.title ?? null);
    const outside = all.filter((p) => !insideRoot(cwd, p));
    out.toolAudit = { enabledTools: ENABLED_TOOLS, toolCallCount: callIds.length, pathsTouched: all.map((p) => String(p).slice(0, 500)), outsideSnapshot: outside.map((p) => String(p).slice(0, 500)), nonViewFileCalls: badTitles, callsWithoutAuditablePath: callIds.filter((id) => !withPath.has(id)), permissionRequests, clientRequests };
    if (outside.length) reasons.push(`tool_read_outside_snapshot:${outside.length}`);
    if (badTitles.length) reasons.push(`non_view_file_tool_calls:${badTitles.length}`);
    if (out.toolAudit.callsWithoutAuditablePath.length) reasons.push(`unauditable_tool_calls:${out.toolAudit.callsWithoutAuditablePath.length}`);
    if (clientRequests.length) reasons.push(`unexpected_client_requests:${clientRequests.length}`);
    if (permissionRequests.length) out.warnings.push(`permission requests rejected (reject_once): ${permissionRequests.length}`);
    // Per-turn model confirmation: every prompt turn must carry at least one matching proxy line.
    out.attempts.forEach((rec, i) => {
      const end = out.attempts[i + 1]?.proxyStart ?? proxyModels.length;
      rec.proxyModels = proxyModels.slice(rec.proxyStart, end);
      if (!rec.proxyModels.length) reasons.push(`proxy_model_unconfirmed:${rec.label}`);
    });
    if (!proxyModels.every((m) => m === expectedProxyModel)) reasons.push(`proxy_model_mismatch:${[...new Set(proxyModels)].join(",")}`);
    const keys = ["totalTokens", "inputTokens", "outputTokens", "thoughtTokens", "cachedReadTokens", "cachedWriteTokens"];
    out.usage = Object.fromEntries(keys.map((k) => [k, promptUsage.reduce((a, u) => a + (Number(u[k]) || 0), 0)]));
    out.authRequired = authRequired;
    if (authRequired && !reasons.includes("auth_required")) reasons.push("auth_required");
    // Isolated home: unlink the symlink itself (never recurse through it), then remove the rest.
    try {
      if (home) {
        const link = path.join(home, "antigravity-acp");
        if (out.isolation) out.isolation.configDirCreatedByServer = fs.existsSync(path.join(home, "config"));
        try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link); } catch {}
        for (const e of fs.readdirSync(home)) fs.rmSync(path.join(home, e), { recursive: true, force: true });
        fs.rmdirSync(home);
      }
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      if (out.isolation) out.isolation.profileAcpDirIntact = fs.existsSync(acpDir);
    } catch (e) { out.warnings.push(`isolation cleanup: ${e.message}`); }
    log("messages.jsonl", msgLines.join("\n") + "\n");
    log("stderr.log", redact(errAll));
  };

  const hard = setTimeout(() => { reasons.push("hard_timeout"); failPending("hard_timeout"); }, pin.timeoutMs + 120_000);
  try { await main(); } catch (e) { reasons.push(`fatal:${String(e?.message ?? e)}`); }
  finally {
    clearTimeout(hard);
    await finish();
  }
  out.limits = [
    "Antigravity does not report the model per response; the pin is checked from set_config_option and the local proxy's stderr line on every turn, which may change between runtime versions.",
    "Session persistence cannot be disabled; session files are deleted after the run when their .meta cwd matches.",
  ];
  return out;
}
