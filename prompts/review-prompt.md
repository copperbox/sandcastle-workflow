# TASK

Review the code changes on branch `{{BRANCH}}` and improve code clarity, consistency, and maintainability while preserving exact functionality.

# CONTEXT

## Branch diff

Configured exclude pathspecs (e.g. generated artifacts) are omitted from this
diff -- they are machine-produced and always considered good; do not review
them. The `| head -c` cap is a safety net so an unexpectedly large diff can
never overflow the prompt.

!`git diff {{TARGET_BRANCH}}...{{BRANCH}} -- . {{DIFF_EXCLUDES}} | head -c 200000`

## Commits on this branch

!`git log {{TARGET_BRANCH}}..{{BRANCH}} --oneline`

# REVIEW PROCESS

1. **Understand the change**: Read the diff and commits above to understand the intent.

2. **Analyze for improvements**: Look for opportunities to:
   - Reduce unnecessary complexity and nesting
   - Eliminate redundant code and abstractions
   - Improve readability through clear variable and function names
   - Consolidate related logic
   - Remove unnecessary comments that describe obvious code
   - Avoid nested ternary operators - prefer switch statements or if/else chains
   - Choose clarity over brevity - explicit code is often better than overly compact code

3. **Check correctness**:
   - Does the implementation match the intent? Are edge cases handled?
   - Are new/changed behaviours covered by tests?
   - Are there unsafe casts, `any` types, or unchecked assumptions?
   - Does the change introduce injection vulnerabilities, credential leaks, or other security issues?

4. **Maintain balance**: Avoid over-simplification that could:
   - Reduce code clarity or maintainability
   - Create overly clever solutions that are hard to understand
   - Combine too many concerns into single functions or components
   - Remove helpful abstractions that improve code organization
   - Make the code harder to debug or extend

5. **Keep the README up to date**: Read the project's README.md and check it against the diff:
   - If the branch adds or changes anything a README reader should know about (features, commands, configuration options, setup steps, usage examples), update README.md to reflect it
   - If the branch removes or renames something the README mentions, correct those references
   - Match the README's existing tone, structure, and level of detail - document what users of the project need, not internal implementation details

6. **Apply project standards**: Follow the coding standards defined in @.sandcastle/CODING_STANDARDS.md

7. **Preserve functionality**: Never change what the code does - only how it does it. All original features, outputs, and behaviors must remain intact. Documentation updates (like the README) are expected and do not count as functionality changes.

# EXECUTION

If you find improvements to make (including README updates):

1. Make the changes directly on this branch
2. Run `{{VERIFY_COMMAND}}` to ensure nothing is broken
3. Commit describing the refinements

If the code is already clean and well-structured and the README is up to date, do nothing.

Once complete, output <promise>COMPLETE</promise>.
