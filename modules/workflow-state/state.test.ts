import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, validateState } from "./state.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "forgekit-state-"));
  roots.push(root);
  return { root, state: join(root, ".context/workflow-state.json") };
}

describe("workflow-state core", () => {
  test("initializes and mutates a valid isolated state", () => {
    const { root, state } = fixture();
    main([
      "init",
      "--task",
      "feat/test",
      "--branch",
      "feat/test",
      "--worktree",
      root,
      "--file",
      state,
    ]);
    main(["set-phase", "implement", "--file", state]);
    main([
      "set-track",
      "core",
      "--status",
      "completed",
      "--note",
      "verified",
      "--file",
      state,
    ]);
    const parsed = JSON.parse(readFileSync(state, "utf8"));
    expect(validateState(parsed)).toEqual({ valid: true, errors: [] });
    expect(parsed.phase).toBe("implement");
    expect(parsed.tracks.core.status).toBe("completed");
  });

  test("rejects secret-bearing fields and preserves valid bytes", () => {
    const { root, state } = fixture();
    main([
      "init",
      "--task",
      "feat/test",
      "--branch",
      "feat/test",
      "--worktree",
      root,
      "--file",
      state,
    ]);
    const before = readFileSync(state, "utf8");
    const parsed = JSON.parse(before);
    parsed.api_token = "do-not-store";
    expect(validateState(parsed).valid).toBe(false);
    expect(readFileSync(state, "utf8")).toBe(before);
  });

  test("rejects credential-shaped string values", () => {
    const { root, state } = fixture();
    main([
      "init",
      "--task",
      "feat/test",
      "--branch",
      "feat/test",
      "--worktree",
      root,
      "--file",
      state,
    ]);
    const parsed = JSON.parse(readFileSync(state, "utf8"));
    parsed.next_step = "feat/task-abcdefghijklmnop risk-abcdefghijklmnop";
    expect(validateState(parsed).valid).toBe(true);
    parsed.verification.pending.push(["sk", "proj", "abcdefghijklmnop"].join("-"));
    expect(validateState(parsed).valid).toBe(false);
  });

  test("rejects duplicate reviews atomically", () => {
    const { root, state } = fixture();
    main([
      "init",
      "--task",
      "feat/test",
      "--branch",
      "feat/test",
      "--worktree",
      root,
      "--file",
      state,
    ]);
    const args = [
      "add-review",
      "R1",
      "--type",
      "code",
      "--status",
      "passed",
      "--findings",
      "0",
      "--note",
      "clean",
      "--file",
      state,
    ];
    main(args);
    const before = readFileSync(state, "utf8");
    expect(() => main(args)).toThrow("duplicate review");
    expect(readFileSync(state, "utf8")).toBe(before);
  });

  test("rejects malformed review findings", () => {
    const { root, state } = fixture();
    main([
      "init",
      "--task",
      "feat/test",
      "--branch",
      "feat/test",
      "--worktree",
      root,
      "--file",
      state,
    ]);
    expect(() =>
      main([
        "add-review",
        "R1",
        "--type",
        "code",
        "--status",
        "passed",
        "--findings",
        "not-a-number",
        "--note",
        "invalid",
        "--file",
        state,
      ])
    ).toThrow("non-negative integer required");
  });
});
