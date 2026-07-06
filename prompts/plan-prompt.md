# ISSUES

Here are the open issues ready to be worked (already filtered to queued
issues that are NOT yet in review):

<issues-json>

{{ISSUES_JSON}}

</issues-json>

Here are the feature branches that already have an open PR. Each records the
**fixed** set of member issues that feature ships. Treat these as immutable:

<feature-prs-json>

{{FEATURE_PRS_JSON}}

</feature-prs-json>

# TASK

Organize the open issues into **features** and decide what can be worked right
now. A feature is a cohesive unit of change that should ship together as one
pull request (e.g. issues that touch the same subsystem, build toward the same
capability, or would otherwise churn each other's files).

## Rules

1. **Respect existing features.** If an open issue is listed as a member of a
   feature in `feature-prs-json`, it MUST stay in that feature, using that
   feature's exact `slug` and `branch`. Never move an issue between features and
   never change an existing feature's membership.

2. **Group the rest.** Assign every remaining open issue to a feature. Reuse an
   existing feature only per rule 1; otherwise create a new feature. Prefer a
   small number of cohesive features over many single-issue features, but do not
   force unrelated issues together.

3. **Feature identity is deterministic.** For a NEW feature, choose a short
   kebab-case `slug` derived from the feature's theme (e.g. `auth-hardening`).
   The `branch` MUST be exactly `{{FEATURE_BRANCH_PREFIX}}{slug}`. Re-planning
   the same set of issues must produce the same slug.

4. **Membership is the full set.** For a NEW feature, `issues` must list ALL of
   its member issues, including ones that are currently blocked (they define
   when the feature is complete). For an EXISTING feature, list the members that
   still need work this round.

5. **Decide what is workable now.** Build a dependency graph. An issue is
   **workable now** (`workNow: true`) only if it has zero unmet blocking
   dependencies on other open issues. Issue B is blocked by issue A if B needs
   code/infra A introduces, B and A modify overlapping files, or B depends on an
   API/decision A establishes. Mark blocked issues `workNow: false`.

   **When in doubt, sequence.** Issues marked `workNow: true` within the same
   feature are implemented concurrently on branches cut from the same starting
   point -- they do NOT see each other's changes until integration. If two such
   issues touch the same files or one subtly depends on the other, integration
   hits a merge conflict or a broken build. So if you are unsure whether two
   issues overlap or depend on each other, mark one `workNow: false` so they run
   in separate rounds (the second is then built on top of the first's merged
   work). The cost of an unnecessary sequencing is one extra round; the cost of a
   missed dependency is a conflict or failed integration. Only co-schedule
   issues in the same round when you are confident they are independent.

6. **Branch names.** Each issue's `branch` MUST be exactly
   `{{ISSUE_BRANCH_PREFIX}}{id}` (no slug or suffix), so re-work is
   deterministic and accumulated progress is preserved.

# OUTPUT

Output your plan as a JSON object wrapped in `<plan>` tags:

<plan>
{"features": [{"slug": "auth-hardening", "branch": "{{FEATURE_BRANCH_PREFIX}}auth-hardening", "title": "Auth hardening", "issues": [{"id": "42", "title": "Fix auth bug", "branch": "{{ISSUE_BRANCH_PREFIX}}42", "workNow": true}, {"id": "43", "title": "Add rate limit", "branch": "{{ISSUE_BRANCH_PREFIX}}43", "workNow": false}]}]}
</plan>

Always emit the `<plan>` tags. If there is nothing to organize, output
`<plan>{"features": []}</plan>` so the run can exit cleanly. It is fine for a
feature to have no `workNow: true` issues this round (its workable issues are
blocked); such a feature simply makes no progress until a later round.
