// Read-only access to an Antigravity 1.5+ session database (`antigravity-acp/conversations/<id>.db`).
// The 1.5 CLI has no local proxy and no `.meta` sidecar, so two facts the adapter used to read from the proxy's
// stderr and from `.meta` now come from this database:
//  - gen_metadata: one row per agent model generation; field 1 holds the generation metadata whose field 19 is
//    the base model id (`gemini-4-neon`) and field 21 the display name with the thinking level
//    (`Gemini 4 Neon (High)`). Layout taken from T3's antigravityUsageReader.ts (fields 1/19/21).
//  - trajectory_metadata_blob: one row; field 6 is the session id, field 1.1 and field 7 the workspace URIs
//    (T3's AntigravitySessionFiles.ts). Used to prove the session belongs to this run before deleting it.
// The database is opened read-only; credentials are never read from it (it holds none).
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Decode one protobuf message into Map<field, value[]> (varint -> number, length-delimited -> bytes). Throws on malformed input. */
export function protoFields(bytes) {
  let o = 0;
  const out = new Map();
  const varint = () => {
    let v = 0n;
    for (let s = 0n; s < 70n; s += 7n) {
      const b = bytes[o++];
      if (b === undefined) throw new Error("truncated varint");
      v |= BigInt(b & 127) << s;
      if (b < 128) return v > BigInt(Number.MAX_SAFE_INTEGER) ? -1 : Number(v);
    }
    throw new Error("varint too long");
  };
  while (o < bytes.length) {
    const tag = varint();
    if (tag < 0) throw new Error("bad tag");
    const n = Math.floor(tag / 8), wire = tag % 8;
    if (n === 0) throw new Error("field 0");
    let value;
    if (wire === 0) value = varint();
    else if (wire === 1 || wire === 5 || wire === 2) {
      const len = wire === 2 ? varint() : wire === 1 ? 8 : 4;
      if (len < 0 || len > bytes.length - o) throw new Error("truncated field");
      value = bytes.subarray(o, o + len);
      o += len;
      if (wire !== 2) continue;
    } else throw new Error(`unsupported wire type ${wire}`);
    if (!out.has(n)) out.set(n, []);
    out.get(n).push(value);
  }
  return out;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const textAt = (f, n) => { const v = f.get(n)?.[0]; return v instanceof Uint8Array ? utf8.decode(v).trim() : null; };
const bytesAt = (f, n) => { const v = f.get(n)?.[0]; return v instanceof Uint8Array ? v : null; };

/** "Gemini 4 Neon (High)" -> "gemini-4-neon-high" (same normalisation as T3's modelName). */
export function normalizeModelName(name) {
  return String(name ?? "").toLowerCase().trim().replace(/\s*\(([^)]*)\)\s*$/, "-$1").replace(/\s+/g, "-");
}

/** One gen_metadata row -> { model, display, normalized }. Throws when the row does not have the expected shape. */
export function decodeGeneration(data) {
  const meta = bytesAt(protoFields(data), 1);
  if (!meta) throw new Error("generation metadata missing");
  const f = protoFields(meta);
  const model = textAt(f, 19), display = textAt(f, 21);
  return { model, display, normalized: display ? normalizeModelName(display) : null };
}

/** trajectory_metadata_blob -> { sessionId, workspaceUris }. */
export function decodeTrajectory(data) {
  const f = protoFields(data);
  const uris = [];
  // Every workspace entry must yield a URI: an entry that cannot be read makes ownership unprovable (throws).
  for (const w of f.get(1) ?? []) { const u = w instanceof Uint8Array ? textAt(protoFields(w), 1) : null; if (!u) throw new Error("workspace entry without a URI"); uris.push(u); }
  for (const w of f.get(7) ?? []) { const u = w instanceof Uint8Array ? utf8.decode(w).trim() : ""; if (!u) throw new Error("workspace URI empty"); uris.push(u); }
  return { sessionId: textAt(f, 6), workspaceUris: uris };
}

let sqliteMod = null;
async function openReadOnly(dbPath) {
  if (!fs.lstatSync(dbPath).isFile()) throw new Error("session database is not a regular file");
  if (!sqliteMod) {
    // node:sqlite prints an ExperimentalWarning on first load in Node 22; it is the only warning silenced here.
    const orig = process.emitWarning;
    process.emitWarning = (w, ...a) => (String(w?.message ?? w).includes("SQLite") ? undefined : orig.call(process, w, ...a));
    try { sqliteMod = await import("node:sqlite"); } finally { process.emitWarning = orig; }
  }
  const db = new sqliteMod.DatabaseSync(dbPath, { readOnly: true });
  try { db.exec("PRAGMA busy_timeout = 200"); } catch {}
  return db;
}

/** Number of generation rows so far (cheap; used after each turn). Throws when unreadable. */
export async function countGenerations(dbPath) {
  const db = await openReadOnly(dbPath);
  try { return Number(db.prepare("SELECT count(*) AS c FROM gen_metadata").get().c); } finally { db.close(); }
}

/** Read all models from one owned session in one read-only snapshot after the writer exits. */
export async function sessionGenerations(dbPath, sessionId, cwd) {
  const db = await openReadOnly(dbPath);
  try {
    db.exec("BEGIN");
    const rows = db.prepare("SELECT data FROM trajectory_metadata_blob LIMIT 2").all();
    if (rows.length !== 1) throw new Error("expected one trajectory metadata row");
    const owner = decodeTrajectory(rows[0].data);
    if (owner.sessionId === null) throw new Error("session database has no session id");
    if (owner.sessionId !== sessionId) throw new Error("session database belongs to another session id");
    if (!owner.workspaceUris.length) throw new Error("session database has no workspace");
    const want = fs.realpathSync(cwd);
    const sameWorkspace = uri => {
      const workspace = fileURLToPath(uri);
      try { return fs.realpathSync(workspace) === want; } catch { return false; }
    };
    if (!owner.workspaceUris.every(sameWorkspace)) {
      throw new Error("session database workspace differs from runner cwd");
    }
    return db.prepare("SELECT data FROM gen_metadata ORDER BY idx").all().map(row => decodeGeneration(row.data));
  } finally { db.close(); }
}
