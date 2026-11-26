// `run`: one reviewer host, one review. Builds the common input, calls the host adapter, validates,
// checks pinned vs reported model, writes evidence, returns the summary. Never switches reviewer or model.
import * as fs from "node:fs";
import * as path from "node:path";
import { hostPin } from "./policy.mjs";
import { buildInput, buildPrompt, hashTree, removeSnapshot, sha256 } from "./inputs.mjs";
import { jsonSchemaFor, nextIdStart, parseReviewText, priorFindingsFrom, validateDispositions, validateReview } from "./schema.mjs";
import { bypassFlags } from "./proc.mjs";
import * as claude from "../adapters/claude.mjs";
import * as codex from "../adapters/codex.mjs";
import * as antigravity from "../adapters/antigravity.mjs";

export const ADAPTERS = { claude, codex, antigravity };

/**
 * Pinned vs reported. A reported value that is missing or different makes the run incomplete. For a host that
 * does not report effort at all (effortReported=false, Claude), effort is recorded as "unreported", never as verified.
 */
export function checkReported(pin, reported, { effortReported = true } = {}) {
  const reasons = [];
  if (!reported?.model) reasons.push("reported_model_unavailable");
  else if (reported.model !== pin.model) reasons.push(`reported_model_mismatch:${reported.model}`);
  if (effortReported) {
    if (reported?.effort == null) reasons.push("reported_effort_unavailable");
    else if (reported.effort !== pin.effort) reasons.push(`reported_effort_mismatch:${reported.effort}`);
  }
  return reasons;
}

const readJson = (p, what) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { throw new Error(`cannot read ${what} ${p}: ${e.message}`); } };

/**
 * runReview(opts, policy, policyPath) -> evidence
 * opts: { host, repo, rev, diff, scope[], context[], checklist[], brief, out, dimensions[], prior?, dispositions?, idStart? }
 */
export async function runReview(opts, policy, policyPath) {
  const adapter = ADAPTERS[opts.host];
  if (!adapter) throw new Error(`unknown host ${opts.host}`);
  const pin = hostPin(policy, opts.host);
  const prefix = pin.idPrefix;
  fs.mkdirSync(opts.out, { recursive: true });
  const rawDir = path.join(opts.out, "raw");
  fs.mkdirSync(rawDir, { recursive: true });

  // Re-review inputs are validated before anything runs.
  let prior = null, dispositions = null, priorIds = [];
  if (opts.prior || opts.dispositions) {
    if (!opts.prior || !opts.dispositions) throw new Error("--prior and --dispositions go together");
    prior = priorFindingsFrom(readJson(opts.prior, "prior findings"));
    priorIds = prior.map((f) => f.id);
    dispositions = readJson(opts.dispositions, "dispositions");
    const de = validateDispositions(dispositions, priorIds);
    if (de.length) throw new Error(`dispositions invalid:\n- ${de.join("\n- ")}`);
  }
  const idStart = opts.idStart ?? (prior ? nextIdStart(prior, prefix) : 1);
  const dimensions = opts.dimensions;
  if (!Array.isArray(dimensions) || !dimensions.length || !dimensions.every((d) => typeof d === "string" && d)) throw new Error("dimensions must be a non-empty list");

  const input = buildInput({ repo: opts.repo, rev: opts.rev, diffPath: opts.diff, scope: opts.scope, contextRefs: opts.context, checklist: opts.checklist, briefPath: opts.brief, dimensions, prior, dispositions });
  try {
    return await reviewWithInput({ opts, adapter, pin, prefix, policyPath, prior, dispositions, priorIds, idStart, dimensions, input, rawDir });
  } finally {
    removeSnapshot(input.snapshot);
  }
}

async function reviewWithInput({ opts, adapter, pin, prefix, policyPath, prior, dispositions, priorIds, idStart, dimensions, input, rawDir }) {
  const promptFor = (o = {}) => buildPrompt(input, { prefix, idStart, priorIds, ...o });
  const prompt = promptFor();
  const jsonSchema = jsonSchemaFor(dimensions, { prior: priorIds.length > 0 });
  fs.writeFileSync(path.join(opts.out, "prompt.txt"), prompt);
  const mkValidate = (dims, mustCoverPrior, start = idStart) => (raw) => {
    const p = parseReviewText(raw);
    if (p.error) return { errors: [p.error] };
    return { value: p.value, errors: validateReview(p.value, { dimensions: dims, prefix, idStart: start, scope: input.scopeLines, priorIds, mustCoverPrior }) };
  };
  const log = (name, text) => fs.writeFileSync(path.join(rawDir, `${opts.host}-${name}`), text);
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  let res;
  try {
    res = await adapter.run({
      input, pin, prompt, promptFor, jsonSchema, prefix, idStart, priorIds, dimensions, log, workDir: rawDir, deps: opts.deps,
      validate: mkValidate(dimensions, priorIds),
      validateGroup: (raw, dims, mustCover, start = idStart) => mkValidate(dims, mustCover, start)(raw),
    });
  } catch (e) {
    res = { reasons: [`adapter_error:${e.message}`], warnings: [], attempts: [] };
  }
  const reasons = [...(res.reasons ?? [])];
  const warnings = [...(res.warnings ?? [])];
  // The argv the adapter reports is re-checked against the same exact allowlist it spawned with (A50).
  const argvBypass = res.argv ? bypassFlags(res.argv, { allowedConfig: res.allowedConfig ?? [] }) : [];
  if (argvBypass.length) reasons.push(`bypass_flags_in_argv:${argvBypass.join(",")}`);

  // Post-checks that turn a schema-valid review into an incomplete one.
  let snapshotUnchanged = null;
  try { snapshotUnchanged = JSON.stringify(hashTree(input.snapshot)) === JSON.stringify(input.snapshotHashBefore); } catch { snapshotUnchanged = false; }
  if (!snapshotUnchanged) reasons.push("snapshot_modified");
  removeSnapshot(input.snapshot);
  const effortReported = res.effortReported !== false;
  reasons.push(...checkReported(pin, res.reported, { effortReported }));
  if (res.review) {
    const final = validateReview(res.review, { dimensions, prefix, idStart, scope: input.scopeLines, priorIds });
    if (final.length) reasons.push(...final.map((e) => `merged_review_invalid:${e}`));
  } else if (!reasons.length) reasons.push("no_valid_review");
  if (input.diffFilesNotInScope.length) warnings.push(`diff files not in scope: ${input.diffFilesNotInScope.join(", ")}`);
  const uniq = [...new Set(reasons)];
  const status = res.review && uniq.length === 0 ? "complete" : "incomplete";

  const evidence = {
    schema: "cross-review-evidence@1",
    reviewer: { host: opts.host, idPrefix: prefix },
    status,
    incompleteReasons: uniq,
    warnings,
    pinned: { model: pin.model, effort: pin.effort, review_effort: pin.review_effort, policyFile: policyPath, policySha256: sha256(fs.readFileSync(policyPath)) },
    reported: res.reported ?? null,
    matchesPinned: checkReported(pin, res.reported, { effortReported }).length === 0,
    effortCheck: effortReported ? "verified against host report" : "unreported (host does not report effort; pinned value only)",
    prompt: { sha256: sha256(prompt), chars: prompt.length, file: "prompt.txt", jsonSchemaSha256: sha256(JSON.stringify(jsonSchema)) },
    timeoutMs: res.timeoutMs ?? pin.timeoutMs,
    startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0,
    usage: res.usage ?? null,
    inputs: {
      repo: input.repo, rev: input.rev, resolvedRev: input.resolvedRev,
      diff: { path: path.resolve(opts.diff), sha256: input.diffSha256, files: input.diffFiles },
      brief: { path: path.resolve(opts.brief), sha256: input.briefSha256 },
      checklist: input.checklist.map((c) => ({ path: c.path, source: c.source, sha256: c.sha256 })),
      files: input.files, dimensions,
      reReview: prior ? { priorIds, idStart, dispositions } : null,
    },
    isolation: { snapshotReadOnly: true, snapshotUnchanged, snapshotRemoved: !fs.existsSync(input.snapshot), ...(res.isolation ?? {}) },
    argv: res.argv ?? null,
    toolAudit: res.toolAudit ?? null,
    attempts: res.attempts ?? [],
    hostLimits: res.limits ?? [],
    extra: { groups: res.groups, groupVerdicts: res.groupVerdicts, agent: res.agent, sessionCleanup: res.sessionCleanup, process: res.process, authRequired: res.authRequired, hostVersion: res.hostVersion, codeExecution: res.codeExecution },
    review: status === "complete" ? res.review : null,
    // An incomplete run's draft is kept for humans (never merged): the schema-valid review, or the raw reply text.
    reviewIfIncomplete: status === "incomplete" ? res.review ?? null : undefined,
    reviewDraftRawIfIncomplete: status === "incomplete" && !res.review && res.draftRaw ? res.draftRaw : undefined,
  };
  fs.writeFileSync(path.join(opts.out, "evidence.json"), JSON.stringify(evidence, null, 2));
  fs.writeFileSync(path.join(opts.out, "review.json"), JSON.stringify(evidence.review, null, 2));
  fs.writeFileSync(path.join(opts.out, "summary.txt"), summarize(evidence, path.join(opts.out, "evidence.json")) + "\n");
  return evidence;
}

/** Short orchestrator summary: verdict, severity counts, full high/critical findings, reviewer/model, evidence path. */
export function summarize(ev, evidencePath) {
  const r = ev.review ?? ev.reviewIfIncomplete ?? null;
  const counts = { critical: 0, high: 0, med: 0, low: 0 };
  for (const f of r?.findings ?? []) counts[f.sev] = (counts[f.sev] ?? 0) + 1;
  const lines = [
    `cross-review ${ev.reviewer.host}: status=${ev.status} verdict=${ev.status === "complete" ? r.verdict : `none (incomplete${r ? `; unaccepted draft verdict ${r.verdict}` : ""})`}`,
    `reviewer=${ev.reviewer.host} model=${ev.pinned.model} effort=${ev.pinned.effort} reported=${ev.reported?.model ?? "unavailable"}${ev.reported?.effort ? `/${ev.reported.effort}` : ""}`,
    `findings: critical=${counts.critical} high=${counts.high} med=${counts.med} low=${counts.low}`,
  ];
  for (const f of (r?.findings ?? []).filter((x) => x.sev === "critical" || x.sev === "high")) {
    lines.push(`[${f.sev}] ${f.id} ${f.loc}`, `  claim: ${f.claim}`, `  evidence: ${f.evidence}`, `  check: ${f.check}`);
  }
  for (const p of r?.prior_verification ?? []) lines.push(`prior ${p.id}: ${p.verified ? "verified" : "NOT verified"}`);
  if (ev.status !== "complete") lines.push(`incomplete: ${ev.incompleteReasons.join("; ")}`);
  lines.push(`evidence: ${evidencePath}`);
  return lines.join("\n");
}
