#!/usr/bin/env bun
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";

type Document = {
  path: string;
  title: string;
  purpose: string;
  authority: "primary" | "secondary" | "historical";
  status: "active" | "superseded" | "archived";
  owner: string;
  last_verified_at: string;
  supersedes?: string[];
};

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function validateRegistry(value: unknown, root: string): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["registry must be an object"];
  }
  const registry = value as { version?: unknown; documents?: unknown };
  if (registry.version !== 1) errors.push("version must be 1");
  if (!Array.isArray(registry.documents)) return [...errors, "documents must be an array"];
  const paths = new Set<string>();
  const activeTitles = new Set<string>();
  registry.documents.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`documents[${index}] must be an object`);
      return;
    }
    const document = raw as Partial<Document>;
    for (const key of [
      "path",
      "title",
      "purpose",
      "authority",
      "status",
      "owner",
      "last_verified_at",
    ] as const) {
      if (typeof document[key] !== "string" || !document[key]) {
        errors.push(`documents[${index}].${key} is required`);
      }
    }
    if (document.path) {
      const resolvedPath = resolve(root, document.path);
      const docsRootPath = resolve(root, "docs");
      const docsRoot = realpathSync(docsRootPath);
      if (
        !/^docs\/[A-Za-z0-9._/-]+\.md$/.test(document.path) ||
        document.path.split("/").includes("..") ||
        !(resolvedPath === docsRootPath || resolvedPath.startsWith(docsRootPath + sep))
      ) {
        errors.push(`${document.path}: path must stay within docs/ and use safe characters`);
      }
      if (paths.has(document.path)) errors.push(`${document.path}: duplicate path`);
      paths.add(document.path);
      if (!existsSync(resolvedPath)) errors.push(`${document.path}: missing file`);
      else if (
        lstatSync(resolvedPath).isSymbolicLink() ||
        !realpathSync(resolvedPath).startsWith(docsRoot + sep)
      ) {
        errors.push(`${document.path}: symlink must not escape docs/`);
      }
    }
    if (
      document.authority &&
      !["primary", "secondary", "historical"].includes(document.authority)
    ) errors.push(`${document.path}: unsupported authority ${document.authority}`);
    if (
      document.status &&
      !["active", "superseded", "archived"].includes(document.status)
    ) errors.push(`${document.path}: unsupported status ${document.status}`);
    if (
      document.last_verified_at &&
      !/^\d{4}-\d{2}-\d{2}$/.test(document.last_verified_at)
    ) errors.push(`${document.path}: last_verified_at must be YYYY-MM-DD`);
    if (document.status === "active" && document.title) {
      if (activeTitles.has(document.title)) {
        errors.push(`${document.title}: duplicate active title`);
      }
      activeTitles.add(document.title);
    }
  });
  return errors;
}

export function renderIndex(documents: Document[]): string {
  const active = documents
    .filter((document) =>
      document.status === "active" && document.authority === "primary"
    )
    .sort((left, right) => left.title.localeCompare(right.title));
  const rows = active.map((document) => {
    const link = `./${document.path.replace(/^docs\//, "")}`;
    return `| [${escapeCell(document.title)}](${link}) | ${escapeCell(document.purpose)} | ${document.owner} | ${document.last_verified_at} |`;
  });
  return [
    "# Documentation Index",
    "",
    "Generated from `docs/_meta/registry.json`. Do not edit by hand.",
    "",
    "| Document | Purpose | Owner | Verified |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

export function main(values = process.argv.slice(2)): void {
  const check = values.includes("--check");
  const rootIndex = values.indexOf("--root");
  const root = resolve(rootIndex >= 0 ? values[rootIndex + 1] : process.cwd());
  const registryPath = join(root, "docs/_meta/registry.json");
  const outputPath = join(root, "docs/INDEX.md");
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
    documents: Document[];
  };
  const errors = validateRegistry(registry, root);
  if (errors.length) throw new Error(errors.join("\n"));
  const rendered = renderIndex(registry.documents);
  if (check) {
    if (!existsSync(outputPath) || readFileSync(outputPath, "utf8") !== rendered) {
      throw new Error(`${relative(root, outputPath)} is stale`);
    }
    console.log("docs-index: current");
  } else {
    writeFileSync(outputPath, rendered);
    console.log(`docs-index: generated ${relative(root, outputPath)}`);
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
