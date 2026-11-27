import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { groupMembers, ownedMembers, ownershipTimeMs, runProcess } from "../lib/proc.mjs";

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

test("after exit, a numeric pgid match is never membership: only members started between spawn and exit are signalled, by pid (X3/A19)", async () => {
  // Mocked spawn: the child "exits" at once while its pipes stay open; members() is what ps would show.
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  let spawnT = 0;
  const fake = () => {
    spawnT = ownershipTimeMs();
    const c = new EventEmitter();
    c.pid = 424242;
    c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.stdin = new PassThrough();
    setTimeout(() => c.emit("exit", 0, null), 10);
    return c;
  };
  const keep = setInterval(() => {}, 1000); // the mock has no real handles keeping the loop alive
  const go = async (members) => {
    const kills = [];
    const r = await runProcess({ bin: "x", args: [], timeoutMs: 60_000 }, { spawn: fake, kill: (p, s) => kills.push([p, s]), members, graceMs: 20 });
    return { r, kills };
  };
  try {
    const empty = await go(() => []);
    assert.equal(empty.r.pipesAbandoned, true);
    assert.deepEqual(empty.kills, []);
    // A bare pid number (no start time) is a numeric match only: never signalled.
    assert.deepEqual((await go(() => [7])).kills, []);
    // A replacement group: its member started after our child exited -> never signalled.
    assert.deepEqual((await go(() => [{ pid: 7, startMs: ownershipTimeMs() + 60_000 }])).kills, []);
    // Our own descendant (started before the exit) is signalled individually; the group id never is.
    // Started at spawn time (inside the spawn..exit window; ps would floor it to the spawn second).
    const mine = await go(() => [{ pid: 7, startMs: spawnT }]);
    assert.deepEqual(mine.kills, [[7, "SIGTERM"], [7, "SIGKILL"], [7, "SIGKILL"]]);
    assert.ok(mine.kills.every(([p]) => p > 0));
  } finally { clearInterval(keep); }
});

test("ownedMembers: start time inside the spawn..exit window only; nothing started after the exit second (X3/A6/A19)", () => {
  const spawnedAt = Date.parse("2026-11-26T05:00:00.400Z"), exitedAt = Date.parse("2026-11-26T05:00:10.300Z");
  const at = (iso) => Date.parse(iso);
  // ps floors start times to the second: 05:00:00 is the spawn second (ours); 05:00:10 is the exit second (accepted
  // residual: cannot be told apart); 05:00:11 started after the exit (a replacement) and is never ours (was accepted
  // by the old +1000 ms slack); 04:59:59 predates the spawn.
  const list = [{ pid: 1, startMs: at("2026-11-26T05:00:00Z") }, { pid: 2, startMs: at("2026-11-26T05:00:10Z") }, { pid: 3, startMs: at("2026-11-26T05:00:11Z") }, { pid: 6, startMs: at("2026-11-26T04:59:59Z") }, { pid: 4, startMs: NaN }, 5];
  assert.deepEqual(ownedMembers(list, { spawnedAt, exitedAt }), [1, 2]);
});

test("Linux group membership and the spawn clock use kernel boot time", { skip: process.platform !== "linux" }, () => {
  const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }));
  const member = groupMembers(pgid).find(m => m.pid === process.pid);
  assert.ok(member);
  assert.ok(member.resolutionMs > 0);
  assert.ok(member.startMs <= ownershipTimeMs());
  assert.ok(ownershipTimeMs() - member.startMs < (process.uptime() + 5) * 1000);
});

test("kernel ticks bound ownership at spawn and exit; unknown bounds cannot authorize cleanup", () => {
  const members = [9790, 9800, 9820, 9830].map((startMs, i) => ({ pid: i + 1, startMs, resolutionMs: 10 }));
  assert.deepEqual(ownedMembers(members, { spawnedAt: 9804, exitedAt: 9827 }), [2, 3]);
  assert.deepEqual(ownedMembers(members, { spawnedAt: NaN, exitedAt: 9827 }), []);
  assert.deepEqual(ownedMembers(members, { spawnedAt: 9804, exitedAt: NaN }), []);
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
