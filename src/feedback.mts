// PR review-feedback plumbing (host side): read human feedback from a feature
// PR, decide what is actionable, and write the workflow's responses back.
//
// Two feedback channels are handled:
//
//   - Review THREADS (inline comments on the diff). Pending = unresolved, not
//     outdated, and the latest trusted comment is not ours. GitHub's own
//     thread-resolution state is the durable "handled" marker: the workflow
//     replies to and resolves a thread it addressed, and a human unresolving
//     the thread (or replying to it) makes it pending again.
//
//   - Review SUBMISSIONS (the top-level "request changes" / "comment" body).
//     These have no resolution state, so handled-ness is a timestamp cursor
//     persisted in a single workflow-maintained PR comment.
//
// Plain PR conversation comments are deliberately NOT a channel: they are too
// noisy to tell chatter from actionable requests.
//
// All durable state lives on the PR itself (thread resolution + the state
// comment) -- consistent with the package's no-local-state rule. The state
// comment is only trusted when authored by the workflow's own gh login, so a
// spoofed marker in someone else's comment cannot move the cursor. Feedback
// authored by untrusted users is dropped before any prompt is built, under the
// same association policy as issue comments (security.trustedCommentsOnly).

import { createHash } from "node:crypto";
import type { ResolvedConfig } from "./config.mjs";
import { gh } from "./exec.mjs";
import { TRUSTED_ASSOCIATIONS } from "./issues.mjs";

// One comment inside a review thread, already trust-filtered.
export interface ThreadComment {
  author: string;
  association: string;
  body: string;
}

// An unresolved inline review thread that needs a response.
export interface FeedbackThread {
  kind: "thread";
  key: string; // synthetic id (T1, T2, ...) the responder echoes back
  threadId: string; // GraphQL node id, used to resolve the thread
  replyToId: number; // REST id of the thread's root comment, used to reply
  path: string;
  line: number | null;
  diffHunk: string;
  comments: ThreadComment[];
  lastCommentId: number; // part of the pending-set signature
}

// A top-level review submission that needs a response.
export interface FeedbackReview {
  kind: "review";
  key: string; // synthetic id (R1, R2, ...)
  reviewId: number;
  author: string;
  state: string; // CHANGES_REQUESTED | COMMENTED
  submittedAt: string;
  body: string;
}

export type FeedbackItem = FeedbackThread | FeedbackReview;

// Durable per-PR feedback state, kept in a hidden marker inside a single
// workflow-authored PR comment (it survives PR-body rebuilds, which would wipe
// anything stored in the feature marker).
export interface FeedbackState {
  cursor: string; // reviews submitted at/before this are handled
  attempts: number; // failed responder rounds against the current sig
  sig: string; // fingerprint of the pending set the attempts count against
  notified: boolean; // "gave up" notice already posted for this sig
}

export interface PendingFeedback {
  items: FeedbackItem[];
  sig: string;
  attempts: number;
  notified: boolean;
  cursor: string; // current (unadvanced) cursor
  newestReviewAt: string | null; // advance the cursor here after a full round
  stateCommentId: number | null;
  changesRequestedBy: string[]; // re-request these reviewers after a fix round
}

export interface ResponderResponse {
  action: "addressed" | "declined";
  note: string;
}

const STATE_PREFIX = "<!-- sandcastle-feedback:";
const EPOCH = "1970-01-01T00:00:00Z";

// Keep the responder prompt bounded even with very chatty reviews.
const MAX_ITEMS = 30;
const MAX_BODY_CHARS = 4000;
const MAX_HUNK_CHARS = 3000;

const clip = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n)}\n[...truncated]` : s;

const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 100) {
            nodes {
              databaseId
              author { login }
              authorAssociation
              body
              diffHunk
            }
          }
        }
      }
    }
  }
}`;

const RESOLVE_MUTATION = `
mutation($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) { thread { id } }
}`;

interface RawThreadComment {
  databaseId: number;
  author: { login: string } | null;
  authorAssociation: string;
  body: string;
  diffHunk: string;
}

interface RawThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  comments: { nodes: RawThreadComment[] };
}

interface RawReview {
  id: number;
  user: { login: string } | null;
  author_association: string;
  body: string;
  state: string;
  submitted_at: string;
}

export type FeedbackOps = ReturnType<typeof createFeedbackOps>;

export function createFeedbackOps(cfg: ResolvedConfig) {
  // The gh login this workflow acts as. Used to skip our own comments/reviews
  // (so the workflow never reacts to itself) and to authenticate the state
  // comment.
  let cachedLogin: string | null = null;
  async function botLogin(): Promise<string> {
    if (cachedLogin) return cachedLogin;
    const res = await gh(["api", "user", "--jq", ".login"]);
    if (res.code !== 0) {
      throw new Error(`failed to resolve gh login: ${res.stderr.trim()}`);
    }
    cachedLogin = res.stdout.trim();
    return cachedLogin;
  }

  // GraphQL calls need explicit owner/name (REST paths get {owner}/{repo}
  // auto-filled by gh).
  let cachedRepo: { owner: string; name: string } | null = null;
  async function repoRef(): Promise<{ owner: string; name: string }> {
    if (cachedRepo) return cachedRepo;
    const res = await gh(["repo", "view", "--json", "owner,name"]);
    if (res.code !== 0) {
      throw new Error(`failed to resolve repo owner/name: ${res.stderr.trim()}`);
    }
    const parsed = JSON.parse(res.stdout) as {
      owner: { login: string };
      name: string;
    };
    cachedRepo = { owner: parsed.owner.login, name: parsed.name };
    return cachedRepo;
  }

  const isTrusted = (association: string): boolean =>
    !cfg.trustedCommentsOnly ||
    TRUSTED_ASSOCIATIONS.has(association.toUpperCase());

  // Unresolved, non-outdated threads that still await a response from us.
  async function fetchThreads(
    prNumber: number,
    me: string,
  ): Promise<Omit<FeedbackThread, "key">[]> {
    const { owner, name } = await repoRef();
    const res = await gh([
      "api",
      "graphql",
      "-f",
      `query=${THREADS_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `number=${prNumber}`,
      "--jq",
      ".data.repository.pullRequest.reviewThreads.nodes",
    ]);
    if (res.code !== 0) {
      throw new Error(
        `failed to fetch review threads for PR #${prNumber}: ${res.stderr.trim()}`,
      );
    }
    const nodes = JSON.parse(res.stdout) as RawThread[];

    const threads: Omit<FeedbackThread, "key">[] = [];
    for (const t of nodes) {
      if (t.isResolved || t.isOutdated) continue;
      const all = t.comments.nodes;
      if (all.length === 0) continue;

      // Untrusted comments never reach a prompt (same policy as issue
      // comments).
      const trusted = all.filter((c) => isTrusted(c.authorAssociation));
      const dropped = all.length - trusted.length;
      if (dropped > 0) {
        console.warn(
          `  · PR #${prNumber} thread on ${t.path}: dropped ${dropped} comment(s) from untrusted authors (security.trustedCommentsOnly).`,
        );
      }

      // Pending needs a trusted human comment, with ours not already the last
      // word -- a bot reply that went unanswered (e.g. a declined item) must
      // not re-trigger work; a human replying after it re-queues the thread.
      const humans = trusted.filter((c) => (c.author?.login ?? "") !== me);
      if (humans.length === 0) continue;
      const last = trusted[trusted.length - 1]!;
      if ((last.author?.login ?? "") === me) continue;

      threads.push({
        kind: "thread",
        threadId: t.id,
        replyToId: all[0]!.databaseId,
        path: t.path,
        line: t.line,
        diffHunk: clip(all[0]!.diffHunk ?? "", MAX_HUNK_CHARS),
        comments: trusted.map((c) => ({
          author: c.author?.login ?? "unknown",
          association: c.authorAssociation,
          body: clip(c.body, MAX_BODY_CHARS),
        })),
        lastCommentId: last.databaseId,
      });
    }
    return threads;
  }

  // Actionable review submissions newer than the cursor, plus the reviewers
  // whose latest review still requests changes (for re-requesting).
  async function fetchReviews(
    prNumber: number,
    me: string,
    cursor: string,
  ): Promise<{
    pending: Omit<FeedbackReview, "key">[];
    changesRequestedBy: string[];
  }> {
    const res = await gh([
      "api",
      `repos/{owner}/{repo}/pulls/${prNumber}/reviews?per_page=100`,
    ]);
    if (res.code !== 0) {
      throw new Error(
        `failed to fetch reviews for PR #${prNumber}: ${res.stderr.trim()}`,
      );
    }
    const raw = JSON.parse(res.stdout) as RawReview[];

    const relevant = raw
      .filter((r) => r.user !== null && r.user.login !== me && r.submitted_at)
      .filter((r) => isTrusted(r.author_association))
      .sort((a, b) => (a.submitted_at < b.submitted_at ? -1 : 1));

    // Latest non-pending review state per author. ISO-8601 Zulu timestamps
    // compare correctly as strings.
    const latestByAuthor = new Map<string, string>();
    for (const r of relevant) {
      if (r.state !== "PENDING") latestByAuthor.set(r.user!.login, r.state);
    }
    const changesRequestedBy = [...latestByAuthor]
      .filter(([, state]) => state === "CHANGES_REQUESTED")
      .map(([login]) => login);

    // Empty-bodied COMMENTED reviews are just containers for inline comments,
    // which the thread channel already carries.
    const pending = relevant
      .filter(
        (r) =>
          (r.state === "CHANGES_REQUESTED" || r.state === "COMMENTED") &&
          r.body.trim().length > 0 &&
          r.submitted_at > cursor,
      )
      .map((r) => ({
        kind: "review" as const,
        reviewId: r.id,
        author: r.user!.login,
        state: r.state,
        submittedAt: r.submitted_at,
        body: clip(r.body.trim(), MAX_BODY_CHARS),
      }));

    return { pending, changesRequestedBy };
  }

  // Locate our state comment (last marker comment authored by us) and decode
  // it. Markers in comments by anyone else are ignored -- they would otherwise
  // let a commenter forge the cursor.
  async function readState(
    prNumber: number,
    me: string,
  ): Promise<{ state: FeedbackState; commentId: number } | null> {
    const res = await gh([
      "api",
      `repos/{owner}/{repo}/issues/${prNumber}/comments?per_page=100`,
      "--jq",
      '[.[] | {id, login: (.user.login // "unknown"), body}]',
    ]);
    if (res.code !== 0) {
      throw new Error(
        `failed to list comments on PR #${prNumber}: ${res.stderr.trim()}`,
      );
    }
    const comments = JSON.parse(res.stdout) as {
      id: number;
      login: string;
      body: string;
    }[];

    for (let i = comments.length - 1; i >= 0; i--) {
      const c = comments[i]!;
      if (c.login !== me) continue;
      const m = c.body.match(/<!-- sandcastle-feedback:\s*(\{[\s\S]*?\})\s*-->/);
      if (!m) continue;
      try {
        const s = JSON.parse(m[1]!) as Partial<FeedbackState>;
        return {
          state: {
            cursor: s.cursor ?? EPOCH,
            attempts: s.attempts ?? 0,
            sig: s.sig ?? "",
            notified: s.notified ?? false,
          },
          commentId: c.id,
        };
      } catch {
        // Unreadable marker: keep scanning older comments.
      }
    }
    return null;
  }

  // Upsert the state comment. Falls back to creating a fresh comment if the
  // recorded one was deleted. Returns the comment id actually written.
  async function writeState(
    prNumber: number,
    commentId: number | null,
    state: FeedbackState,
    note: string,
  ): Promise<number> {
    const body = `${STATE_PREFIX} ${JSON.stringify(state)} -->\n**Sandcastle feedback log.** ${note}\n\n_Maintained by the workflow; edits will be overwritten._`;
    if (commentId !== null) {
      const res = await gh([
        "api",
        "-X",
        "PATCH",
        `repos/{owner}/{repo}/issues/comments/${commentId}`,
        "-f",
        `body=${body}`,
      ]);
      if (res.code === 0) return commentId;
      console.warn(
        `  ⚠ could not edit feedback state comment ${commentId}: ${res.stderr.trim()}; creating a new one.`,
      );
    }
    const res = await gh([
      "api",
      "-X",
      "POST",
      `repos/{owner}/{repo}/issues/${prNumber}/comments`,
      "-f",
      `body=${body}`,
      "--jq",
      ".id",
    ]);
    if (res.code !== 0) {
      throw new Error(
        `failed to write feedback state on PR #${prNumber}: ${res.stderr.trim()}`,
      );
    }
    return Number.parseInt(res.stdout.trim(), 10);
  }

  // Everything on the PR that still needs a response, or null if the PR is
  // clean. `attempts`/`notified` carry over only while the pending set is
  // unchanged; any new/changed feedback resets them.
  async function getPendingFeedback(
    prNumber: number,
  ): Promise<PendingFeedback | null> {
    const me = await botLogin();
    const saved = await readState(prNumber, me);
    const cursor = saved?.state.cursor ?? EPOCH;

    const threads = await fetchThreads(prNumber, me);
    const { pending: reviews, changesRequestedBy } = await fetchReviews(
      prNumber,
      me,
      cursor,
    );

    let all: (Omit<FeedbackThread, "key"> | Omit<FeedbackReview, "key">)[] = [
      ...threads,
      ...reviews,
    ];
    if (all.length === 0) return null;
    if (all.length > MAX_ITEMS) {
      console.warn(
        `  ⚠ PR #${prNumber}: ${all.length} feedback item(s) pending; handling the first ${MAX_ITEMS} this round.`,
      );
      all = all.slice(0, MAX_ITEMS);
    }

    let t = 0;
    let r = 0;
    const items: FeedbackItem[] = all.map((item) =>
      item.kind === "thread"
        ? { ...item, key: `T${++t}` }
        : { ...item, key: `R${++r}` },
    );

    // Thread signatures include the last comment id so a fresh human reply to
    // an already-declined thread reads as new feedback (attempts reset).
    const sig = createHash("sha256")
      .update(
        JSON.stringify(
          items
            .map((i) =>
              i.kind === "thread"
                ? `t:${i.threadId}:${i.lastCommentId}`
                : `r:${i.reviewId}`,
            )
            .sort(),
        ),
      )
      .digest("hex")
      .slice(0, 16);

    const sameSet = saved?.state.sig === sig;
    const reviewTimes = items
      .filter((i): i is FeedbackReview => i.kind === "review")
      .map((i) => i.submittedAt);

    return {
      items,
      sig,
      attempts: sameSet ? saved!.state.attempts : 0,
      notified: sameSet ? saved!.state.notified : false,
      cursor,
      newestReviewAt:
        reviewTimes.length > 0
          ? reviewTimes.reduce((a, b) => (a > b ? a : b))
          : null,
      stateCommentId: saved?.commentId ?? null,
      changesRequestedBy,
    };
  }

  // The feedback block the responder prompt receives. Values are passed as an
  // inert promptArg, so nothing in here is ever substituted or executed.
  function renderFeedback(items: FeedbackItem[]): string {
    return items
      .map((item) => {
        if (item.kind === "thread") {
          const where =
            item.line !== null
              ? `${item.path} line ${item.line}`
              : `${item.path} (file-level)`;
          const comments = item.comments
            .map(
              (c) =>
                `<comment author="${c.author}" association="${c.association}">\n${c.body}\n</comment>`,
            )
            .join("\n");
          return `<feedback id="${item.key}" type="thread" location="${where}">\n<diff-context>\n${item.diffHunk}\n</diff-context>\n${comments}\n</feedback>`;
        }
        return `<feedback id="${item.key}" type="review" author="${item.author}" state="${item.state}">\n${item.body}\n</feedback>`;
      })
      .join("\n\n");
  }

  // Decode the responder's <response id=... action=...> verdict lines. Items
  // the agent failed to answer are simply absent from the map.
  function parseResponses(stdout: string): Map<string, ResponderResponse> {
    const map = new Map<string, ResponderResponse>();
    for (const m of stdout.matchAll(
      /<response\s+id="([^"]+)"\s+action="(addressed|declined)"\s*>([\s\S]*?)<\/response>/g,
    )) {
      map.set(m[1]!, {
        action: m[2] as ResponderResponse["action"],
        note: m[3]!.trim().replace(/\s+/g, " ").slice(0, 400),
      });
    }
    return map;
  }

  async function replyToThread(
    prNumber: number,
    thread: FeedbackThread,
    body: string,
  ): Promise<void> {
    const res = await gh([
      "api",
      "-X",
      "POST",
      `repos/{owner}/{repo}/pulls/${prNumber}/comments/${thread.replyToId}/replies`,
      "-f",
      `body=${body}`,
    ]);
    if (res.code !== 0) {
      throw new Error(
        `failed to reply to thread on ${thread.path}: ${res.stderr.trim()}`,
      );
    }
  }

  async function resolveThread(threadId: string): Promise<void> {
    const res = await gh([
      "api",
      "graphql",
      "-f",
      `query=${RESOLVE_MUTATION}`,
      "-f",
      `id=${threadId}`,
    ]);
    if (res.code !== 0) {
      throw new Error(`failed to resolve review thread: ${res.stderr.trim()}`);
    }
  }

  async function postComment(prNumber: number, body: string): Promise<void> {
    const res = await gh([
      "api",
      "-X",
      "POST",
      `repos/{owner}/{repo}/issues/${prNumber}/comments`,
      "-f",
      `body=${body}`,
    ]);
    if (res.code !== 0) {
      throw new Error(
        `failed to comment on PR #${prNumber}: ${res.stderr.trim()}`,
      );
    }
  }

  // Best-effort: a login that cannot be re-requested (left the repo, is the
  // PR author, ...) must not fail the round.
  async function reRequestReviewers(
    prNumber: number,
    logins: string[],
  ): Promise<void> {
    for (const login of logins) {
      const res = await gh([
        "api",
        "-X",
        "POST",
        `repos/{owner}/{repo}/pulls/${prNumber}/requested_reviewers`,
        "-f",
        `reviewers[]=${login}`,
      ]);
      if (res.code !== 0) {
        console.warn(
          `  ⚠ could not re-request review from ${login}: ${res.stderr.trim()}`,
        );
      }
    }
  }

  return {
    getPendingFeedback,
    renderFeedback,
    parseResponses,
    replyToThread,
    resolveThread,
    postComment,
    reRequestReviewers,
    writeState,
  };
}
