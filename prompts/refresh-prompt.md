# TASK

This feature branch has an open, ready pull request targeting `{{TARGET_BRANCH}}`,
but `{{TARGET_BRANCH}}` has advanced since the branch was last updated. Merge the
latest `{{TARGET_BRANCH}}` into this branch so the PR stays conflict-free and is
verified against current `{{TARGET_BRANCH}}`.

Merge (do NOT rebase -- keep history additive so the push fast-forwards):

```
git merge {{TARGET_BRANCH}} --no-edit
```

- Resolve any conflicts intelligently by reading both sides.
- This is a **refresh, not a re-bump**: do not change the version number. For a
  `package.json` / `package-lock.json` version conflict, keep THIS branch's
  (higher) version.
- After resolving, run `{{VERIFY_COMMAND}}`. Fix any failures.
- Commit the merge if it left anything staged.

If `{{TARGET_BRANCH}}` is already fully merged (nothing to do), that is fine --
leave the branch as is.

Once done, output <promise>COMPLETE</promise>.
