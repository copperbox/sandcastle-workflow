#!/usr/bin/env node
// Scaffolder: `npx @copperbox/sandcastle-workflow init` writes the thin
// per-repo layer into the current repo. The orchestration logic itself stays in
// this package (so fixes propagate via `npm update`); only the files a repo is
// expected to customize are copied.
//
// This replaces `sandcastle init` (which refuses to run once .sandcastle/
// exists and only offers its own built-in templates). The upstream CLI is still
// used for image builds: `npx sandcastle docker build-image`.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const templateDir = fileURLToPath(new URL("../template/", import.meta.url));

// npm strips .gitignore (and dotfiles are easy to lose in packing), so
// templates ship under safe names and are renamed into place on copy.
const RENAMES: Record<string, string> = {
  gitignore: ".gitignore",
  "env.example": ".env.example",
};

// Files that land outside .sandcastle/.
const LOOP_SCRIPT = "sandcastle-loop.sh";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const command = process.argv[2];
if (command !== "init") {
  console.log(
    [
      "Usage: npx @copperbox/sandcastle-workflow init",
      "",
      "Scaffolds the Sandcastle feature-PR workflow into the current repo:",
      "  .sandcastle/{config.mts, main.mts, Dockerfile, CODING_STANDARDS.md,",
      "               WORKFLOW.md, tsconfig.json, .env.example, .gitignore}",
      "  scripts/sandcastle-loop.sh",
      "  package.json scripts: sandcastle, sandcastle:loop",
    ].join("\n"),
  );
  process.exit(command === undefined || command === "help" || command === "--help" ? 0 : 1);
}

const root = process.cwd();
const pkgPath = path.join(root, "package.json");
if (!existsSync(pkgPath)) {
  fail("no package.json here -- run this from your repo's root directory.");
}
const dest = path.join(root, ".sandcastle");
if (existsSync(dest)) {
  fail(".sandcastle/ already exists -- refusing to overwrite it.");
}

// 1. Copy the .sandcastle/ template files.
mkdirSync(dest, { recursive: true });
for (const entry of readdirSync(templateDir)) {
  if (entry === LOOP_SCRIPT) continue;
  copyFileSync(path.join(templateDir, entry), path.join(dest, RENAMES[entry] ?? entry));
  console.log(`  + .sandcastle/${RENAMES[entry] ?? entry}`);
}

// 2. Install the supervisor loop script.
const scriptsDir = path.join(root, "scripts");
mkdirSync(scriptsDir, { recursive: true });
const loopDest = path.join(scriptsDir, LOOP_SCRIPT);
if (existsSync(loopDest)) {
  console.warn(`  ⚠ scripts/${LOOP_SCRIPT} already exists; left untouched.`);
} else {
  copyFileSync(path.join(templateDir, LOOP_SCRIPT), loopDest);
  chmodSync(loopDest, 0o755);
  console.log(`  + scripts/${LOOP_SCRIPT}`);
}

// 3. Patch package.json scripts (never overwriting an existing entry).
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
  scripts?: Record<string, string>;
};
pkg.scripts ??= {};
const wanted: Record<string, string> = {
  sandcastle: "npx tsx .sandcastle/main.mts",
  "sandcastle:loop": "bash scripts/sandcastle-loop.sh",
};
let patched = false;
for (const [name, cmd] of Object.entries(wanted)) {
  const existing = pkg.scripts[name];
  if (existing === undefined) {
    pkg.scripts[name] = cmd;
    patched = true;
    console.log(`  + package.json script "${name}"`);
  } else if (existing !== cmd) {
    console.warn(`  ⚠ package.json script "${name}" already exists; left untouched.`);
  }
}
if (patched) {
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

console.log(`
Done. Next steps:

  1. npm install -D @copperbox/sandcastle-workflow tsx
  2. cp .sandcastle/.env.example .sandcastle/.env   # then fill in the tokens
  3. Edit .sandcastle/config.mts       -- at minimum verifyCommand
     Edit .sandcastle/Dockerfile       -- add your project's tooling (marked section)
     Edit .sandcastle/CODING_STANDARDS.md
  4. npx sandcastle docker build-image
  5. Label some GitHub issues "Sandcastle", then: npm run sandcastle:loop

To override a packaged prompt, copy it into .sandcastle/prompts/ (same
filename) and edit; see WORKFLOW.md for the full picture.`);
