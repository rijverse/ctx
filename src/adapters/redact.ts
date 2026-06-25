import type { PortableMessage } from "../schema/portable.js";

/**
 * Replace tool_result bodies with "[redacted]" while keeping text and
 * tool names intact. Useful before sharing an export.
 */
export function redactMessage(msg: PortableMessage): PortableMessage {
  if (typeof msg.content === "string") return msg;
  const blocks = msg.content.map((b) =>
    b.type === "tool_result" ? { ...b, content: "[redacted]" } : b
  );
  return { ...msg, content: blocks };
}