import { describe, expect, it } from "vitest";
import { defaultShared, INVENTORY, isGuarded, itemByName, itemsWithRole } from "../../src/core/inventory.js";

describe("inventory", () => {
  it("has no duplicate names", () => {
    const names = INVENTORY.map((i) => i.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("never offers an identity entry as shareable", () => {
    for (const name of defaultShared()) expect(isGuarded(name)).toBe(false);
  });

  it("guards the files that carry a login", () => {
    for (const name of [".credentials.json", ".claude.json", "policy-limits.json"]) {
      expect(isGuarded(name)).toBe(true);
    }
  });

  it("guards the temp files Claude writes while saving the registry", () => {
    expect(isGuarded(".claude.json.tmp.2989669.26bd1a0a524b")).toBe(true);
  });

  it("rejects path traversal", () => {
    expect(isGuarded("..")).toBe(true);
    expect(isGuarded("../../etc/passwd")).toBe(true);
  });

  it("leaves machine-local scratch out of the shared set", () => {
    const local = itemsWithRole("local").map((i) => i.name);
    for (const name of ["cache", "sessions", "telemetry", "shell-snapshots"]) {
      expect(local).toContain(name);
      expect(defaultShared()).not.toContain(name);
    }
  });

  it("shares the things that make a session portable", () => {
    for (const name of ["projects", "todos", "file-history", "history.jsonl", "skills"]) {
      expect(itemByName(name)?.role).toBe("shared");
    }
  });
});
