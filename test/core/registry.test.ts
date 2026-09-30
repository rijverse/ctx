import { describe, expect, it } from "vitest";
import {
  compose,
  describe as summarize,
  extract,
  mergeBack,
  SHARED_REGISTRY_KEYS,
} from "../../src/core/registry.js";

const KEYS = [...SHARED_REGISTRY_KEYS];

describe("extract", () => {
  it("takes only the shared keys", () => {
    const full = { projects: { a: {} }, oauthAccount: { emailAddress: "x@y.z" }, userID: "u" };
    expect(extract(full, KEYS)).toEqual({ projects: { a: {} } });
  });

  it("skips keys the file does not have", () => {
    expect(extract({ userID: "u" }, KEYS)).toEqual({});
  });
});

describe("compose", () => {
  it("overlays the store slice without disturbing identity", () => {
    const profile = { oauthAccount: { emailAddress: "me@example.com" }, projects: { old: {} } };
    const slice = { projects: { shared: {} } };
    const out = compose(profile, slice, KEYS);
    expect(out.oauthAccount).toEqual({ emailAddress: "me@example.com" });
    expect(out.projects).toEqual({ shared: {} });
  });

  it("leaves the profile's value when the store has none", () => {
    const profile = { projects: { mine: {} }, userID: "u" };
    expect(compose(profile, {}, KEYS)).toEqual(profile);
  });
});

describe("mergeBack", () => {
  it("unions projects from different profiles", () => {
    const slice = { projects: { "/a": { hasTrustDialogAccepted: true } } };
    const session = { projects: { "/b": { hasTrustDialogAccepted: true } } };
    const out = mergeBack(slice, session, KEYS) as { projects: Record<string, unknown> };
    expect(Object.keys(out.projects).sort()).toEqual(["/a", "/b"]);
  });

  it("prefers the fresher entry per project", () => {
    const slice = { projects: { "/a": { lastSessionModified: 200, lastSessionId: "old" } } };
    const session = { projects: { "/a": { lastSessionModified: 100, lastSessionId: "newer-run" } } };
    const out = mergeBack(slice, session, KEYS) as { projects: Record<string, { lastSessionId: string }> };
    expect(out.projects["/a"]!.lastSessionId).toBe("old");
  });

  it("keeps fields the fresher entry does not mention", () => {
    const slice = { projects: { "/a": { lastSessionModified: 1, allowedTools: ["Bash"] } } };
    const session = { projects: { "/a": { lastSessionModified: 2, mcpServers: { x: {} } } } };
    const out = mergeBack(slice, session, KEYS) as { projects: Record<string, Record<string, unknown>> };
    expect(out.projects["/a"]!.allowedTools).toEqual(["Bash"]);
    expect(out.projects["/a"]!.mcpServers).toEqual({ x: {} });
  });

  it("never picks up identity", () => {
    const out = mergeBack({}, { oauthAccount: { emailAddress: "x" }, userID: "u" }, KEYS);
    expect(out).toEqual({});
  });

  it("merges plain objects key by key", () => {
    const out = mergeBack({ mcpServers: { a: 1 } }, { mcpServers: { b: 2 } }, KEYS);
    expect(out.mcpServers).toEqual({ a: 1, b: 2 });
  });

  it("is a no-op for keys the session lacks", () => {
    const slice = { projects: { "/a": {} }, mcpServers: { a: 1 } };
    expect(mergeBack(slice, {}, KEYS)).toEqual(slice);
  });
});

describe("summarize", () => {
  it("counts projects, trusted projects and servers", () => {
    const slice = {
      projects: { "/a": { hasTrustDialogAccepted: true }, "/b": {} },
      mcpServers: { one: {} },
    };
    expect(summarize(slice)).toBe("2 projects (1 trusted), 1 mcp servers");
  });

  it("copes with an empty slice", () => {
    expect(summarize({})).toBe("0 projects (0 trusted), 0 mcp servers");
  });
});
