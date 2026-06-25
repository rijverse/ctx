import { z } from "zod";
import { SCHEMA_VERSION } from "./version.js";

/**
 * The portable session schema, aligned with Anthropic's content-block model
 * for best round-trip fidelity. The Claude/puku JSONL almost literally maps
 * onto this shape; Gemini/Codex/Aider adapters normalize into it.
 */

const TextBlock = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const ThinkingBlock = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
});

const RedactedThinkingBlock = z.object({
  type: z.literal("redacted_thinking"),
  reason: z.string(),
});

const ToolUseBlock = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown().optional(),
});

// Forward-declared recursive content: tool_result.content may itself be a
// list of content blocks. We type the inner array as z.any() to break
// Zod 3's circular type inference. The outer ContentBlockSchema (also
// recursive) validates the shape at runtime.
const ToolResultBlock = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.any())]),
  is_error: z.boolean(),
});

export const ContentBlockSchema: z.ZodType<ContentBlock> = z.lazy(() =>
  z.discriminatedUnion("type", [
    TextBlock,
    ThinkingBlock,
    RedactedThinkingBlock,
    ToolUseBlock,
    ToolResultBlock,
  ])
);
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "redacted_thinking"; reason: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input?: unknown;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | ContentBlock[];
      is_error: boolean;
    };

export const ToolNameSchema = z.enum([
  "claude",
  "puku",
  "gemini",
  "codex",
  "aider",
]);
export type ToolName = z.infer<typeof ToolNameSchema>;

/** Tools that can consume a `--write-native` synthetic JSONL import. */
export const NATIVE_CAPABLE = new Set<ToolName>(["claude", "puku"]);

export const PortableMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.union([z.string(), z.array(ContentBlockSchema)]),
  timestamp: z.string().datetime().optional(),
  model: z.string().optional(),
  // Usage is intentionally loose. Providers (Claude, Anthropic, etc.)
  // include non-numeric fields like `speed` and `service_tier`.
  usage: z.record(z.string(), z.unknown()).optional(),
  uuid: z.string().optional(),
});
export type PortableMessage = z.infer<typeof PortableMessageSchema>;

export const SourceMetaSchema = z.object({
  tool: ToolNameSchema,
  version: z.string().optional(),
  exported_at: z.string().datetime(),
});
export type SourceMeta = z.infer<typeof SourceMetaSchema>;

export const SessionMetaSchema = z.object({
  id: z.string(),
  started_at: z.string().datetime().optional(),
  cwd: z.string(),
  git_branch: z.string().optional(),
  model: z.string().optional(),
});
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

export const PortableSessionSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  source: SourceMetaSchema,
  session: SessionMetaSchema,
  system: z.union([z.string(), z.array(ContentBlockSchema)]).optional(),
  messages: z.array(PortableMessageSchema),
  tools: z.array(z.unknown()).optional(),
  decisions: z.array(z.string()).optional(),
});
export type PortableSession = z.infer<typeof PortableSessionSchema>;

// Re-export the Zod schema under the legacy name for downstream imports.
export const PortableSession = PortableSessionSchema;

/**
 * Convenience builder that fills in `exported_at` and `schema_version`.
 */
export function makePortableSession(
  partial: Omit<PortableSession, "schema_version" | "source"> & {
    source: Omit<SourceMeta, "exported_at"> & { exported_at?: string };
  }
): PortableSession {
  const sourceData: SourceMeta = {
    exported_at: partial.source.exported_at ?? new Date().toISOString(),
    tool: partial.source.tool,
    version: partial.source.version,
  };
  const { source: _source, ...rest } = partial;
  void _source;
  return PortableSessionSchema.parse({
    schema_version: SCHEMA_VERSION,
    ...rest,
    source: sourceData,
  }) as PortableSession;
}