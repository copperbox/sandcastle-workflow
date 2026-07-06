# TASK

You are on the feature integration branch `{{FEATURE_BRANCH}}`. Merge the
following issue branches into it (the current branch):

{{BRANCHES}}

For each branch:

1. Run `git merge <branch> --no-edit`
2. If there are merge conflicts, resolve them intelligently by reading both
   sides and choosing the correct resolution
3. After resolving conflicts, run `{{VERIFY_COMMAND}}` to verify everything
   works
4. If tests fail, fix the issues before proceeding to the next branch

After all branches are merged, make a single commit summarizing the integration
if the merges left anything staged.

Do **not** merge into the target branch, open a pull request, or close any
issues -- those steps are handled outside this run. Your only job is to assemble
the completed issue branches onto `{{FEATURE_BRANCH}}` with a green test suite.

Once you've merged everything you can, output <promise>COMPLETE</promise>.
