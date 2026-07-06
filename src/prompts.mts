// Prompt resolution: a consuming repo can override any packaged prompt by
// dropping a file with the same name into its prompt-override directory
// (config.prompts.dir, default ./.sandcastle/prompts). Otherwise the packaged
// default under <package>/prompts/ is used.
//
// Paths returned here are ABSOLUTE. Sandcastle resolves a relative promptFile
// against process.cwd(), which would never find files inside this package.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedConfig } from "./config.mjs";

const packagedPromptsDir = fileURLToPath(new URL("../prompts/", import.meta.url));

export type PromptName =
  | "plan-prompt.md"
  | "implement-prompt.md"
  | "review-prompt.md"
  | "merge-prompt.md"
  | "release-prompt.md"
  | "rebump-prompt.md"
  | "refresh-prompt.md";

export function promptPath(cfg: ResolvedConfig, name: PromptName): string {
  if (cfg.promptsDir) {
    const override = path.resolve(cfg.promptsDir, name);
    if (existsSync(override)) return override;
  }
  return path.join(packagedPromptsDir, name);
}
