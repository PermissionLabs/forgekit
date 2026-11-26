#!/usr/bin/env node
// Stand-in for `codex exec` (plain mode): stderr transcript header + -o last message. No model call.
// `fake-codex sandbox -c default_permissions=.. -c permissions.<p>.filesystem={..} -- cmd...` confines cmd like
// codex's Seatbelt would: the profile's read/none entries become a real sandbox-exec SBPL profile (macOS only).
// FAKE_SANDBOX_NOOP=1 runs cmd unconfined (a sandbox that does not enforce).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "sandbox") {
  const dash = args.indexOf("--");
  const cmd = args.slice(dash + 1);
  const fsArg = args.find((a) => /^permissions\.[a-z0-9_]+\.filesystem=/.test(a)) ?? "";
  const entries = [...fsArg.matchAll(/"([^"]+)"="(read|none|write)"/g)].map((m) => [m[1], m[2]]);
  if (process.env.FAKE_SANDBOX_NOOP) { const r = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" }); process.exit(r.status ?? 1); }
  if (process.platform !== "darwin") { process.stderr.write("sandbox-exec: Operation not permitted\n"); process.exit(71); }
  // Like codex's Seatbelt profile (A62): ":minimal" grants the platform set, which includes the shared temp areas
  // /private/tmp and /private/var/tmp; entries are emitted in profile order and the last matching rule wins, so a
  // later "none" entry is what denies those areas (drop it and they become readable, as with real codex).
  const q = (p) => `"${p}"`;
  const MINIMAL = ["/usr/lib", "/usr/share", "/System", "/bin", "/usr/bin", "/private/var/db/dyld", "/dev", "/private/tmp", "/private/var/tmp"];
  const rules = entries.flatMap(([p, v]) => {
    if (p === ":minimal") return v === "read" ? [`(allow file-read* (literal "/") ${MINIMAL.map((m) => `(subpath ${q(m)})`).join(" ")})`] : [];
    if (!p.startsWith("/")) return [];
    return [v === "none" ? `(deny file-read* (subpath ${q(p)}))` : `(allow file-read* (subpath ${q(p)}))`];
  });
  const sbpl = ["(version 1)", "(allow default)", "(deny file-read*)", "(allow file-read-metadata)", ...rules,
    "(deny file-write*)", '(allow file-write* (literal "/dev/null"))', "(deny network*)"].join("\n");
  const r = spawnSync("/usr/bin/sandbox-exec", ["-p", sbpl, ...cmd], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
const prompt = fs.readFileSync(0, "utf8");
if (process.env.FAKE_ARGV_OUT) fs.writeFileSync(process.env.FAKE_ARGV_OUT, JSON.stringify(args));
if (process.env.FAKE_ENV_OUT) fs.writeFileSync(process.env.FAKE_ENV_OUT, JSON.stringify(Object.keys(process.env)));
const val = (f) => args[args.indexOf(f) + 1];
const effort = (args.find((a) => a.startsWith("model_reasoning_effort=")) ?? "").replace(/^.*="?|"$/g, "");
const cwd = val("-C");
const e = (s) => process.stderr.write(s + "\n");
e("OpenAI Codex v0.167.0");
e("--------");
e(`workdir: ${cwd}`);
e(`model: ${process.env.FAKE_REPORTED_MODEL ?? val("-m")}`);
e("provider: openai");
e(`approval: ${process.env.FAKE_APPROVAL ?? "never"}`);
e(`sandbox: ${process.env.FAKE_SANDBOX ?? "read-only"}`);
const isRetry = prompt.includes("=== CORRECTION ===");
if (!process.env.FAKE_NO_EFFORT && !(isRetry && process.env.FAKE_NO_EFFORT_ON_RETRY)) e(`reasoning effort: ${effort}`);
e("session id: 00000000-0000-0000-0000-000000000000");
e("--------");
e("user");
e(process.env.FAKE_PROMPT_ECHO ?? prompt); // codex echoes the prompt it received
e("");
e("codex");
e("Reading the files.");
e("");
e("exec");
e(`/bin/zsh -lc '${process.env.FAKE_COMMAND ?? "sed -n 1,40p src/a.ts"}' in ${cwd}`);
e(" succeeded in 0ms:");
e(process.env.FAKE_COMMAND_OUTPUT ?? "export const a = 1;");
e("");
e("codex");
e("done");
e("tokens used");
e("1,234");
const outs = (process.env.FAKE_OUTPUTS ?? process.env.FAKE_REVIEW).split("\n---\n");
const out = outs[Math.min(val("-o").includes("retry") ? 1 : 0, outs.length - 1)];
if (!process.env.FAKE_NO_O) fs.writeFileSync(val("-o"), process.env.FAKE_EMPTY_O ? "" : out);
process.stdout.write(process.env.FAKE_STDOUT ?? out);
