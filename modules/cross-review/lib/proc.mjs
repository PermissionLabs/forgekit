// Child process helper: own process group, stdin prompt, hard timeout, SIGTERM -> SIGKILL group cleanup.
import { execFileSync, spawn } from "node:child_process";

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * runProcess({ bin, args, cwd, env, input, timeoutMs }) ->
 *   { code, signal, timedOut, stdout, stderr, durationMs, spawnError, leftoversKilled, pipesAbandoned }
 * Resolves on 'close' (process exited and its stdio drained), so output is complete. If a descendant that left
 * the group keeps the pipes open, the pipes are dropped ~6 s after the child exits (pipesAbandoned=true).
 */
export async function runProcess({ bin, args, cwd, env, input, timeoutMs }) {
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const t0 = Date.now();
  let child;
  try {
    child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  } catch (e) {
    return { code: null, signal: null, timedOut: false, stdout: "", stderr: "", durationMs: 0, spawnError: e.message, leftoversKilled: 0, pipesAbandoned: false };
  }
  let stdout = "", stderr = "", spawnError = null, timedOut = false, done = false;
  child.stdout.setEncoding("utf8").on("data", (s) => { stdout += s; });
  child.stderr.setEncoding("utf8").on("data", (s) => { stderr += s; });
  let exitInfo = null, pipesAbandoned = false, forceSettle;
  const closed = new Promise((res) => {
    forceSettle = res;
    child.on("error", (e) => { spawnError = e.message; done = true; res({ code: null, signal: null }); });
    child.on("close", (code, signal) => { done = true; res({ code, signal }); });
  });
  // A descendant that left the group (setsid) but kept stdout/stderr open would block 'close' forever:
  // after the child has exited and the group was signalled, stop waiting and drop the pipes.
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
  // Until 'close', the group still has a member (the child, or a descendant holding its pipes), so the pgid
  // cannot have been reused. After 'close' no signal is sent.
  const killGroup = (sig) => { if (!done && child.pid) { try { process.kill(-child.pid, sig); } catch {} } };
  // A descendant that keeps stdout/stderr open after the child exits is killed after a short grace period.
  child.on("exit", (code, signal) => {
    exitInfo = { code, signal };
    setTimeout(() => {
      killGroup("SIGTERM");
      setTimeout(() => { killGroup("SIGKILL"); setTimeout(abandonPipes, 2000).unref(); }, 2000).unref();
    }, 2000).unref();
  });
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
  // Descendants that closed their stdio but stayed in the group: the group is non-empty, so its id is still ours
  // (a pgid is not reused while any member is alive; the window between ps and kill is accepted).
  const leftovers = groupMembers(child.pid);
  if (leftovers.length) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  return { code, signal, timedOut, stdout, stderr, durationMs, spawnError, leftoversKilled: leftovers.length, pipesAbandoned };
}

function groupMembers(pgid) {
  if (!pgid) return [];
  try {
    return execFileSync("ps", ["-axo", "pid=,pgid="], { encoding: "utf8" }).split("\n")
      .map((l) => l.trim().split(/\s+/).map(Number)).filter(([, g]) => g === pgid).map(([p]) => p);
  } catch { return []; }
}

/**
 * Flags that bypass permissions or sandboxing. Flag tokens (starting with "-") are matched as flags, including
 * `--flag=value`; the value after a mode-setting flag is matched as a value. Other tokens (paths, JSON) are not
 * scanned, so a random temp-dir name cannot cause a false positive.
 */
const BAD_FLAGS = [/^--dangerously-/, /^--allow-dangerously-/, /^--yolo(=|$)/, /^--full-auto(=|$)/, /^--approve-for-me(=|$)/, /^--add-dir(=|$)/, /^-y$/];
const MODE_FLAGS = new Set(["-s", "--sandbox", "--permission-mode", "--approval-mode", "-a", "--ask-for-approval", "-c", "--config"]);
const BAD_VALUES = [/danger-full-access/, /workspace-write/, /bypassPermissions/, /acceptEdits/, /\byolo\b/, /approval_policy\s*=\s*"?(on-failure|untrusted-auto|auto)/, /sandbox_mode\s*=\s*"?(danger|workspace)/];
export function bypassFlags(argv) {
  const hits = [];
  argv.forEach((raw, i) => {
    const a = String(raw);
    if (!a.startsWith("-")) {
      if (i > 0 && MODE_FLAGS.has(String(argv[i - 1])) && BAD_VALUES.some((re) => re.test(a))) hits.push(a);
      return;
    }
    const [flag, value] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, null];
    if (BAD_FLAGS.some((re) => re.test(a))) hits.push(a);
    else if (value !== null && MODE_FLAGS.has(flag) && BAD_VALUES.some((re) => re.test(value))) hits.push(a);
  });
  return hits;
}
