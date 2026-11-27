// Child process helper: own process group, stdin prompt, hard timeout, SIGTERM -> SIGKILL group cleanup,
// bypass-flag refusal before spawn, minimal environment.
import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";

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
// Linux ps reconstructs lstart from a whole-second boot epoch. Around a second boundary
// that can put a new process before its own spawn. Use boot time on both sides instead.
export function ownershipTimeMs() {
  if (process.platform !== "linux") return Date.now();
  try {
    const uptime = readFileSync("/proc/uptime", "utf8").split(" ")[0];
    return /^\d+\.\d+$/.test(uptime) ? Math.round(Number(uptime) * 1000) : NaN;
  } catch { return NaN; }
}

let ticksPerSecond;
function linuxGroupMembers(pgid) {
  ticksPerSecond ??= Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
  if (!Number.isSafeInteger(ticksPerSecond) || ticksPerSecond <= 0) return [];
  const resolutionMs = 1000 / ticksPerSecond;
  const rows = execFileSync("ps", ["-eo", "pid=,pgid="], { encoding: "utf8" });
  const members = [];
  for (const row of rows.trim().split("\n")) {
    const [pid, group] = row.trim().split(/\s+/).map(Number);
    if (group !== pgid) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // The parenthesized command can contain spaces, closing parentheses and newlines.
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
      const ticks = Number(fields[19]); // field 22 (starttime); fields[0] is field 3.
      if (Number(fields[2]) === pgid && !["Z", "X"].includes(fields[0]) && Number.isSafeInteger(ticks) && ticks >= 0) {
        members.push({ pid, startMs: ticks * resolutionMs, resolutionMs });
      }
    } catch { /* A process may disappear between enumeration and the stat read. */ }
  }
  return members;
}

/** Live group members in the same clock domain as ownershipTimeMs; unknown provenance is excluded. */
export function groupMembers(pgid) {
  if (!pgid) return [];
  try {
    if (process.platform === "linux") return linuxGroupMembers(pgid);
    return execFileSync("ps", ["-eo", "pid=,pgid=,lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } }).split("\n")
      .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), pgid: Number(m[2]), startMs: Date.parse(m[3]) }))
      .filter((x) => x.pgid === pgid).map(({ pid, startMs }) => ({ pid, startMs }));
  } catch { return []; }
}

/**
 * Members of an exited child's group that are provably ours: a numeric pgid match alone is never enough (the
 * number may already belong to a replacement group). A member counts only when its start time is known and lies
 * in the spawn..exit window. Round the lower bound down to the reported start time's precision
 * (one kernel tick on Linux, one second with ps lstart). The upper bound gets no slack.
 */
export function ownedMembers(list, { spawnedAt, exitedAt }) {
  if (!Number.isFinite(spawnedAt) || !Number.isFinite(exitedAt) || exitedAt < spawnedAt) return [];
  return (list ?? []).filter(m => {
    if (!Number.isInteger(m?.pid) || m.pid <= 0 || !Number.isFinite(m.startMs)) return false;
    const step = m.resolutionMs ?? 1000;
    return step > 0 && Number.isFinite(step) && m.startMs >= Math.floor(spawnedAt / step) * step && m.startMs <= exitedAt;
  }).map(m => m.pid);
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
 * allowedConfig: the exact sensitive `-c` values the caller generated; shape: "codex" for the exact codex argv shape (see bypassFlags).
 * deps (tests): { spawn, kill, members, graceMs }.
 */
export async function runProcess({ bin, args = [], cwd, env, input, timeoutMs, allowedConfig = [], shape = null }, deps = {}) {
  const { spawn = nodeSpawn, kill = (pid, sig) => process.kill(pid, sig), members = groupMembers, graceMs = 2000 } = deps;
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const t0 = Date.now();
  const signals = [];
  const result = (extra) => ({ code: null, signal: null, timedOut: false, stdout: "", stderr: "", durationMs: 0, spawnError: null, refusedFlags: [], leftoversKilled: 0, pipesAbandoned: false, signals, ...extra });
  // The full, untruncated argv is checked before anything is executed.
  const refused = bypassFlags(args, { allowedConfig, shape });
  if (refused.length) return result({ spawnError: `refused before spawn: bypass flags ${refused.join(" ")}`, refusedFlags: refused });
  let child;
  const spawnedAt = ownershipTimeMs();
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
    exitInfo = { code, signal, atMs: ownershipTimeMs() };
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
    if (!exitInfo) exitInfo = { code, signal, atMs: ownershipTimeMs() };
    leftoversKilled = signalOwned("SIGKILL", "leftovers after close");
    if (signals.at(-1)?.why === "leftovers after close" && signals.at(-1).skipped === "no live group member") signals.pop(); // keep the log to real events
  }
  return result({ code, signal, timedOut, stdout, stderr, durationMs, spawnError, leftoversKilled, pipesAbandoned });
}

// ---------------------------------------------------------------- bypass guard
/**
 * Flags that bypass permissions or sandboxing. Flag tokens (starting with "-") are matched as flags, including
 * `--flag=value` and attached short values (`-sX`, `-P:x`, `-aX`); the value after a mode-setting flag is matched
 * as a value. Other tokens (paths, JSON) are not scanned, so a random temp-dir name cannot cause a false positive.
 *
 * No host needs `-s`/`--sandbox`, `sandbox_mode`, a Codex profile (`--profile`, `-c profile=`) or managed config,
 * so those are refused in every form (A59). Config overrides (`-c`/`--config`): the key is decoded as TOML (bare,
 * dotted, quoted keys, \u/\U escapes); a key touching permissions, sandbox, approval, profile, network, features,
 * web search, ... is accepted only when the whole value is byte-for-byte one the runner generated for this run
 * (allowedConfig) or a fixed safe value; an undecodable key counts as sensitive.
 *
 * shape "codex" (A50/A59): additionally the argv must have exactly the shape codex.buildArgv produces (an
 * allowlist of flags, every `-c` one of allowedConfig and every allowedConfig value present); anything else is
 * refused.
 */
const BAD_FLAGS = [/^--dangerously-/, /^--allow-dangerously-/, /^--yolo(=|$)/, /^--full-auto(=|$)/, /^--approve-for-me(=|$)/, /^--add-dir(=|$)/, /^-y$/,
  /^--enable(=|$)/, /^--sandbox-state/, /^--permission-profile(=|$)/, /^-P/, /^--include-managed-config/, /^--allow-unix-socket(=|$)/,
  /^-s/, /^--sandbox(=|$)/, /^--profile(=|$)/, /^-a./];
const MODE_FLAGS = new Set(["--permission-mode", "--approval-mode", "-a", "--ask-for-approval", "-c", "--config"]);
const BAD_VALUES = [/danger-full-access/, /workspace-write/, /bypassPermissions/, /acceptEdits/, /\byolo\b/i, /\bauto\b/];
const SENSITIVE_CONFIG = /permission|sandbox|approval|network|feature|web_search|writable|shell_environment|mcp|profile|managed|trust|notify|exec|model_provider|experimental/i;
export const SAFE_CONFIG = ['approval_policy="never"', 'web_search="disabled"'];
const unquote = (s) => s.trim().replace(/^(["'])([\s\S]*)\1$/, "$2");

/**
 * The dotted key of a `-c key=value` override, decoded as TOML (bare keys, "basic" keys with escapes, 'literal'
 * keys, dots and whitespace), or null when it cannot be decoded (callers treat null as sensitive).
 */
export function tomlKey(v) {
  const s = String(v);
  const parts = [];
  let i = 0, cur = null;
  const ws = () => { while (s[i] === " " || s[i] === "\t") i++; };
  ws();
  for (;;) {
    if (s[i] === '"') {
      let out = ""; i++;
      for (;;) {
        if (i >= s.length) return null;
        const c = s[i];
        if (c === '"') { i++; break; }
        if (c === "\\") {
          const e = s[i + 1];
          const simple = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\", e: "\u001b" };
          if (e in simple) { out += simple[e]; i += 2; continue; }
          const n = e === "u" ? 4 : e === "U" ? 8 : e === "x" ? 2 : 0;
          const hex = s.slice(i + 2, i + 2 + n);
          if (!n || !new RegExp(`^[0-9A-Fa-f]{${n}}$`).test(hex)) return null;
          const cp = parseInt(hex, 16);
          if (cp > 0x10ffff) return null;
          out += String.fromCodePoint(cp); i += 2 + n; continue;
        }
        out += c; i++;
      }
      cur = out;
    } else if (s[i] === "'") {
      const j = s.indexOf("'", i + 1);
      if (j === -1) return null;
      cur = s.slice(i + 1, j); i = j + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!m) return null;
      cur = m[0]; i += m[0].length;
    }
    parts.push(cur);
    ws();
    if (s[i] === ".") { i++; ws(); continue; }
    if (s[i] === "=") return parts.join(".");
    return null;
  }
}

function badConfig(v, allowedConfig) {
  if (SAFE_CONFIG.includes(v) || allowedConfig.includes(v)) return false;
  const key = tomlKey(v);
  return key === null || SENSITIVE_CONFIG.test(key) || SENSITIVE_CONFIG.test(v);
}
function badModeValue(flag, value, allowedConfig) {
  const v = String(value);
  if (flag === "-c" || flag === "--config") return badConfig(v, allowedConfig);
  if (flag === "-a" || flag === "--ask-for-approval") return unquote(v) !== "never";
  return BAD_VALUES.some((re) => re.test(v));
}

// codex.buildArgv's exact flag set: valued flags with their value check, and boolean flags.
const CODEX_VALUED = {
  "-m": (v) => /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/.test(v),
  "-c": null, // checked against allowedConfig
  "--disable": (v) => /^[a-z][a-z0-9_]*$/.test(v),
  "-C": (v) => v.startsWith("/"),
  "--color": (v) => v === "never",
  "--output-schema": (v) => v.startsWith("/") || !v.startsWith("-"),
  "-o": (v) => v.startsWith("/") || !v.startsWith("-"),
};
const CODEX_BOOL = new Set(["--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check"]);
const CODEX_REQUIRED = ["--ephemeral", "--ignore-user-config", "--ignore-rules", "-C", "-m"];

/** Tokens of a codex argv that are not part of the runner-built shape (empty = exact shape). A leading binary path is skipped. */
export function codexShapeProblems(argv, allowedConfig = []) {
  const a = (argv ?? []).map(String);
  const hits = [];
  let i = a[0] === "exec" ? 0 : a[1] === "exec" && !a[0].startsWith("-") ? 1 : -1;
  if (i === -1) return ["<codex argv does not start with exec>"];
  i++;
  const seen = new Set();
  const configs = [];
  for (; i < a.length; i++) {
    const t = a[i];
    if (t === "-" && i === a.length - 1) { seen.add("-"); continue; }
    if (CODEX_BOOL.has(t)) { seen.add(t); continue; }
    if (Object.hasOwn(CODEX_VALUED, t) && i + 1 < a.length) {
      const v = a[++i];
      if (t === "-c") { if (allowedConfig.includes(v)) configs.push(v); else hits.push(v); }
      else if (CODEX_VALUED[t](v)) seen.add(t);
      else hits.push(`${t} ${v}`);
      continue;
    }
    hits.push(t);
  }
  for (const r of [...CODEX_REQUIRED, "-"]) if (!seen.has(r)) hits.push(`<missing ${r}>`);
  for (const c of allowedConfig) if (!configs.includes(c)) hits.push(`<missing -c ${c}>`);
  if (!allowedConfig.length) hits.push("<no runner-generated -c allowlist>");
  return hits;
}

export function bypassFlags(argv, { allowedConfig = [], shape = null } = {}) {
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
  if (shape === "codex") { for (const h of codexShapeProblems(argv, allowedConfig)) if (!hits.includes(h)) hits.push(h); }
  else if (shape) hits.push(`<unknown argv shape ${shape}>`);
  return hits;
}
