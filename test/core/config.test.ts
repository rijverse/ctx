import { describe, expect, it } from "vitest";
import { defaultConfig, normalize } from "../../src/core/config.js";

describe("normalize", () => {
  it("drops a guarded entry someone added by hand", () => {
    const config = normalize({ shared: ["projects", ".credentials.json", ".claude.json"] });
    expect(config.shared).toEqual(["projects"]);
  });

  it("drops names it does not recognise", () => {
    expect(normalize({ shared: ["projects", "nonsense"] }).shared).toEqual(["projects"]);
  });

  it("drops local-only entries", () => {
    expect(normalize({ shared: ["projects", "cache"] }).shared).toEqual(["projects"]);
  });

  it("refuses to share oauthAccount however it is asked", () => {
    const config = normalize({ registryKeys: ["projects", "oauthAccount"] });
    expect(config.registryKeys).toEqual(["projects"]);
  });

  it("deduplicates", () => {
    expect(normalize({ shared: ["projects", "projects"] }).shared).toEqual(["projects"]);
  });

  it("falls back to the defaults for missing fields", () => {
    expect(normalize({})).toEqual(defaultConfig());
  });
});
