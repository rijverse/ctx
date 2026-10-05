import { describe, expect, it } from "vitest";
import {
  compose,
  describe as summarize,
  extract,
  looksReset,
  mergeShared,
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

describe("mergeShared", () => {
  type P = { projects: Record<string, Record<string, unknown>>; mcpServers: Record<string, unknown> };
  const merge = (base: object, store: object, profile: object) =>
    mergeShared(base as never, store as never, profile as never, KEYS) as unknown as P;

  it("unions projects from different profiles", () => {
    const out = merge({}, { projects: { "/a": {} } }, { projects: { "/b": {} } });
    expect(Object.keys(out.projects).sort()).toEqual(["/a", "/b"]);
  });

  it("lets a profile delete an MCP server for everyone", () => {
    const base = { mcpServers: { foo: { command: "foo" }, bar: { command: "bar" } } };
    const out = merge(base, base, { mcpServers: { bar: { command: "bar" } } });
    expect(Object.keys(out.mcpServers)).toEqual(["bar"]);
  });

  it("keeps what other profiles added when this one did not touch the key", () => {
    const base = { mcpServers: { foo: {} } };
    const out = merge(base, { mcpServers: { foo: {}, added: {} } }, base);
    expect(Object.keys(out.mcpServers).sort()).toEqual(["added", "foo"]);
  });

  it("deletes nothing on first contact, when there is no common history", () => {
    const out = merge({}, { mcpServers: { a: 1 } }, { mcpServers: { b: 2 } });
    expect(out.mcpServers).toEqual({ a: 1, b: 2 });
  });

  it("reads an emptied or missing key as no opinion, not as delete-all", () => {
    const base = { mcpServers: { a: 1 }, projects: { "/a": {} } };
    expect(merge(base, base, { mcpServers: {}, projects: { "/a": {} } }).mcpServers).toEqual({ a: 1 });
    expect(merge(base, base, { projects: { "/a": {} } }).mcpServers).toEqual({ a: 1 });
  });

  it("keeps a trust flag set on either side when the two never agreed before", () => {
    const store = { projects: { "/a": { hasTrustDialogAccepted: true } } };
    const profile = { projects: { "/a": { hasTrustDialogAccepted: false, lastSessionId: "s2" } } };
    const out = merge({}, store, profile);
    expect(out.projects["/a"]).toEqual({ hasTrustDialogAccepted: true, lastSessionId: "s2" });
  });

  it("merges lists as sets, honouring removals on either side", () => {
    const base = { projects: { "/a": { allowedTools: ["Bash", "Read"] } } };
    const store = { projects: { "/a": { allowedTools: ["Bash", "Read", "Edit"] } } };
    const profile = { projects: { "/a": { allowedTools: ["Read", "Grep"] } } };
    expect(merge(base, store, profile).projects["/a"]!.allowedTools).toEqual(["Read", "Edit", "Grep"]);
  });

  it("lets an edit beat a deletion of the same entry", () => {
    const base = { mcpServers: { a: { args: [] } }, projects: { "/x": {} } };
    const store = { mcpServers: {}, projects: { "/x": {} } };
    const profile = { mcpServers: { a: { args: ["--v2"] } }, projects: { "/x": {} } };
    expect(merge(base, store, profile).mcpServers).toEqual({ a: { args: ["--v2"] } });
  });

  it("gives a true conflict to the profile, the latest writer", () => {
    const base = { projects: { "/a": { lastSessionId: "s0" } } };
    const out = merge(base, { projects: { "/a": { lastSessionId: "s1" } } }, { projects: { "/a": { lastSessionId: "s2" } } });
    expect(out.projects["/a"]!.lastSessionId).toBe("s2");
  });

  it("merges fields of one project independently", () => {
    const base = { projects: { "/a": { x: 1, y: 1 } } };
    const out = merge(base, { projects: { "/a": { x: 2, y: 1 } } }, { projects: { "/a": { x: 1, y: 3 } } });
    expect(out.projects["/a"]).toEqual({ x: 2, y: 3 });
  });

  it("never picks up identity", () => {
    const out = mergeShared({}, {}, { oauthAccount: { emailAddress: "x" }, userID: "u" }, KEYS);
    expect(out).toEqual({});
  });
});

describe("looksReset", () => {
  it("flags a profile whose projects vanished", () => {
    expect(looksReset({ projects: { "/a": {} } }, { projects: {} })).toBe(true);
    expect(looksReset({ projects: { "/a": {} } }, { userID: "fresh" })).toBe(true);
  });

  it("leaves ordinary profiles alone", () => {
    expect(looksReset({ projects: { "/a": {} } }, { projects: { "/b": {} } })).toBe(false);
    expect(looksReset({}, { projects: {} })).toBe(false);
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
