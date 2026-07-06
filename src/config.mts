// The per-repo configuration surface. Everything a consuming repo can vary
// lives here; `resolveConfig` fills in the defaults so the rest of the package
// only ever sees a fully-populated ResolvedConfig.

import type * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

type CreateSandboxOptions = Parameters<typeof sandcastle.createSandbox>[0];
export type SandboxProvider = CreateSandboxOptions["sandbox"];
export type SandboxHooks = CreateSandboxOptions["hooks"];

// Exit code used when there is no work to do (no queued issues, or every open
// issue is blocked/in-review). Distinct from 0 (worked through the backlog
// cleanly) and 1 (a crash/thrown error) so a supervising loop -- e.g. the
// scaffolded scripts/sandcastle-loop.sh -- can tell "idle, stop polling" apart
// from both a normal completion and a real failure. This is a fixed contract
// with the loop script; it is deliberately not configurable.
export const IDLE_EXIT_CODE = 3;

export type Role =
  | "planner"
  | "implementer"
  | "reviewer"
  | "merger"
  | "refresh"
  | "rebump"
  | "release";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentSpec {
  model: string;
  effort: Effort;
}

export interface FeatureFlowConfig {
  // Branch that feature branches fork from and that feature PRs target.
  // Default: "main".
  targetBranch?: string;

  // Command the implement/review/merge/rebump/refresh agents run to verify
  // their work (injected into the prompts as {{VERIFY_COMMAND}}).
  // Default: "npm run typecheck && npm run test".
  verifyCommand?: string;

  labels?: {
    // Label marking an issue as fair game for the workflow. Default: "Sandcastle".
    queue?: string;
    // Label applied once an issue's work is parked behind a feature PR.
    // Default: "sandcastle:in-review".
    inReview?: string;
  };

  branchPrefix?: {
    // Prefix for feature integration branches. Default: "sandcastle/feature-".
    feature?: string;
    // Prefix for per-issue branches. Default: "sandcastle/issue-".
    issue?: string;
  };

  // Per-role model + reasoning effort overrides (merged over the defaults).
  agents?: Partial<Record<Role, AgentSpec>>;

  // Maximum plan -> deliver cycles per invocation. Default: 10.
  maxIterations?: number;

  // Iteration cap for the implementer agent on a single issue. Default: 100.
  implementerMaxIterations?: number;

  // Paths copied from the host into each worktree before its sandbox starts.
  // Default: ["node_modules"].
  copyToWorktree?: string[];

  // Sandbox hooks, passed through to sandcastle. Default installs fresh
  // dependencies: { sandbox: { onSandboxReady: [{ command: "npm install" }] } }.
  hooks?: SandboxHooks;

  // Factory for the sandbox provider (called once per sandbox). Default: docker().
  sandbox?: () => SandboxProvider;

  release?: {
    // When true (default), every completed feature gets a semver bump of the
    // root package.json (npm repos only) and version-collision handling.
    // Set false for repos where that does not apply; feature PRs then flip
    // ready without a release commit.
    enabled?: boolean;
  };

  prompts?: {
    // Directory checked for per-repo prompt overrides (same filenames as the
    // packaged defaults). Default: "./.sandcastle/prompts". Set null to
    // disable overrides entirely.
    dir?: string | null;
  };

  review?: {
    // Pathspecs excluded from the diff the reviewer sees (e.g. generated
    // artifacts). Rendered as ':(exclude)...' specs. Default: [].
    diffExcludes?: string[];
  };

  // Extra repo-specific guidance appended to the implementer prompt via
  // {{IMPLEMENT_NOTES}} (e.g. how to verify UI changes). Default: "".
  implementNotes?: string;

  security?: {
    // Lock each queued issue's conversation the first time the workflow picks
    // it up, so only collaborators can comment afterwards. Closes the
    // comment-injection channel on public repos. Default: false (mutates
    // GitHub state, so it is opt-in).
    lockOnQueue?: boolean;
    // Only feed comments authored by OWNER/MEMBER/COLLABORATOR users to the
    // agents; comments from anyone else are dropped before prompts are built.
    // Default: true (harmless on private repos -- everyone who can comment is
    // trusted there -- and safe-by-default on public ones).
    trustedCommentsOnly?: boolean;
  };
}

export interface ResolvedConfig {
  targetBranch: string;
  verifyCommand: string;
  queueLabel: string;
  inReviewLabel: string;
  featureBranchPrefix: string;
  issueBranchPrefix: string;
  agents: Record<Role, AgentSpec>;
  maxIterations: number;
  implementerMaxIterations: number;
  copyToWorktree: string[];
  hooks: SandboxHooks;
  sandbox: () => SandboxProvider;
  releaseEnabled: boolean;
  promptsDir: string | null;
  reviewDiffExcludes: string[];
  implementNotes: string;
  lockOnQueue: boolean;
  trustedCommentsOnly: boolean;
}

// Fable 5 writes and reviews the code; Opus 4.8 handles the reasoning-heavy
// planning and the conflict-resolving merges; Sonnet 5 (cheaper) handles the
// packaging steps. Effort is capped at "high" (never xhigh/max) for cost, and
// dropped to medium/low on the simpler steps.
const DEFAULT_AGENTS: Record<Role, AgentSpec> = {
  planner: { model: "claude-opus-4-8", effort: "high" },
  implementer: { model: "claude-fable-5", effort: "high" },
  reviewer: { model: "claude-fable-5", effort: "medium" },
  merger: { model: "claude-opus-4-8", effort: "medium" },
  refresh: { model: "claude-opus-4-8", effort: "medium" },
  rebump: { model: "claude-sonnet-5", effort: "medium" },
  release: { model: "claude-sonnet-5", effort: "low" },
};

export function resolveConfig(user: FeatureFlowConfig = {}): ResolvedConfig {
  return {
    targetBranch: user.targetBranch ?? "main",
    verifyCommand: user.verifyCommand ?? "npm run typecheck && npm run test",
    queueLabel: user.labels?.queue ?? "Sandcastle",
    inReviewLabel: user.labels?.inReview ?? "sandcastle:in-review",
    featureBranchPrefix: user.branchPrefix?.feature ?? "sandcastle/feature-",
    issueBranchPrefix: user.branchPrefix?.issue ?? "sandcastle/issue-",
    agents: { ...DEFAULT_AGENTS, ...user.agents },
    maxIterations: user.maxIterations ?? 10,
    implementerMaxIterations: user.implementerMaxIterations ?? 100,
    copyToWorktree: user.copyToWorktree ?? ["node_modules"],
    hooks:
      user.hooks ??
      ({ sandbox: { onSandboxReady: [{ command: "npm install" }] } } as SandboxHooks),
    sandbox: user.sandbox ?? (() => docker()),
    releaseEnabled: user.release?.enabled ?? true,
    promptsDir:
      user.prompts?.dir === undefined ? "./.sandcastle/prompts" : user.prompts.dir,
    reviewDiffExcludes: user.review?.diffExcludes ?? [],
    implementNotes: user.implementNotes ?? "",
    lockOnQueue: user.security?.lockOnQueue ?? false,
    trustedCommentsOnly: user.security?.trustedCommentsOnly ?? true,
  };
}

// Identity helper so a repo's .sandcastle/config.mts gets full type checking
// and completion without importing the type explicitly.
export function defineConfig(config: FeatureFlowConfig): FeatureFlowConfig {
  return config;
}
