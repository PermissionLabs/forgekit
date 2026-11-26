#!/usr/bin/env node
// Stand-in for the T3-managed `agy_acp_server` (ACP over stdio JSON-RPC). No model call.
// Behaviour per prompt turn (0-based, counting retries) comes from FAKE_AGY (JSON):
//   noProxy: [turn], proxyModel: "m", stopReason: {turn: "cancelled"}, stderrLine: {turn: "..."}, error: {turn: "msg"},
//   readPath: {turn: "/abs"}, longEscape: true, updateTitle: {turn: "run_command"}, invalid: [turn], restartIds: true,
//   exitAfter: "initialize", splitStderr: ["first chunk", "second chunk"], exitCode: n (on stdin end),
//   trailingStderr: "text without newline" (written at stdin end, right before exit), metaCwd: "/other",
//   permission: [turn] (session/request_permission before the reply), clientRpc: {turn: "fs/read_text_file"},
//   signalOnStdinEnd: "SIGABRT" (the server kills itself with that signal when stdin closes)
// Started with `acp ...` it behaves like the 1.5 CLI ("cli" layout): checks its argv, logs to --log-file instead of
// stderr (stderrLine/splitStderr go there), writes no .meta but a real SQLite session database with one gen_metadata
// row per turn and a trajectory_metadata_blob row, sends ACP `name`/`args` tool calls (read_file), and advertises
// session modes. Extra knobs: noGen: [turn], genModel: "m", genDisplay: "Name (Level)", workspace: "/other",
//   mode: "auto", toolName: {turn: "run_command"}, steps: true (an update_steps call without a path),
//   browser: true (authenticate runs `open <url>` from PATH, then fails like 1.5 without a sign-in),
//   noDb: true (no session database at all), noTrajSid: true (trajectory metadata without the session id),
//   lateGen: true (turn 0 commits a second generation 300 ms after its reply), idless: {turn: true} (a read_file
//   tool_call without toolCallId), namelessSteps: {turn: true} (a nameless "view_file" call without a path that a
//   later update renames to update_steps).
// Per-turn stderr is written (and flushed) before any stdout for that turn, so the parent always sees it first.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const cfg = JSON.parse(process.env.FAKE_AGY ?? "{}");
const CLI = process.argv[2] === "acp";
let logFile = null, db = null;
if (CLI) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  if (arg("--gemini-dir") !== process.env.GEMINI_HOME || arg("--app-data-dir") !== "antigravity-acp" || !arg("--log-file") || !process.argv.includes("--disable-telemetry")) process.exit(3);
  logFile = arg("--log-file");
}
const sqlite = CLI ? await import("node:sqlite") : null;
const varint = (x) => { const o = []; while (x > 127) { o.push((x & 127) | 128); x = Math.floor(x / 128); } o.push(x); return Buffer.from(o); };
const enc = (fields) => Buffer.concat(fields.map(([n, v]) => { const b = Buffer.isBuffer(v) ? v : Buffer.from(String(v)); return Buffer.concat([varint(n * 8 + 2), varint(b.length), b]); }));
const errOut = (text, cb) => { if (CLI) { fs.appendFileSync(logFile, text); cb?.(); } else process.stderr.write(text, cb); };
const SID = "11111111-1111-4111-8111-111111111111";
let model = "default-model", thinking = "low", cwd = null, turn = 0, findingsSoFar = 0;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const opts = () => [{ id: "model", currentValue: model }, { id: "thinking", category: "thought_level", currentValue: thinking }];
const notify = (update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SID, update } });
const has = (list, t) => Array.isArray(list) && list.includes(t);
function review(text) {
  const dims = (text.match(/THIS TURN covers only these dimensions: ([^.]+)\./)?.[1] ?? text.match(/for dimensions ([^(]+?) \(/)?.[1] ?? "correctness").split(",").map((s) => s.trim());
  const start = text.match(/start at ([A-Z])(\d+)/);
  const prefix = start?.[1] ?? "A";
  const n = cfg.restartIds ? 1 : Number(start?.[2] ?? 1);
  const file = text.match(/reviews only these scope files[^:]*: (\S+?)[,.](?:\s|$)/)?.[1] ?? "src/a.ts";
  return { verdict: "fix", coverage: Object.fromEntries(dims.map((d) => [d, "checked"])), findings: [{ id: `${prefix}${n}`, sev: "low", loc: `${file}:1`, claim: `claim ${dims.join("+")}`, evidence: "e", check: "k" }], limits: [] };
}
let buf = "";
process.stdin.setEncoding("utf8").on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === undefined) continue; // replies to our client requests
    const reply = (result) => send({ jsonrpc: "2.0", id: m.id, result });
    if (m.method === "initialize") { reply({ agentInfo: { name: "fake-agy", version: "0.0.1" } }); if (cfg.exitAfter === "initialize") process.exit(0); }
    else if (m.method === "authenticate") {
      if (cfg.browser) { spawnSync("open", ["https://accounts.google.com/o/oauth2/auth?x=1"], { stdio: "ignore" }); send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "No browser is available here to sign in" } }); }
      else reply({});
    }
    else if (m.method === "session/new") {
      cwd = m.params.cwd;
      const conv = path.join(process.env.GEMINI_HOME, "antigravity-acp", "conversations");
      fs.mkdirSync(conv, { recursive: true });
      if (CLI && !cfg.noDb) {
        db = new sqlite.DatabaseSync(path.join(conv, `${SID}.db`));
        db.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB); CREATE TABLE trajectory_metadata_blob (data BLOB);");
        const uri = pathToFileURL(cfg.workspace ?? cwd).href;
        db.prepare("INSERT INTO trajectory_metadata_blob (data) VALUES (?)").run(enc([[1, enc([[1, uri]])], ...(cfg.noTrajSid ? [] : [[6, SID]]), [7, uri]]));
        const ann = path.join(process.env.GEMINI_HOME, "antigravity-acp", "annotations");
        fs.mkdirSync(ann, { recursive: true });
        fs.writeFileSync(path.join(ann, `${SID}.pbtxt`), "x");
      } else if (!CLI) {
        fs.writeFileSync(path.join(conv, `${SID}.meta`), JSON.stringify({ cwd: cfg.metaCwd ?? cwd }));
        fs.writeFileSync(path.join(conv, `${SID}.db`), "");
      }
      const result = () => ({ sessionId: SID, configOptions: opts(), ...(CLI ? { modes: { currentModeId: cfg.mode ?? "default" } } : {}) });
      // splitStderr: one stderr line written in two chunks, 100 ms apart (before the session reply).
      if (cfg.splitStderr) {
        errOut(cfg.splitStderr[0]);
        const id = m.id;
        setTimeout(() => { errOut(cfg.splitStderr[1]); send({ jsonrpc: "2.0", id, result: result() }); }, 100);
      } else reply(result());
    } else if (m.method === "session/set_config_option") {
      if (m.params.configId === "model") model = m.params.value; else thinking = m.params.value;
      reply({ configOptions: opts() });
    } else if (m.method === "session/prompt") {
      const t = turn++;
      const text = m.params.prompt.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      let err = "";
      if (!CLI && !has(cfg.noProxy, t)) err += `I1126 proxy.go:1] Proxy extracted model from path: ${cfg.proxyModel ?? `${model}-${thinking}`}\n`;
      const gen = () => enc([[1, enc([[19, cfg.genModel ?? model], [21, cfg.genDisplay ?? `${model} (${thinking})`]])]]);
      if (CLI && db && !has(cfg.noGen, t)) db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(t * 10, gen());
      if (CLI && db && cfg.lateGen && t === 0) setTimeout(() => db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(1, gen()), 330);
      if (cfg.stderrLine?.[t]) err += cfg.stderrLine[t] + "\n";
      const id = m.id;
      // stderr first, flushed, and a pause: stdout for this turn can never overtake its stderr (A44).
      errOut(err, () => setTimeout(() => answer(t, text, id), 30));
      continue;
    } else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unknown" } });
  }
});
function answer(t, text, id) {
  const reply = (result) => send({ jsonrpc: "2.0", id, result });
  // longEscape: inside the snapshot for the first 500+ characters, then climbs out.
  const p = cfg.longEscape && t === 0 ? cwd + "/.".repeat(300) + "/../../../../../../../../etc/passwd" : cfg.readPath?.[t] ?? path.join(cwd, "src/a.ts");
  if (CLI && cfg.steps) notify({ sessionUpdate: "tool_call", toolCallId: `s${t}`, name: "update_steps", title: "Run update_steps", kind: "other", status: "completed", args: { steps: [] } });
  if (CLI && cfg.idless?.[t]) notify({ sessionUpdate: "tool_call", name: "read_file", title: "File x", kind: "read", status: "pending", args: {} });
  if (CLI && cfg.namelessSteps?.[t]) { notify({ sessionUpdate: "tool_call", toolCallId: `n${t}`, title: "view_file", kind: "read", status: "pending" }); notify({ sessionUpdate: "tool_call_update", toolCallId: `n${t}`, name: "update_steps", status: "completed" }); }
  if (CLI) notify({ sessionUpdate: "tool_call", toolCallId: `t${t}`, name: cfg.toolName?.[t] ?? "read_file", title: `File ${path.basename(p)}`, kind: "read", status: "pending", args: { Path: p }, locations: [{ path: p }] });
  else notify({ sessionUpdate: "tool_call", toolCallId: `t${t}`, title: "view_file", kind: "read", status: "pending", rawInput: { AbsolutePath: p } });
  if (cfg.updateTitle?.[t]) notify({ sessionUpdate: "tool_call_update", toolCallId: `t${t}`, title: cfg.updateTitle[t], status: "completed" });
  const body = has(cfg.invalid, t) ? "not json" : JSON.stringify(review(text));
  notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: body } });
  if (has(cfg.permission, t)) send({ jsonrpc: "2.0", id: `perm${t}`, method: "session/request_permission", params: { sessionId: SID, toolCall: { title: "run_command", kind: "execute" }, options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }] } });
  if (cfg.clientRpc?.[t]) send({ jsonrpc: "2.0", id: `rpc${t}`, method: cfg.clientRpc[t], params: { sessionId: SID, path: "/etc/hosts" } });
  if (cfg.error?.[t]) send({ jsonrpc: "2.0", id, error: { code: -32000, message: cfg.error[t] } });
  else reply({ stopReason: cfg.stopReason?.[t] ?? "end_turn", usage: { totalTokens: 10, inputTokens: 7, outputTokens: 3 } });
}
process.stdin.on("end", () => {
  try { db?.close(); } catch {}
  if (cfg.signalOnStdinEnd) process.kill(process.pid, cfg.signalOnStdinEnd);
  const code = cfg.exitCode ?? 0;
  if (cfg.trailingStderr) process.stderr.write(cfg.trailingStderr, () => process.exit(code));
  else process.exit(code);
});
