// Pre-flight issue queries for the planner, run on the HOST (before any
// sandbox spins up).
//
//   - checkTasks()              -> open, queue-labelled issues that are NOT
//                                  already in review (i.e. not yet parked behind
//                                  an open feature PR). This is the planner's
//                                  work queue.
//   - getInReviewIssueNumbers() -> open issues currently carrying the in-review
//                                  label, used to reconcile issues whose feature
//                                  PR was closed without merging.

import type { ResolvedConfig } from "./config.mjs";
import { gh } from "./exec.mjs";

// One issue comment, attributed so the workflow (and the agents reading
// ISSUES_JSON) can tell who said what. `association` is GitHub's
// authorAssociation: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, ...
export interface IssueComment {
  author: string;
  association: string;
  body: string;
}

// The shape emitted by the gh --jq projection below, one entry per issue.
export interface SandcastleIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  comments: IssueComment[];
}

// Author associations whose comments are kept when trustedCommentsOnly is on.
// Everyone else (CONTRIBUTOR, FIRST_TIMER, NONE, ...) can be an arbitrary
// member of the public on a public repo, so their comments are treated as
// untrusted input and never reach an agent prompt. Exported because the PR
// review-feedback channel (feedback.mts) enforces the same policy.
export const TRUSTED_ASSOCIATIONS = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

export function createIssueQueries(cfg: ResolvedConfig) {
  async function ghJson(args: string[]): Promise<string> {
    const res = await gh(args);
    if (res.code !== 0) {
      throw new Error(`gh ${args[0]} ${args[1]} failed: ${res.stderr.trim()}`);
    }
    return res.stdout;
  }

  // Fetch open issues from GitHub and keep only those that carry the queue
  // label AND are not already in review. Returns an empty array when there is
  // nothing queued to work on.
  async function checkTasks(): Promise<SandcastleIssue[]> {
    const stdout = await ghJson([
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      cfg.queueLabel,
      "--limit",
      "100",
      "--json",
      "number,title,body,labels,comments",
      "--jq",
      '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[] | {author: (.author.login // "unknown"), association: .authorAssociation, body}]}]',
    ]);

    const issues = JSON.parse(stdout) as SandcastleIssue[];

    const queued = issues.filter((issue) => {
      const labels = issue.labels.map((l) => l.toLowerCase());
      const isQueued = labels.includes(cfg.queueLabel.toLowerCase());
      const inReview = labels.includes(cfg.inReviewLabel.toLowerCase());
      return isQueued && !inReview;
    });

    if (!cfg.trustedCommentsOnly) return queued;

    // Drop untrusted comments BEFORE anything downstream sees the issue, so no
    // prompt (planner or implementer) is ever built from them.
    return queued.map((issue) => {
      const comments = issue.comments.filter((c) =>
        TRUSTED_ASSOCIATIONS.has(c.association.toUpperCase()),
      );
      const dropped = issue.comments.length - comments.length;
      if (dropped > 0) {
        console.warn(
          `  · issue #${issue.number}: dropped ${dropped} comment(s) from untrusted authors (security.trustedCommentsOnly).`,
        );
      }
      return { ...issue, comments };
    });
  }

  // The open issue numbers currently labelled in-review. Used to detect issues
  // whose feature PR was closed unmerged (they must be requeued).
  async function getInReviewIssueNumbers(): Promise<number[]> {
    const stdout = await ghJson([
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      cfg.inReviewLabel,
      "--limit",
      "100",
      "--json",
      "number",
      "--jq",
      "[.[].number]",
    ]);

    return JSON.parse(stdout) as number[];
  }

  return { checkTasks, getInReviewIssueNumbers };
}
