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
  if (policy.default_dimensions !== undefined && (!Array.isArray(policy.default_dimensions) || !policy.default_dimensions.length || !policy.default_dimensions.every((d) => typeof d === "string" && d)))
    errs.push("default_dimensions must be a non-empty array of strings");
  if (policy.host_order !== undefined) {
    if (!Array.isArray(policy.host_order)) errs.push("host_order must be an array");
    else {
      const seen = new Set();
      for (const h of policy.host_order) {
        if (!policy.hosts[h]) errs.push(`host_order: ${h} is not a configured host`);
        if (seen.has(h)) errs.push(`host_order: ${h} listed twice`);
        seen.add(h);
      }
    }
  }
  for (const [name, h] of Object.entries(policy.hosts)) {
    if (!HOSTS.includes(name)) errs.push(`hosts.${name}: unknown host (known: ${HOSTS.join(", ")})`);
    if (typeof h?.model !== "string" || !h.model) errs.push(`hosts.${name}.model missing`);
    if (!h?.effort_map || typeof h.effort_map[policy.review_effort] !== "string")
      errs.push(`hosts.${name}.effort_map has no entry for review_effort=${policy.review_effort}`);
    const pre = h?.id_prefix ?? DEFAULT_PREFIX[name];
    if (!/^[A-Z]$/.test(pre ?? "")) errs.push(`hosts.${name}.id_prefix must be one capital letter`);
    if (prefixes.has(pre)) errs.push(`hosts.${name}.id_prefix ${pre} is used by another host`);
    prefixes.add(pre);
    if (h?.allow_code_execution !== undefined) {
      if (typeof h.allow_code_execution !== "boolean") errs.push(`hosts.${name}.allow_code_execution must be boolean`);
      else if (h.allow_code_execution && name !== "codex") errs.push(`hosts.${name}.allow_code_execution: only codex runs commands (inside its read-only sandbox)`);
    }
    if (h?.os_sandbox !== undefined) {
      if (!["required", "audit_only"].includes(h.os_sandbox)) errs.push(`hosts.${name}.os_sandbox must be "required" or "audit_only"`);
      else if (name !== "codex") errs.push(`hosts.${name}.os_sandbox: only codex runs model commands under the OS sandbox`);
    }
    if (h?.env_passthrough !== undefined && (!Array.isArray(h.env_passthrough) || !h.env_passthrough.every((k) => typeof k === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))))
      errs.push(`hosts.${name}.env_passthrough must be an array of variable names`);
    for (const [k, v] of Object.entries(h?.expected_cost ?? {})) if (typeof v !== "number" || !(v >= 0 && v <= 1)) errs.push(`hosts.${name}.expected_cost.${k} must be a fraction in [0, 1]`);
    for (const k of ["max_files_per_turn", "max_bytes_per_turn"]) if (h?.[k] !== undefined && !(Number.isInteger(h[k]) && h[k] > 0)) errs.push(`hosts.${name}.${k} must be a positive integer`);
  }
  const p = policy.pace;
  if (p) {
    if (typeof p.use_at_or_above !== "number" || typeof p.high_only_at_or_above !== "number") errs.push("pace thresholds must be numbers");
    else if (p.high_only_at_or_above > p.use_at_or_above) errs.push("pace.high_only_at_or_above must be <= use_at_or_above");
    if (p.reset_soon_minutes !== undefined && !(typeof p.reset_soon_minutes === "number" && p.reset_soon_minutes >= 0)) errs.push("pace.reset_soon_minutes must be a number >= 0");
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
    // Whether model-run commands may execute code (interpreters, command substitution). Only codex runs commands,
    // always inside its read-only sandbox; default allowed there, never elsewhere.
    allowCodeExecution: host === "codex" ? h.allow_code_execution ?? true : false,
    envPassthrough: h.env_passthrough ?? [],
    config: h,
  };
}

export function defaultPolicyPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "review-policy.json");
}
