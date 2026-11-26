#!/usr/bin/env node
// Stand-in for `claude -p ... --output-format stream-json`: no model call. Behaviour comes from FAKE_* env vars
// (the runner passes them through only because the test policy lists them in env_passthrough).
import * as fs from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, "utf8"); // consume the prompt
const retry = prompt.includes("=== CORRECTION ===");
if (process.env.FAKE_ARGV_OUT) fs.writeFileSync(process.env.FAKE_ARGV_OUT, JSON.stringify(args));
if (process.env.FAKE_ENV_OUT) fs.writeFileSync(process.env.FAKE_ENV_OUT, JSON.stringify(Object.keys(process.env)));
const model = args[args.indexOf("--model") + 1];
const emit = (m) => process.stdout.write(JSON.stringify(m) + "\n");
emit({ type: "system", subtype: "init", model: process.env.FAKE_INIT_MODEL ?? model, cwd: process.cwd(), tools: (process.env.FAKE_TOOLS ?? "Glob,Grep,Read,StructuredOutput").split(","), mcp_servers: [], permissionMode: "dontAsk" });
const read = process.env.FAKE_READ ?? `${process.cwd()}/src/a.ts`;
emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: read } }] } });
if (process.env.FAKE_WRITE) { fs.chmodSync(`${process.cwd()}/src/a.ts`, 0o644); fs.writeFileSync(`${process.cwd()}/src/a.ts`, "tampered"); }
const outs = (process.env.FAKE_OUTPUTS ?? process.env.FAKE_REVIEW).split("\n---\n");
const text = outs[Math.min(retry ? 1 : 0, outs.length - 1)];
let review;
try { review = JSON.parse(text); } catch { review = text; }
emit({ type: "result", subtype: "success", is_error: false, result: typeof review === "string" ? review : JSON.stringify(review), structured_output: typeof review === "string" ? undefined : review,
  usage: { input_tokens: 10, output_tokens: 20 }, modelUsage: { [process.env.FAKE_USAGE_MODEL ?? model]: { inputTokens: 10 } }, total_cost_usd: 0.01, permission_denials: [] });
// A setsid'd descendant that keeps stdout/stderr open after this process exits (pipe-abandon case).
if (process.env.FAKE_ESCAPE) spawn(process.execPath, ["-e", "setTimeout(()=>{},15000)"], { detached: true, stdio: "inherit" }).unref();
