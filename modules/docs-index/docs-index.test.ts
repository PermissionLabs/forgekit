import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, renderIndex, validateRegistry } from "./docs-index.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "forgekit-docs-"));
  roots.push(root);
  mkdirSync(join(root, "docs/_meta"), { recursive: true });
  writeFileSync(join(root, "docs/GUIDE.md"), "# Guide\n");
  const registry = {
    version: 1,
    documents: [{
      path: "docs/GUIDE.md",
      title: "Guide",
      purpose: "Primary task routing",
      authority: "primary",
      status: "active",
      owner: "platform",
      last_verified_at: "2026-07-11",
    }],
  };
  writeFileSync(
    join(root, "docs/_meta/registry.json"),
    JSON.stringify(registry, null, 2) + "\n",
  );
  return { root, registry };
}

describe("generated docs index", () => {
  test("generates and checks a deterministic primary index", () => {
    const { root, registry } = fixture();
    expect(validateRegistry(registry, root)).toEqual([]);
    main(["--root", root]);
    expect(() => main(["--root", root, "--check"])).not.toThrow();
    expect(renderIndex(registry.documents as never)).toContain(
      "[Guide](./GUIDE.md)",
    );
  });

  test("rejects missing files and duplicate active titles", () => {
    const { root, registry } = fixture();
    registry.documents.push({
      ...registry.documents[0],
      path: "docs/MISSING.md",
    });
    const errors = validateRegistry(registry, root);
    expect(errors.some((error) => error.includes("missing file"))).toBe(true);
    expect(errors.some((error) => error.includes("duplicate active title"))).toBe(true);
  });

  test("rejects unknown authority and status values", () => {
    const { root, registry } = fixture();
    const invalid = structuredClone(registry) as unknown as {
      documents: Array<Record<string, unknown>>;
    };
    invalid.documents[0].authority = "guess";
    invalid.documents[0].status = "current-ish";
    const errors = validateRegistry(invalid, root);
    expect(errors.some((error) => error.includes("unsupported authority"))).toBe(true);
    expect(errors.some((error) => error.includes("unsupported status"))).toBe(true);
  });

  test("rejects registry paths that escape docs", () => {
    const { root, registry } = fixture();
    const invalid = structuredClone(registry) as unknown as {
      documents: Array<Record<string, unknown>>;
    };
    invalid.documents[0].path = "docs/../outside.md";
    expect(
      validateRegistry(invalid, root).some((error) =>
        error.includes("must stay within docs")
      ),
    ).toBe(true);
  });

  test("rejects registry paths that escape docs through symlinks", () => {
    const { root, registry } = fixture();
    writeFileSync(join(root, "outside.md"), "# Outside\n");
    symlinkSync(join(root, "outside.md"), join(root, "docs/ESCAPE.md"));
    const invalid = structuredClone(registry) as unknown as {
      documents: Array<Record<string, unknown>>;
    };
    invalid.documents[0].path = "docs/ESCAPE.md";
    expect(
      validateRegistry(invalid, root).some((error) => error.includes("symlink")),
    ).toBe(true);
  });

  test("fails closed when the generated index is stale", () => {
    const { root } = fixture();
    writeFileSync(join(root, "docs/INDEX.md"), "stale\n");
    expect(() => main(["--root", root, "--check"])).toThrow("is stale");
  });
});
