#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

type Json = Record<string, unknown>;
type Validation = { valid: boolean; errors: string[] };

const schema = JSON.parse(
  readFileSync(join(import.meta.dir, "schema.json"), "utf8"),
) as Json;
const phases = new Set(
  ((schema.properties as Json).phase as Json).enum as string[],
);
const trackStatuses = new Set([
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "skipped",
]);
const secretField = new RegExp(
  schema["x-secret-deny-field-pattern"] as string,
  "i",
);
const secretValue = new RegExp(
  schema["x-secret-deny-value-pattern"] as string,
);

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scanSecrets(value: unknown, path: string, errors: string[]): void {
  if (typeof value === "string") {
    if (secretValue.test(value)) {
      errors.push(`${path}: secret-looking values are forbidden`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      scanSecrets(entry, `${path}[${index}]`, errors)
    );
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (secretField.test(key)) {
      errors.push(`${path}.${key}: secret-bearing fields are forbidden`);
    }
    scanSecrets(child, `${path}.${key}`, errors);
  }
}

export function validateState(value: unknown): Validation {
  const errors: string[] = [];
  if (!isObject(value)) return { valid: false, errors: ["$: object required"] };
  if (value.version !== 3) errors.push("$.version: must be 3");
  if (typeof value.task !== "string" || !value.task) {
    errors.push("$.task: non-empty string required");
  }
  if (!phases.has(value.phase as string)) {
    errors.push(`$.phase: unsupported phase ${JSON.stringify(value.phase)}`);
  }
  if (typeof value.branch !== "string" || !value.branch) {
    errors.push("$.branch: non-empty string required");
  }
  if (typeof value.tracking !== "boolean") {
    errors.push("$.tracking: boolean required");
  }
  if (!isObject(value.isolation)) {
    errors.push("$.isolation: object required");
  } else {
    if (!["worktree", "checkout"].includes(String(value.isolation.mode))) {
      errors.push("$.isolation.mode: worktree or checkout required");
    }
    for (const key of ["path", "branch"] as const) {
      if (typeof value.isolation[key] !== "string" || !value.isolation[key]) {
        errors.push(`$.isolation.${key}: non-empty string required`);
      }
    }
    if (typeof value.isolation.verified_before_edit !== "boolean") {
      errors.push("$.isolation.verified_before_edit: boolean required");
    }
  }
  if (!isObject(value.tracks)) {
    errors.push("$.tracks: object required");
  } else {
    for (const [id, track] of Object.entries(value.tracks)) {
      if (!isObject(track)) errors.push(`$.tracks.${id}: object required`);
      else {
        if (!trackStatuses.has(String(track.status))) {
          errors.push(`$.tracks.${id}.status: unsupported status`);
        }
        if (typeof track.note !== "string") {
          errors.push(`$.tracks.${id}.note: string required`);
        }
      }
    }
  }
  if (!Array.isArray(value.reviews)) errors.push("$.reviews: array required");
  else {
    const ids = new Set<string>();
    value.reviews.forEach((review, index) => {
      const path = `$.reviews[${index}]`;
      if (!isObject(review)) {
        errors.push(`${path}: object required`);
        return;
      }
      for (const key of ["id", "type", "status", "note"] as const) {
        if (typeof review[key] !== "string" || (key !== "note" && !review[key])) {
          errors.push(
            `${path}.${key}: ${key === "note" ? "string" : "non-empty string"} required`,
          );
        }
      }
      if (typeof review.id === "string") {
        if (ids.has(review.id)) errors.push(`${path}.id: duplicate ${review.id}`);
        ids.add(review.id);
      }
      if (!Number.isInteger(review.findings) || Number(review.findings) < 0) {
        errors.push(`${path}.findings: non-negative integer required`);
      }
    });
  }
  if (!isObject(value.verification)) {
    errors.push("$.verification: object required");
  } else {
    for (const key of ["passed", "pending", "skipped"] as const) {
      if (
        !Array.isArray(value.verification[key]) ||
        (value.verification[key] as unknown[]).some((entry) =>
          typeof entry !== "string"
        )
      ) errors.push(`$.verification.${key}: string array required`);
    }
  }
  if (typeof value.next_step !== "string") {
    errors.push("$.next_step: string required");
  }
  if (
    typeof value.updated_at !== "string" ||
    Number.isNaN(Date.parse(value.updated_at))
  ) errors.push("$.updated_at: RFC 3339 date-time required");
  scanSecrets(value, "$", errors);
  return { valid: errors.length === 0, errors };
}

function readState(path: string): Json {
  const state = JSON.parse(readFileSync(path, "utf8"));
  const result = validateState(state);
  if (!result.valid) throw new Error(`${path}:\n  ${result.errors.join("\n  ")}`);
  return state;
}

export function writeStateAtomic(path: string, state: Json): void {
  const result = validateState(state);
  if (!result.valid) {
    throw new Error(`refusing invalid state:\n  ${result.errors.join("\n  ")}`);
  }
  const serialized = JSON.stringify(state, null, 2) + "\n";
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${path.split("/").at(-1)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (existsSync(path)) chmodSync(temporary, statSync(path).mode);
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function parse(values: string[]) {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) positionals.push(value);
    else {
      const [name, inline] = value.split("=", 2);
      const next = inline ?? values[++index];
      if (!next || next.startsWith("--")) throw new Error(`${name} needs a value`);
      flags.set(name, next);
    }
  }
  return { positionals, flags };
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function now(): string {
  return new Date().toISOString();
}

function mutate(path: string, callback: (state: Json) => void): void {
  const state = structuredClone(readState(path));
  callback(state);
  state.updated_at = now();
  writeStateAtomic(path, state);
}

function usage(): never {
  console.error(`usage: bun modules/workflow-state/state.ts <command> [options]

commands:
  init --task T --branch B --worktree PATH [--file FILE]
  validate [--file FILE]
  show [--file FILE]
  set-phase PHASE [--file FILE]
  set-track ID --status STATUS --note TEXT [--file FILE]
  add-review ID --type TYPE --status STATUS --findings N --note TEXT [--file FILE]
  touch --next-step TEXT [--file FILE]`);
  process.exit(2);
}

export function main(values = process.argv.slice(2)): void {
  const { positionals, flags } = parse(values);
  const command = positionals[0];
  const path = resolve(
    flags.get("--file") ?? join(process.cwd(), ".context/workflow-state.json"),
  );
  if (command === "init") {
    const task = required(flags, "--task");
    const branch = required(flags, "--branch");
    writeStateAtomic(path, {
      version: 3,
      task,
      phase: "plan",
      branch,
      tracking: true,
      isolation: {
        mode: "worktree",
        path: resolve(required(flags, "--worktree")),
        branch,
        verified_before_edit: true,
      },
      tracks: {},
      reviews: [],
      verification: { passed: [], pending: [], skipped: [] },
      next_step: "Record the concrete task plan before editing.",
      updated_at: now(),
    });
  } else if (command === "validate") {
    readState(path);
    console.log(`VALID\t${path}`);
  } else if (command === "show") {
    console.log(JSON.stringify(readState(path), null, 2));
  } else if (command === "set-phase") {
    const phase = positionals[1] ?? "";
    if (!phases.has(phase)) throw new Error(`unsupported phase: ${phase}`);
    mutate(path, (state) => {
      state.phase = phase;
    });
  } else if (command === "set-track") {
    const id = positionals[1];
    const status = required(flags, "--status");
    if (!id || !trackStatuses.has(status)) throw new Error("invalid track id/status");
    mutate(path, (state) => {
      (state.tracks as Json)[id] = { status, note: required(flags, "--note") };
    });
  } else if (command === "add-review") {
    const id = positionals[1];
    if (!id) throw new Error("review id required");
    mutate(path, (state) => {
      const reviews = state.reviews as unknown[];
      if (reviews.some((review) => isObject(review) && review.id === id)) {
        throw new Error(`duplicate review: ${id}`);
      }
      reviews.push({
        id,
        type: required(flags, "--type"),
        status: required(flags, "--status"),
        findings: Number(required(flags, "--findings")),
        note: required(flags, "--note"),
      });
    });
  } else if (command === "touch") {
    mutate(path, (state) => {
      state.next_step = required(flags, "--next-step");
    });
  } else usage();
}

if (import.meta.main) {
  try {
    main();
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
