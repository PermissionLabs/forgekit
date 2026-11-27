// Common reviewer input: read-only snapshot of in-scope files at --rev (git objects only), diff,
// context refs, checklist, brief, prompt. Every adapter receives the same ReviewInput.
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDiffPaths } from "./diff.mjs";
import { schemaText } from "./schema.mjs";

export const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

export function safeRel(p) {
  const n = path.posix.normalize(String(p).replace(/\\/g, "/"));
  if (!n || n === "." || path.posix.isAbsolute(n) || n === ".." || n.startsWith("../") || n.includes("\0") || n.split("/").includes(".git"))
    throw new Error(`unsafe path: ${p}`);
  return n;
}

/**
 * A list argument: `@<file>` reads one path per line (# comments) from that file; anything else is a
 * comma-separated list. A bare file name is never guessed to be a list file (it may be a repo path).
 */
export function readList(arg) {
  if (!arg) return [];
  const text = arg.startsWith("@") ? fs.readFileSync(arg.slice(1), "utf8") : arg.split(",").join("\n");
  const out = [];
  for (const raw of text.split("\n")) {
    const l = raw.replace(/#.*$/, "").trim();
    if (l && !out.includes(l)) out.push(l);
  }
  return out;
}

/** Blob bytes of `rel` at `rev`; refuses symlinks, submodules and anything that is not a regular file. */
export function gitBlob(repo, rev, rel) {
  const ls = execFileSync("git", ["-C", repo, "ls-tree", "-z", rev, "--", rel], { encoding: "utf8" });
  const entry = ls.split("\0").find((e) => e.endsWith(`\t${rel}`));
  if (!entry) throw new Error(`${rel} does not exist at ${rev}`);
  const [mode, type] = entry.split(/\s/);
  if (type !== "blob" || !(mode === "100644" || mode === "100755")) throw new Error(`${rel} at ${rev} is not a regular file (mode ${mode}, ${type})`);
  return execFileSync("git", ["-C", repo, "show", `${rev}:${rel}`], { maxBuffer: 256 * 1024 * 1024 });
}

export function chmodTree(root, fileMode, dirMode) {
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); fs.chmodSync(p, dirMode); } else if (e.isFile()) fs.chmodSync(p, fileMode);
    }
  };
  walk(root);
  fs.chmodSync(root, dirMode);
}

export function hashTree(root) {
  // X38: a null-prototype object, so a file named __proto__ is an own entry like any other.
  const out = Object.create(null);
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p)] = e.isFile() ? sha256(fs.readFileSync(p)) : `non-file:${e.isSymbolicLink() ? "symlink" : "other"}`;
    }
  };
  walk(root);
  return out;
}

/**
 * Checklist text. A relative path is a repo path read from the git object at `rev` (never the working tree);
 * an absolute path inside the repository is treated the same way. Whether an absolute path is inside the
 * repository is decided from the path as written (only its parent directory is resolved), never from a
 * working-tree symlink's target, so an in-repo symlink is read as the git object, which gitBlob refuses
 * because it is a symlink. An absolute path outside the repository is read from disk.
 * Each entry records its source and hash in the evidence.
 */
export function readChecklist(repo, rev, p) {
  const s = String(p);
  let rel = null;
  if (path.isAbsolute(s)) {
    const top = realish(repo);
    // (r8 delta, A86) first: the ancestor of the path as written that IS the repository (aliases and letter case
    // resolved by realish); the rest stays lexical, so an in-repo directory symlink is never followed (gitBlob
    // then refuses it). Only otherwise the parent-directory candidates below (a link pointing into the repo).
    const parts = path.resolve(s).split(path.sep).filter(Boolean);
    for (let k = 0; top && k < parts.length && rel === null; k++) {
      if (realish(path.sep + parts.slice(0, k).join(path.sep)) === top) rel = parts.slice(k).join(path.sep);
    }
    const lexical = path.resolve(s);
    const parent = realish(path.dirname(lexical));
    const candidates = [lexical, parent ? path.join(parent, path.basename(lexical)) : null].filter(Boolean);
    for (const c of candidates) {
      for (const t of [top, path.resolve(repo)]) {
        if (t && rel === null && (c === t || c.startsWith(t + path.sep))) rel = path.relative(t, c);
      }
    }
  } else rel = s;
  if (rel !== null) {
    const r = safeRel(rel);
    const buf = gitBlob(repo, rev, r);
    return { path: r, source: `git:${rev}`, text: buf.toString("utf8"), sha256: sha256(buf) };
  }
  // (r9 A88) read the lexically resolved path that was checked and is recorded (never re-resolve `link/..`).
  const file = path.resolve(s);
  const buf = fs.readFileSync(file);
  return { path: file, source: "file", text: buf.toString("utf8"), sha256: sha256(buf) };
}

export function removeSnapshot(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  try { chmodTree(dir, 0o600, 0o700); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}

const lineCount = (buf) => { const s = buf.toString("utf8"); if (!s) return 0; const n = s.split("\n").length; return s.endsWith("\n") ? n - 1 : n; };

/**
 * buildInput(opts) -> ReviewInput
 * opts: { repo, rev, diffPath, scope[], contextRefs[], checklist[], briefPath, dimensions[], prior?, dispositions? }
 * The snapshot is a private mkdtemp directory (0500 dirs / 0400 files, owner only) outside the repository;
 * the caller removes it with removeSnapshot().
 */
export function buildInput(opts) {
  const repo = path.resolve(opts.repo);
  const resolvedRev = execFileSync("git", ["-C", repo, "rev-parse", "--verify", `${opts.rev}^{commit}`], { encoding: "utf8" }).trim();
  const diffText = fs.readFileSync(opts.diffPath, "utf8");
  const briefText = fs.readFileSync(opts.briefPath, "utf8");
  const scope = opts.scope.map(safeRel);
  if (!scope.length) throw new Error("--scope is empty");
  const contextRefs = (opts.contextRefs ?? []).map(safeRel).filter((p) => !scope.includes(p));
  const checklist = (opts.checklist ?? []).map((p) => readChecklist(repo, resolvedRev, p));

  const snapshot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-snap-")));
  const files = [];
  try {
    for (const [kind, list] of [["scope", scope], ["context", contextRefs]]) for (const rel of list) {
      const buf = gitBlob(repo, resolvedRev, rel);
      const dst = path.join(snapshot, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, buf);
      files.push({ path: rel, kind, bytes: buf.length, lines: lineCount(buf), sha256: sha256(buf) });
    }
    const meta = path.join(snapshot, "__review__");
    fs.mkdirSync(meta);
    fs.writeFileSync(path.join(meta, "diff.patch"), diffText);
    fs.writeFileSync(path.join(meta, "brief.md"), briefText);
    if (checklist.length) fs.writeFileSync(path.join(meta, "checklist.md"), checklist.map((c) => c.text).join("\n\n"));
    chmodTree(snapshot, 0o400, 0o500);
  } catch (e) { removeSnapshot(snapshot); throw e; }

  const scopeLines = new Map(files.filter((f) => f.kind === "scope").map((f) => [f.path, f.lines]));
  const diffFiles = parseDiffPaths(diffText).newPaths;
  return {
    repo, rev: opts.rev, resolvedRev, snapshot, files, scope, contextRefs, scopeLines,
    diffText, diffSha256: sha256(diffText), diffFiles, diffFilesNotInScope: diffFiles.filter((p) => !scope.includes(p)),
    briefText, briefSha256: sha256(briefText), checklist, dimensions: opts.dimensions,
    prior: opts.prior ?? null, dispositions: opts.dispositions ?? null,
    snapshotHashBefore: hashTree(snapshot),
  };
}

/** Thrown by buildPrompt when the parts that are never cut (rules, brief, earlier findings, dispositions, diff) exceed the budget. */
export class PromptBudgetError extends Error {
  constructor(message, detail) { super(message); this.name = "PromptBudgetError"; this.detail = detail; }
}

const utf8Bytes = (s) => Buffer.byteLength(s, "utf8");
/** The longest prefix of `s` that is at most `n` UTF-8 bytes, never splitting a character. */
function utf8Prefix(s, n) {
  const b = Buffer.from(s, "utf8");
  if (b.length <= n) return s;
  let end = Math.max(0, n);
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
  return b.subarray(0, end).toString("utf8");
}

/**
 * Host-neutral reviewer prompt. Adapters may wrap it (turn splitting, attachments) but never change its rules.
 * The scope is listed with repo-relative paths; the reviewer's working directory is the snapshot root.
 *
 * Order: rules, schema, brief, EARLIER FINDINGS, AUTHOR DISPOSITIONS, checklist, diff. The prior blocks come
 * before the checklist so a host that cuts a long prompt text cuts the checklist, never the prior findings (r8:
 * an Antigravity re-review whose first text block was cut at 134,525 bytes lost both prior blocks).
 * maxBytes (a host's max_prompt_text_bytes) bounds the UTF-8 size of the returned text plus reserveBytes (text the
 * adapter appends to the same block). Only the checklist is truncated to fit, with a marker that points at the full
 * copy in the snapshot; when the other parts alone do not fit, PromptBudgetError is thrown (the run is incomplete).
 * meta, when given, receives { bytes, maxBytes, checklist: { totalBytes, shownBytes, truncated } }.
 */
export function buildPrompt(input, { prefix, idStart, dimensions = input.dimensions, priorIds = [], toolNote, includeDiff = true, maxBytes = null, reserveBytes = 0, meta = null }) {
  const fileList = input.files.map((f) => `- ${f.path} (${f.lines} lines${f.kind === "context" ? ", context only" : ""})`).join("\n");
  const rules = [
    "You are an independent, READ-ONLY code reviewer. You must not modify files, run commands that change state, use the network, or delegate to other agents.",
    toolNote ?? "Your working directory is a read-only snapshot of the files under review at the post-change revision. Read files there with your read-only file tools.",
    `Snapshot root: ${input.snapshot}. The diff is at __review__/diff.patch, the brief at __review__/brief.md${input.checklist.length ? ", the checklist at __review__/checklist.md" : ""}.`,
    "Files in the snapshot (the review scope; context-only files may be read but findings must point at scope files):",
    fileList,
    `Every finding's loc MUST be a scope path exactly as listed plus a 1-based line number (or a-b range) at the post-change revision, e.g. "${input.scope[0]}:12". Do not use the diff, brief or checklist as a loc.`,
    "Each finding needs: claim (the defect), evidence (quote or cite concrete lines), and check (how a human or a test can confirm it). Report real defects, not style preferences. There is no length limit.",
    `Dimensions to review (coverage keys, all required, no others): ${dimensions.join(", ")}. Use "checked" only if you examined that dimension against code you read; otherwise "n/a:<reason>".`,
    "In limits, list anything relevant you could not read or verify.",
    `Severity: critical|high|med|low. verdict: "block" if any critical/high finding, "fix" if only med/low findings${priorIds.length ? " or any earlier finding is not verified" : ""}, "pass" otherwise.`,
    `New finding ids are ${prefix}${idStart}, ${prefix}${idStart + 1}, ... in order.`,
  ];
  if (priorIds.length) {
    rules.push(
      `RE-REVIEW: earlier findings ${priorIds.join(", ")} and the author's dispositions are attached below. The diff contains only the new commit(s).`,
      "In prior_verification give one entry per earlier id: verified=true only if you read the current code and the disposition holds (fixed: the defect is resolved; followup/accepted/blocked: the stated reason is accurate and nothing regressed); otherwise verified=false. note cites what you checked (file:line).",
      "Do not repeat an earlier finding as a new finding; a remaining or partial defect goes in prior_verification as verified=false.",
    );
  }
  rules.push("Respond with ONLY one JSON object, no prose and no code fences, matching exactly this shape:", schemaText(dimensions, prefix, idStart, priorIds));
  const brief = ["", "=== REVIEW BRIEF ===", input.briefText];
  const priorFindings = priorIds.length ? ["", "=== EARLIER FINDINGS ===", JSON.stringify(input.prior, null, 2)] : [];
  const dispositions = priorIds.length ? ["", "=== AUTHOR DISPOSITIONS ===", JSON.stringify(input.dispositions, null, 2)] : [];
  const diff = includeDiff ? ["", "=== DIFF UNDER REVIEW ===", input.diffText] : [];
  const checklistBody = input.checklist.map((c) => `--- ${path.basename(c.path)} ---\n${c.text}`).join("\n");
  const checklistTotal = utf8Bytes(checklistBody);
  const assemble = (checklist) => [...rules, ...brief, ...priorFindings, ...dispositions, ...checklist, ...diff].join("\n");
  const full = assemble(input.checklist.length ? ["", "=== CHECKLIST ===", checklistBody] : []);
  const record = (text, shown) => {
    if (meta) Object.assign(meta, { bytes: utf8Bytes(text), maxBytes, checklist: { totalBytes: checklistTotal, shownBytes: shown, truncated: shown < checklistTotal } });
    return text;
  };
  if (maxBytes == null || utf8Bytes(full) + reserveBytes <= maxBytes) return record(full, checklistTotal);

  // Over budget: keep every other part whole and cut only the checklist.
  const head = (shown) => `=== CHECKLIST (TRUNCATED to fit this host's prompt budget: the first ${shown} of ${checklistTotal} bytes are shown; the full checklist is __review__/checklist.md in the snapshot, read the rest there with your read-only file tool) ===`;
  const tailMark = "[... checklist truncated here; continue in __review__/checklist.md ...]";
  const fixed = utf8Bytes(assemble([])) + reserveBytes;
  // Bytes the truncated section adds besides the shown text: "\n" + "" + "\n" + head + "\n" + text + "\n" + mark.
  const overhead = input.checklist.length ? 4 + utf8Bytes(head(checklistTotal)) + utf8Bytes(tailMark) : 0;
  const room = maxBytes - fixed - overhead;
  if (!input.checklist.length || room < 0) {
    const sizes = { rules_and_schema: utf8Bytes(rules.join("\n")), brief: utf8Bytes(brief.join("\n")), earlier_findings: utf8Bytes(priorFindings.join("\n")), author_dispositions: utf8Bytes(dispositions.join("\n")), diff: utf8Bytes(diff.join("\n")), reserved: reserveBytes };
    const list = Object.entries(sizes).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(", ");
    throw new PromptBudgetError(`prompt_over_budget: the parts that are never cut need ${fixed} bytes (${list}) of max_prompt_text_bytes ${maxBytes}; only the checklist can be truncated`, { maxBytes, fixedBytes: fixed, sizes });
  }
  const shownText = utf8Prefix(checklistBody, room);
  const shown = utf8Bytes(shownText);
  return record(assemble(["", head(shown), shownText, tailMark]), shown);
}

// ---------------------------------------------------------------- redaction (raw logs are local, still scrubbed)
// r8: the sign-in URL ends at a JSON string boundary (`"`, `\`, whitespace), so a redacted line of
// raw/antigravity-messages.jsonl stays valid JSON. JSON escapes that may sit inside the URL itself
// (`\uXXXX`, e.g. Go's `\u0026` for `&`, and `\/`) are consumed whole, also at any nesting depth (a JSON
// string inside a JSON string doubles the backslashes: `\\u0026`, X1), so the query after them is still
// removed. A match starts after a non-backslash and swallows the whole backslash run of each escape, so it never
// splits one. The prefix accepts escaped slashes too (`https:\/\/accounts.google.com\/`). Any other escape
// (`\"`, `\n`, `\\` before anything but `u`/`/`) ends the URL and stays intact.
const AUTH_URL = /https:(?:\\*\/){2}accounts\.google\.com\\*\/(?:[^\s"\\]|\\+u[0-9A-Fa-f]{4}|\\+\/)*/g;
export function redact(s) {
  return String(s)
    .replace(/ya29\.[A-Za-z0-9_\-.]+/g, "[REDACTED]")
    .replace(/1\/\/[A-Za-z0-9_\-]{20,}/g, "[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]+/g, "[REDACTED]")
    .replace(/AIza[0-9A-Za-z_\-]{30,}/g, "[REDACTED]")
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_\-]{20,}/g, "[REDACTED]")
    .replace(AUTH_URL, "[auth-url-redacted]");
}

/**
 * Real path of `p`, resolving the longest existing prefix (so not-yet-existing paths still compare correctly).
 * null when the path cannot be resolved (e.g. a dangling symlink on the way): callers treat that as outside.
 * A82/A86: realpath.native returns the on-disk case on case-insensitive volumes (macOS APFS), so `/x/myrepo` and
 * `/x/MyRepo` (or `.GIT` and `.git`) compare equal; the JS realpath keeps the caller's spelling.
 */
export function realish(p) {
  let base = path.resolve(p);
  const rest = [];
  const present = (x) => { try { fs.lstatSync(x); return true; } catch { return false; } };
  while (!present(base) && path.dirname(base) !== base) { rest.unshift(path.basename(base)); base = path.dirname(base); }
  try { return path.join(fs.realpathSync.native(base), ...rest); } catch { return null; }
}

/**
 * A tool-reported path as a plain filesystem path, or null when it is not confidently one: any URI scheme
 * other than file: (case-insensitive), a file: URI with a non-local host or encoded separators, NUL bytes.
 */
export function plainPath(p) {
  const s = String(p);
  if (s.includes("\0")) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s)) {
    if (!/^file:/i.test(s)) return null;
    try {
      const u = new URL(s);
      if (u.protocol !== "file:" || (u.host && u.host !== "localhost")) return null;
      return fileURLToPath(u);
    } catch { return null; }
  }
  return s;
}

/** True when `p` (absolute, relative to root, or a file: URI) resolves inside root; symlinks along the path are resolved. */
export function insideRoot(root, p) {
  const plain = plainPath(p);
  if (plain === null) return false;
  // A47: a tool may expand "~" itself; a ~-prefixed path is never read as a relative name inside the root.
  if (plain.startsWith("~")) return false;
  const r = realish(root);
  const real = realish(path.resolve(root, plain));
  if (!r || !real) return false;
  return real === r || real.startsWith(r + path.sep);
}
