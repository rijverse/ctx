import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  expandHome,
  absPath,
  encodeCwd,
  decodeCwd,
  samePath,
  isInside,
} from "../../src/fs/paths.js";

describe("expandHome", () => {
  it("expands bare ~ and ~/...", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/.claude-shared")).toBe(join(homedir(), ".claude-shared"));
  });
  it("leaves absolute and relative paths alone", () => {
    expect(expandHome("/etc/hosts")).toBe("/etc/hosts");
    expect(expandHome("foo/bar")).toBe("foo/bar");
    expect(expandHome("~user/x")).toBe("~user/x"); // not us
  });
});

describe("absPath", () => {
  it("expands ~ then resolves", () => {
    expect(absPath("~/x")).toBe(join(homedir(), "x"));
  });
});

describe("encodeCwd / decodeCwd", () => {
  it("round-trips an absolute path", () => {
    const cwd = "/home/robert/www/ctx";
    expect(encodeCwd(cwd)).toBe("-home-robert-www-ctx");
    expect(decodeCwd(encodeCwd(cwd))).toBe(cwd);
  });
});

describe("samePath", () => {
  it("ignores trailing separators", () => {
    expect(samePath("/a/b", "/a/b/")).toBe(true);
    expect(samePath("/a/b", "/a/c")).toBe(false);
  });
});

describe("isInside", () => {
  it("treats equal and nested as inside", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b/c", "/a/b")).toBe(true);
  });
  it("rejects siblings and prefix look-alikes", () => {
    expect(isInside("/a/c", "/a/b")).toBe(false);
    expect(isInside("/a/bc", "/a/b")).toBe(false);
  });
});
