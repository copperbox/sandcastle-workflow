# TASK

This feature branch already has an open pull request targeting
`{{TARGET_BRANCH}}`, but another PR merged first and took its version number. You
must rebase the branch onto the latest `{{TARGET_BRANCH}}` and re-apply the
version bump so the PR lands a fresh, non-colliding version.

This feature bundles the following issues:

{{ISSUES}}

# STEP 1 -- MERGE THE LATEST TARGET BRANCH

Merge the current target branch into this branch (do NOT rebase -- keep history
additive so the push fast-forwards):

```
git merge {{TARGET_BRANCH}} --no-edit
```

- Resolve any code conflicts intelligently by reading both sides.
- For `package.json` / `package-lock.json` **version** fields specifically,
  take `{{TARGET_BRANCH}}`'s value (you will bump it in Step 2 anyway).
- After resolving, run `{{VERIFY_COMMAND}}`. Fix any failures.
- Commit the merge if it left anything staged.

# STEP 2 -- RE-APPLY THE VERSION BUMP

The version bump for this feature is a **{{LEVEL}}** bump. The merge above set the
root `package.json` version to the target branch's current version, so bumping
now lands exactly one {{LEVEL}} above it. From the repo root:

```
npm version {{LEVEL}} --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore(release): v<newversion> ({{LEVEL}}, rebased on {{TARGET_BRANCH}})"
```

Modify only the version files in this step.

# STEP 3 -- REFRESH THE DESCRIPTION

Write an updated, reviewer-focused PR description in GitHub-flavored markdown
(what & why, notable changes, review notes + test status). No title heading, no
`Closes #...` lines.

# OUTPUT

Emit the level, then the description, and nothing after the closing tag:

<bump>{{LEVEL}}</bump>
<pr-description>
...your markdown here...
</pr-description>
