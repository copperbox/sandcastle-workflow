# TASK

You are on a completed feature branch that is about to become a pull request
targeting `{{TARGET_BRANCH}}`. You will (1) apply a semantic-version bump and
(2) write the PR description.

This feature bundles the following issues:

{{ISSUES}}

Inspect exactly what changed:

<commits>

!`git log {{TARGET_BRANCH}}..HEAD --format="%H%n%ad%n%B---" --date=short`

</commits>

<diffstat>

!`git diff {{TARGET_BRANCH}}...HEAD --stat`

</diffstat>

# STEP 1 -- DETERMINE THE SEMVER LEVEL

Judge the level from the actual diff, taking the **highest** level that applies
across the whole feature (major > minor > patch):

- **major** -- a breaking change: existing public API, CLI, config, on-disk/wire
  format, or documented behavior is removed or changed incompatibly.
- **minor** -- new functionality added in a backward-compatible way (a new
  feature, endpoint, flag, capability) with no breaking change.
- **patch** -- bug fixes or internal changes only, with no change to
  functionality or public surface.

# STEP 2 -- APPLY THE BUMP

`ALREADY_BUMPED` is **{{ALREADY_BUMPED}}**.

- If it is `true`, no bump is needed (a release commit already exists on this
  branch, or releases are disabled for this repo). **Do NOT bump and do NOT
  commit.** Skip to Step 3.
- If it is `false`, bump the **root** `package.json` from the repo root, without
  tagging:

  ```
  npm version <level> --no-git-tag-version
  ```

  where `<level>` is your Step 1 decision. Then stage and commit ONLY the
  resulting version changes (`package.json` and `package-lock.json`) with this
  exact subject format (substitute the new version and level):

  ```
  git add package.json package-lock.json
  git commit -m "chore(release): v<newversion> (<level>)"
  ```

  Do not modify any other files. Do not run the test suite -- a version bump
  cannot affect it, and the feature branch is already green.

# STEP 3 -- WRITE THE PR DESCRIPTION

Write a concise, reviewer-focused description in GitHub-flavored markdown:

- **What & why** -- a short summary of the capability or fix this feature adds.
- **Changes** -- the notable changes grouped logically (not a raw file dump).
- **Review notes** -- anything the reviewer should scrutinize, plus test status.

Do not include a title heading and do not add `Closes #...` lines (those are
added automatically).

# OUTPUT

Emit the chosen level, then the description, and nothing after the closing tag:

<bump>LEVEL</bump>
<pr-description>
...your markdown here...
</pr-description>
