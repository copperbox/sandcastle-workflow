// Parallel Feature Planner with Review + PR delivery -- multi-phase loop.
//
// Drives an autonomous workflow that groups issues into features, implements
// them on isolated branches, integrates each feature onto its own feature
// branch, and delivers finished work as a GitHub pull request for a human to
// review and merge -- it never merges to the target branch itself.
//
//   Phase 0 (Check):   On the HOST, reconcile in-review issues whose PR was
//                      closed unmerged, address human review feedback on open
//                      feature PRs (a responder agent fixes the branch, replies
//                      to and resolves review threads, and re-requests review),
//                      then fetch the open queued issues that are not already
//                      parked behind a feature PR.
//   Phase 1 (Plan):    A planner agent groups the open issues into features
//                      (cohesive units that ship as one PR), respecting the
//                      membership of features that already have an open PR, and
//                      marks which issues are workable now vs. blocked.
//   Phase 2 (Deliver): Each feature runs as an INDEPENDENT, concurrent pipeline:
//                      implement + review each workable issue on its own branch
//                      (cut off the feature branch), integrate the completed
//                      issue branches onto the feature branch, push, and open or
//                      update a DRAFT PR. Each completed issue is labelled
//                      in-review so it leaves the queue. When every member issue
//                      of a feature is done, the draft PR is fleshed out with a
//                      generated description and flipped to ready-for-review.
//
// Crucially there is NO global merge barrier: one feature waiting on human
// review never blocks another feature's issues from being worked or shipped.
//
// The outer loop repeats up to maxIterations times so newly unblocked issues
// (including ones unblocked by an earlier merge onto their feature branch) are
// picked up on later rounds.

import * as sandcastle from "@ai-hero/sandcastle";
import { z } from "zod";
import {
  resolveConfig,
  type FeatureFlowConfig,
  type ResolvedConfig,
  type Role,
} from "./config.mjs";
import { errMsg } from "./exec.mjs";
import { createFeedbackOps } from "./feedback.mjs";
import { createIssueQueries, type SandcastleIssue } from "./issues.mjs";
import {
  createRepoOps,
  type FeatureMember,
  type FeaturePR,
} from "./repo-ops.mjs";
import { promptPath } from "./prompts.mjs";

// The planner emits its plan as JSON inside <plan> tags; Output.object extracts
// and validates it against this schema. Each feature carries its full member
// list (workNow flags which issues are unblocked this round) so the workflow
// knows both what to do now and when the feature is complete.
const planSchema = z.object({
  features: z.array(
    z.object({
      slug: z.string(),
      branch: z.string(),
      title: z.string(),
      issues: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          branch: z.string(),
          workNow: z.boolean(),
        }),
      ),
    }),
  ),
});

type PlanFeature = z.infer<typeof planSchema>["features"][number];
type PlanIssue = PlanFeature["issues"][number];

export interface FeatureFlowResult {
  // "idle": nothing queued, or everything remaining is blocked/in-review.
  // "max-iterations": ran the full cycle count (there may be more to do).
  status: "idle" | "max-iterations";
  iterations: number;
}

export async function runFeatureFlow(
  userConfig: FeatureFlowConfig = {},
): Promise<FeatureFlowResult> {
  const cfg: ResolvedConfig = resolveConfig(userConfig);
  const ops = createRepoOps(cfg);
  const fb = createFeedbackOps(cfg);
  const { checkTasks, getInReviewIssueNumbers, getInProgressIssueNumbers } =
    createIssueQueries(cfg);

  // The agent provider (model + effort) for a given role.
  function agentFor(role: Role): sandcastle.AgentProvider {
    const { model, effort } = cfg.agents[role];
    return sandcastle.claudeCode(model, { effort });
  }

  const { hooks, copyToWorktree } = cfg;

  // Rendered ':(exclude)...' pathspecs for the reviewer's diff command.
  const diffExcludes = cfg.reviewDiffExcludes
    .map((p) => `':(exclude)${p}'`)
    .join(" ");

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  // Count the commits an issue branch carries that its feature branch does not
  // yet have. Runs inside the issue's sandbox, where `exec` defaults its cwd to
  // the worktree repo. Used only to gate the reviewer (don't review a no-op run).
  async function branchCommitsAhead(
    sandbox: sandcastle.Sandbox,
    base: string,
    branch: string,
  ): Promise<{ sha: string }[]> {
    const res = await sandbox.exec(`git rev-list ${base}..${branch}`);
    if (res.exitCode !== 0) {
      throw new Error(
        `git rev-list ${base}..${branch} failed (exit ${res.exitCode}): ${res.stderr.trim()}`,
      );
    }
    return res.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((sha) => ({ sha }));
  }

  // Run `fn` against a short-lived sandbox checked out on the given branch.
  async function withFeatureSandbox<T>(
    branch: string,
    fn: (sandbox: sandcastle.Sandbox) => Promise<T>,
  ): Promise<T> {
    await ops.removeLeakedWorktree(branch);
    const sandbox = await sandcastle.createSandbox({
      branch,
      sandbox: cfg.sandbox(),
      hooks,
      copyToWorktree,
    });
    try {
      return await fn(sandbox);
    } finally {
      await sandbox.close();
    }
  }

  // The issue body/comments the implementer receives, rendered from the
  // already-filtered queue data. The content is passed INLINE via promptArgs
  // (never re-fetched by the agent), so the trustedCommentsOnly filter is
  // enforced by the module rather than left to agent behavior. Sandcastle
  // treats promptArg values as inert -- {{...}} and !`...` inside them are
  // never substituted or executed.
  function renderIssueBody(source: SandcastleIssue | undefined): string {
    const body = source?.body.trim();
    return body || "(no description provided -- rely on the title and repo exploration)";
  }

  function renderIssueComments(source: SandcastleIssue | undefined): string {
    if (!source || source.comments.length === 0) return "(no comments)";
    return source.comments
      .map(
        (c) =>
          `<comment author="${c.author}" association="${c.association}">\n${c.body}\n</comment>`,
      )
      .join("\n\n");
  }

  // Implement and (if it produced commits) review a single issue on its own
  // branch, cut off the feature branch. Best-effort: git state is the source of
  // truth for what actually landed, so we don't return a status here.
  async function implementAndReview(
    feature: PlanFeature,
    issue: PlanIssue,
    source: SandcastleIssue | undefined,
  ): Promise<void> {
    const branch = ops.issueBranch(issue.id);
    await ops.removeLeakedWorktree(branch);
    const sandbox = await sandcastle.createSandbox({
      branch,
      baseBranch: feature.branch,
      sandbox: cfg.sandbox(),
      hooks,
      copyToWorktree,
    });
    try {
      const implement = await sandbox.run({
        name: `implementer:${issue.id}`,
        maxIterations: cfg.implementerMaxIterations,
        agent: agentFor("implementer"),
        promptFile: promptPath(cfg, "implement-prompt.md"),
        promptArgs: {
          TASK_ID: issue.id,
          ISSUE_TITLE: issue.title,
          ISSUE_BODY: renderIssueBody(source),
          ISSUE_COMMENTS: renderIssueComments(source),
          BRANCH: branch,
          VERIFY_COMMAND: cfg.verifyCommand,
          IMPLEMENT_NOTES: cfg.implementNotes,
        },
      });

      if (implement.completionSignal === undefined) {
        console.warn(
          `  ⚠ ${issue.id} implementer stopped without a completion signal (iteration cap or context limit).`,
        );
      }

      const ahead = await branchCommitsAhead(sandbox, feature.branch, branch);
      if (ahead.length === 0) return;

      // A reviewer failure must never discard committed work: log and move on.
      try {
        await sandbox.run({
          name: `reviewer:${issue.id}`,
          maxIterations: 1,
          agent: agentFor("reviewer"),
          promptFile: promptPath(cfg, "review-prompt.md"),
          promptArgs: {
            BRANCH: branch,
            VERIFY_COMMAND: cfg.verifyCommand,
            DIFF_EXCLUDES: diffExcludes,
          },
        });
      } catch (err) {
        console.error(
          `  ⚠ reviewer failed on ${branch}: ${errMsg(err)}. Keeping committed work.`,
        );
      }
    } finally {
      await sandbox.close();
    }
  }

  // Prepare the release for a completed feature: idempotently bump the root
  // package.json version on the feature branch (skipped when a release commit
  // already exists OR when releases are disabled -- ALREADY_BUMPED=true makes
  // the release prompt skip straight to writing the description) and generate
  // the PR description. Returns the chosen bump level and description; both may
  // be null on agent failure.
  async function prepareRelease(
    feature: PlanFeature,
    members: FeatureMember[],
    alreadyBumped: boolean,
  ): Promise<{ level: string | null; description: string | null }> {
    try {
      return await withFeatureSandbox(feature.branch, async (sandbox) => {
        const res = await sandbox.run({
          name: `release:${feature.slug}`,
          maxIterations: 1,
          agent: agentFor("release"),
          promptFile: promptPath(cfg, "release-prompt.md"),
          completionSignal: "</pr-description>",
          // {{TARGET_BRANCH}} is a Sandcastle built-in (the host's active
          // branch); it is injected automatically and must not be passed here.
          promptArgs: {
            ALREADY_BUMPED: String(alreadyBumped),
            ISSUES: members.map((m) => `- #${m.id} ${m.title}`).join("\n"),
          },
        });
        const bump = res.stdout.match(/<bump>\s*(patch|minor|major)\s*<\/bump>/i);
        const desc = res.stdout.match(/<pr-description>([\s\S]*?)<\/pr-description>/);
        return {
          level: bump ? bump[1]!.toLowerCase() : null,
          description: desc ? desc[1]!.trim() : null,
        };
      });
    } catch (err) {
      console.error(
        `  ⚠ release agent failed for ${feature.slug}: ${errMsg(err)}. No bump/description this round.`,
      );
      return { level: null, description: null };
    }
  }

  // Create or update the feature's draft PR to reflect current progress. When
  // every member issue is done, apply the version bump + description and flip
  // the PR ready. Returns whether the PR is now ready-for-review -- if the bump
  // does not land, readiness is deferred (PR stays a draft) so the feature
  // retries.
  async function finalizeFeaturePR(
    feature: PlanFeature,
    members: FeatureMember[],
    doneIds: Set<string>,
  ): Promise<{ ready: boolean }> {
    const memberIds = members.map((m) => String(m.id));
    const pr = await ops.findFeaturePR(feature.branch);
    const branchHasWork =
      (await ops.commitsAhead(cfg.targetBranch, feature.branch)) > 0;

    // Nothing on the branch and no PR yet: nothing to publish this round.
    if (!pr && !branchHasWork) return { ready: false };

    // Create or update the PR body, returning its number.
    const publish = async (
      description: string | null,
      release: { version: string; level: string | null } | null,
    ): Promise<number> => {
      const body = ops.buildFeatureBody({
        slug: feature.slug,
        branch: feature.branch,
        members,
        doneIds,
        description,
        release,
      });
      if (pr) {
        await ops.setPRBody(pr.prNumber, body);
        return pr.prNumber;
      }
      await ops.pushBranch(feature.branch); // creating a PR needs the branch on origin
      return ops.createDraftPR({
        branch: feature.branch,
        title: feature.title,
        body,
      });
    };

    const allDone =
      memberIds.length > 0 && memberIds.every((id) => doneIds.has(id));

    if (!allDone) {
      const prNumber = await publish(null, null);
      console.log(`  · feature ${feature.slug}: draft PR #${prNumber} updated.`);
      return { ready: false };
    }

    // All members done -> bump the version (once, when releases are enabled)
    // and write the description. With releases disabled, ALREADY_BUMPED=true
    // turns the release agent into a description-only run and the bump gating
    // below is bypassed.
    const alreadyBumped =
      !cfg.releaseEnabled || (await ops.hasReleaseCommit(feature.branch));
    const prep = await prepareRelease(feature, members, alreadyBumped);
    const bumped =
      !cfg.releaseEnabled ||
      alreadyBumped ||
      (await ops.hasReleaseCommit(feature.branch));

    if (!bumped) {
      // The bump did not land (agent failure). Keep the PR a draft and defer
      // readiness; the feature is retried next round.
      const prNumber = await publish(prep.description, null);
      console.warn(
        `  ⚠ feature ${feature.slug}: version bump did not land; PR #${prNumber} left as draft for retry.`,
      );
      return { ready: false };
    }

    await ops.pushBranch(feature.branch); // push the release commit
    const release = cfg.releaseEnabled
      ? {
          version: await ops.readVersion(feature.branch),
          level: prep.level ?? (await ops.readReleaseLevel(feature.branch)),
        }
      : null;
    const prNumber = await publish(prep.description, release);
    await ops.markReady(prNumber);
    console.log(
      `  ✔ feature ${feature.slug}: PR #${prNumber} ready for review${
        release
          ? ` (v${release.version}${release.level ? `, ${release.level}` : ""})`
          : ""
      }.`,
    );
    return { ready: true };
  }

  // Run one feature's full pipeline. Independent of every other feature.
  // The in-progress label is purely informational (it never gates a workflow
  // decision -- the queue and done sets come from the queue/in-review labels
  // and git state), so a GitHub hiccup here must never stop the run.
  async function markInProgress(issues: PlanIssue[]): Promise<void> {
    await Promise.all(
      issues.map(async (issue) => {
        try {
          await ops.addInProgress(issue.id);
        } catch (err) {
          console.warn(
            `  ⚠ could not label issue #${issue.id} in-progress: ${errMsg(err)}`,
          );
        }
      }),
    );
  }

  async function clearInProgress(issues: PlanIssue[]): Promise<void> {
    await Promise.all(
      issues.map(async (issue) => {
        try {
          await ops.removeInProgress(issue.id);
        } catch (err) {
          console.warn(
            `  ⚠ could not remove in-progress label from issue #${issue.id}: ${errMsg(err)}`,
          );
        }
      }),
    );
  }

  async function runFeature(
    feature: PlanFeature,
    existing: FeaturePR | undefined,
    issueByNumber: Map<string, SandcastleIssue>,
  ): Promise<void> {
    // Full, fixed membership: from the existing PR's marker if there is one,
    // else from the plan (a brand-new feature lists all its members, incl.
    // blocked).
    const members: FeatureMember[] = existing
      ? existing.members
      : feature.issues.map((i) => ({ id: String(i.id), title: i.title }));
    const memberIds = members.map((m) => String(m.id));

    await ops.ensureFeatureBranch(feature.branch);

    // Skip issues already done -- closed, in-review, OR already integrated into
    // the feature branch (git state is the truth) -- so we never re-do work.
    const doneAtStart = await ops.effectiveDoneIds(memberIds, feature.branch);
    const workable = feature.issues.filter(
      (i) => i.workNow && !doneAtStart.has(String(i.id)),
    );

    // Mark the issues this round is about to work so watchers can tell them
    // apart from merely queued ones; always lift the mark when the round ends
    // (in-review, integrated, or failed-and-requeued alike).
    await markInProgress(workable);
    try {
      if (workable.length > 0) {
        const settled = await Promise.allSettled(
          workable.map((issue) =>
            implementAndReview(feature, issue, issueByNumber.get(String(issue.id))),
          ),
        );
        for (const [i, outcome] of settled.entries()) {
          if (outcome.status === "rejected") {
            console.error(
              `  ✗ ${workable[i]!.id} (${ops.issueBranch(workable[i]!.id)}) failed: ${outcome.reason}`,
            );
          }
        }
      }

      // Integrate: which workable issue branches carry real work not yet on the
      // feature branch? (git state, not "did this run commit", is the truth.)
      const toMerge: PlanIssue[] = [];
      for (const issue of workable) {
        const branch = ops.issueBranch(issue.id);
        if ((await ops.commitsAhead(cfg.targetBranch, branch)) === 0) continue; // missing or no work
        if ((await ops.commitsAhead(feature.branch, branch)) > 0) toMerge.push(issue);
      }

      if (toMerge.length > 0) {
        await withFeatureSandbox(feature.branch, async (sandbox) => {
          await sandbox.run({
            name: `merger:${feature.slug}`,
            maxIterations: 1,
            agent: agentFor("merger"),
            promptFile: promptPath(cfg, "merge-prompt.md"),
            promptArgs: {
              FEATURE_BRANCH: feature.branch,
              BRANCHES: toMerge.map((i) => `- ${ops.issueBranch(i.id)}`).join("\n"),
              VERIFY_COMMAND: cfg.verifyCommand,
            },
          });
        });
        await ops.pushBranch(feature.branch);
      }

      // Recompute the done set from git + labels, then finalize (bump + ready
      // when every member is done).
      const doneIds = await ops.effectiveDoneIds(memberIds, feature.branch);
      const allDone =
        memberIds.length > 0 && memberIds.every((id) => doneIds.has(id));
      const { ready } = await finalizeFeaturePR(feature, members, doneIds);

      // Persist the in-review labels LAST. If the feature is fully done but NOT
      // confirmed ready (e.g. the version bump failed), withhold ALL labels so
      // the feature stays in the work queue and is retried next round. Otherwise
      // label every integrated member that isn't already labelled/closed so its
      // issue leaves the queue. Keeping this after finalize means a crash before
      // "ready" leaves at least one member unlabelled, which requeues the feature
      // -- so recovery needs no extra pass.
      //
      // The skip guard here is label/closed state ONLY (getFeatureDoneIds), NOT
      // the integration-aware doneAtStart: an issue integrated in an earlier
      // round but never labelled (because the release agent kept failing) must
      // still get labelled once the feature finally goes ready.
      if (allDone && !ready) {
        console.warn(
          `  ⚠ feature ${feature.slug}: not ready; leaving issues queued for retry.`,
        );
        return;
      }
      const labelledOrClosed = await ops.getFeatureDoneIds(memberIds);
      for (const id of memberIds) {
        if (labelledOrClosed.has(id)) continue; // already in-review or closed
        if (await ops.isIssueIntegrated(id, feature.branch)) {
          await ops.addInReview(id);
        }
      }
    } finally {
      await clearInProgress(workable);
    }
  }

  // Address human review feedback on an open feature PR: run the responder
  // agent on the feature branch against the pending items (unresolved trusted
  // review threads + new review submissions), push whatever it commits, then
  // write the outcome back to GitHub -- a reply per thread (resolved when
  // addressed), a summary comment for top-level reviews, an updated state
  // comment, and a re-request to reviewers who asked for changes.
  //
  // Idempotence lives on the PR itself: resolved threads and the state
  // comment's cursor drop handled items from the next round's pending set, and
  // an attempts counter (reset whenever the pending set changes) stops a
  // persistently failing round from retrying forever.
  async function respondToFeedback(fp: FeaturePR): Promise<void> {
    const pending = await fb.getPendingFeedback(fp.prNumber);
    if (!pending) return;

    if (pending.attempts >= cfg.feedbackMaxAttempts) {
      if (!pending.notified) {
        console.warn(
          `  ⚠ feature ${fp.slug}: feedback on PR #${fp.prNumber} still unhandled after ${pending.attempts} attempt(s); giving up until it changes.`,
        );
        await fb.postComment(
          fp.prNumber,
          `⚠️ Sandcastle could not fully address the current review feedback after ${pending.attempts} attempt(s). It will retry when the feedback changes (a new reply, a re-opened thread, or a new review).`,
        );
        await fb.writeState(
          fp.prNumber,
          pending.stateCommentId,
          {
            cursor: pending.cursor,
            attempts: pending.attempts,
            sig: pending.sig,
            notified: true,
          },
          `Gave up after ${pending.attempts} attempt(s); waiting for the feedback to change.`,
        );
      }
      return;
    }

    console.log(
      `  · feature ${fp.slug}: ${pending.items.length} review feedback item(s) pending on PR #${fp.prNumber}.`,
    );

    const headBefore = await ops.branchHead(fp.branch);

    let stdout: string;
    try {
      stdout = await withFeatureSandbox(fp.branch, async (sandbox) => {
        const res = await sandbox.run({
          name: `responder:${fp.slug}`,
          // Feedback fixes are implementer-class work, so the responder
          // shares the implementer's iteration cap.
          maxIterations: cfg.implementerMaxIterations,
          agent: agentFor("responder"),
          promptFile: promptPath(cfg, "respond-prompt.md"),
          completionSignal: "</responses>",
          promptArgs: {
            FEEDBACK: fb.renderFeedback(pending.items),
            VERIFY_COMMAND: cfg.verifyCommand,
            IMPLEMENT_NOTES: cfg.implementNotes,
          },
        });
        return res.stdout;
      });
    } catch (err) {
      console.error(
        `  ⚠ responder failed on ${fp.branch}: ${errMsg(err)}. Keeping committed work.`,
      );
      // Push whatever landed (a reviewer failure must never discard committed
      // work), then record the failed attempt so a broken round cannot retry
      // forever.
      const headAfterFail = await ops.branchHead(fp.branch);
      if (headAfterFail && headAfterFail !== headBefore) {
        await ops.pushBranch(fp.branch);
      }
      await fb.writeState(
        fp.prNumber,
        pending.stateCommentId,
        {
          cursor: pending.cursor,
          attempts: pending.attempts + 1,
          sig: pending.sig,
          notified: false,
        },
        `Responder run failed (attempt ${pending.attempts + 1} of ${cfg.feedbackMaxAttempts}).`,
      );
      return;
    }

    const responses = fb.parseResponses(stdout);

    const headAfter = await ops.branchHead(fp.branch);
    const pushed = headAfter !== null && headAfter !== headBefore;
    if (pushed) await ops.pushBranch(fp.branch);
    const shortSha = pushed ? headAfter.slice(0, 7) : null;

    // Write each verdict back. Thread replies/resolutions are per-item and
    // best-effort (an unreplied thread simply stays pending); review verdicts
    // are batched into one summary comment.
    const reviewSummaries: string[] = [];
    let addressed = 0;
    let unhandled = 0;
    for (const item of pending.items) {
      const verdict = responses.get(item.key);
      if (!verdict) {
        unhandled++;
        continue;
      }
      if (verdict.action === "addressed") addressed++;
      if (item.kind === "thread") {
        const reply =
          verdict.action === "addressed"
            ? `Addressed${shortSha ? ` in ${shortSha}` : ""}: ${verdict.note}`
            : `Sandcastle declined this item: ${verdict.note}\n\nReply here to push back -- a new reply re-queues it.`;
        try {
          await fb.replyToThread(fp.prNumber, item, reply);
          if (verdict.action === "addressed") {
            await fb.resolveThread(item.threadId);
          }
        } catch (err) {
          console.warn(
            `  ⚠ could not write back to thread ${item.key} on PR #${fp.prNumber}: ${errMsg(err)}`,
          );
        }
      } else {
        reviewSummaries.push(
          `- **${item.key}** (review by @${item.author}): ${verdict.action} -- ${verdict.note}`,
        );
      }
    }

    if (reviewSummaries.length > 0) {
      try {
        await fb.postComment(
          fp.prNumber,
          `Sandcastle responded to review feedback${shortSha ? ` (${shortSha})` : ""}:\n\n${reviewSummaries.join("\n")}`,
        );
      } catch (err) {
        console.warn(
          `  ⚠ could not post feedback summary on PR #${fp.prNumber}: ${errMsg(err)}`,
        );
      }
    }

    // Advance the review cursor only when every pending review got a verdict;
    // otherwise leave it so the missed ones stay pending. Unanswered items
    // count as a failed attempt (against the OLD sig -- if the set shrinks
    // next round, the sig changes and attempts reset).
    const reviewsAllHandled = pending.items
      .filter((i) => i.kind === "review")
      .every((i) => responses.has(i.key));
    await fb.writeState(
      fp.prNumber,
      pending.stateCommentId,
      {
        cursor:
          reviewsAllHandled && pending.newestReviewAt
            ? pending.newestReviewAt
            : pending.cursor,
        attempts: unhandled > 0 ? pending.attempts + 1 : 0,
        sig: pending.sig,
        notified: false,
      },
      `Last round: ${addressed} addressed, ${responses.size - addressed} declined, ${unhandled} unanswered${shortSha ? ` (pushed ${shortSha})` : ""}.`,
    );

    if (pushed && addressed > 0 && pending.changesRequestedBy.length > 0) {
      await fb.reRequestReviewers(fp.prNumber, pending.changesRequestedBy);
    }

    console.log(
      `  ✔ feature ${fp.slug}: feedback round on PR #${fp.prNumber} done (${addressed} addressed, ${responses.size - addressed} declined, ${unhandled} unanswered).`,
    );
  }

  // Refresh a ready feature PR whose version collided with the target branch:
  // merge the latest target branch into its branch and re-apply the bump (one
  // level above the new base), so the PR lands a fresh version. The PR stays
  // ready; only its branch + body move.
  async function rebumpFeature(fp: FeaturePR): Promise<void> {
    const level = (await ops.readReleaseLevel(fp.branch)) ?? "patch";
    const members = fp.members;

    let prep: { level: string | null; description: string | null } | null;
    try {
      prep = await withFeatureSandbox(fp.branch, async (sandbox) => {
        const res = await sandbox.run({
          name: `rebump:${fp.slug}`,
          maxIterations: 1,
          agent: agentFor("rebump"),
          promptFile: promptPath(cfg, "rebump-prompt.md"),
          completionSignal: "</pr-description>",
          // {{TARGET_BRANCH}} is a Sandcastle built-in; do not pass it here.
          promptArgs: {
            LEVEL: level,
            ISSUES: members.map((m) => `- #${m.id} ${m.title}`).join("\n"),
            VERIFY_COMMAND: cfg.verifyCommand,
          },
        });
        const bump = res.stdout.match(/<bump>\s*(patch|minor|major)\s*<\/bump>/i);
        const desc = res.stdout.match(/<pr-description>([\s\S]*?)<\/pr-description>/);
        return {
          level: bump ? bump[1]!.toLowerCase() : null,
          description: desc ? desc[1]!.trim() : null,
        };
      });
    } catch (err) {
      console.error(
        `  ⚠ re-bump agent failed for ${fp.slug}: ${errMsg(err)}. Will retry next cycle.`,
      );
      return;
    }

    // Only publish if the collision is actually resolved (branch now ahead of
    // the target branch). Otherwise leave the PR untouched and retry next
    // cycle.
    if (await ops.needsRebump(fp.branch)) {
      console.warn(
        `  ⚠ feature ${fp.slug}: re-bump did not resolve the version collision; will retry next cycle.`,
      );
      return;
    }

    await ops.pushBranch(fp.branch);
    const release = {
      version: await ops.readVersion(fp.branch),
      level: prep.level ?? level,
    };
    const body = ops.buildFeatureBody({
      slug: fp.slug,
      branch: fp.branch,
      members,
      // A ready feature's members are all done.
      doneIds: new Set(members.map((m) => String(m.id))),
      description: prep.description,
      release,
    });
    await ops.setPRBody(fp.prNumber, body);
    console.log(
      `  ↻ feature ${fp.slug}: PR #${fp.prNumber} re-bumped to v${release.version}.`,
    );
  }

  // Refresh a ready feature PR that has fallen behind the target branch (it
  // advanced without taking this PR's version, so no re-bump is needed -- just
  // the merge). Merges the latest target branch into the branch to keep the PR
  // conflict-free and tested against current target; no version change, PR
  // stays ready.
  async function refreshFeature(fp: FeaturePR): Promise<void> {
    try {
      await withFeatureSandbox(fp.branch, async (sandbox) => {
        await sandbox.run({
          name: `refresh:${fp.slug}`,
          maxIterations: 1,
          agent: agentFor("refresh"),
          promptFile: promptPath(cfg, "refresh-prompt.md"),
          // {{TARGET_BRANCH}} is a Sandcastle built-in.
          promptArgs: {
            VERIFY_COMMAND: cfg.verifyCommand,
          },
        });
      });
    } catch (err) {
      console.error(
        `  ⚠ refresh agent failed for ${fp.slug}: ${errMsg(err)}. Will retry next cycle.`,
      );
      return;
    }

    // Only publish if the branch actually caught up to the target branch.
    if ((await ops.commitsAhead(fp.branch, cfg.targetBranch)) > 0) {
      console.warn(
        `  ⚠ feature ${fp.slug}: still behind ${cfg.targetBranch} after refresh; will retry next cycle.`,
      );
      return;
    }

    await ops.pushBranch(fp.branch);
    console.log(
      `  ⟲ feature ${fp.slug}: PR #${fp.prNumber} refreshed with ${cfg.targetBranch}.`,
    );
  }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------

  for (let iteration = 1; iteration <= cfg.maxIterations; iteration++) {
    console.log(`\n=== Iteration ${iteration}/${cfg.maxIterations} ===\n`);

    // -------------------------------------------------------------------------
    // Phase 0: Sync + reconcile + re-bump (host only)
    // -------------------------------------------------------------------------

    // Track the real merged state: fast-forward the local target branch to
    // origin so every downstream computation (new feature bases, versions,
    // collisions) is current.
    await ops.syncMainFromOrigin();
    await ops.ensureInReviewLabel();
    await ops.ensureInProgressLabel();

    // Nothing is being worked at this point in an iteration, so any issue
    // still labelled in-progress is a leftover from a crashed run. Best-effort
    // for the same reason mark/clearInProgress are: the label is informational.
    try {
      for (const id of await getInProgressIssueNumbers()) {
        console.log(`Issue #${id} carries a stale in-progress label; clearing.`);
        await ops.removeInProgress(id);
      }
    } catch (err) {
      console.warn(`  ⚠ could not clear stale in-progress labels: ${errMsg(err)}`);
    }

    let featurePRs = await ops.getOpenFeaturePRs();

    // Requeue any in-review issue whose feature PR is no longer open (i.e. it
    // was closed without merging): drop the label so it re-enters the work
    // queue.
    const inReview = await getInReviewIssueNumbers();
    if (inReview.length > 0) {
      const covered = new Set(
        featurePRs.flatMap((f) => f.members.map((m) => Number(m.id))),
      );
      for (const id of inReview) {
        if (!covered.has(id)) {
          console.log(
            `Issue #${id} was in-review but has no open feature PR; requeuing.`,
          );
          await ops.removeInReview(id);
        }
      }
    }

    // Maintain each open feature PR (independent per feature, so one never
    // blocks another). In order, per PR:
    //   1. Address human review feedback (responder agent) -- BEFORE any
    //      target-branch churn, so the reviewer's requested changes land
    //      first. Runs on ready PRs (and drafts when feedback.includeDrafts).
    //      This step precedes the idle exit below on purpose: once everything
    //      is parked in review, feedback is usually the only work left.
    //   2. Keep the branch current with the target: version collision (a
    //      sibling merged and took the version) -> re-bump (which also merges
    //      the target in); otherwise merely behind -> refresh (merge the
    //      target in, no version change). Drafts are left alone: they refresh
    //      naturally as their issues integrate.
    const maintained = await Promise.allSettled(
      featurePRs.map(async (fp) => {
        if (
          cfg.feedbackEnabled &&
          (!fp.isDraft || cfg.feedbackIncludeDrafts)
        ) {
          try {
            await respondToFeedback(fp);
          } catch (err) {
            console.error(
              `  ⚠ feedback handling failed for ${fp.slug}: ${errMsg(err)}. Will retry next cycle.`,
            );
          }
        }
        if (await ops.needsRebump(fp.branch)) {
          await rebumpFeature(fp);
        } else if (
          !fp.isDraft &&
          (await ops.commitsAhead(fp.branch, cfg.targetBranch)) > 0
        ) {
          await refreshFeature(fp);
        }
      }),
    );
    for (const [i, outcome] of maintained.entries()) {
      if (outcome.status === "rejected") {
        console.error(
          `  ✗ maintenance for ${featurePRs[i]!.slug} failed: ${outcome.reason}`,
        );
      }
    }

    const openIssues = await checkTasks();
    if (openIssues.length === 0) {
      console.log(`No open ${cfg.queueLabel}-labelled issues to work on. Exiting.`);
      return { status: "idle", iterations: iteration };
    }
    console.log(
      `Found ${openIssues.length} ${cfg.queueLabel}-labelled open issue(s).`,
    );

    // Lock queued issues so only collaborators can comment from here on
    // (comments already posted by untrusted users are handled by the
    // trustedCommentsOnly filter in checkTasks). Best-effort: a lock failure
    // must not stop the run.
    if (cfg.lockOnQueue) {
      let locked = 0;
      await Promise.all(
        openIssues.map(async (issue) => {
          try {
            await ops.lockIssue(issue.number);
            locked++;
          } catch (err) {
            console.warn(`  ⚠ could not lock issue #${issue.number}: ${errMsg(err)}`);
          }
        }),
      );
      console.log(`Locked ${locked} queued issue(s) (security.lockOnQueue).`);
    }

    // Refresh after any re-bump edits so the planner sees current PR bodies.
    featurePRs = await ops.getOpenFeaturePRs();

    // -------------------------------------------------------------------------
    // Phase 1: Plan (on the target branch -- it only reads and reasons)
    // -------------------------------------------------------------------------
    const plan = await sandcastle.run({
      hooks,
      sandbox: cfg.sandbox(),
      name: "planner",
      maxIterations: 1,
      agent: agentFor("planner"),
      promptFile: promptPath(cfg, "plan-prompt.md"),
      promptArgs: {
        ISSUES_JSON: JSON.stringify(openIssues, null, 2),
        // Existing feature PRs (fixed membership) the planner must preserve.
        FEATURE_PRS_JSON: JSON.stringify(
          featurePRs.map((f) => ({
            slug: f.slug,
            branch: f.branch,
            issueIds: f.members.map((m) => m.id),
          })),
          null,
          2,
        ),
        FEATURE_BRANCH_PREFIX: cfg.featureBranchPrefix,
        ISSUE_BRANCH_PREFIX: cfg.issueBranchPrefix,
      },
      output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
    });

    // Re-validate: Output.object already extracted the payload, but parsing
    // through the schema here also gives us precise types regardless of how
    // sandcastle types `output`.
    const features = planSchema.parse(plan.output).features;
    const totalWorkable = features.reduce(
      (n, f) => n + f.issues.filter((i) => i.workNow).length,
      0,
    );

    if (totalWorkable === 0) {
      console.log(
        "No workable issues this round (everything remaining is blocked or in review). Exiting.",
      );
      return { status: "idle", iterations: iteration };
    }

    console.log(
      `Planning complete. ${features.length} feature(s), ${totalWorkable} workable issue(s):`,
    );
    for (const f of features) {
      const now =
        f.issues.filter((i) => i.workNow).map((i) => i.id).join(", ") ||
        "(none this round)";
      console.log(`  ${f.slug} [${f.branch}] -> workable: ${now}`);
    }

    // -------------------------------------------------------------------------
    // Phase 2: Deliver -- one independent, concurrent pipeline per feature.
    // -------------------------------------------------------------------------
    const byBranch = new Map(featurePRs.map((f) => [f.branch, f]));
    const issueByNumber = new Map(
      openIssues.map((i) => [String(i.number), i]),
    );
    const settled = await Promise.allSettled(
      features.map((f) => runFeature(f, byBranch.get(f.branch), issueByNumber)),
    );
    for (const [i, outcome] of settled.entries()) {
      if (outcome.status === "rejected") {
        console.error(`  ✗ feature ${features[i]!.slug} failed: ${outcome.reason}`);
      }
    }

    console.log(`\nIteration ${iteration} complete.`);
  }

  console.log("\nReached maxIterations. Stopping.");
  return { status: "max-iterations", iterations: cfg.maxIterations };
}
