// Adapter smoke tests: constructed argv/session parameters only. No real model is called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPolicy, defaultPolicyPath, hostPin } from "../lib/policy.mjs";
import { bypassFlags } from "../lib/proc.mjs";
import * as claude from "../adapters/claude.mjs";
import * as codex from "../adapters/codex.mjs";
import * as ag from "../adapters/antigravity.mjs";
import { jsonSchemaFor } from "../lib/schema.mjs";

const { policy } = loadPolicy(defaultPolicyPath());
const clone = (x) => JSON.parse(JSON.stringify(x));
const schema = jsonSchemaFor(["correctness"]);
const SNAP = "/tmp/snap-x";
const flagValue = (argv, f) => argv[argv.indexOf(f) + 1];

test("claude argv: read-only tools, no MCP, no settings, no session persistence, pinned model/effort, no bypass", () => {
  const argv = claude.buildArgv(hostPin(policy, "claude"), schema);
  assert.equal(argv[0], "-p");
  assert.equal(flagValue(argv, "--model"), policy.hosts.claude.model);
  assert.equal(flagValue(argv, "--effort"), policy.hosts.claude.effort_map.high);
  assert.equal(flagValue(argv, "--tools"), "Read,Grep,Glob");
  assert.equal(flagValue(argv, "--allowedTools"), "Read,Grep,Glob");
  assert.equal(flagValue(argv, "--permission-mode"), "dontAsk");
  assert.equal(flagValue(argv, "--permission-prompts"), "none");
  assert.equal(flagValue(argv, "--mcp-config"), '{"mcpServers":{}}');
  assert.equal(flagValue(argv, "--setting-sources"), "");
  for (const f of ["--restricted", "--safe-mode", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands", "--json-schema"]) assert.ok(argv.includes(f), f);
  for (const bad of ["Bash", "Edit", "Write", "WebFetch", "WebSearch", "Agent", "Task"]) assert.ok(!flagValue(argv, "--tools").split(",").includes(bad), bad);
  assert.deepEqual(bypassFlags(argv), []);
  for (const f of ["--resume", "--continue", "--add-dir", "--agents", "--plugin-dir", "--chrome", "--settings", "--fallback-model"]) assert.ok(!argv.includes(f), f);
});

test("claude model comes from the policy, not the code", () => {
  const p = clone(policy);
  p.hosts.claude.model = "claude-test-model";
  p.hosts.claude.effort_map.high = "max";
  const argv = claude.buildArgv(hostPin(p, "claude"), schema);
  assert.equal(flagValue(argv, "--model"), "claude-test-model");
  assert.equal(flagValue(argv, "--effort"), "max");
});

test("claude stream audit: extra tools, MCP, outside reads and wrong model make the run incomplete", () => {
  const pin = hostPin(policy, "claude");
  const ok = [
    { type: "system", subtype: "init", model: pin.model, cwd: SNAP, tools: ["Read", "Grep", "Glob", "StructuredOutput"], mcp_servers: [], permissionMode: "dontAsk" },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "Read", input: { file_path: `${SNAP}/src/a.ts` } }] } },
    { type: "result", subtype: "success", is_error: false, structured_output: { verdict: "pass" }, modelUsage: { [pin.model]: {}, "claude-haiku-5-5": {} }, permission_denials: [] },
  ];
  const lines = (xs) => xs.map((x) => JSON.stringify(x)).join("\n");
  const a = claude.auditStream(lines(ok), SNAP, pin);
  assert.deepEqual(a.reasons, []);
  assert.equal(a.reported.model, pin.model);
  assert.match(a.warnings.join(), /claude-haiku-5-5/);
  const bad = clone(ok);
  bad[0].tools.push("Bash");
  bad[0].mcp_servers = [{ name: "x" }];
  bad[1].message.content.push({ type: "tool_use", id: "b", name: "Read", input: { file_path: "/etc/hosts" } });
  bad[1].message.content.push({ type: "tool_use", id: "c", name: "Write", input: { file_path: `${SNAP}/x` } });
  bad[2].modelUsage = { "claude-sonnet-5-5": {} };
  const r = claude.auditStream(lines(bad), SNAP, pin).reasons.join("\n");
  assert.match(r, /tools_not_read_only:Bash/);
  assert.match(r, /mcp_servers_present:x/);
  assert.match(r, /tool_read_outside_snapshot:\/etc\/hosts/);
  assert.match(r, /non_read_tool_call:Write/);
  assert.match(r, /pinned_model_not_in_modelUsage/);
  // An outside read the host itself denied is a warning, not a failure.
  const denied = clone(ok);
  denied[1].message.content.push({ type: "tool_use", id: "d", name: "Read", input: { file_path: "/etc/hosts" } });
  denied[2].permission_denials = [{ tool_use_id: "d" }];
  const d = claude.auditStream(lines(denied), SNAP, pin);
  assert.deepEqual(d.reasons, []);
  assert.match(d.warnings.join(), /denied by the host/);
});

test("codex argv: read-only sandbox, approval never, ephemeral, user config/rules ignored, pinned model/effort, no bypass", () => {
  const argv = codex.buildArgv(hostPin(policy, "codex"), { snapshot: SNAP, schemaPath: "/tmp/s.json", lastMessagePath: "/tmp/l.txt" });
  assert.equal(argv[0], "exec");
  assert.equal(flagValue(argv, "-m"), policy.hosts.codex.model);
  assert.ok(argv.includes(`model_reasoning_effort="${policy.hosts.codex.effort_map.high}"`));
  assert.equal(flagValue(argv, "-s"), "read-only");
  assert.ok(argv.includes('approval_policy="never"'));
  assert.ok(argv.includes('web_search="disabled"'));
  for (const f of ["--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--output-schema"]) assert.ok(argv.includes(f), f);
  for (const feat of ["multi_agent", "apps", "plugins", "hooks", "browser_use", "computer_use"]) assert.ok(argv.join(" ").includes(`--disable ${feat}`), feat);
  assert.equal(flagValue(argv, "-C"), SNAP);
  assert.equal(argv.at(-1), "-");
  assert.deepEqual(bypassFlags(argv), []);
  for (const f of ["--full-auto", "--dangerously-bypass-approvals-and-sandbox", "--add-dir", "--approve-for-me", "--worktree", "--json", "-p", "--profile"]) assert.ok(!argv.includes(f), f);
  const p = clone(policy);
  p.hosts.codex.model = "gpt-test";
  assert.equal(flagValue(codex.buildArgv(hostPin(p, "codex"), { snapshot: SNAP, schemaPath: "s", lastMessagePath: "l" }), "-m"), "gpt-test");
});

test("codex transcript: header and commands parsed; outside paths and non-read sections flagged", () => {
  const pin = hostPin(policy, "codex");
  const t = codex.parseTranscript([
    "OpenAI Codex v0.167.0", "--------", `workdir: ${SNAP}`, "model: gpt-6.1-sol", "provider: openai", "approval: never", "sandbox: read-only", "reasoning effort: high", "--------",
    "user", "x", "exec", `/bin/zsh -lc 'cat ../outside.txt' in ${SNAP}`, "exec", `/bin/zsh -lc 'sed -n 1,5p src/a.ts 2>/dev/null' in ${SNAP}`, "tokens used", "8,177",
  ].join("\n"));
  assert.equal(t.header.model, "gpt-6.1-sol");
  assert.equal(t.tokens, 8177);
  assert.equal(t.commands.length, 2);
  const a = codex.audit(t, SNAP, pin);
  assert.match(a.reasons.join(), /tool_read_outside_snapshot:1/);
  assert.equal(a.reported.model, "gpt-6.1-sol");
  assert.deepEqual(codex.outsidePaths("/bin/zsh -lc 'cat ~/.codex/auth.json'", SNAP), ["~/.codex/auth.json"]);
  assert.deepEqual(codex.outsidePaths("/bin/zsh -lc 'cat /etc/passwd'", SNAP), ["/etc/passwd"]);
  assert.deepEqual(codex.outsidePaths(`/bin/zsh -lc 'rg -n foo ${SNAP}/src /dev/null'`, SNAP), []);
  const loose = codex.audit(codex.parseTranscript(["--------", "model: gpt-6.1-sol", "approval: on-request", "sandbox: workspace-write", "reasoning effort: low", "--------", "tool github.search(...)"].join("\n")), SNAP, pin);
  const r = loose.reasons.join();
  assert.match(r, /sandbox_not_read_only:workspace-write/);
  assert.match(r, /approval_not_never:on-request/);
  assert.match(r, /effort_mismatch:low/);
  assert.match(r, /non_read_tool_calls:1/);
});

test("antigravity: view_file only, empty MCP list, fs/terminal off, permissions always rejected once", () => {
  assert.deepEqual(ag.ENABLED_TOOLS, ["view_file"]);
  assert.deepEqual(ag.sessionNewParams(SNAP), { cwd: SNAP, mcpServers: [], _meta: { antigravity: { enabledTools: ["view_file"] } } });
  assert.deepEqual(ag.CLIENT_CAPABILITIES.fs, { readTextFile: false, writeTextFile: false });
  assert.equal(ag.CLIENT_CAPABILITIES.terminal, false);
  const opts = [{ kind: "allow_always", optionId: "aa" }, { kind: "allow_once", optionId: "ao" }, { kind: "reject_always", optionId: "ra" }, { kind: "reject_once", optionId: "deny" }];
  assert.deepEqual(ag.permissionOutcome(opts), { outcome: "selected", optionId: "deny" });
  assert.deepEqual(ag.permissionOutcome(opts.slice(0, 3)), { outcome: "cancelled" }); // never allow, never persist a reject
  assert.deepEqual(ag.permissionOutcome(undefined), { outcome: "cancelled" });
});

test("antigravity env: isolated GEMINI_HOME, provider credentials stripped", () => {
  const env = ag.buildEnv({ PATH: "/bin", GEMINI_API_KEY: "k", GOOGLE_APPLICATION_CREDENTIALS: "/c.json", GEMINI_HOME: "/real", Browser: "x" }, { geminiHome: "/iso", tmpDir: "/t", harness: "/h" });
  assert.equal(env.GEMINI_HOME, "/iso");
  assert.equal(env.TMPDIR, "/t");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.ok(!env.BROWSER.includes("open"));
});

test("antigravity turn groups follow the policy and cover every run dimension once", () => {
  assert.deepEqual(ag.groupsFor(["correctness", "tests", "contract_docs"], policy.hosts.antigravity.groups), [["correctness"], ["tests", "contract_docs"]]);
  assert.deepEqual(ag.groupsFor(["security", "perf"], policy.hosts.antigravity.groups), [["security"], ["perf"]]);
  assert.deepEqual(ag.groupsFor(["x"], undefined), [["x"]]);
});

test("antigravity model and thinking level come from the policy", () => {
  const pin = hostPin(policy, "antigravity");
  assert.equal(pin.model, "gemini-4-neon");
  assert.equal(pin.effort, "high");
  assert.equal(pin.idPrefix, "A");
});

test("bypass guard catches =-joined and value forms", () => {
  const bad = ["--add-dir=/x", "--yolo", "--yolo=true", "-y", "--approval-mode=yolo", "--sandbox=danger-full-access", "--dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox", "--allow-dangerously-skip-permissions", "--permission-mode=bypassPermissions", "--full-auto", "--add-dir"];
  assert.deepEqual(bypassFlags(bad), bad);
  assert.deepEqual(bypassFlags(["-s", "workspace-write", "--permission-mode", "acceptEdits", "-c", 'approval_policy="on-failure"', "--approval-mode", "yolo"]), ["workspace-write", "acceptEdits", 'approval_policy="on-failure"', "yolo"]);
  assert.deepEqual(bypassFlags(["--model", "x", "-s", "read-only", "--ephemeral", "-c", 'approval_policy="never"', "--permission-mode", "dontAsk"]), []);
  // Paths and JSON values are not scanned: a temp dir named like a bypass word is not a false positive.
  assert.deepEqual(bypassFlags(["-C", "/tmp/cross-review-snap-YoLo12", "--json-schema", '{"description":"yolo full-auto"}', "-"]), []);
});
