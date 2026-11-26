// Policy loading and validation. Model ids and effort levels live only in the policy file.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const HOSTS = ["claude", "codex", "antigravity"];
export const DEFAULT_PREFIX = { claude: "C", codex: "X", antigravity: "A" };

export function expandHome(p) {
  if (typeof p !== "string") return p;
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/** Returns a list of problems; empty when the policy is usable. */
export function policyProblems(policy) {
  const errs = [];
  if (!policy || typeof policy !== "object") return ["policy is not an object"];
  if (typeof policy.review_effort !== "string" || !policy.review_effort) errs.push("review_effort missing");
  if (!policy.hosts || typeof policy.hosts !== "object") return [...errs, "hosts missing"];
  const prefixes = new Set();
  for (const [name, h] of Object.entries(policy.hosts)) {
    if (!HOSTS.includes(name)) errs.push(`hosts.${name}: unknown host (known: ${HOSTS.join(", ")})`);
    if (typeof h?.model !== "string" || !h.model) errs.push(`hosts.${name}.model missing`);
    if (!h?.effort_map || typeof h.effort_map[policy.review_effort] !== "string")
      errs.push(`hosts.${name}.effort_map has no entry for review_effort=${policy.review_effort}`);
    const pre = h?.id_prefix ?? DEFAULT_PREFIX[name];
    if (!/^[A-Z]$/.test(pre ?? "")) errs.push(`hosts.${name}.id_prefix must be one capital letter`);
    if (prefixes.has(pre)) errs.push(`hosts.${name}.id_prefix ${pre} is used by another host`);
    prefixes.add(pre);
  }
  const p = policy.pace;
  if (p) {
    if (typeof p.use_at_or_above !== "number" || typeof p.high_only_at_or_above !== "number") errs.push("pace thresholds must be numbers");
    else if (p.high_only_at_or_above > p.use_at_or_above) errs.push("pace.high_only_at_or_above must be <= use_at_or_above");
  }
  const r = policy.grade?.reviewers;
  if (r && (!Number.isInteger(r.standard) || !Number.isInteger(r.high) || r.standard < 1 || r.high < 1)) errs.push("grade.reviewers.{standard,high} must be positive integers");
  return errs;
}

export function loadPolicy(file) {
  const abs = path.resolve(file);
  let policy;
  try { policy = JSON.parse(fs.readFileSync(abs, "utf8")); } catch (e) { throw new Error(`cannot read policy ${abs}: ${e.message}`); }
  const errs = policyProblems(policy);
  if (errs.length) throw new Error(`invalid policy ${abs}:\n- ${errs.join("\n- ")}`);
  return { policy, path: abs };
}

/** Pinned settings for one host, resolved from the policy. */
export function hostPin(policy, host) {
  const h = policy.hosts?.[host];
  if (!h) throw new Error(`policy has no hosts.${host}`);
  return {
    host,
    model: h.model,
    effort: h.effort_map[policy.review_effort],
    review_effort: policy.review_effort,
    idPrefix: h.id_prefix ?? DEFAULT_PREFIX[host],
    timeoutMs: Math.round((h.timeout_sec ?? 1800) * 1000),
    config: h,
  };
}

export function defaultPolicyPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "review-policy.json");
}
