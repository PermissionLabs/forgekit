#!/usr/bin/env node
// cross-review: host-neutral cross-review runner (zero dependencies, Node >= 20).
//
//   cross-review.mjs plan  --author <host> --paths-from <diff|list> [--dimensions a,b] [--usage <usage.json>] [--no-user] [--out <file>] [--repo <dir>] [--policy <file>]
//   cross-review.mjs run   --host <host> --rev <sha> --diff <patch> --scope <a,b|@list> --brief <md> --out <dir>
//                          [--repo <dir>] [--dimensions a,b] [--context <a,b|@list>] [--checklist <path>]... [--prior <findings.json> --dispositions <file>] [--id-start <n>] [--policy <file>]
//   cross-review.mjs merge --review <run dir|evidence.json> --review <...> [--out <file>] [--repo <dir>] [--line-window <n>]
//                          (only runs whose evidence.json says status=complete are merged)
//
// Exit codes: plan ok=0 ask=3 blocked=4; run complete=0 incomplete=1; merge all-complete=0 some-incomplete=1; usage error=2.
// --out is refused when it is tracked (or holds tracked files) in its own repository or in --repo.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultPolicyPath, HOSTS, loadPolicy } from "./lib/policy.mjs";
import { pathsFromDiffText, plan } from "./lib/plan.mjs";
import { readList, realish } from "./lib/inputs.mjs";
import { runReview, summarize } from "./lib/run.mjs";
import { loadReviewEntry, mergeReviews } from "./lib/merge.mjs";

// Flags per command: value flags, repeatable value flags, boolean flags. Anything else is a usage error.
export const SPEC = {
  plan: { values: ["author", "dimensions", "paths-from", "usage", "out", "policy", "repo"], multi: [], bool: ["no-user"] },
  run: { values: ["host", "rev", "diff", "scope", "brief", "out", "repo", "dimensions", "context", "prior", "dispositions", "id-start", "policy"], multi: ["checklist"], bool: [] },
  merge: { values: ["out", "line-window", "repo"], multi: ["review"], bool: [] },
};

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const o = { _cmd: cmd };
  if (cmd === undefined || cmd === "help" || cmd === "--help") return { _cmd: cmd === undefined ? undefined : "help", help: true };
  const spec = SPEC[cmd];
  if (!spec) throw new Error(`unknown command ${cmd} (plan | run | merge)`);
  for (const k of spec.multi) o[k] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (k === "help") { o.help = true; continue; }
    if (spec.bool.includes(k)) { o[k] = true; continue; }
    const isMulti = spec.multi.includes(k);
    if (!isMulti && !spec.values.includes(k)) throw new Error(`unknown option --${k} for ${cmd}`);
    const v = rest[i + 1];
    if (v === undefined || (v.startsWith("--") && v !== "--")) throw new Error(`--${k} needs a value`);
    if (isMulti) o[k].push(v);
    else if (o[k] !== undefined) throw new Error(`--${k} given twice`);
    else o[k] = v;
    i++;
  }
  return o;
}
const need = (o, k) => { if (!o[k] || (Array.isArray(o[k]) && !o[k].length)) throw new Error(`--${k} is required`); return o[k]; };
const positiveInt = (s, k) => { const n = Number(s); if (!Number.isInteger(n) || n < 1) throw new Error(`--${k} must be a positive integer`); return n; };
const csv = (s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);

/**
 * An output location must not be tracked inside a repository (evidence is local and untracked). It is checked
 * against every repository it could land in: the one containing the output path itself (nearest existing
 * ancestor), and `repo` when given (--repo, or the run's target repo). Inside a work tree the path must be
 * git-ignored (checked against the index, so a tracked file never passes), never under .git, and an output
 * directory must not contain tracked files (an ignored directory can still hold force-added ones).
 */
export function checkOut(repo, out, { dir = true } = {}) {
  const abs = path.resolve(out);
  const realAbs = realish(abs);
  if (!realAbs) throw new Error(`--out ${out}: cannot resolve the path`);
  // Never under a .git directory, whether or not a work tree can be found for it (A10: `git rev-parse` fails inside .git).
  if (abs.split(path.sep).includes(".git") || realAbs.split(path.sep).includes(".git")) throw new Error(`--out ${out} is inside a .git directory; use an untracked location (e.g. .context/ or a temp dir)`);
  const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const topOf = (d) => { try { return realish(git(d, ["rev-parse", "--show-toplevel"]).trim()); } catch { return null; } };
  let anc = realAbs;
  while (!fs.existsSync(anc) && path.dirname(anc) !== anc) anc = path.dirname(anc);
  if (!fs.statSync(anc).isDirectory()) anc = path.dirname(anc);
  const tops = new Set([topOf(anc), repo ? topOf(repo) : null].filter(Boolean));
  const bad = () => new Error(`--out ${out} is inside the repository and not git-ignored; use an untracked location (e.g. .context/ or a temp dir)`);
  for (const realTop of tops) {
    if (realAbs !== realTop && !realAbs.startsWith(realTop + path.sep)) continue;
    const rel = path.relative(realTop, realAbs);
    if (!rel || rel.split(path.sep).includes(".git")) throw bad();
    try { execFileSync("git", ["-C", realTop, "check-ignore", "-q", "--", dir ? rel + "/" : rel], { stdio: "ignore" }); }
    catch { throw bad(); }
    let tracked = "";
    try { tracked = git(realTop, ["ls-files", "-z", "--", rel]); } catch { throw bad(); }
    if (tracked.length) throw new Error(`--out ${out} contains or is a tracked file (${tracked.split("\0")[0]}); use an untracked location`);
  }
}

// The usage text is the leading comment block (after the shebang), however many lines it has.
export const HELP = () => {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
  const n = lines.findIndex((l) => !l.startsWith("//"));
  return lines.slice(0, n === -1 ? lines.length : n).map((l) => l.replace(/^\/\/ ?/, "")).join("\n");
};

export async function main(argv = process.argv.slice(2)) {
  let o;
  try { o = parseArgs(argv); } catch (e) { console.error(`cross-review: ${e.message}`); return 2; }
  if (o.help) { console.log(HELP()); return o._cmd === undefined ? 2 : 0; }
  try {
    if (o._cmd === "merge") {
      const entries = need(o, "review").map(loadReviewEntry);
      const m = mergeReviews(entries, { lineWindow: o["line-window"] ? positiveInt(o["line-window"], "line-window") : 3 });
      if (o.out) { checkOut(o.repo ?? null, o.out, { dir: false }); fs.writeFileSync(o.out, JSON.stringify(m, null, 2)); }
      console.log(m.text);
      return entries.every((e) => e.status === "complete") ? 0 : 1;
    }
    let policy, policyPath;
    ({ policy, path: policyPath } = loadPolicy(o.policy ?? defaultPolicyPath()));
    const dims = csv(o.dimensions);
    if (o._cmd === "plan") {
      const author = need(o, "author");
      const paths = pathsFromDiffText(fs.readFileSync(need(o, "paths-from"), "utf8"));
      const usage = o.usage ? JSON.parse(fs.readFileSync(o.usage, "utf8")) : null;
      if (o.out) checkOut(o.repo ?? null, o.out, { dir: false });
      const p = plan({ policy, author, dimensions: dims.length ? dims : policy.default_dimensions ?? [], paths, usage, noUser: !!o["no-user"] });
      if (o.out) fs.writeFileSync(o.out, JSON.stringify(p, null, 2));
      console.log(JSON.stringify(p, null, 2));
      return p.status === "ok" ? 0 : p.status === "ask" ? 3 : 4;
    }
    // run
    const host = need(o, "host");
    if (!HOSTS.includes(host)) throw new Error(`--host must be one of ${HOSTS.join(", ")}`);
    const repo = path.resolve(o.repo ?? ".");
    const out = path.resolve(need(o, "out"));
    checkOut(repo, out);
    const dimensions = dims.length ? dims : policy.default_dimensions;
    if (!dimensions?.length) throw new Error("no --dimensions and the policy has no default_dimensions");
    const ev = await runReview({
      host, repo, rev: need(o, "rev"), diff: need(o, "diff"), scope: readList(need(o, "scope")), context: readList(o.context),
      checklist: o.checklist, brief: need(o, "brief"), out, dimensions,
      prior: o.prior, dispositions: o.dispositions, idStart: o["id-start"] ? positiveInt(o["id-start"], "id-start") : undefined,
    }, policy, policyPath);
    console.log(summarize(ev, path.join(out, "evidence.json")));
    return ev.status === "complete" ? 0 : 1;
  } catch (e) {
    console.error(`cross-review: ${e.message}`);
    return 2;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().then((code) => process.exit(code));
}
