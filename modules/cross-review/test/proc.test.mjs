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

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const settle = () => new Promise((res) => setTimeout(res, 300));

test("timeout kills the whole process group (child and its descendant) and reports timedOut", async () => {
  const script = `const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore","ignore","ignore"]}); console.log(c.pid); setInterval(()=>{},1000)`;
  const r = await runProcess({ bin: node, args: ["-e", script], env: process.env, input: "", timeoutMs: 1500 });
  assert.equal(r.timedOut, true);
  assert.ok(r.durationMs < 8000);
  const pid = Number(r.stdout.trim());
  assert.ok(pid > 0);
  await settle();
  assert.equal(alive(pid), false, "descendant in the group survived the timeout");
});

test("a descendant holding the pipes after the child exits is killed through the group", async () => {
  const script = `const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"}); console.log(c.pid); process.exit(0)`;
  const r = await runProcess({ bin: node, args: ["-e", script], env: process.env, input: "", timeoutMs: 60_000 });
  assert.equal(r.timedOut, false);
  assert.equal(r.pipesAbandoned, false, "pipes were dropped instead of the descendant being killed");
  assert.ok(r.durationMs < 10_000, `took ${r.durationMs}`);
  const pid = Number(r.stdout.trim());
  await settle();
  assert.equal(alive(pid), false);
  assert.ok(r.signals.some((x) => x.sig === "SIGTERM" && /members:/.test(x.held ?? "")));
});

test("after the child exits, an empty process group is never signalled (X3/A19)", async () => {
  // The child exits; a setsid'd descendant keeps the pipes, so 'close' never comes, but the child's own
  // group is empty and its pgid could be reused: no signal may target it.
  const kills = [];
  const script = `const c=require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},20000)"],{detached:true,stdio:"inherit"}); console.log(c.pid); c.unref(); process.exit(0)`;
  const r = await runProcess({ bin: node, args: ["-e", script], env: process.env, input: "", timeoutMs: 60_000 },
    { kill: (pid, sig) => { kills.push([pid, sig]); process.kill(pid, sig); }, graceMs: 200 });
  const pid = Number(r.stdout.trim());
  if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
  assert.equal(r.pipesAbandoned, true);
  assert.deepEqual(kills.filter(([p]) => p < 0), []);
  assert.ok(r.signals.every((x) => x.skipped === "no live group member"));
});

test("after exit, a reused pgid reported by ps is the only case signalled; a stale empty one is skipped (mocked)", async () => {
  // Mocked spawn: the child "exits" at once while its pipes stay open; members() decides membership.
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const fake = () => {
    const c = new EventEmitter();
    c.pid = 424242;
    c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.stdin = new PassThrough();
    setTimeout(() => c.emit("exit", 0, null), 10);
    return c;
  };
  const keep = setInterval(() => {}, 1000); // the mock has no real handles keeping the loop alive
  try {
    const kills = [];
    const r = await runProcess({ bin: "x", args: [], timeoutMs: 60_000 }, { spawn: fake, kill: (p, s) => kills.push([p, s]), members: () => [], graceMs: 20 });
    assert.equal(r.pipesAbandoned, true);
    assert.deepEqual(kills, []);
    // With a live member shown by ps right before the signal, the group is signalled (accepted ps-to-kill window).
    const kills2 = [];
    await runProcess({ bin: "x", args: [], timeoutMs: 60_000 }, { spawn: fake, kill: (p, s) => kills2.push([p, s]), members: () => [7], graceMs: 20 });
    assert.deepEqual(kills2.map(([, s]) => s), ["SIGTERM", "SIGKILL", "SIGKILL"]);
  } finally { clearInterval(keep); }
});

test("bypass flags are refused before anything is spawned (A3)", async () => {
  let spawned = false;
  const r = await runProcess({ bin: node, args: ["exec", "-c", 'approval_policy="on-request"', "-"], env: process.env, input: "" }, { spawn: () => { spawned = true; throw new Error("must not spawn"); } });
  assert.equal(spawned, false);
  assert.match(r.spawnError, /refused before spawn/);
  assert.deepEqual(r.refusedFlags, ['approval_policy="on-request"']);
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

test("a setsid'd descendant holding the pipes cannot hang the runner", async () => {
  const script = `const c=require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{detached:true,stdio:"inherit"}); console.log(c.pid); c.unref(); process.exit(0)`;
  const r = await runProcess({ bin: node, args: ["-e", script], env: process.env, input: "", timeoutMs: 200 }, { graceMs: 500 });
  assert.equal(r.pipesAbandoned, true);
  assert.ok(r.durationMs < 15_000, `took ${r.durationMs}`);
  const pid = Number(r.stdout.trim());
  if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
});
