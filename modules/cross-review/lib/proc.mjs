// Child process helper: own process group, stdin prompt, hard timeout, SIGTERM -> SIGKILL group cleanup,
// bypass-flag refusal before spawn, minimal environment.
import { execFileSync, spawn as nodeSpawn } from "node:child_process";

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------- environment
/** Variables every reviewer child gets (when set). Everything else needs hosts.<host>.env_passthrough. */
export const BASE_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "TZ", "TMPDIR"];
export function scrubEnv(base, passthrough = []) {
  const env = {};
  for (const [k, v] of Object.entries(base ?? {})) {
    if (v === undefined) continue;
    if (BASE_ENV.includes(k) || /^LC_[A-Z_]+$/.test(k) || passthrough.includes(k)) env[k] = v;
  }
  return env;
}

// ---------------------------------------------------------------- process groups
/**
 * Live members of process group `pgid` with their start time: [{ pid, startMs }] (POSIX `ps -eo pid,pgid,lstart`,
 * C locale, one-second resolution). An unreadable process table yields []: never signal blind.
 */
export function groupMembers(pgid) {
  if (!pgid) return [];
  try {
    return execFileSync("ps", ["-eo", "pid=,pgid=,lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } }).split("\n")
      .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), pgid: Number(m[2]), startMs: Date.parse(m[3]) }))
      .filter((x) => x.pgid === pgid).map(({ pid, startMs }) => ({ pid, startMs }));
  } catch { return []; }
}

/**
 * Members of an exited child's group that are provably ours: a numeric pgid match alone is never enough (the
 * number may already belong to a replacement group). A member counts only when its start time is known and lies
 * in the spawn..exit window: ps reports start times floored to the second, so the window is
 * [floor(spawn to s), exit] with no slack after exit. A process started after the child's exit is never
 * accepted, except one started within the same wall-clock second as the exit (it cannot be told apart at ps's
 * one-second resolution; accepted residual). Bare numbers or unknown start times are skipped.
 */
export function ownedMembers(list, { spawnedAt, exitedAt }) {
  const lo = Math.floor(spawnedAt / 1000) * 1000;
  return (list ?? []).filter((m) => m && typeof m === "object" && Number.isInteger(m.pid) && m.pid > 0 && Number.isFinite(m.startMs)
    && m.startMs >= lo && m.startMs <= exitedAt).map((m) => m.pid);
}

/**
 * runProcess({ bin, args, cwd, env, input, timeoutMs }, deps?) ->
 *   { code, signal, timedOut, stdout, stderr, durationMs, spawnError, refusedFlags, leftoversKilled, pipesAbandoned, signals[] }
 * Resolves on 'close' (process exited and its stdio drained), so output is complete. If a descendant that left
 * the group keeps the pipes open, the pipes are dropped ~3 grace periods after the child exits (pipesAbandoned=true).
 *
 * Signal rule: before the child is reaped ('exit' not yet emitted) the child itself holds the pgid, so the group
 * is signalled. After that, membership is re-read with `ps` right before each signal and only members started
 * between spawn and exit (ownedMembers) are signalled, each by pid; the pgid itself is never signalled again.
 * Accepted residuals: a process started in the same wall-clock second as the exit (ps resolution), and pid reuse
 * between the ps read and the kill.
 * allowedConfig: the exact sensitive `-c` values the caller generated (see bypassFlags).
 * deps (tests): { spawn, kill, members, graceMs }.
 */
export async function runProcess({ bin, args = [], cwd, env, input, timeoutMs, allowedConfig = [] }, deps = {}) {
  const { spawn = nodeSpawn, kill = (pid, sig) => process.kill(pid, sig), members = groupMembers, graceMs = 2000 } = deps;
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const t0 = Date.now();
  const signals = [];
  const result = (extra) => ({ code: null, signal: null, timedOut: false, stdout: "", stderr: "", durationMs: 0, spawnError: null, refusedFlags: [], leftoversKilled: 0, pipesAbandoned: false, signals, ...extra });
  // The full, untruncated argv is checked before anything is executed.
  const refused = bypassFlags(args, { allowedConfig });
  if (refused.length) return result({ spawnError: `refused before spawn: bypass flags ${refused.join(" ")}`, refusedFlags: refused });
  let child;
  const spawnedAt = Date.now();
  try {
    child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  } catch (e) {
    return result({ spawnError: e.message });
  }
  let stdout = "", stderr = "", spawnError = null, timedOut = false, done = false;
  child.stdout.setEncoding("utf8").on("data", (s) => { stdout += s; });
  child.stderr.setEncoding("utf8").on("data", (s) => { stderr += s; });
  let exitInfo = null, pipesAbandoned = false, forceSettle;
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); t.unref?.(); timers.add(t); };
  const closed = new Promise((res) => {
    forceSettle = res;
    child.on("error", (e) => { spawnError = e.message; done = true; res({ code: null, signal: null }); });
    child.on("close", (code, signal) => { done = true; res({ code, signal }); });
  });
  const abandonPipes = () => {
    if (done || !exitInfo) return;
    pipesAbandoned = true;
    done = true;
    child.stdout.destroy();
    child.stderr.destroy();
    forceSettle(exitInfo);
  };
  child.stdin.on("error", () => {});
  child.stdin.end(input ?? "");
  /** Signal our live members (by pid) after exit; returns how many were signalled. */
  const signalOwned = (sig, why) => {
    const all = members(child.pid);
    const mine = ownedMembers(all, { spawnedAt, exitedAt: exitInfo.atMs });
    if (!mine.length) { signals.push({ sig, why, skipped: all.length ? `no member provably ours (${all.length} in group)` : "no live group member" }); return 0; }
    let n = 0;
    for (const pid of mine) { try { kill(pid, sig); n++; } catch {} }
    signals.push({ sig, why, held: `members:${mine.length}`, pids: mine });
    return n;
  };
  const killGroup = (sig, why) => {
    if (done || !child.pid) return;
    if (exitInfo === null) {
      try { kill(-child.pid, sig); signals.push({ sig, why, held: "child not reaped" }); } catch {}
      return;
    }
    signalOwned(sig, why);
  };
  // A descendant that keeps stdout/stderr open after the child exits: signal our members, then drop the pipes.
  child.on("exit", (code, signal) => {
    exitInfo = { code, signal, atMs: Date.now() };
    later(() => {
      killGroup("SIGTERM", "pipes open after exit");
      later(() => { killGroup("SIGKILL", "pipes open after exit"); later(abandonPipes, graceMs); }, graceMs);
    }, graceMs);
  });
  later(() => {
    timedOut = true;
    killGroup("SIGTERM", "timeout");
    later(() => killGroup("SIGKILL", "timeout"), 5000);
  }, limit);
  const { code, signal } = await closed;
  const durationMs = Date.now() - t0;
  for (const t of timers) clearTimeout(t);
  timers.clear();
  // Descendants that closed their stdio but stayed in the group.
  let leftoversKilled = 0;
  if (child.pid && !spawnError) {
    if (!exitInfo) exitInfo = { code, signal, atMs: Date.now() };
    leftoversKilled = signalOwned("SIGKILL", "leftovers after close");
    if (signals.at(-1)?.why === "leftovers after close" && signals.at(-1).skipped === "no live group member") signals.pop(); // keep the log to real events
  }
  return result({ code, signal, timedOut, stdout, stderr, durationMs, spawnError, leftoversKilled, pipesAbandoned });
}

// ---------------------------------------------------------------- bypass guard
/**
 * Flags that bypass permissions or sandboxing. Flag tokens (starting with "-") are matched as flags, including
 * `--flag=value`; the value after a mode-setting flag is matched as a value. Other tokens (paths, JSON) are not
 * scanned, so a random temp-dir name cannot cause a false positive.
 *
 * Config overrides (`-c`/`--config`, A50): a value that mentions any sensitive setting (permissions, sandbox,
 * approval, default_permissions, network, features, web_search) in any TOML spelling (dotted, quoted or inline-
 * table keys, single- or double-quoted values) is accepted only when it is byte-for-byte one of the values the
 * runner generated for this run (allowedConfig) or a fixed safe value; anything else is refused before spawn.
 */
const BAD_FLAGS = [/^--dangerously-/, /^--allow-dangerously-/, /^--yolo(=|$)/, /^--full-auto(=|$)/, /^--approve-for-me(=|$)/, /^--add-dir(=|$)/, /^-y$/,
  /^--enable(=|$)/, /^--sandbox-state/, /^--permission-profile(=|$)/, /^-P$/, /^--include-managed-config$/, /^--allow-unix-socket(=|$)/];
const MODE_FLAGS = new Set(["-s", "--sandbox", "--permission-mode", "--approval-mode", "-a", "--ask-for-approval", "-c", "--config"]);
const BAD_VALUES = [/danger-full-access/, /workspace-write/, /bypassPermissions/, /acceptEdits/, /\byolo\b/i, /\bauto\b/];
const SENSITIVE_CONFIG = /permission|sandbox|approval|network|feature|web_search|writable|shell_environment|mcp/i;
export const SAFE_CONFIG = ['approval_policy="never"', 'web_search="disabled"', 'sandbox_mode="read-only"'];
const unquote = (s) => s.trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
function badModeValue(flag, value, allowedConfig) {
  const v = String(value);
  if (flag === "-c" || flag === "--config") return SENSITIVE_CONFIG.test(v) && !SAFE_CONFIG.includes(v) && !allowedConfig.includes(v);
  if (flag === "-s" || flag === "--sandbox") return unquote(v) !== "read-only";
  if (flag === "-a" || flag === "--ask-for-approval") return unquote(v) !== "never";
  return BAD_VALUES.some((re) => re.test(v));
}
export function bypassFlags(argv, { allowedConfig = [] } = {}) {
  const hits = [];
  (argv ?? []).forEach((raw, i) => {
    const a = String(raw);
    if (!a.startsWith("-")) {
      if (i > 0 && MODE_FLAGS.has(String(argv[i - 1])) && badModeValue(String(argv[i - 1]), a, allowedConfig)) hits.push(a);
      return;
    }
    // A value that itself starts with "-" after -c is still a config value.
    if (i > 0 && (argv[i - 1] === "-c" || argv[i - 1] === "--config")) { if (badModeValue("-c", a, allowedConfig)) hits.push(a); return; }
    const [flag, value] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, null];
    if (BAD_FLAGS.some((re) => re.test(a))) hits.push(a);
    else if (value !== null && MODE_FLAGS.has(flag) && badModeValue(flag, value, allowedConfig)) hits.push(a);
    else if (/^-c./.test(a) && !a.startsWith("--") && badModeValue("-c", a.slice(2), allowedConfig)) hits.push(a); // -ckey=value
  });
  return hits;
}
