import type { ContentBlock, PortableSession } from "../schema/portable.js";

/**
 * Render a portable session as a Markdown document for pasting into a
 * target CLI's prompt. Optimized for readability, not for round-trip.
 */
export function renderMarkdownHandoff(session: PortableSession): string {
  const lines: string[] = [];

  // Header
  lines.push(`# Session handoff`);
  lines.push("");
  lines.push(`> Exported from **${session.source.tool}** on ${session.source.exported_at}`);
  lines.push("");
  lines.push(`- **Session ID**: \`${session.session.id}\``);
  if (session.session.started_at) {
    lines.push(`- **Started**: ${session.session.started_at}`);
  }
  lines.push(`- **Working directory**: \`${session.session.cwd}\``);
  if (session.session.git_branch) {
    lines.push(`- **Git branch**: \`${session.session.git_branch}\``);
  }
  if (session.session.model) {
    lines.push(`- **Model**: ${session.session.model}`);
  }
  lines.push(`- **Messages**: ${session.messages.length}`);
  lines.push("");

  if (session.system) {
    lines.push("## System context");
    lines.push("");
    lines.push(formatContent(session.system));
    lines.push("");
  }

  if (session.decisions && session.decisions.length > 0) {
    lines.push("## Decisions to carry forward");
    lines.push("");
    for (const d of session.decisions) {
      lines.push(`- ${d}`);
    }
    lines.push("");
  }

  // Conversation
  lines.push("## Conversation");
  lines.push("");
  for (const msg of session.messages) {
    const heading =
      msg.role === "user"
        ? "## User"
        : msg.role === "assistant"
          ? "## Assistant"
          : "## System";
    lines.push(heading);
    lines.push("");
    if (msg.model) {
      lines.push(`*(${msg.model})*`);
      lines.push("");
    }
    lines.push(formatContent(msg.content));
    lines.push("");
  }

  return lines.join("\n");
}

function formatContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content.map(formatBlock).join("\n\n");
}

function formatBlock(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "thinking":
      return `<details><summary>Thinking</summary>\n\n${block.thinking}\n\n</details>`;
    case "redacted_thinking":
      return `*[redacted thinking: ${block.reason}]*`;
    case "tool_use":
      return (
        `**Tool call: \`${block.name}\`** (id: \`${block.id}\`)\n\n` +
        "```json\n" +
        safeStringify(block.input) +
        "\n```"
      );
    case "tool_result": {
      const flag = block.is_error ? " ⚠️ error" : "";
      const body =
        typeof block.content === "string"
          ? block.content
          : formatContent(block.content);
      return `**Tool result${flag}** (id: \`${block.tool_use_id}\`)\n\n${body}`;
    }
    default: {
      // Exhaustiveness check for the discriminated union.
      const _exhaustive: never = block;
      void _exhaustive;
      return "";
    }
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}