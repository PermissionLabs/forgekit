#!/usr/bin/env node
// Stand-in for the T3-managed `agy_acp_server` (ACP over stdio JSON-RPC). No model call.
// Behaviour per prompt turn (0-based, counting retries) comes from FAKE_AGY (JSON):
//   noProxy: [turn], proxyModel: "m", stopReason: {turn: "cancelled"}, stderrLine: {turn: "..."}, error: {turn: "msg"},
//   readPath: {turn: "/abs"}, longEscape: true, updateTitle: {turn: "run_command"}, invalid: [turn], restartIds: true,
//   exitAfter: "initialize", splitStderr: ["first chunk", "second chunk"], exitCode: n (on stdin end),
//   trailingStderr: "text without newline" (written at stdin end, right before exit), metaCwd: "/other",
//   permission: [turn] (session/request_permission before the reply), clientRpc: {turn: "fs/read_text_file"},
//   signalOnStdinEnd: "SIGABRT" (the server kills itself with that signal when stdin closes)
// Per-turn stderr is written (and flushed) before any stdout for that turn, so the parent always sees it first.
import * as fs from "node:fs";
import * as path from "node:path";
const cfg = JSON.parse(process.env.FAKE_AGY ?? "{}");
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
    else if (m.method === "authenticate") reply({});
    else if (m.method === "session/new") {
      cwd = m.params.cwd;
      const conv = path.join(process.env.GEMINI_HOME, "antigravity-acp", "conversations");
      fs.mkdirSync(conv, { recursive: true });
      fs.writeFileSync(path.join(conv, `${SID}.meta`), JSON.stringify({ cwd: cfg.metaCwd ?? cwd }));
      fs.writeFileSync(path.join(conv, `${SID}.db`), "");
      // splitStderr: one stderr line written in two chunks, 100 ms apart (before the session reply).
      if (cfg.splitStderr) {
        process.stderr.write(cfg.splitStderr[0]);
        const id = m.id;
        setTimeout(() => { process.stderr.write(cfg.splitStderr[1]); send({ jsonrpc: "2.0", id, result: { sessionId: SID, configOptions: opts() } }); }, 100);
      } else reply({ sessionId: SID, configOptions: opts() });
    } else if (m.method === "session/set_config_option") {
      if (m.params.configId === "model") model = m.params.value; else thinking = m.params.value;
      reply({ configOptions: opts() });
    } else if (m.method === "session/prompt") {
      const t = turn++;
      const text = m.params.prompt.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      let err = "";
      if (!has(cfg.noProxy, t)) err += `I1126 proxy.go:1] Proxy extracted model from path: ${cfg.proxyModel ?? `${model}-${thinking}`}\n`;
      if (cfg.stderrLine?.[t]) err += cfg.stderrLine[t] + "\n";
      const id = m.id;
      // stderr first, flushed, and a pause: stdout for this turn can never overtake its stderr (A44).
      process.stderr.write(err, () => setTimeout(() => answer(t, text, id), 30));
      continue;
    } else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unknown" } });
  }
});
function answer(t, text, id) {
  const reply = (result) => send({ jsonrpc: "2.0", id, result });
  // longEscape: inside the snapshot for the first 500+ characters, then climbs out.
  const p = cfg.longEscape && t === 0 ? cwd + "/.".repeat(300) + "/../../../../../../../../etc/passwd" : cfg.readPath?.[t] ?? path.join(cwd, "src/a.ts");
  notify({ sessionUpdate: "tool_call", toolCallId: `t${t}`, title: "view_file", kind: "read", status: "pending", rawInput: { AbsolutePath: p } });
  if (cfg.updateTitle?.[t]) notify({ sessionUpdate: "tool_call_update", toolCallId: `t${t}`, title: cfg.updateTitle[t], status: "completed" });
  const body = has(cfg.invalid, t) ? "not json" : JSON.stringify(review(text));
  notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: body } });
  if (has(cfg.permission, t)) send({ jsonrpc: "2.0", id: `perm${t}`, method: "session/request_permission", params: { sessionId: SID, toolCall: { title: "run_command", kind: "execute" }, options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }] } });
  if (cfg.clientRpc?.[t]) send({ jsonrpc: "2.0", id: `rpc${t}`, method: cfg.clientRpc[t], params: { sessionId: SID, path: "/etc/hosts" } });
  if (cfg.error?.[t]) send({ jsonrpc: "2.0", id, error: { code: -32000, message: cfg.error[t] } });
  else reply({ stopReason: cfg.stopReason?.[t] ?? "end_turn", usage: { totalTokens: 10, inputTokens: 7, outputTokens: 3 } });
}
process.stdin.on("end", () => {
  if (cfg.signalOnStdinEnd) process.kill(process.pid, cfg.signalOnStdinEnd);
  const code = cfg.exitCode ?? 0;
  if (cfg.trailingStderr) process.stderr.write(cfg.trailingStderr, () => process.exit(code));
  else process.exit(code);
});
