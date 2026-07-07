// Per-repo configuration for the Sandcastle feature-PR workflow.
// Every field is optional; the defaults are shown in the comments.
// Full reference: the FeatureFlowConfig type in @copperbox/sandcastle-workflow.

import { defineConfig } from "@copperbox/sandcastle-workflow";

export default defineConfig({
  // Command the implement/review/merge/refresh agents run to verify their work.
  verifyCommand: "npm run typecheck && npm run test",

  // Branch that feature branches fork from and that feature PRs target.
  // targetBranch: "main",

  // Semver bump of the root package.json on every completed feature PR.
  // Set enabled: false for repos where that does not apply (non-npm repos).
  // release: { enabled: true },

  // Extra repo-specific guidance appended to the implementer prompt, e.g. how
  // to verify UI changes end-to-end inside the sandbox.
  // implementNotes: "",

  // Hardening for public repos. trustedCommentsOnly (default true) drops issue
  // comments AND PR review feedback from non-OWNER/MEMBER/COLLABORATOR authors
  // before any prompt is built. lockOnQueue (default false) locks each queued
  // issue's conversation to collaborators the first time the workflow picks it
  // up.
  // security: { lockOnQueue: true, trustedCommentsOnly: true },

  // Review-feedback handling: each cycle, unresolved review threads and new
  // reviews on open feature PRs are addressed on the branch by a responder
  // agent (replies, resolves what it fixed, re-requests review). maxAttempts
  // caps retries per unchanged feedback set; includeDrafts extends the
  // behavior to draft PRs.
  // feedback: { enabled: true, maxAttempts: 2, includeDrafts: false },

  // Pathspecs excluded from the diff the reviewer sees (generated artifacts).
  // review: { diffExcludes: ["generated-dir/**"] },

  // Labels driving the queue.
  // labels: { queue: "Sandcastle", inReview: "sandcastle:in-review" },

  // Branch naming.
  // branchPrefix: { feature: "sandcastle/feature-", issue: "sandcastle/issue-" },

  // Per-role model + reasoning-effort overrides (planner, implementer,
  // reviewer, responder, merger, refresh, rebump, release).
  // agents: { implementer: { model: "claude-fable-5", effort: "high" } },

  // Plan -> deliver cycles per invocation, and the implementer's per-issue cap.
  // maxIterations: 10,
  // implementerMaxIterations: 100,

  // Sandbox bootstrapping.
  // copyToWorktree: ["node_modules"],
  // hooks: { sandbox: { onSandboxReady: [{ command: "npm install" }] } },

  // Prompt overrides: drop same-named files (e.g. implement-prompt.md) into
  // this directory to replace the packaged defaults.
  // prompts: { dir: "./.sandcastle/prompts" },
});
