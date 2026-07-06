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

// The shape emitted by the gh --jq projection below, one entry per issue.
export interface SandcastleIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  comments: string[];
}

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
      "[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]",
    ]);

    const issues = JSON.parse(stdout) as SandcastleIssue[];

    return issues.filter((issue) => {
      const labels = issue.labels.map((l) => l.toLowerCase());
      const isQueued = labels.includes(cfg.queueLabel.toLowerCase());
      const inReview = labels.includes(cfg.inReviewLabel.toLowerCase());
      return isQueued && !inReview;
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
