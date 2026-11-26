// Child process helper: own process group, stdin prompt, hard timeout, SIGTERM -> SIGKILL group cleanup.
import { execFileSync, spawn } from "node:child_process";

const sleep = (n) => new Promise((r) => setTimeout(r, n));
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * runProcess({ bin, args, cwd, env, input, timeoutMs }) ->
 *   { code, signal, timedOut, stdout, stderr, durationMs, spawnError }
 * Resolves on 'close' (process exited and its stdio drained), so output is complete.
 */
export async function runProcess({ bin, args, cwd, env, input, timeoutMs }) {
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const t0 = Date.now();
  let child;
  try {
    child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  } catch (e) {
    return { code: null, signal: null, timedOut: false, stdout: "", stderr: "", durationMs: 0, spawnError: e.message };
  }
  let stdout = "", stderr = "", spawnError = null, timedOut = false, done = false;
  child.stdout.setEncoding("utf8").on("data", (s) => { stdout += s; });
  child.stderr.setEncoding("utf8").on("data", (s) => { stderr += s; });
  const closed = new Promise((res) => {
    child.on("error", (e) => { spawnError = e.message; done = true; res({ code: null, signal: null }); });
    child.on("close", (code, signal) => { done = true; res({ code, signal }); });
  });
  child.stdin.on("error", () => {});
  child.stdin.end(input ?? "");
  // Until 'close', the group still has a member (the child, or a descendant holding its pipes), so the pgid
  // cannot have been reused. After 'close' no signal is sent.
  const killGroup = (sig) => { if (!done && child.pid) { try { process.kill(-child.pid, sig); } catch {} } };
  // A descendant that keeps stdout/stderr open after the child exits is killed after a short grace period.
  child.on("exit", () => { setTimeout(() => { killGroup("SIGTERM"); setTimeout(() => killGroup("SIGKILL"), 2000).unref(); }, 2000).unref(); });
  let killTimer = null;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup("SIGTERM");
    killTimer = setTimeout(() => killGroup("SIGKILL"), 5000);
  }, limit);
  const { code, signal } = await closed;
  const durationMs = Date.now() - t0;
  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  // Descendants that closed their stdio but stayed in the group: the group is non-empty, so its id is still ours.
  const leftovers = groupMembers(child.pid);
  if (leftovers.length) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  return { code, signal, timedOut, stdout, stderr, durationMs, spawnError, leftoversKilled: leftovers.length };
}

function groupMembers(pgid) {
  if (!pgid) return [];
  try {
    return execFileSync("ps", ["-axo", "pid=,pgid="], { encoding: "utf8" }).split("\n")
      .map((l) => l.trim().split(/\s+/).map(Number)).filter(([, g]) => g === pgid).map(([p]) => p);
  } catch { return []; }
}

/** Flags that bypass permissions or sandboxing, in `--flag`, `--flag=value` and value positions. */
export const BYPASS_PATTERNS = [
  /dangerously/i, /yolo/i, /full-auto/i, /danger-full-access/i, /bypassPermissions/i, /acceptEdits/i,
  /^--approve-for-me(=|$)/, /workspace-write/i, /^--add-dir(=|$)/, /^-y$/, /^--approval-mode(=|$)/,
];
export function bypassFlags(argv) {
  return argv.filter((a) => BYPASS_PATTERNS.some((re) => re.test(String(a))));
}
