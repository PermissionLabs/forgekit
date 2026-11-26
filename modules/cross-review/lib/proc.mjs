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
/** Live members of process group `pgid` (POSIX `ps -eo`). An unreadable process table yields []: never signal blind. */
export function groupMembers(pgid) {
  if (!pgid) return [];
  try {
    return execFileSync("ps", ["-eo", "pid=,pgid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n")
      .map((l) => l.trim().split(/\s+/).map(Number)).filter(([p, g]) => p && g === pgid).map(([p]) => p);
  } catch { return []; }
}

/**
 * runProcess({ bin, args, cwd, env, input, timeoutMs }, deps?) ->
 *   { code, signal, timedOut, stdout, stderr, durationMs, spawnError, refusedFlags, leftoversKilled, pipesAbandoned, signals[] }
 * Resolves on 'close' (process exited and its stdio drained), so output is complete. If a descendant that left
 * the group keeps the pipes open, the pipes are dropped ~3 grace periods after the child exits (pipesAbandoned=true).
 *
 * Signal rule: the child's group is signalled only while it is provably ours. Before the child is reaped
 * ('exit' not yet emitted) the child itself holds the pgid. After that, `ps` must show a live member of the
 * group immediately before each signal; otherwise the signal is skipped (the pgid may already be reused).
 * The remaining ps-to-kill window is an accepted residual.
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
  const killGroup = (sig, why) => {
    if (done || !child.pid) return;
    if (exitInfo === null) {
      try { kill(-child.pid, sig); signals.push({ sig, why, held: "child not reaped" }); } catch {}
      return;
    }
    const m = members(child.pid);
    if (!m.length) { signals.push({ sig, why, skipped: "no live group member" }); return; }
    try { kill(-child.pid, sig); signals.push({ sig, why, held: `members:${m.length}` }); } catch {}
  };
  // A descendant that keeps stdout/stderr open after the child exits: signal the group (if still populated), then drop the pipes.
  child.on("exit", (code, signal) => {
    exitInfo = { code, signal };
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
  // Descendants that closed their stdio but stayed in the group: ps shows them, so the pgid is still ours.
  const leftovers = members(child.pid);
  if (leftovers.length) { try { kill(-child.pid, "SIGKILL"); signals.push({ sig: "SIGKILL", why: "leftovers after close", held: `members:${leftovers.length}` }); } catch {} }
  return result({ code, signal, timedOut, stdout, stderr, durationMs, spawnError, leftoversKilled: leftovers.length, pipesAbandoned });
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
