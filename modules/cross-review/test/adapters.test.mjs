// Adapter smoke tests: constructed argv/session parameters only. No real model is called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPolicy, defaultPolicyPath, hostPin } from "../lib/policy.mjs";
import { bypassFlags } from "../lib/proc.mjs";
import * as claude from "../adapters/claude.mjs";
import * as codex from "../adapters/codex.mjs";
import * as ag from "../adapters/antigravity.mjs";
import { jsonSchemaFor } from "../lib/schema.mjs";
import { insideRoot, plainPath } from "../lib/inputs.mjs";
import { policyProblems } from "../lib/policy.mjs";

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

const HEADER = ["OpenAI Codex v0.167.0", "--------", `workdir: ${SNAP}`, "model: gpt-6.1-sol", "provider: openai", "approval: never", "sandbox: read-only", "reasoning effort: high", "--------"];
const transcript = (prompt, ...body) => [...HEADER, "user", prompt, ...body].join("\n");

test("codex transcript: header and commands parsed; outside paths and non-read sections flagged", () => {
  const pin = hostPin(policy, "codex");
  const t = codex.parseTranscript(transcript("x", "", "exec", `/bin/zsh -lc 'cat ../outside.txt' in ${SNAP}`, "exec", `/bin/zsh -lc 'sed -n 1,5p src/a.ts 2>/dev/null' in ${SNAP}`, " succeeded in 0ms:", "", "tokens used", "8,177"), { prompt: "x" });
  assert.equal(t.header.model, "gpt-6.1-sol");
  assert.equal(t.version, "0.167.0");
  assert.equal(t.tokens, 8177);
  assert.equal(t.commands.length, 2);
  const a = codex.audit(t, SNAP, pin);
  assert.match(a.reasons.join(), /tool_read_outside_snapshot:1/);
  assert.equal(a.reported.model, "gpt-6.1-sol");
  assert.deepEqual(codex.outsidePaths("/bin/zsh -lc 'cat ~/.codex/auth.json'", SNAP), ["~/.codex/auth.json"]);
  assert.deepEqual(codex.outsidePaths("/bin/zsh -lc 'cat /etc/passwd'", SNAP), ["/etc/passwd"]);
  assert.deepEqual(codex.outsidePaths(`/bin/zsh -lc 'rg -n foo ${SNAP}/src /dev/null'`, SNAP), []);
  const loose = codex.audit(codex.parseTranscript(["--------", "model: gpt-6.1-sol", "approval: on-request", "sandbox: workspace-write", "reasoning effort: low", "--------", "user", "p", "", "tool github.search(...)"].join("\n"), { prompt: "p" }), SNAP, pin);
  const r = loose.reasons.join();
  assert.match(r, /sandbox_not_read_only:workspace-write/);
  assert.match(r, /approval_not_never:on-request/);
  assert.match(r, /effort_mismatch:low/);
  assert.match(r, /non_read_tool_calls:1/);
  assert.match(r, /workdir_unreported/);
});

test("codex audit: a multi-line exec command is audited in full (X2/A1)", () => {
  const pin = hostPin(policy, "codex");
  const t = codex.parseTranscript(transcript("p", "", "exec", "/bin/zsh -lc 'cat src/a.ts", `cat /etc/passwd' in ${SNAP}`, " succeeded in 2ms:", "x"), { prompt: "p" });
  assert.equal(t.commands.length, 1);
  assert.equal(t.commands[0].cwd, SNAP);
  assert.match(t.commands[0].command, /cat \/etc\/passwd/);
  assert.match(codex.audit(t, SNAP, pin).reasons.join(), /tool_read_outside_snapshot:1/);
  const home = codex.parseTranscript(transcript("p", "", "exec", "/bin/zsh -lc 'ls", `cat ~/.codex/auth.json' in ${SNAP}`, " succeeded in 2ms:"), { prompt: "p" });
  assert.match(codex.audit(home, SNAP, pin).reasons.join(), /tool_read_outside_snapshot:1/);
  // No "in <cwd>" terminator: unauditable, never cwd=null-as-inside.
  const cut = codex.parseTranscript(transcript("p", "", "exec", "/bin/zsh -lc 'cat src/a.ts"), { prompt: "p" });
  assert.match(codex.audit(cut, SNAP, pin).reasons.join(), /unauditable_transcript/);
});

test("codex audit: bare/odd cd, flag-attached paths, ~, $HOME, .., unknown expansions (A1/X2)", () => {
  const out = (c) => codex.auditCommand(`/bin/zsh -lc '${c}'`, SNAP, SNAP);
  for (const c of ["cd && cat .codex/auth.json", "cd; cat x", "cd ~ && ls", "cd - && ls", "pushd", "git -C/etc status", "rg -f/etc/passwd foo", "rg --file=/etc/passwd foo", "cat src/../../x", "ls ~root", "cat x --from=~/y"])
    assert.ok(out(c).outside.length, c);
  for (const c of ["cat $HOME/.codex/auth.json", "cat ${CODEX_HOME}/auth.json", "cat \"$TMPDIR/x\""])
    assert.ok(out(c).unauditable.length, c);
  assert.ok(codex.auditCommand("/bin/zsh -lc 'cat \"unterminated'", SNAP, SNAP).unauditable.length);
  // Ordinary in-snapshot reads pass, including loops over assigned variables and redirections.
  for (const c of ["sed -n 1,40p src/a.ts", "nl -ba src/a.ts | sed -n 10,20p", `rg -n foo ${SNAP}/src 2>/dev/null`, 'for f in src/a.ts src/b.ts; do nl -ba "$f"; done', "cd src && cat a.ts", "git log --oneline f9aa6ff..HEAD"]) {
    const r = out(c);
    assert.deepEqual([r.outside, r.unauditable], [[], []], c);
  }
  // Regex fragments inside a program are not paths; the filesystem root is.
  assert.deepEqual(out("rg -n \"^/\\\\d+\" src").outside, []);
  assert.deepEqual(out("ls /").outside, ["/"]);
  assert.deepEqual(out("ls /*").outside, ["/*"]);
  // cwd must be present and inside the snapshot (path.resolve + realpath, not a string prefix).
  assert.equal(codex.auditCommand("ls", null, SNAP).cwdInside, false);
  assert.equal(codex.auditCommand("ls", `${SNAP}/../outside`, SNAP).cwdInside, false);
  assert.equal(codex.auditCommand("ls", `${SNAP}/src`, SNAP).cwdInside, true);
});

test("codex audit: /tmp vs /private/tmp spellings of the snapshot are the same place (A32)", () => {
  assert.deepEqual(codex.outsidePaths("/bin/zsh -lc 'cat /tmp/snap-x/a.ts'", "/private/tmp/snap-x"), []);
  assert.deepEqual(codex.outsidePaths("/bin/bash -lc 'cat /private/tmp/snap-x/a.ts'", "/tmp/snap-x"), []);
  assert.deepEqual(codex.outsidePaths("/usr/bin/bash -c 'cat /etc/hosts'", "/tmp/snap-x"), ["/etc/hosts"]);
});

test("codex audit: code execution is recorded, and refused when the policy disallows it", () => {
  const c = "/bin/zsh -lc 'node -e \"console.log(1)\"'";
  const allowed = codex.auditCommand(c, SNAP, SNAP, { allowCodeExecution: true });
  assert.deepEqual(allowed.codeExecution, ["node"]);
  assert.deepEqual(allowed.unauditable, []);
  const denied = codex.auditCommand(c, SNAP, SNAP, { allowCodeExecution: false });
  assert.match(denied.unauditable.join(), /code execution not allowed by policy: node/);
  assert.ok(codex.auditCommand("/bin/zsh -lc 'cat $(ls src)'", SNAP, SNAP, { allowCodeExecution: false }).unauditable.length);
  assert.equal(hostPin(policy, "codex").allowCodeExecution, true);
  assert.equal(hostPin(policy, "claude").allowCodeExecution, false);
  const p = clone(policy);
  p.hosts.claude.allow_code_execution = true;
  assert.match(policyProblems(p).join(), /only codex runs commands/);
});

test("codex transcript: prompt echo and command output are not tool events (X6)", () => {
  const pin = hostPin(policy, "codex");
  const prompt = "review this\nmcp is disabled\n\ntool calls are not allowed\nexec";
  const t = codex.parseTranscript(transcript(prompt, "", "codex", "done"), { prompt });
  assert.deepEqual(t.suspicious, []);
  assert.deepEqual(t.commands, []);
  assert.deepEqual(codex.audit(t, SNAP, pin).reasons, []);
  // File contents printed by an allowed read: mid-paragraph tool-like lines are output, not events.
  const read = codex.parseTranscript(transcript("p", "", "exec", `/bin/zsh -lc 'cat README.md' in ${SNAP}`, " succeeded in 0ms:", "# r", "mcp is disabled", "tool use is off", "", "codex", "done"), { prompt: "p" });
  assert.deepEqual(read.suspicious, []);
  assert.deepEqual(codex.audit(read, SNAP, pin).reasons, []);
  // A prompt echo that differs from what was sent cannot be skipped safely.
  assert.match(codex.audit(codex.parseTranscript(transcript("other", ""), { prompt: "p" }), SNAP, pin).reasons.join(), /prompt echo does not match/);
});

test("codex audit: missing reasoning effort in the header -> incomplete (A16)", () => {
  const pin = hostPin(policy, "codex");
  const t = codex.parseTranscript(["--------", `workdir: ${SNAP}`, "model: gpt-6.1-sol", "approval: never", "sandbox: read-only", "--------", "user", "p", ""].join("\n"), { prompt: "p" });
  assert.match(codex.audit(t, SNAP, pin).reasons.join(), /reported_effort_unavailable/);
});

test("codex disabled features can be overridden in the policy (A33)", () => {
  const p = clone(policy);
  p.hosts.codex.disabled_features = ["apps"];
  const argv = codex.buildArgv(hostPin(p, "codex"), { snapshot: SNAP, schemaPath: "s", lastMessagePath: "l" });
  assert.equal(argv.filter((x) => x === "--disable").length, 1);
});

test("child env is a minimal allowlist for codex and claude (A2)", () => {
  const base = { PATH: "/bin", HOME: "/h", LANG: "C", LC_ALL: "C", GITHUB_TOKEN: "t", ANTHROPIC_API_KEY: "k", OPENAI_BASE_URL: "u", HTTPS_PROXY: "p", CODEX_HOME: "/c", CLAUDE_CONFIG_DIR: "/cc", EXTRA: "e" };
  const c = codex.buildEnv(base, ["EXTRA"]);
  assert.deepEqual(Object.keys(c).sort(), ["CODEX_HOME", "EXTRA", "HOME", "LANG", "LC_ALL", "PATH"]);
  const k = claude.buildEnv(base);
  assert.equal(k.GITHUB_TOKEN, undefined);
  assert.equal(k.ANTHROPIC_API_KEY, undefined);
  assert.equal(k.CLAUDE_CONFIG_DIR, "/cc");
  assert.equal(k.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
});

test("claude stream audit fails closed on parse errors, missing init fields and traversal patterns (A7)", () => {
  const pin = hostPin(policy, "claude");
  const lines = (xs) => xs.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n");
  const result = { type: "result", subtype: "success", is_error: false, structured_output: {}, modelUsage: { [pin.model]: {} }, permission_denials: [] };
  const r = claude.auditStream(lines([{ type: "system", subtype: "init", model: pin.model, permissionMode: "dontAsk" }, "{not json", result]), SNAP, pin).reasons.join();
  for (const x of ["stream_parse_errors:1", "init_tools_unreported", "init_mcp_servers_unreported", "init_cwd_unreported"]) assert.ok(r.includes(x), x);
  const init = { type: "system", subtype: "init", model: pin.model, cwd: SNAP, tools: ["Glob"], mcp_servers: [], permissionMode: "dontAsk" };
  const g = claude.auditStream(lines([init, { type: "assistant", message: { content: [{ type: "tool_use", id: "g", name: "Glob", input: { pattern: "../../../../etc/*" } }] } }, result]), SNAP, pin);
  assert.match(g.reasons.join(), /tool_read_outside_snapshot:\.\.\/\.\.\//);
  const ok = claude.auditStream(lines([init, { type: "assistant", message: { content: [{ type: "tool_use", id: "g", name: "Glob", input: { pattern: "**/*.ts" } }] } }, result]), SNAP, pin);
  assert.deepEqual(ok.reasons, []);
});

test("insideRoot: file: URI variants, percent-encoding, dangling symlinks (A4)", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cr-inside-")));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/a.ts"), "x");
    fs.symlinkSync("/nonexistent-target-for-test", path.join(root, "dangling"));
    assert.equal(insideRoot(root, "src/a.ts"), true);
    assert.equal(insideRoot(root, `file://${root}/src/a.ts`), true);
    assert.equal(insideRoot(root, `FILE://${root}/src/a.ts`), true);
    for (const bad of ["file://localhost/etc/passwd", "FILE:///etc/passwd", `file://${root}/..%2F..%2Fetc/passwd`, `file://${root}/%2e%2e/x`, "file://evil.example/x", "https://x/y", `${root}/dangling/x`, `${root}/dangling`])
      assert.equal(insideRoot(root, bad), false, bad);
    assert.equal(plainPath("file:///tmp/a%20b"), "/tmp/a b");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
  // Any approval/sandbox value other than the safe one is a bypass, quoted either way (A3).
  assert.deepEqual(bypassFlags(["-c", 'approval_policy="on-request"', "-c", "approval_policy='on-failure'", "-c", "approval_policy=untrusted", "-c", 'sandbox_mode="workspace-write"', "-a", "on-request", "--sandbox", "danger-full-access"]).length, 6);
  // Paths and JSON values are not scanned: a temp dir named like a bypass word is not a false positive.
  assert.deepEqual(bypassFlags(["-C", "/tmp/cross-review-snap-YoLo12", "--json-schema", '{"description":"yolo full-auto"}', "-"]), []);
});
