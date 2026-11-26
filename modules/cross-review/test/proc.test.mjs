import { test } from "node:test";
import assert from "node:assert/strict";
import { runProcess } from "../lib/proc.mjs";

const node = process.execPath;

test("output is complete: resolves after stdio drains", async () => {
  const big = 4 * 1024 * 1024;
  const r = await runProcess({ bin: node, args: ["-e", `process.stdout.write("x".repeat(${big}))`], env: process.env, input: "", timeoutMs: 30_000 });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.length, big);
});

test("timeout kills the process group and reports timedOut", async () => {
  const r = await runProcess({ bin: node, args: ["-e", "setInterval(()=>{},1000)"], env: process.env, input: "", timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.ok(r.durationMs < 5000);
});

test("a descendant holding the pipes after the child exits is killed", async () => {
  const script = `require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"}); process.exit(0)`;
  const r = await runProcess({ bin: node, args: ["-e", script], env: process.env, input: "", timeoutMs: 60_000 });
  assert.equal(r.timedOut, false);
  assert.ok(r.durationMs < 10_000, `took ${r.durationMs}`);
});

test("missing timeout falls back to the default instead of killing at once", async () => {
  const r = await runProcess({ bin: node, args: ["-e", "setTimeout(()=>{},200)"], env: process.env, input: "" });
  assert.equal(r.timedOut, false);
  assert.equal(r.code, 0);
});

test("missing binary is a spawn error", async () => {
  const r = await runProcess({ bin: "/nonexistent/bin", args: [], env: process.env, input: "", timeoutMs: 1000 });
  assert.ok(r.spawnError);
});

test("a detached-stdio descendant left in the group is killed after close", async () => {
  const script = `const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); console.log(c.pid); process.exit(0)`;
  const r = await runProcess({ bin: node, args: ["-e", script], env: process.env, input: "", timeoutMs: 60_000 });
  const pid = Number(r.stdout.trim());
  assert.equal(r.leftoversKilled, 1);
  await new Promise((res) => setTimeout(res, 300));
  assert.throws(() => process.kill(pid, 0));
});
