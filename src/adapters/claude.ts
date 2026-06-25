import { ClaudeFamilyAdapter } from "./claude-family.js";
import { claudeRoot } from "../io/paths.js";

export class ClaudeAdapter extends ClaudeFamilyAdapter {
  readonly tool = "claude" as const;
  protected root(): string {
    return claudeRoot();
  }
}