# @copperbox/sandcastle-workflow

A reusable, autonomous **issues → reviewed feature PRs** workflow built on
[`@ai-hero/sandcastle`](https://github.com/mattpocock/sandcastle). Label GitHub
issues, run the loop, and get version-bumped, review-ready pull requests
assembled by sandboxed coding agents — it never merges to your target branch
itself.

- Issues are grouped into **features** by a planner agent; each feature ships as
  one PR on its own integration branch.
- Each issue is implemented + code-reviewed in its own Docker-sandboxed
  worktree, then merged onto the feature branch by a merge agent that resolves
  conflicts and re-runs your verify command.
- Feature PRs open as drafts with a live progress checklist, then flip to
  **ready for review** with a generated description and a semver bump once every
  member issue lands.
- Ready PRs are kept current with your target branch automatically (merge
  refreshes, version-collision re-bumps).
- **All durable state lives in git + GitHub** — no local state files; a killed
  process recovers by re-deriving everything on the next run.

The orchestration logic lives in this package so fixes propagate to every repo
via `npm update`. Each repo owns only a thin layer: a config file, a sandbox
Dockerfile, coding standards, and optional prompt overrides.

## Install

```bash
cd your-repo               # must have a package.json and a GitHub remote
npx @copperbox/sandcastle-workflow init
npm install -D @copperbox/sandcastle-workflow tsx
```

`init` scaffolds:

```
.sandcastle/
├── config.mts            # all per-repo configuration
├── main.mts              # entry point (3 lines)
├── Dockerfile            # sandbox image — add your project tooling
├── CODING_STANDARDS.md   # loaded by the reviewer agent
├── WORKFLOW.md           # how the whole loop works
├── tsconfig.json
├── .env.example          # tokens (copy to .env and fill in)
└── .gitignore
scripts/sandcastle-loop.sh
```

plus `package.json` scripts `sandcastle` and `sandcastle:loop`.

## Setup

1. `cp .sandcastle/.env.example .sandcastle/.env` and fill in
   `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) and `GH_TOKEN`.
2. Edit `.sandcastle/config.mts` — at minimum `verifyCommand`.
3. Add your project's runtime tooling to the marked section of
   `.sandcastle/Dockerfile`, then build the image:
   ```bash
   npx sandcastle docker build-image
   ```
4. Make sure `gh` is authenticated on the host with push access to `origin`.

## Run

```bash
# Label some issues "Sandcastle" on GitHub, then:
npm run sandcastle        # one batch of plan → implement → review → PR cycles
npm run sandcastle:loop   # keep watching for newly labelled issues
```

Review and merge the PRs it opens; `Closes #…` lines auto-close the issues.
Close a PR unmerged and its issues automatically re-enter the queue.

## Configuration

Everything is optional; defaults in parentheses. See `FeatureFlowConfig` for
the full typed reference.

| Field | Purpose |
|---|---|
| `verifyCommand` | What agents run to verify work (`npm run typecheck && npm run test`) |
| `targetBranch` | Base branch for features and PRs (`main`) |
| `labels.queue` / `labels.inReview` | Queue label (`Sandcastle`) / parked label (`sandcastle:in-review`) |
| `branchPrefix.feature` / `.issue` | Branch naming (`sandcastle/feature-`, `sandcastle/issue-`) |
| `agents.<role>` | Per-role `{ model, effort }` for planner, implementer, reviewer, merger, refresh, rebump, release |
| `maxIterations` | Plan → deliver cycles per invocation (`10`) |
| `implementerMaxIterations` | Implementer iteration cap per issue (`100`) |
| `copyToWorktree` / `hooks` | Sandbox bootstrapping (`["node_modules"]` / `npm install`) |
| `sandbox` | Sandbox provider factory (`docker()`) |
| `release.enabled` | Semver-bump the root package.json per feature PR (`true`; set `false` for non-npm repos) |
| `review.diffExcludes` | Pathspecs hidden from the reviewer's diff (generated artifacts) |
| `implementNotes` | Extra repo-specific guidance injected into the implementer prompt |
| `prompts.dir` | Prompt-override directory (`./.sandcastle/prompts`) |
| `security.trustedCommentsOnly` | Drop issue comments from non-OWNER/MEMBER/COLLABORATOR authors before building prompts (`true`) |
| `security.lockOnQueue` | Lock each queued issue's conversation to collaborators when first picked up (`false`) |

### Public repos & untrusted input

On a public repo anyone can open issues, but only users with triage permission
can apply labels — so the queue label is already your gate (never auto-apply it
via an issue template). Comments are the remaining channel: anyone can comment
on a labelled issue, and comments flow into agent prompts. Two defenses are
built in:

- **`security.trustedCommentsOnly`** (default **on**): comments from authors
  who aren't `OWNER`/`MEMBER`/`COLLABORATOR` are dropped in `checkTasks`,
  before any prompt is built. The implementer receives the issue body and the
  surviving comments **inline** (it is instructed not to re-fetch the issue),
  so the filter is enforced by the module, not by agent behavior.
- **`security.lockOnQueue`** (default off, recommended for public repos): each
  queued issue's conversation is locked (collaborators-only) the first time
  the workflow picks it up, closing the channel entirely going forward.

Your manual review of the PRs the workflow opens remains the final gate.

### Prompt overrides

The seven role prompts (`plan-prompt.md`, `implement-prompt.md`,
`review-prompt.md`, `merge-prompt.md`, `release-prompt.md`, `rebump-prompt.md`,
`refresh-prompt.md`) ship with this package. To customize one, copy it from
`node_modules/@copperbox/sandcastle-workflow/prompts/` into
`.sandcastle/prompts/` and edit — same filename wins.

## How it works

See [template/WORKFLOW.md](template/WORKFLOW.md) (scaffolded into every repo as
`.sandcastle/WORKFLOW.md`): branch topology, the three-phase cycle, version
bump + collision handling, ordering guarantees, and crash recovery.

## Requirements

- Node ≥ 20, Docker, `git`, and an authenticated `gh` CLI with push access
- A GitHub repository (issues + PRs are the workflow's state store)

## Development

```bash
npm install
npm run build        # tsc → dist/
```

Published files: `dist/` (library + init bin), `prompts/` (default role
prompts), `template/` (files written by init).
