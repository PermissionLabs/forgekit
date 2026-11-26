// Child process helper: own process group, stdin prompt, hard timeout, SIGTERM -> SIGKILL group cleanup.
import { spawn } from "node:child_process";

const sleep = (n) => new Promise((r) => setTimeout(r, n));

/**
 * runProcess({ bin, args, cwd, env, input, timeoutMs }) ->
 *   { code, signal, timedOut, stdout, stderr, durationMs, spawnError }
 */
export async function runProcess({ bin, args, cwd, env, input, timeoutMs }) {
  const t0 = Date.now();
  let child;
  try {
    child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  } catch (e) {
    return { code: null, signal: null, timedOut: false, stdout: "", stderr: "", durationMs: 0, spawnError: e.message };
  }
  let stdout = "", stderr = "", spawnError = null, timedOut = false;
  child.stdout.setEncoding("utf8").on("data", (s) => { stdout += s; });
  child.stderr.setEncoding("utf8").on("data", (s) => { stderr += s; });
  const exited = new Promise((res) => {
    child.on("error", (e) => { spawnError = e.message; res({ code: null, signal: null }); });
    child.on("exit", (code, signal) => res({ code, signal }));
  });
  child.stdin.on("error", () => {});
  child.stdin.end(input ?? "");
  const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch {} };
  const timer = setTimeout(async () => {
    timedOut = true;
    killGroup("SIGTERM");
    await sleep(5000);
    killGroup("SIGKILL");
  }, timeoutMs);
  const { code, signal } = await exited;
  clearTimeout(timer);
  killGroup("SIGTERM"); // grandchildren left in the group
  await sleep(200);
  killGroup("SIGKILL");
  return { code, signal, timedOut, stdout, stderr, durationMs: Date.now() - t0, spawnError };
}

/** Flags that bypass permissions or sandboxing. No adapter may ever emit one. */
export const BYPASS_PATTERNS = [
  /dangerously/i, /^--yolo$/, /full-auto/, /danger-full-access/, /bypassPermissions/, /acceptEdits/,
  /^--approve-for-me$/, /^--allow-dangerously-skip-permissions$/, /workspace-write/, /^--add-dir$/,
];
export function bypassFlags(argv) {
  return argv.filter((a) => BYPASS_PATTERNS.some((re) => re.test(String(a))));
}
