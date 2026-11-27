// Antigravity reviewer adapter: the runner is the ACP client of the T3-managed Antigravity runtime.
// Two runtime layouts are supported (findRuntime):
//  - "cli" (T3 runtime 1.5+): versions/<releaseId>/.install-complete.json names the executable (`antigravity`);
//    it is started as `antigravity acp --gemini-dir <isolated home> --app-data-dir antigravity-acp --log-file <tmp>
//    --disable-telemetry`. No local proxy; sign-in comes from the OS keyring (or the profile dir) as in T3.
//  - "par" (runtime <= 1.4): versions/<version>/agy_acp_server.par with the Python proxy.
// Ported from the proven view_file runner (ag-review-vf.ts, cycles r5-r8). Rules it enforces:
//  - Isolated GEMINI_HOME holding only an `antigravity-acp` symlink to the T3 profile (no config/, so no global
//    MCP config is merged). Token files are never opened. mcpServers: [].
//  - Client capabilities fs/terminal false; every session/request_permission -> reject_once (never allow_*, never
//    reject_always); any other client request -> -32601 and the run is incomplete. The cli session must start in
//    mode "default" (ask before edits and commands).
//  - cwd = the read-only snapshot. "par": session _meta.antigravity.enabledTools = ["view_file"]. "cli": 1.5 ignores
//    enabledTools, so the allowlist is enforced by the audit only: read_file/view_file (paths audited) and
//    update_steps (no path); any other tool -> incomplete. Every tool call's locations[].path and rawInput/args path
//    fields must resolve inside the snapshot; otherwise incomplete. A `open`/`xdg-open` shim on PATH turns a
//    browser launch (sign-in) into auth_required instead of opening a URL.
//  - Model pin: set_config_option model + thinking level, verified from the response and, per turn, from
//    "par": the stderr "Proxy extracted model from path: <model>-<thinking>" line;
//    "cli": the session database's gen_metadata rows (lib/agy-session-db.mjs), each of which must name the pinned
//    model and thinking level. A turn without a confirming record, or an unreadable database -> incomplete.
//  - Turns (lib/turns.mjs layoutConfig): "cli" (1.5) has no first-byte wall (measured 2026-11-27: longest silent
//    gap 20 s, a 495 s turn succeeded), so it runs ONE turn for every dimension and splits only a scope above
//    max_files_per_turn / max_bytes_per_turn (32 files / 400 KB). "par": the local proxy aborts a model call whose
//    first byte takes > 300 s (HTTP 502), so par_layout keeps one turn per dimension group and 8-file / 120 KB
//    chunks. CLI prompts and retries use independent native sessions; par shares one session. The first upstream failure cancels the run.
//  - Every turn (first and retry) is checked for timeout, upstream failure, RPC error, non-end_turn stop reason,
//    fatal agent errors and auth prompts before its text is used; any of them withholds the review.
//  - Per-turn schema validation with contiguous ids across turns and at most one corrective re-ask.
//  - Process-group cleanup signals the group only while it is provably ours; session files removed only when
//    the .meta cwd ("par") or every workspace URI in the session database ("cli", no .meta) equals this run's cwd.
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expandHome } from "../lib/policy.mjs";
import { insideRoot, redact, sha256 } from "../lib/inputs.mjs";
import { bypassFlags, groupMembers, ownedMembers } from "../lib/proc.mjs";
import { TURN_DEFAULTS, groupsFor, layoutConfig, planTurns, runTurns, totalBudget } from "../lib/turns.mjs";
import { countGenerations, sessionGenerations } from "../lib/agy-session-db.mjs";

export { groupsFor, layoutConfig, planTurns, totalBudget }; // re-exported for callers/tests of the adapter

export const ENABLED_TOOLS = ["view_file"];
export const CLIENT_CAPABILITIES = { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { notices: {} } };
const ALLOWED_TOOL_TITLE = /^(Running |Ran )?view_file\b/;
/** "cli" tool names (ACP `name`): read tools whose paths are audited, and bookkeeping tools without a path. */
export const READ_TOOLS = new Set(["read_file", "view_file"]);
export const NO_PATH_TOOLS = new Set(["update_steps"]);
const INSTALL_RECORD = ".install-complete.json";
const PAR_NAMES = new Set(["agy_acp_server.par", "agy_acp_server.exe"]);
const SESSION_SUFFIXES = [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const REMOVED_ENV = new Set([
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION", "GOOGLE_CLOUD_QUOTA_PROJECT", "GOOGLE_GENAI_USE_VERTEXAI", "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT", "AGY_ACP_CCPA_PROJECT", "AGY_ACP_ENABLE_OAUTH", "GEMINI_HOME",
  "AGY_ACP_FORCE_FILE_STORAGE", "ANTIGRAVITY_HARNESS_PATH", "BROWSER", "PYTHONUNBUFFERED", "ELECTRON_RUN_AS_NODE",
  "AGY_CLI_DISABLE_AUTO_UPDATE", "CHROME_CRASHPAD_PIPE_NAME",
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

export function buildEnv(base, { geminiHome, tmpDir, harness, layout = "par", shimDir = null }) {
  const q = (s) => `'${s.replaceAll("'", `'"'"'`)}'`;
  const helper = `process.stderr.on("error",()=>process.exit(0)).write("${BROWSER_MARKER}"+"\\n",()=>process.exit(0))`;
  const env = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !REMOVED_ENV.has(k.toUpperCase())) env[k] = v;
  Object.assign(env, {
    GEMINI_HOME: geminiHome,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    BROWSER: [process.execPath, "-e", helper, "--", "%s"].map(q).join(" "), // an auth URL is never opened or logged
    PYTHONUNBUFFERED: "1",
    ELECTRON_RUN_AS_NODE: "1",
    TMPDIR: tmpDir,
  });
  if (layout === "par") env.ANTIGRAVITY_HARNESS_PATH = harness;
  else {
    env.AGY_CLI_DISABLE_AUTO_UPDATE = "1";
    // The 1.5 CLI ignores BROWSER: `open`/`xdg-open` on PATH are shims that only record the attempt (no URL).
    if (shimDir) { const pk = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH"; env[pk] = env[pk] ? `${shimDir}${path.delimiter}${env[pk]}` : shimDir; }
  }
  return env;
}

/** argv for the runtime: "par" takes none; "cli" runs the ACP stdio server against the isolated home. */
export function launchArgs(layout, { geminiHome, logFile }) {
  if (layout === "par") return [];
  // --app-data-dir is joined beneath --gemini-dir by the CLI (T3 passes the same pair).
  return ["acp", "--gemini-dir", geminiHome, "--app-data-dir", "antigravity-acp", "--log-file", logFile, "--disable-telemetry"];
}

/** Browser shims: write a marker file and fail, so a sign-in attempt can never open a URL. */
export function writeBrowserShims(shimDir, markerFile) {
  fs.mkdirSync(shimDir, { recursive: true, mode: 0o700 });
  const q = (s) => `'${s.replaceAll("'", `'"'"'`)}'`;
  for (const name of ["open", "xdg-open"]) {
    fs.writeFileSync(path.join(shimDir, name), `#!/bin/sh\n: > ${q(markerFile)}\nexit 1\n`, { mode: 0o700 });
  }
}

/** Use the executable and login profile from the same T3 installation. */
export function installationRoots(settings, home = os.homedir()) {
  const runtime = path.join("tools", "antigravity-acp", `${process.platform}-${process.arch}`, "versions");
  const profiles = path.join("userdata", "providers", "antigravity");
  let installation = path.join(home, ".t3");
  if (!settings.runtime_root && !settings.profile_root && !settings.profile &&
      !findRuntime(path.join(installation, runtime)).version) {
    const custom = path.join(home, ".t3-custom");
    if (findRuntime(path.join(custom, runtime)).version) installation = custom;
  }
  return {
    runtime: settings.runtime_root ?? path.join(installation, runtime),
    profiles: settings.profile_root ?? path.join(installation, profiles),
  };
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
      .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: +m[1], pgid: +m[2], cmd: m[3].slice(0, 1000) }));
  } catch { return []; }
}
/** An Antigravity runtime process: the 1.4 server/harness, a 1.5 `antigravity acp`, or this run's executable. */
export const isAgy = (cmd, executable = null) => /agy_acp_server|localharness_external/.test(cmd)
  || /(^|\/)antigravity(\.exe)?\s+acp(\s|$)/.test(cmd) || (!!executable && (cmd === executable || cmd.startsWith(`${executable} `)));

/**
 * One version directory -> { version, dir, executable, layout } or null.
 * The version directory must be a real directory (not a symlink) directly under the root.
 * "cli": a regular (non-symlink) `.install-complete.json` gives a numeric version and a plain executable file name;
 * the executable must be a regular, non-symlink, executable file whose size equals the record's positive integer
 * `executable.bytes` (a missing or malformed size rejects the record). A record naming agy_acp_server.par is the
 * "par" layout. Without a record, a directory with a numeric version name holding a regular executable
 * agy_acp_server.par is "par" (pre-record installs).
 */
const VERSION_RE = /^\d+(\.\d+)*([.+_-][0-9A-Za-z]+)*$/;
export function runtimeEntry(root, name) {
  const dir = path.join(root, name);
  const lst = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
  if (!lst(dir)?.isDirectory()) return null;
  const rec = path.join(dir, INSTALL_RECORD);
  const exeOk = (exe, bytes) => {
    const st = lst(exe);
    if (!st?.isFile() || (bytes !== undefined && st.size !== bytes)) return false;
    try { fs.accessSync(exe, fs.constants.X_OK); return true; } catch { return false; }
  };
  const recSt = lst(rec);
  if (recSt) {
    if (!recSt.isFile()) return null;
    let j;
    try { j = JSON.parse(fs.readFileSync(rec, "utf8")); } catch { return null; }
    const exeName = j?.executable?.name, bytes = j?.executable?.bytes;
    if (typeof j?.version !== "string" || !VERSION_RE.test(j.version)) return null;
    if (typeof exeName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(exeName)) return null;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) return null;
    const executable = path.join(dir, exeName);
    if (!exeOk(executable, bytes)) return null;
    return { version: j.version, dir, executable, layout: PAR_NAMES.has(exeName) ? "par" : "cli" };
  }
  const par = path.join(dir, "agy_acp_server.par");
  return VERSION_RE.test(name) && exeOk(par) ? { version: name, dir, executable: par, layout: "par" } : null;
}

/** Runtime: `{platform}-{arch}` placeholders expanded; the highest version of either layout (runtimeEntry). */
export function findRuntime(runtimeRootSetting) {
  const root = expandHome(String(runtimeRootSetting ?? "~/.t3/tools/antigravity-acp/{platform}-{arch}/versions").replaceAll("{platform}", process.platform).replaceAll("{arch}", process.arch));
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) return { root, version: null };
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
  const entries = fs.readdirSync(root).map((d) => runtimeEntry(root, d)).filter(Boolean).sort((a, b) => cmp(a.version, b.version));
  const best = entries.at(-1) ?? null;
  return { root, version: best?.version ?? null, dir: best?.dir ?? null, executable: best?.executable ?? null, layout: best?.layout ?? null, candidates: entries.map((e) => `${e.version} (${e.layout})`) };
}

/**
 * How the server's exit is classified (X12). A signal counts as ours only when the server exited after cleanup
 * started and that very signal was sent by us to its process group while it was alive; any other signal
 * (a crash before cleanup, or a different signal during it) is agent_exit_signal. -> reason | null.
 */
export function exitReason({ exitInfo, cleanupStartedWall, signals, pid }) {
  if (!exitInfo) return null;
  if (exitInfo.code !== null && exitInfo.code !== undefined && exitInfo.code !== 0) return `agent_exit_nonzero:${exitInfo.code}`;
  if (!exitInfo.signal) return null;
  const afterCleanup = Number.isFinite(cleanupStartedWall) && exitInfo.wall >= cleanupStartedWall;
  const sentByUs = (signals ?? []).some((x) => x.target === -pid && x.sig === exitInfo.signal && !x.error);
  return afterCleanup && sentByUs ? null : `agent_exit_signal:${exitInfo.signal}${afterCleanup ? "" : " (before cleanup: crash)"}`;
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
  const rt = pin.config.runtime ?? {};
  const out = { attempts: [], reasons: [], warnings: [], toolAudit: null, reported: { model: null, effort: null, source: null, proxyModels: [], generationModels: [] } };
  const reasons = out.reasons;
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  const thinking = pin.effort;
  const expectedProxyModel = `${pin.model}-${thinking}`;
  const scopeFiles = input.files.filter((f) => f.kind === "scope");

  // ---- runtime + profile (directory names only; files inside are never opened, except a session's .meta/.db)
  const roots = installationRoots(rt);
  const runtime = findRuntime(roots.runtime);
  const { root: runtimeRoot, version, layout } = runtime;
  if (!version) { reasons.push(`runtime_not_found:${runtimeRoot}`); return out; }
  // Turn split and timings for this runtime layout: one turn on 1.5 "cli", the old per-group split on <= 1.4 "par"
  // (300 s proxy first-byte wall). plan() estimates with the same helpers (A63).
  const cfg = layoutConfig(pin.config, layout);
  // A small re-review may use one group (rereview_single_group) when the layout has groups.
  const { groups, turns } = runTurns(cfg, dimensions, scopeFiles, { rereview: priorIds.length > 0, diffBytes: Buffer.byteLength(input.diffText ?? "") });
  out.groups = groups;
  out.turns = turns.map((t) => t.label);
  // The total budget scales with the planned turns (per_turn_budget_sec x turns, capped by max_total_sec).
  const budget = totalBudget(cfg, turns.length, pin.timeoutMs);
  out.timeoutMs = budget.totalMs;
  out.budget = { turns: turns.length, layout, ...budget };
  if (budget.capped) out.warnings.push(`time budget capped: ${turns.length} turns x ${budget.perTurnSec} s > max_total_sec ${budget.capSec} s`);
  const runtimeDir = runtime.dir;
  const serverBin = runtime.executable;
  const cli = layout === "cli";
  out.runtime = { layout, version, dir: runtimeDir, executable: serverBin, candidates: runtime.candidates };
  out.reported.source = cli
    ? "set_config_option currentValue; session database gen_metadata model on every turn"
    : "set_config_option currentValue; stderr proxy model on every turn";
  let profile;
  try { profile = rt.profile ? expandHome(rt.profile) : findProfile(expandHome(roots.profiles)); }
  catch (e) { reasons.push(`profile_not_found:${e.message}`); return out; }
  const acpDir = path.join(profile, "antigravity-acp");
  if (!fs.existsSync(acpDir) || !fs.statSync(acpDir).isDirectory()) { reasons.push("profile_acp_dir_missing"); return out; }

  const cwd = input.snapshot;
  const sessions = new Set();
  const deadline = t0 + budget.totalMs;
  const remaining = () => deadline - Date.now();
  let home = null, tmpDir = null, child = null, exitInfo = null, spawnFailed = null, sessionId, spawnedWall = 0;
  let authRequired = false, nextId = 1, collecting = null, upstreamFailures = 0, upstreamInTurns = 0, cleanupStartedWall = null;
  let logFile = null, browserMarker = null, logOffset = 0, logBuf = "", logAll = "";
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
    timeoutMs = Math.min(timeoutMs, remaining());
    if (timeoutMs <= 0) return reject(new Error("review budget expired"));
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
    const sid = m.params?.sessionId;
    const isTool = u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update";
    if (cli && (isTool || (collecting && u.sessionUpdate === "agent_message_chunk")) && sid !== sessionId) {
      reasons.push("session_update_id_mismatch");
      return;
    }
    // ACP tool call IDs are scoped to a session and may repeat in the next session.
    const toolId = cli && u.toolCallId !== undefined ? JSON.stringify([sid, u.toolCallId]) : u.toolCallId;
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text" && collecting) collecting.push(u.content.text);
    if (isTool) {
      toolItems.push({ update: u.sessionUpdate, id: toolId, name: u.name, title: u.title, kind: u.kind, status: u.status });
      // Full values are audited; only the messages log is size-limited. 1.5 sends `args`, 1.4 `rawInput`.
      if (u.rawInput || u.args || u.locations) toolInputs.push({ id: toolId,
        rawInput: u.rawInput && typeof u.rawInput === "object" ? u.rawInput : undefined,
        args: u.args && typeof u.args === "object" ? u.args : undefined,
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
  // "cli": the runtime logs to --log-file instead of stderr; new lines are fed to the same checks.
  const pollLog = () => {
    if (!logFile) return;
    let chunk = "";
    try {
      const fd = fs.openSync(logFile, "r");
      try {
        const size = fs.fstatSync(fd).size;
        if (size > logOffset) { const b = Buffer.alloc(size - logOffset); fs.readSync(fd, b, 0, b.length, logOffset); logOffset = size; chunk = b.toString("utf8"); }
      } finally { fs.closeSync(fd); }
    } catch { return; }
    if (!chunk) return;
    logAll += chunk;
    logBuf += chunk;
    let nl;
    while ((nl = logBuf.indexOf("\n")) !== -1) { const line = logBuf.slice(0, nl); logBuf = logBuf.slice(nl + 1); onStderrLine(line); }
  };
  const sessionDb = (id) => path.join(acpDir, "conversations", id + ".db");

  // Generation rows have no prompt identifier. On 1.5 every actual prompt, including a
  // corrective retry, must be the only prompt ever sent in its native session.
  const newSession = async () => {
    const ns = await request("session/new", sessionNewParams(cwd));
    const id = ns.sessionId;
    if (cli && (typeof id !== "string" || !UUID_V4.test(id) || id !== id.toLowerCase() || sessions.has(id))) {
      throw new Error("session id missing, invalid or reused");
    }
    if (cli && fs.existsSync(sessionDb(id)) && await countGenerations(sessionDb(id)) !== 0) {
      throw new Error("session already contains generation records");
    }
    sessionId = id;
    sessions.add(id);
    out.sessionId = id;
    out.sessionMode = ns.modes?.currentModeId ?? null;
    if (cli && out.sessionMode !== "default") throw new Error(`session_mode_not_default:${out.sessionMode}`);
    const r1 = await request("session/set_config_option", { sessionId, configId: "model", value: pin.model });
    const opts = r1?.configOptions ?? ns.configOptions ?? [];
    const thinkingOpt = opts.find((o) => o.category === "thought_level");
    if (!thinkingOpt) throw new Error("no_thought_level_option");
    const r2 = await request("session/set_config_option", { sessionId, configId: thinkingOpt.id, value: thinking });
    const applied = r2?.configOptions ?? opts;
    out.reported.model = applied.find((o) => o.id === "model")?.currentValue ?? null;
    out.reported.effort = applied.find((o) => o.id === thinkingOpt.id)?.currentValue ?? null;
    if (out.reported.model !== pin.model || out.reported.effort !== thinking) throw new Error("model_pin_not_applied");
  };

  const runPrompt = async (blocks, label, timeoutMs) => {
    if (cli || !sessions.size) await newSession();
    collecting = [];
    const started = ms();
    const failBefore = upstreamFailures;
    const errBefore = agentErrors.length;
    const proxyStart = proxyModels.length;
    let timedOut = false, upstream = false;
    const watchdog = setInterval(() => {
      pollLog();
      if (timedOut || upstream) return;
      if (ms() - started > timeoutMs) { timedOut = true; send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }); }
      else if (upstreamFailures > failBefore) { upstream = true; send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }); }
    }, 1000);
    let resp, err;
    try { resp = await request("session/prompt", { sessionId, prompt: blocks }, timeoutMs + 60_000); } catch (e) { err = e; }
    clearInterval(watchdog);
    pollLog();
    if (!upstream && upstreamFailures > failBefore) upstream = true;
    upstreamInTurns += upstreamFailures - failBefore; // A55: failures outside any turn are caught at cleanup
    const text = collecting.join("");
    collecting = null;
    if (resp?.usage) promptUsage.push({ label, ...resp.usage });
    const rec = { label, durationMs: ms() - started, timedOut, upstreamFailure: upstream, stopReason: resp?.stopReason ?? null, error: err ? String(err.message ?? err) : null, agentErrors: agentErrors.slice(errBefore), outputChars: text.length, promptSha256: sha256(JSON.stringify(blocks)), proxyStart };
    if (cli) rec.sessionId = sessionId;
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
    let shimDir = null;
    if (cli) {
      logFile = path.join(tmpDir, "agy-server.log");
      browserMarker = path.join(tmpDir, "browser-open-attempted");
      shimDir = path.join(tmpDir, "browser-shim");
      writeBrowserShims(shimDir, browserMarker);
    }
    const args = launchArgs(layout, { geminiHome: home, logFile });
    out.argv = [serverBin, ...args];
    // Same guard the other adapters run before spawning (run.mjs re-checks the reported argv afterwards).
    const bypass = bypassFlags(args);
    if (bypass.length) { reasons.push(`bypass_flags_in_argv:${bypass.join(",")} (refused before spawn)`); return; }
    out.isolation = { geminiHome: home, antigravityAcpLink: acpDir, cwd, clientCapabilities: CLIENT_CAPABILITIES, sessionMeta: { antigravity: { enabledTools: ENABLED_TOOLS } }, enabledToolsEnforcedBy: cli ? "audit only (1.5 ignores enabledTools)" : "runtime + audit", permissionPolicy: "reject_once", runtime: version, layout, browserShim: shimDir };
    psBefore = psList().filter((p) => isAgy(p.cmd, serverBin)).map((p) => p.pid);
    const env = buildEnv(process.env, { geminiHome: home, tmpDir, harness: path.join(runtimeDir, "localharness_external"), layout, shimDir });
    spawnedWall = Date.now();
    child = spawn(serverBin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    child.on("exit", (code, signal) => { exitInfo = { code, signal, atMs: ms(), wall: Date.now(), duringCleanup: cleanupStartedWall !== null }; failPending(`agent exited (${code ?? signal})`); resolveExited(); });
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
    catch (e) {
      // 1.5 answers a missing sign-in with -32000 or "No browser is available here..." (T3 antigravityAuthSupport).
      const signIn = /AUTH_REQUIRED|No browser is available|not logged in/i.test(e.message ?? "");
      reasons.push(authRequired || signIn ? "auth_required" : `authenticate_failed:${e.message}`); return;
    }
    const turnMs = (cfg.turn_timeout_sec ?? TURN_DEFAULTS.turn_timeout_sec) * 1000;
    const retryMs = cli ? turnMs : (cfg.retry_timeout_sec ?? TURN_DEFAULTS.retry_timeout_sec) * 1000;
    const fileList = input.files.map((f) => `${path.join(cwd, f.path)}  (${f.lines} lines${f.kind === "context" ? ", context only" : ""})`).join("\n");
    const tool = cli ? "read_file" : "view_file";
    const toolNote = cli
      ? `Use ONLY the ${tool} tool. Read files with ${tool} using the absolute paths listed below (snapshot root ${cwd}); read only those files, in several small steps. Any other tool (commands, edits, web search, subagents, questions) invalidates the review. No shell, no web, no writes.`
      : `You have exactly ONE tool: view_file. Read files with view_file using the absolute paths listed below (snapshot root ${cwd}); read only those files, in several small steps. No shell, no web, no writes.`;
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
      const blocks = cli || ti === 0 ? [
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
        const correction = { type: "text", text: `Your previous reply failed validation:\n- ${v.errors.join("\n- ")}\nReply again with ONLY the corrected JSON object for dimensions ${dims.join(", ")} (no prose, no code fences, no tool calls). Finding ids start at ${prefix}${turnStart}.` };
        const retryBlocks = cli ? [...blocks, { type: "text", text: `Repeat the review from the supplied evidence. Correct these validation errors from the earlier attempt:\n${v.errors.join("\n")}` }] : [correction];
        const retry = await runPrompt(retryBlocks, `${label}:retry`, rb);
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
    // An incomplete run keeps the merged accepted turns as its draft (reviewIfIncomplete), never as the review.
    if (parts.length !== turns.length) {
      if (!reasons.length) reasons.push(`turns_incomplete:${parts.length}/${turns.length}`);
      if (!parts.length) return;
    }
    // Merge: ids are already contiguous; coverage per dimension is "checked" if any chunk checked it.
    const findings = parts.flatMap((p) => p.value.findings).map((f, i) => ({ ...f, id: `${prefix}${idStart + i}` }));
    const coverage = {};
    for (const p of parts) for (const [k, x] of Object.entries(p.value.coverage)) if (coverage[k] === undefined || x === "checked") coverage[k] = x;
    for (const d of dimensions) if (coverage[d] === undefined) coverage[d] = "n/a:not reviewed (run incomplete before this turn)";
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

  // Inspect each native session after the producer exits, including records written
  // during a later attempt. Ownership is required for both using and removing its data.
  const confirmAndCleanSession = async (sessionId) => {
    const sc = { sessionId: sessionId ?? null, removed: [], skipped: null };
    const attempt = out.attempts.find((rec) => rec.sessionId === sessionId);
    try {
      if (!sessionId || !UUID_V4.test(sessionId)) sc.skipped = "no native session id";
      else {
        const base = path.join(acpDir, "conversations", sessionId);
        const brain = path.join(acpDir, "brain", sessionId);
        const annotation = path.join(acpDir, "annotations", `${sessionId}.pbtxt`);
        if (!cli && fs.existsSync(`${base}.meta`)) {
          let metaCwd;
          try { metaCwd = JSON.parse(fs.readFileSync(`${base}.meta`, "utf8"))?.cwd; } catch (e) { sc.skipped = `.meta unreadable: ${e.message}`; }
          if (!sc.skipped && metaCwd !== cwd) sc.skipped = ".meta cwd differs from runner cwd";
          if (!sc.skipped) sc.ownedBy = ".meta cwd";
        } else if (!cli) sc.skipped = ".meta missing";
        else if (!fs.existsSync(`${base}.db`)) sc.skipped = ".meta and session database missing";
        else {
          try {
            const rows = await sessionGenerations(sessionDb(sessionId), sessionId, cwd);
            sc.ownedBy = "session database workspace";
            if (attempt) {
              const show = g => `${g.model ?? "?"}/${g.normalized ?? "?"}`;
              attempt.generationModels = rows.map(show);
              out.reported.generationModels = out.reported.generationModels.concat(attempt.generationModels);
              const bad = rows.filter(g => g.model !== pin.model || g.normalized !== expectedProxyModel);
              if (bad.length) reasons.push(`generation_model_mismatch:${[...new Set(bad.map(show))].join(",")}`);
            }
          } catch (e) { sc.skipped = e.message; }
        }
        if (!sc.skipped) {
          for (const s of SESSION_SUFFIXES) if (fs.existsSync(base + s)) { fs.rmSync(base + s, { force: true }); sc.removed.push(sessionId + s); }
          if (fs.existsSync(brain)) { fs.rmSync(brain, { recursive: true, force: true }); sc.removed.push(`brain/${sessionId}/`); }
          if (fs.existsSync(annotation)) { fs.rmSync(annotation, { force: true }); sc.removed.push(`annotations/${sessionId}.pbtxt`); }
        }
      }
    } catch (e) { sc.error = e.message; }
    if (cli && attempt && !attempt.generationModels?.length) {
      attempt.generationModels = [];
      reasons.push(`model_unconfirmed:${attempt.label}${sc.skipped ? " (" + sc.skipped + ")" : ""}`);
    }
    if (sc.skipped && sessionId) out.warnings.push(`session files not removed: ${sc.skipped}`);
    return sc;
  };

  let cleaned = false;
  const finish = async () => {
    if (cleaned) return;
    cleaned = true;
    cleanupStartedWall = Date.now();
    const pid = child?.pid;
    if (pid && !spawnFailed) {
      // The runtime may flush asynchronously after end_turn. Wait once for each
      // attempt to have evidence, then read every row after process shutdown.
      if (cli && !reasons.length) {
        const until = Math.min(deadline, Date.now() + 10_000);
        const missing = new Set(out.attempts.map(rec => rec.sessionId));
        while (missing.size && !exitInfo && Date.now() < until) {
          for (const id of missing) {
            try { if (await countGenerations(sessionDb(id)) > 0) missing.delete(id); } catch { /* not flushed yet */ }
          }
          if (missing.size) await sleep(200);
        }
      }
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
      pollLog();
      if (logBuf) { onStderrLine(logBuf); logBuf = ""; }
      if (agentErrors.some(isFatal) && !reasons.some((r) => r.startsWith("agent_error:"))) reasons.push(`agent_error:stderr (${agentErrors.filter(isFatal).at(-1).slice(0, 120)})`);
      if (upstreamFailures > upstreamInTurns && !reasons.some((r) => r.startsWith("upstream_502:"))) reasons.push(`upstream_502:stderr outside a turn (${upstreamFailures - upstreamInTurns})`);
      // The server must exit cleanly after stdin closes; a non-zero code, or a signal we did not send, is a failure.
      const er = exitReason({ exitInfo, cleanupStartedWall, signals, pid });
      if (er) reasons.push(er);
      // agy processes outside our group may belong to another session: reported, never signalled.
      const strays = psList().filter((p) => isAgy(p.cmd, serverBin) && p.pgid !== pid && !psBefore.includes(p.pid)).map((p) => p.pid);
      if (strays.length) out.warnings.push(`agy processes outside this run's process group (not signalled): ${strays.join(",")}`);
      out.process = { exit: exitInfo, signals, straysOutsideGroup: strays.length };
    }
    if (browserMarker && fs.existsSync(browserMarker)) authRequired = true; // a sign-in tried to open a browser
    out.sessionCleanups = [];
    for (const id of sessions) out.sessionCleanups.push(await confirmAndCleanSession(id));
    out.sessionCleanup = out.sessionCleanups[0] ?? { sessionId: null, removed: [], skipped: "no native session id" };
    // Tool/path audit (snapshot still exists; the runner removes it after this adapter returns).
    const pathFields = (o) => Object.entries(o ?? {}).filter(([k, x]) => typeof x === "string" && /path|file|uri|dir/i.test(k)).map(([, x]) => x);
    const pathsOf = (t) => [...(t.locations ?? []), ...pathFields(t.rawInput), ...pathFields(t.args)].filter(Boolean);
    const all = [...new Set(toolInputs.flatMap(pathsOf))];
    const callIds = [...new Set(toolItems.map((t) => t.id).filter((x) => x !== undefined))];
    const withPath = new Set(toolInputs.filter((t) => pathsOf(t).length).map((t) => t.id));
    // An item is allowed by its ACP `name` (1.5) when it has one, otherwise by its title (1.4 view_file). Names and
    // titles from tool_call and tool_call_update are both checked: an update may introduce or change the tool.
    // An update without a name keeps the name its call established (1.5 updates may change only the title), but
    // only when the call's first item carried that name; a call that started nameless is judged item by item.
    const firstName = new Map(), seenId = new Set();
    for (const t of toolItems) {
      if (t.id === undefined || seenId.has(t.id)) continue;
      seenId.add(t.id);
      if (t.name !== undefined) firstName.set(t.id, t.name);
    }
    const nameOf = (t) => t.name ?? (t.id !== undefined ? firstName.get(t.id) : undefined);
    const allowedItem = (t) => { const n = nameOf(t); return n !== undefined ? READ_TOOLS.has(n) || NO_PATH_TOOLS.has(n) : ALLOWED_TOOL_TITLE.test(String(t.title ?? "")); };
    const badTitles = toolItems.filter((t) => (t.update === "tool_call" || t.title !== undefined || t.name !== undefined) && !allowedItem(t)).map((t) => t.name ?? t.title ?? null);
    // Bookkeeping tools carry no path; a call is exempt only when every one of its items is a bookkeeping tool by name.
    const noPathIds = new Set(callIds.filter((id) => { const its = toolItems.filter((t) => t.id === id); return its.every((t) => NO_PATH_TOOLS.has(nameOf(t))); }));
    // A tool call without a toolCallId cannot be matched to its inputs: never auditable.
    const idless = toolItems.filter((t) => t.id === undefined).length;
    const outside = all.filter((p) => !insideRoot(cwd, p));
    out.toolAudit = { enabledTools: ENABLED_TOOLS, toolCallCount: callIds.length, pathsTouched: all.map((p) => String(p).slice(0, 500)), outsideSnapshot: outside.map((p) => String(p).slice(0, 500)), nonViewFileCalls: badTitles, callsWithoutAuditablePath: callIds.filter((id) => !withPath.has(id) && !noPathIds.has(id)), permissionRequests, clientRequests };
    if (outside.length) reasons.push(`tool_read_outside_snapshot:${outside.length}`);
    if (badTitles.length) reasons.push(`non_view_file_tool_calls:${badTitles.length}`);
    if (out.toolAudit.callsWithoutAuditablePath.length) reasons.push(`unauditable_tool_calls:${out.toolAudit.callsWithoutAuditablePath.length}`);
    out.toolAudit.itemsWithoutCallId = idless;
    if (idless) reasons.push(`tool_calls_without_id:${idless}`);
    if (clientRequests.length) reasons.push(`unexpected_client_requests:${clientRequests.length}`);
    if (permissionRequests.length) out.warnings.push(`permission requests rejected (reject_once): ${permissionRequests.length}`);
    if (!cli) {
      // Per-turn model confirmation: every prompt turn must carry at least one matching proxy line.
      out.attempts.forEach((rec, i) => {
        const end = out.attempts[i + 1]?.proxyStart ?? proxyModels.length;
        rec.proxyModels = proxyModels.slice(rec.proxyStart, end);
        if (!rec.proxyModels.length) reasons.push(`proxy_model_unconfirmed:${rec.label}`);
      });
      if (!proxyModels.every((m) => m === expectedProxyModel)) reasons.push(`proxy_model_mismatch:${[...new Set(proxyModels)].join(",")}`);
    }
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
    // Account e-mail addresses are dropped from the saved runtime log as well.
    if (cli) log("server.log", redact(logAll).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"));
  };

  const hard = setTimeout(() => { reasons.push("hard_timeout"); failPending("hard_timeout"); }, budget.totalMs + 120_000);
  try { await main(); } catch (e) { reasons.push(`fatal:${String(e?.message ?? e)}`); }
  finally {
    clearTimeout(hard);
    await finish();
  }
  out.limits = cli ? [
    "Antigravity does not report the model per response; the pin is checked from set_config_option and from the session database's per-generation model records (gen_metadata), whose layout may change between runtime versions.",
    "Runtime 1.5 ignores the enabledTools allowlist: the tool restriction is enforced after the fact by the audit (any non-read tool makes the run incomplete) and, for edits and commands, by rejecting every permission request.",
    "Every prompt has its own native session. Session files are removed after the run when the database confirms both its session ID and snapshot workspace.",
  ] : [
    "Antigravity does not report the model per response; the pin is checked from set_config_option and the local proxy's stderr line on every turn, which may change between runtime versions.",
    "Session persistence cannot be disabled; session files are deleted after the run when their .meta cwd matches.",
  ];
  return out;
}
