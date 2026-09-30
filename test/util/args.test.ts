import { describe, expect, it } from "vitest";
import { flagList, flagString, parseArgs } from "../../src/util/args.js";

describe("parseArgs", () => {
  it("splits command, positionals and flags", () => {
    const p = parseArgs(["sync", "me", "ekram", "--all", "-y"]);
    expect(p.command).toBe("sync");
    expect(p.positionals).toEqual(["me", "ekram"]);
    expect(p.flags.get("all")).toBe(true);
    expect(p.flags.get("y")).toBe(true);
  });

  it("takes --key=value and --key value for value flags", () => {
    expect(flagString(parseArgs(["x", "--store=/tmp/s"]), "store")).toBe("/tmp/s");
    expect(flagString(parseArgs(["x", "--store", "/tmp/s"]), "store")).toBe("/tmp/s");
  });

  it("does not swallow the next word after a boolean flag", () => {
    const p = parseArgs(["sync", "--all", "me"]);
    expect(p.positionals).toEqual(["me"]);
  });

  it("expands bundled short flags", () => {
    const p = parseArgs(["status", "-vn"]);
    expect(p.flags.get("v")).toBe(true);
    expect(p.flags.get("n")).toBe(true);
  });

  it("hands everything after -- to the child untouched", () => {
    const p = parseArgs(["run", "me", "--", "--resume", "-p", "hi"]);
    expect(p.positionals).toEqual(["me"]);
    expect(p.passthrough).toEqual(["--resume", "-p", "hi"]);
  });

  it("parses --only as a list", () => {
    expect(flagList(parseArgs(["sync", "--only", "projects, skills"]), "only")).toEqual([
      "projects",
      "skills",
    ]);
    expect(flagList(parseArgs(["sync"]), "only")).toBeUndefined();
  });
});
