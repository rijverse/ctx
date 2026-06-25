import { describe, it, expect } from "vitest";
import { renderMarkdownHandoff } from "../../src/render/markdown-handoff.js";
import { makePortableSession } from "../../src/schema/portable.js";

describe("renderMarkdownHandoff", () => {
  it("renders a session header with metadata", () => {
    const session = makePortableSession({
      source: { tool: "claude", version: "2.1.161" },
      session: {
        id: "abc-123",
        started_at: "2026-06-25T10:00:00.000Z",
        cwd: "/home/test/project",
        git_branch: "main",
        model: "claude-opus-4-8",
      },
      messages: [
        { role: "user", content: "Hello, world!" },
        { role: "assistant", content: "Hi there!" },
      ],
    });

    const md = renderMarkdownHandoff(session);
    expect(md).toContain("# Session handoff");
    expect(md).toContain("**claude**");
    expect(md).toContain("Hello, world!");
    expect(md).toContain("Hi there!");
    expect(md).toContain("`/home/test/project`");
    expect(md).toContain("**Model**: claude-opus-4-8");
  });

  it("renders tool_use blocks as fenced JSON", () => {
    const session = makePortableSession({
      source: { tool: "claude" },
      session: { id: "s1", cwd: "/tmp" },
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Reading the file..." },
            {
              type: "tool_use",
              id: "toolu_abc",
              name: "Read",
              input: { file_path: "/tmp/x.txt" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_abc",
              content: "file contents here",
              is_error: false,
            },
          ],
        },
      ],
    });

    const md = renderMarkdownHandoff(session);
    expect(md).toContain("Tool call: `Read`");
    expect(md).toContain("toolu_abc");
    expect(md).toContain("file_path");
    expect(md).toContain("Tool result");
    expect(md).toContain("file contents here");
  });

  it("renders a Decisions section when provided", () => {
    const session = makePortableSession({
      source: { tool: "claude" },
      session: { id: "s1", cwd: "/tmp" },
      messages: [],
      decisions: ["Use TypeScript strict mode", "Prefer functional components"],
    });

    const md = renderMarkdownHandoff(session);
    expect(md).toContain("## Decisions to carry forward");
    expect(md).toContain("Use TypeScript strict mode");
    expect(md).toContain("Prefer functional components");
  });
});
