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
import * as sandbox from "../lib/sandbox.mjs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const HERE_A = path.dirname(fileURLToPath(import.meta.url));

const { policy } = loadPolicy(defaultPolicyPath());
const clone = (x) => JSON.parse(JSON.stringify(x));
const schema = jsonSchemaFor(["correctness"]);
const SNAP = "/tmp/snap-x";
const flagValue = (argv, f) => argv[argv.indexOf(f) + 1];
const PERM = sandbox.profileArgs(sandbox.permissionProfile({ snapshot: SNAP, codexRoot: "/opt/codex/1.0.0", name: "cross_review_test" }));

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
  // A39: Grep's pattern is a regex over contents, never a path; Glob patterns and Grep path/glob still are.
  const grep = clone(ok);
  for (const [id, pattern] of [["g1", "../lib/proc.mjs"], ["g2", "/etc/passwd"], ["g3", "~/"]]) grep[1].message.content.push({ type: "tool_use", id, name: "Grep", input: { pattern } });
  assert.deepEqual(claude.auditStream(lines(grep), SNAP, pin).reasons, []);
  const glob = clone(ok);
  glob[1].message.content.push({ type: "tool_use", id: "h1", name: "Glob", input: { pattern: "/etc/*" } });
  glob[1].message.content.push({ type: "tool_use", id: "h2", name: "Grep", input: { pattern: "x", path: "/etc" } });
  glob[1].message.content.push({ type: "tool_use", id: "h3", name: "Grep", input: { pattern: "x", glob: "../**/*.env" } });
  const gr = claude.auditStream(lines(glob), SNAP, pin).reasons.join("\n");
  assert.match(gr, /tool_read_outside_snapshot:\/etc\/\*/);
  assert.match(gr, /tool_read_outside_snapshot:\/etc$/m);
  assert.match(gr, /tool_read_outside_snapshot:\.\.\/\*\*\/\*\.env/);
  // A48: brace alternatives are audited one by one.
  const brace = clone(ok);
  for (const [id, name, input] of [["b1", "Glob", { pattern: "{/etc/passwd,src/*}" }], ["b2", "Glob", { pattern: "{../outside/*,src/*}" }], ["b3", "Grep", { pattern: "x", glob: "{~/.codex/*,src/*}" }], ["b4", "Glob", { pattern: "src/{a,b}/*.ts" }]])
    brace[1].message.content.push({ type: "tool_use", id, name, input });
  const br = claude.auditStream(lines(brace), SNAP, pin).reasons;
  assert.equal(br.length, 3, br.join());
  assert.ok(br.every((r) => /^tool_read_outside_snapshot:\{/.test(r)));
});

test("codex argv: read-only sandbox, approval never, ephemeral, user config/rules ignored, pinned model/effort, no bypass", () => {
  const pinC = hostPin(policy, "codex");
  const argv = codex.buildArgv(pinC, { snapshot: SNAP, schemaPath: "/tmp/s.json", lastMessagePath: "/tmp/l.txt", permissionArgs: PERM });
  assert.equal(argv[0], "exec");
  assert.equal(flagValue(argv, "-m"), policy.hosts.codex.model);
  assert.ok(argv.includes(`model_reasoning_effort="${policy.hosts.codex.effort_map.high}"`));
  assert.ok(!argv.includes("-s"), "the permission profile replaces -s read-only");
  // There is no profile-less mode any more (audit_only removed).
  assert.throws(() => codex.buildArgv(pinC, { snapshot: SNAP, schemaPath: "s", lastMessagePath: "l" }), /permission profile/);
  assert.ok(argv.includes('approval_policy="never"'));
  assert.ok(argv.includes('web_search="disabled"'));
  for (const f of ["--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--output-schema"]) assert.ok(argv.includes(f), f);
  for (const feat of ["multi_agent", "apps", "plugins", "hooks", "browser_use", "computer_use"]) assert.ok(argv.join(" ").includes(`--disable ${feat}`), feat);
  assert.equal(flagValue(argv, "-C"), SNAP);
  assert.equal(argv.at(-1), "-");
  assert.deepEqual(bypassFlags(argv, { allowedConfig: codex.allowedConfig(pinC, PERM) }), []);
  for (const f of ["--full-auto", "--dangerously-bypass-approvals-and-sandbox", "--add-dir", "--approve-for-me", "--worktree", "--json", "-p", "--profile"]) assert.ok(!argv.includes(f), f);
  const p = clone(policy);
  p.hosts.codex.model = "gpt-test";
  assert.equal(flagValue(codex.buildArgv(hostPin(p, "codex"), { snapshot: SNAP, schemaPath: "s", lastMessagePath: "l", permissionArgs: PERM }), "-m"), "gpt-test");
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
  // Evidence names the offending command and path (operator 3); since r3 it is a warning, never a reason.
  assert.deepEqual(a.reasons, []);
  assert.match(a.warnings.join(), /shell audit \(evidence only\): \/bin\/zsh -lc 'cat \.\.\/outside\.txt': literal read outside \.\.\/outside\.txt/);
  assert.equal(a.reported.model, "gpt-6.1-sol");
  assert.deepEqual(codex.outsidePaths("/bin/zsh -lc 'cat ~/.codex/auth.json'", SNAP), ["~/.codex/auth.json"]);
  assert.deepEqual(codex.outsidePaths("/bin/zsh -lc 'cat /etc/passwd'", SNAP), ["/etc/passwd"]);
  assert.deepEqual(codex.outsidePaths(`/bin/zsh -lc 'rg -n foo ${SNAP}/src /dev/null'`, SNAP), []);
  const loose = codex.audit(codex.parseTranscript(["--------", "model: gpt-6.1-sol", "approval: on-request", "sandbox: workspace-write", "reasoning effort: low", "--------", "user", "p", "", "tool github.search(...)"].join("\n"), { prompt: "p" }), SNAP, pin);
  const r = loose.reasons.join();
  assert.match(r, /sandbox_not_read_only:workspace-write/);
  assert.match(r, /approval_not_never:on-request/);
  assert.match(r, /effort_mismatch:low/);
  assert.match(r, /non_read_tool_calls:tool github\.search/);
  assert.match(r, /workdir_unreported/);
});

test("codex audit: a multi-line exec command is audited in full (X2/A1)", () => {
  const pin = hostPin(policy, "codex");
  const t = codex.parseTranscript(transcript("p", "", "exec", "/bin/zsh -lc 'cat src/a.ts", `cat /etc/passwd' in ${SNAP}`, " succeeded in 2ms:", "x"), { prompt: "p" });
  assert.equal(t.commands.length, 1);
  assert.equal(t.commands[0].cwd, SNAP);
  assert.match(t.commands[0].command, /cat \/etc\/passwd/);
  assert.match(codex.audit(t, SNAP, pin).warnings.join(), /literal read outside \/etc\/passwd/);
  const home = codex.parseTranscript(transcript("p", "", "exec", "/bin/zsh -lc 'ls", `cat ~/.codex/auth.json' in ${SNAP}`, " succeeded in 2ms:"), { prompt: "p" });
  assert.match(codex.audit(home, SNAP, pin).warnings.join(), /literal read outside ~\/\.codex\/auth\.json/);
  assert.deepEqual(codex.audit(home, SNAP, pin).reasons, []);
  // No "in <cwd>" terminator: not a command block (X6: an `exec` line inside command output); counted, never cwd=null-as-inside.
  const cut = codex.parseTranscript(transcript("p", "", "exec", "/bin/zsh -lc 'cat src/a.ts"), { prompt: "p" });
  assert.equal(cut.commands.length, 0);
  assert.equal(cut.execLinesIgnored, 1);
  assert.deepEqual(codex.audit(cut, SNAP, pin).reasons, []);
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

test("codex audit: a symlinked spelling of the snapshot is the same place (A32), portable (A43/X17)", () => {
  // An explicit alias in a temp dir instead of assuming macOS /tmp -> /private/tmp.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-alias-")));
  try {
    const realSnap = path.join(base, "real-snap");
    fs.mkdirSync(realSnap);
    const alias = path.join(base, "alias");
    fs.symlinkSync(realSnap, alias);
    assert.deepEqual(codex.outsidePaths(`/bin/zsh -lc 'cat ${alias}/a.ts'`, realSnap), []);
    assert.deepEqual(codex.outsidePaths(`/bin/bash -lc 'cat ${realSnap}/a.ts'`, alias), []);
    assert.deepEqual(codex.outsidePaths("/usr/bin/bash -c 'cat /etc/hosts'", alias), ["/etc/hosts"]);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("codex audit (secondary): r2 bypasses are now seen; interpreter literals are warnings, not incomplete (A35-A38, X10, X13, X14, R2)", () => {
  const pin = hostPin(policy, "codex");
  const ac = (c, o = {}) => codex.auditCommand(`/bin/zsh -lc '${c}'`, SNAP, SNAP, o);
  const zq = (c) => codex.auditCommand(`/bin/zsh -lc "${c}"`, SNAP, SNAP);
  // A35/X11: ANSI-C and locale quoting are flagged as unauditable expansions.
  assert.match(zq("cat $'/etc/passwd'").unauditable.join(), /expansion \$'/);
  assert.match(zq('cat $\\"/etc/passwd\\"').unauditable.join(), /expansion \$"/);
  // A36/X10: assignments count only in order and in command position.
  assert.match(ac('echo HOME=src; cat "$HOME/.codex/auth.json"').unauditable.join(), /expansion \$HOME/);
  assert.match(ac("cat $HOME/.codex/auth.json; HOME=1").unauditable.join(), /expansion \$HOME/);
  assert.match(ac("true HOME= && cat $HOME/x").unauditable.join(), /expansion \$HOME/);
  assert.deepEqual(ac('f=src/a.ts; cat "$f"').unauditable, []);
  // A37/X13: a leading redirection or prefix options keep command position.
  assert.ok(ac(">/dev/null cd && cat .codex/auth.json").hard.length);
  assert.deepEqual(ac('</dev/null node -e "console.log(1)"').codeExecution, ["node"]);
  assert.deepEqual(ac('command -p node -e "console.log(1)"').codeExecution, ["node"]);
  assert.deepEqual(ac('nice -n 0 python3 -c "print(1)"').codeExecution, ["python3"]);
  assert.match(ac('2>/dev/null node -e "1"', { allowCodeExecution: false }).unauditable.join(), /code execution not allowed by policy: node/);
  // A38/X14: glob and non-ASCII root paths are paths.
  assert.deepEqual(ac("cat /?tc/passwd").hard, ["/?tc/passwd"]);
  assert.deepEqual(ac("cat /비공개/secret.txt").hard, ["/비공개/secret.txt"]);
  // R2: literal paths inside an interpreter program or a grep pattern are not hard violations.
  assert.deepEqual(ac(`node -e "require(\\"fs\\").statSync(\\"/etc/passwd\\")"`).hard, []);
  assert.deepEqual(ac('rg -n "/etc/passwd" src').hard, []);
  assert.deepEqual(ac("grep -e /etc/hosts src/a.ts").hard, []);
  assert.deepEqual(ac("rg -n foo /etc").hard, ["/etc"]);
  const t = codex.parseTranscript(transcript("p", "", "exec", `/bin/zsh -lc 'node -e "console.log(\\"/etc/passwd\\")"' in ${SNAP}`, " succeeded in 0ms:", "/etc/passwd"), { prompt: "p" });
  const a = codex.audit(t, SNAP, pin);
  assert.deepEqual(a.reasons, []);
  assert.match(a.warnings.join(), /shell audit \(evidence only\).*outside \/etc\/passwd/);
});

test("codex audit (r3): never an incomplete reason; ls of an allowed runtime path, cwd outside, code execution are warnings (X21/A51/X10)", () => {
  const pin = hostPin(policy, "codex");
  const cmds = ["ls -l /Users/u/.local/share/node/v22.23.5/bin/node", "cat /etc/hosts", 'echo read HOME; cat "$HOME/.codex/auth.json"', "/bin/zsh -lc 'cat /etc/hosts' _"];
  const t = codex.parseTranscript(transcript("p", "", ...cmds.flatMap((c) => ["exec", `/bin/zsh -lc ${JSON.stringify(c).replace(/^"|"$/g, "'")} in /etc`, " succeeded in 0ms:", "x", ""])), { prompt: "p" });
  const a = codex.audit(t, SNAP, { ...pin, allowCodeExecution: false });
  assert.deepEqual(a.reasons, []);
  assert.ok(a.warnings.length >= 3, a.warnings.join("\n"));
  assert.match(a.warnings.join(), /cwd \/etc/);
  // X21: echo/printf print literals: outside (evidence) but not a literal read.
  const ac = (c) => codex.auditCommand(`/bin/zsh -lc '${c}'`, SNAP, SNAP);
  assert.deepEqual(ac("echo /etc/hosts").hard, []);
  assert.deepEqual(ac("printf %s\\n /etc/hosts").hard, []);
  assert.deepEqual(ac("cat /etc/hosts").hard, ["/etc/hosts"]);
  // A51.1: a redirection target is not cd's operand: bare cd behind a redirection still leaves the snapshot.
  assert.match(ac("cd >/dev/null && cat .codex/auth.json").hard.join(), /cd without a target/);
});

test("codex audit: grep/rg/sed -f FILE reads FILE (X20); -e PATTERN does not", () => {
  const ac = (c) => codex.auditCommand(`/bin/zsh -lc '${c}'`, SNAP, SNAP);
  assert.deepEqual(ac("rg -f /etc/hosts .").hard, ["/etc/hosts"]);
  assert.deepEqual(ac("grep --file /etc/hosts src/a.ts").hard, ["/etc/hosts"]);
  assert.deepEqual(ac("sed -f /etc/hosts src/a.ts").hard, ["/etc/hosts"]);
  assert.deepEqual(ac("grep --file=/etc/hosts src/a.ts").hard, ["/etc/hosts"]);
  assert.deepEqual(ac("grep -e /etc/hosts src/a.ts").hard, []);
  // After -f the first positional is a file, not the pattern.
  assert.deepEqual(ac("grep -f src/p.txt /etc/hosts").hard, ["/etc/hosts"]);
});

test("codex transcript: an exec line inside command output is not a tool event (X6)", () => {
  const pin = hostPin(policy, "codex");
  const t = codex.parseTranscript(transcript("p", "", "exec", `/bin/zsh -lc 'cat notes.txt' in ${SNAP}`, " succeeded in 0ms:", "the word", "exec", "appears in this file", "and so does a path /etc/hosts", "", "codex", "done"), { prompt: "p" });
  assert.equal(t.commands.length, 1);
  assert.equal(t.execLinesIgnored, 1);
  assert.deepEqual(codex.audit(t, SNAP, pin).reasons, []);
  // X6: a stray exec in output never searches past the next exec marker, so it cannot swallow a real command.
  const x6 = codex.parseTranscript(transcript("p", "", "exec", `/bin/zsh -lc 'cat notes.txt' in ${SNAP}`, " succeeded in 0ms:", "exec", "", "exec", `/bin/zsh -lc 'cat /etc/hosts' in ${SNAP}`, " succeeded in 0ms:", "127.0.0.1 localhost"), { prompt: "p" });
  assert.deepEqual(x6.commands.map((c) => c.command), ["/bin/zsh -lc 'cat notes.txt'", "/bin/zsh -lc 'cat /etc/hosts'"]);
  assert.equal(x6.execLinesIgnored, 1);
  assert.match(codex.audit(x6, SNAP, pin).warnings.join(), /literal read outside \/etc\/hosts/);
  // Sandbox denials are not counted from output text (r3: "Operation not permitted" printed by nl/cat is not a denial).
  const d = codex.parseTranscript(transcript("p", "", "exec", `/bin/zsh -lc 'nl -ba doc.md' in ${SNAP}`, " succeeded in 0ms:", "  12 fails with Operation not permitted"), { prompt: "p" });
  assert.equal(d.denied, undefined);
});

test("codex argv: the generated permission profile replaces -s read-only; the guard refuses write/builtin profiles", () => {
  const pin = hostPin(policy, "codex");
  const prof = sandbox.permissionProfile({ snapshot: SNAP, codexRoot: "/opt/codex/1.0.0", name: "cross_review_test" });
  const perm = sandbox.profileArgs(prof);
  const argv = codex.buildArgv(pin, { snapshot: SNAP, schemaPath: "s", lastMessagePath: "l", permissionArgs: perm });
  assert.ok(!argv.includes("-s"), "-s read-only would override the profile with full-disk read");
  assert.ok(argv.includes('default_permissions="cross_review_test"'));
  const allowedConfig = codex.allowedConfig(pin, perm);
  assert.deepEqual(bypassFlags(argv, { allowedConfig }), []);
  // A50: without the run's exact allowlist, the generated profile itself is refused (nothing sensitive is implicit).
  assert.ok(bypassFlags(argv).length >= 2);
  assert.deepEqual(Object.values(prof.filesystem).filter((v) => v !== "read" && v !== "none"), []);
  assert.equal(prof.filesystem["/private/tmp"], "none");
  assert.deepEqual(bypassFlags(["-c", 'default_permissions=":danger-full-access"']), ['default_permissions=":danger-full-access"']);
  assert.deepEqual(bypassFlags(["-c", 'default_permissions=":workspace"']), ['default_permissions=":workspace"']);
  assert.deepEqual(bypassFlags(["-c", 'permissions.x.filesystem={"/"="write"}']), ['permissions.x.filesystem={"/"="write"}']);
  assert.deepEqual(bypassFlags(["-c", "permissions.x.network.enabled=true"]), ["permissions.x.network.enabled=true"]);
  // A50: every other spelling touching permissions/sandbox/approval/network/features is refused, even next to an allowlist.
  const evil = ['permissions={x={filesystem={"/"="write"},network={enabled=true}}}', "permissions.x.filesystem={'/'='write'}", 'permissions.x.filesystem."/"="write"',
    `permissions.cross_review_test.filesystem={":minimal"="read", "/"="read"}`, 'default_permissions="other"', "features.shell_tool=true", '"sandbox_mode"="danger-full-access"', "approval_policy='on-request'", "sandbox_workspace_write.network_access=true"];
  for (const v of evil) assert.deepEqual(bypassFlags(["-c", v], { allowedConfig }), [v], v);
  assert.deepEqual(bypassFlags([`--config=${evil[0]}`], { allowedConfig }), [`--config=${evil[0]}`]);
  assert.deepEqual(bypassFlags([`-c${evil[1]}`], { allowedConfig }), [`-c${evil[1]}`]);
  for (const f of ["--enable", "-P", "--permission-profile", "--sandbox-state-readable-root", "--sandbox-state-json"]) assert.deepEqual(bypassFlags([f, "x"], { allowedConfig }), [f], f);
  // Non-sensitive overrides stay allowed.
  assert.deepEqual(bypassFlags(["-c", 'model_reasoning_effort="high"', "-c", 'model="gpt"'], { allowedConfig }), []);
});

test("sandbox runtime grants: exact package dir or the binary file, never a shared prefix; DENY entries win (X18/A52)", () => {
  const H = "/Users/alice";
  assert.equal(sandbox.installRoot("/usr/local/bin/node"), "/usr/local/bin/node");
  assert.equal(sandbox.installRoot(`${H}/bin/codex`), `${H}/bin/codex`);
  assert.equal(sandbox.installRoot(`${H}/.local/bin/codex`), `${H}/.local/bin/codex`);
  assert.equal(sandbox.installRoot("/opt/homebrew/bin/codex"), "/opt/homebrew/bin/codex");
  assert.equal(sandbox.installRoot("/bin/codex"), "/bin/codex");
  assert.equal(sandbox.installRoot(`${H}/.codex/packages/standalone/releases/0.172.0-aarch64-apple-darwin/bin/codex`), `${H}/.codex/packages/standalone/releases/0.172.0-aarch64-apple-darwin`);
  assert.equal(sandbox.installRoot(`${H}/.local/share/node/v22.23.5/bin/node`), `${H}/.local/share/node/v22.23.5`);
  assert.equal(sandbox.installRoot("/opt/homebrew/Cellar/node/22.1.0/bin/node"), "/opt/homebrew/Cellar/node/22.1.0");
  assert.equal(sandbox.installRoot(`${H}/.nvm/versions/node/v22.0.0/bin/node`), `${H}/.nvm/versions/node/v22.0.0`);
  assert.equal(sandbox.installRoot("/usr/local/lib/node_modules/@openai/codex/bin/codex.js"), "/usr/local/lib/node_modules/@openai/codex");
  // Grants that are or contain /, $HOME, CODEX_HOME or a denied path are refused; runtime grants inside a denied path too.
  const mk = (codexRoot, o = {}) => () => sandbox.permissionProfile({ snapshot: "/var/snap", codexRoot, home: H, codexHome: `${H}/.codex`, name: "cross_review_t", ...o });
  for (const bad of ["/", H, `${H}/.codex`, "/private", "/private/tmp", "/private/tmp/bin/codex", "/private/var/tmp/x"]) assert.throws(mk(bad), /read grant/, bad);
  assert.throws(mk("/opt/c/1.0", { snapshot: H }), /\$HOME/);
  const ok = mk(`${H}/.codex/packages/standalone/releases/0.172.0/bin/codex`)();
  assert.equal(ok.filesystem["/private/tmp"], "none");
  assert.equal(ok.filesystem["/private/var/tmp"], "none");
  // Denials are written after the grants, so nothing can overwrite them.
  assert.deepEqual(Object.keys(ok.filesystem).slice(-2), ["/private/tmp", "/private/var/tmp"]);
});

test("sandbox runtime grant: a codex binary in a fake shared prefix exposes only itself, not a sentinel next to it (X18)", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-prefix-")));
  try {
    fs.mkdirSync(path.join(base, "prefix", "bin"), { recursive: true });
    fs.mkdirSync(path.join(base, "prefix", "etc"));
    const exe = path.join(base, "prefix", "bin", "codex");
    fs.writeFileSync(exe, "binary\n", { mode: 0o755 });
    const sentinel = path.join(base, "prefix", "etc", "sentinel.txt");
    fs.writeFileSync(sentinel, "harmless sentinel\n");
    const rt = sandbox.codexRuntime("codex", path.join(base, "prefix", "bin"));
    assert.equal(rt.root, exe);
    const prof = sandbox.permissionProfile({ snapshot: path.join(base, "snap"), codexRoot: rt.root, name: "cross_review_t" });
    const grants = Object.entries(prof.filesystem).filter(([k, v]) => v === "read" && k.startsWith("/")).map(([k]) => k);
    assert.ok(!grants.some((g) => sentinel === g || sentinel.startsWith(g + path.sep)), grants.join());
    if (sandbox.sandboxAvailable()) {
      // Enforced by the profile-interpreting stand-in (real sandbox-exec): the sentinel is unreadable, the binary readable.
      const fake = path.join(HERE_A, "fixtures", "fake-codex.mjs");
      const sx = (f) => spawnSync(process.execPath, [fake, "sandbox", ...sandbox.profileArgs(prof), "--", "/bin/cat", f], { encoding: "utf8" });
      assert.notEqual(sx(sentinel).status, 0);
      assert.match(sx(sentinel).stderr, /Operation not permitted/);
      assert.equal(sx(exe).status, 0, sx(exe).stderr);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
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
  const argv = codex.buildArgv(hostPin(p, "codex"), { snapshot: SNAP, schemaPath: "s", lastMessagePath: "l", permissionArgs: PERM });
  assert.equal(argv.filter((x) => x === "--disable").length, 1);
  // A53: the self-test uses exactly the same config flags as codex exec.
  const cfg = codex.configArgs(hostPin(p, "codex"), PERM);
  const at = argv.indexOf(cfg[1]) - 1;
  assert.deepEqual(argv.slice(at, at + cfg.length), cfg);
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
