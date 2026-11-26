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
 * in [child spawn, child exit] (one-second slack for ps resolution): a replacement group's processes all start
 * after our child was reaped. Bare numbers or unknown start times are skipped.
 */
export function ownedMembers(list, { spawnedAt, exitedAt }) {
  return (list ?? []).filter((m) => m && typeof m === "object" && Number.isInteger(m.pid) && m.pid > 0 && Number.isFinite(m.startMs)
    && m.startMs >= Math.floor(spawnedAt / 1000) * 1000 - 1000 && m.startMs <= exitedAt + 1000).map((m) => m.pid);
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
 * The remaining ps-to-kill window (pid reuse within it) is an accepted residual.
 * deps (tests): { spawn, kill, members, graceMs }.
 */
export async function runProcess({ bin, args = [], cwd, env, input, timeoutMs }, deps = {}) {
  const { spawn = nodeSpawn, kill = (pid, sig) => process.kill(pid, sig), members = groupMembers, graceMs = 2000 } = deps;
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const t0 = Date.now();
  const signals = [];
  const result = (extra) => ({ code: null, signal: null, timedOut: false, stdout: "", stderr: "", durationMs: 0, spawnError: null, refusedFlags: [], leftoversKilled: 0, pipesAbandoned: false, signals, ...extra });
  // The full, untruncated argv is checked before anything is executed.
  const refused = bypassFlags(args);
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
 */
const BAD_FLAGS = [/^--dangerously-/, /^--allow-dangerously-/, /^--yolo(=|$)/, /^--full-auto(=|$)/, /^--approve-for-me(=|$)/, /^--add-dir(=|$)/, /^-y$/];
const MODE_FLAGS = new Set(["-s", "--sandbox", "--permission-mode", "--approval-mode", "-a", "--ask-for-approval", "-c", "--config"]);
const BAD_VALUES = [/danger-full-access/, /workspace-write/, /bypassPermissions/, /acceptEdits/, /\byolo\b/i, /\bauto\b/];
const unquote = (s) => s.trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
function badModeValue(flag, value) {
  const v = String(value);
  if (flag === "-c" || flag === "--config") {
    const m = v.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*([\s\S]*)$/);
    if (m) {
      const key = m[1], val = unquote(m[2]);
      if (key === "approval_policy") return val !== "never";
      if (key === "sandbox_mode") return val !== "read-only";
      // Permission profiles: only runner-generated read-only ones (read/none entries, no built-in write profile).
      if (key === "default_permissions") return /^:/.test(val) && val !== ":read-only";
      if (/^permissions\./.test(key)) return !/\.filesystem$/.test(key) || /=\s*"?(write|full|rw)\b/i.test(m[2]);
      if (/^(permission_profile|allowed_permission_profiles|sandbox_state)/.test(key)) return true;
      if (/^sandbox_workspace_write\b|^sandbox_permissions\b/.test(key)) return true;
      return false;
    }
    return BAD_VALUES.some((re) => re.test(v));
  }
  if (flag === "-s" || flag === "--sandbox") return unquote(v) !== "read-only";
  if (flag === "-a" || flag === "--ask-for-approval") return unquote(v) !== "never";
  return BAD_VALUES.some((re) => re.test(v));
}
export function bypassFlags(argv) {
  const hits = [];
  (argv ?? []).forEach((raw, i) => {
    const a = String(raw);
    if (!a.startsWith("-")) {
      if (i > 0 && MODE_FLAGS.has(String(argv[i - 1])) && badModeValue(String(argv[i - 1]), a)) hits.push(a);
      return;
    }
    const [flag, value] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, null];
    if (BAD_FLAGS.some((re) => re.test(a))) hits.push(a);
    else if (value !== null && MODE_FLAGS.has(flag) && badModeValue(flag, value)) hits.push(a);
  });
  return hits;
}
