#!/usr/bin/env node
// cross-review: host-neutral cross-review runner (zero dependencies, Node >= 20).
//
//   cross-review.mjs plan --author <host> --dimensions a,b --paths-from <diff|list> [--usage <usage.json>] [--no-user] [--policy <file>]
//   cross-review.mjs run  --host <host> --rev <sha> --diff <patch> --scope <list|a,b> --brief <md> --out <dir>
//                         [--repo <dir>] [--dimensions a,b] [--context <list>] [--checklist <md,md>]
//                         [--prior <findings.json> --dispositions <file>] [--id-start <n>] [--policy <file>]
//
// Exit codes: plan ok=0 ask=3 blocked=4; run complete=0 incomplete=1; usage error=2.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultPolicyPath, HOSTS, loadPolicy } from "./lib/policy.mjs";
import { pathsFromDiffText, plan } from "./lib/plan.mjs";
import { readList } from "./lib/inputs.mjs";
import { runReview, summarize } from "./lib/run.mjs";

const BOOL = new Set(["no-user", "help"]);
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const o = { _cmd: cmd };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (BOOL.has(k)) { o[k] = true; continue; }
    const v = rest[i + 1];
    if (v === undefined || (v.startsWith("--") && v !== "--")) throw new Error(`--${k} needs a value`);
    o[k] = v;
    i++;
  }
  return o;
}
const need = (o, k) => { if (!o[k]) throw new Error(`--${k} is required`); return o[k]; };
const positiveInt = (s, k) => { const n = Number(s); if (!Number.isInteger(n) || n < 1) throw new Error(`--${k} must be a positive integer`); return n; };
const csv = (s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);

/** --out must not be a tracked location inside the repository (evidence is local and untracked). */
function checkOut(repo, out) {
  const abs = path.resolve(out);
  let top;
  try { top = execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(); } catch { return; }
  const realTop = fs.realpathSync(top);
  let probe = abs;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const realAbs = path.join(fs.realpathSync(probe), path.relative(probe, abs));
  if (realAbs !== realTop && !realAbs.startsWith(realTop + path.sep)) return;
  try { execFileSync("git", ["-C", repo, "check-ignore", "-q", "--no-index", path.relative(realTop, realAbs) + "/"], { stdio: "ignore" }); }
  catch { throw new Error(`--out ${out} is inside the repository and not git-ignored; use an untracked location (e.g. .context/ or a temp dir)`); }
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`cross-review: ${e.message}`); return 2; }
  if (!o._cmd || o.help || o._cmd === "help") { console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 9).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")); return o._cmd ? 0 : 2; }
  let policy, policyPath;
  try { ({ policy, path: policyPath } = loadPolicy(o.policy ?? defaultPolicyPath())); } catch (e) { console.error(`cross-review: ${e.message}`); return 2; }
  const dims = csv(o.dimensions);
  try {
    if (o._cmd === "plan") {
      const author = need(o, "author");
      const paths = pathsFromDiffText(fs.readFileSync(need(o, "paths-from"), "utf8"));
      const usage = o.usage ? JSON.parse(fs.readFileSync(o.usage, "utf8")) : null;
      const p = plan({ policy, author, dimensions: dims.length ? dims : policy.default_dimensions ?? [], paths, usage, noUser: !!o["no-user"] });
      if (o.out) fs.writeFileSync(o.out, JSON.stringify(p, null, 2));
      console.log(JSON.stringify(p, null, 2));
      return p.status === "ok" ? 0 : p.status === "ask" ? 3 : 4;
    }
    if (o._cmd === "run") {
      const host = need(o, "host");
      if (!HOSTS.includes(host)) throw new Error(`--host must be one of ${HOSTS.join(", ")}`);
      const repo = path.resolve(o.repo ?? ".");
      const out = path.resolve(need(o, "out"));
      checkOut(repo, out);
      const ev = await runReview({
        host, repo, rev: need(o, "rev"), diff: need(o, "diff"), scope: readList(need(o, "scope")), context: readList(o.context),
        checklist: csv(o.checklist), brief: need(o, "brief"), out, dimensions: dims.length ? dims : policy.default_dimensions,
        prior: o.prior, dispositions: o.dispositions, idStart: o["id-start"] ? positiveInt(o["id-start"], "id-start") : undefined,
      }, policy, policyPath);
      console.log(summarize(ev, path.join(out, "evidence.json")));
      return ev.status === "complete" ? 0 : 1;
    }
    throw new Error(`unknown command ${o._cmd} (plan | run)`);
  } catch (e) {
    console.error(`cross-review: ${e.message}`);
    return 2;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().then((code) => process.exit(code));
}
