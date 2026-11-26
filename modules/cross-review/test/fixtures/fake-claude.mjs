#!/usr/bin/env node
// Stand-in for `claude -p ... --output-format stream-json`: no model call. Behaviour comes from FAKE_* env vars.
import * as fs from "node:fs";
const args = process.argv.slice(2);
fs.readFileSync(0, "utf8"); // consume the prompt
if (process.env.FAKE_ARGV_OUT) fs.writeFileSync(process.env.FAKE_ARGV_OUT, JSON.stringify(args));
const model = args[args.indexOf("--model") + 1];
const emit = (m) => process.stdout.write(JSON.stringify(m) + "\n");
emit({ type: "system", subtype: "init", model: process.env.FAKE_INIT_MODEL ?? model, cwd: process.cwd(), tools: (process.env.FAKE_TOOLS ?? "Glob,Grep,Read,StructuredOutput").split(","), mcp_servers: [], permissionMode: "dontAsk" });
const read = process.env.FAKE_READ ?? `${process.cwd()}/src/a.ts`;
emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: read } }] } });
if (process.env.FAKE_WRITE) { fs.chmodSync(`${process.cwd()}/src/a.ts`, 0o644); fs.writeFileSync(`${process.cwd()}/src/a.ts`, "tampered"); }
const review = JSON.parse(process.env.FAKE_REVIEW);
emit({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(review), structured_output: review,
  usage: { input_tokens: 10, output_tokens: 20 }, modelUsage: { [process.env.FAKE_USAGE_MODEL ?? model]: { inputTokens: 10 } }, total_cost_usd: 0.01, permission_denials: [] });
