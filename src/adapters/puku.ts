import { ClaudeFamilyAdapter } from "./claude-family.js";
import { pukuRoot } from "../io/paths.js";

export class PukuAdapter extends ClaudeFamilyAdapter {
  readonly tool = "puku" as const;
  protected root(): string {
    return pukuRoot();
  }
}