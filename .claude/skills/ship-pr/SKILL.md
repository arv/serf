---
name: ship-pr
description: >
  Drive the current branch all the way to a merged pull request: create the
  PR (or find the branch's existing one), get a GitHub Copilot code review,
  verify and fix each finding, reply on and resolve the threads, re-request
  review, and merge once Copilot is satisfied and CI is green. Use this
  whenever the user wants work shipped end-to-end rather than just pushed —
  "ship this", "PR this and merge it", "get this reviewed and merged",
  "open a PR and have copilot look at it", "merge when approved", "drive
  this to merge" — even when they never say the words "pull request".
---

# Ship a PR through Copilot review to merge

The loop is create → review → fix → re-request → merge. Each stage has a
gate; skipping ahead (pushing unvalidated fixes, merging on a stale review)
is what burns review cycles and reviewer trust.

Tooling: in GitHub-MCP environments use the `mcp__github__*` tools
(`list_pull_requests`, `create_pull_request`, `request_copilot_review`,
`pull_request_read`, `add_reply_to_pull_request_comment`,
`resolve_review_thread`, `merge_pull_request`); with the `gh` CLI the same
steps are `gh pr list/create/edit/view/merge`.

## 0. Before the PR exists

- All work committed and pushed on a feature branch — never the default
  branch.
- Run the repo's own fast checks locally first (typecheck, unit tests,
  lint/format — whatever a contributor runs before pushing). A PR that
  opens red spends its first review round on things you could have caught
  in seconds.

## 1. Create the PR — or find it

- Check for an existing open PR for this head branch first. Reuse it: a
  second PR for the same branch splits the review history and confuses
  every watcher.
- If none exists, create one. If the repo has a PR template
  (`.github/pull_request_template.md` and friends), mirror its sections and
  fill them from the diff. Title says what the change does; body is a
  summary plus key changes — no filler.
- If the environment offers PR-activity subscription
  (`subscribe_pr_activity`), subscribe now: review and CI events then
  arrive as wakes instead of you polling for them.

## 2. Get the Copilot review

- Request it (`request_copilot_review`, or `gh pr edit --add-reviewer
  copilot`). Some repos auto-request Copilot on PR creation; requesting
  again is harmless.
- Wait event-driven if subscribed. If you must poll, space the checks to
  review-sized intervals — Copilot typically takes about five minutes, so
  polling every few seconds is pure waste.

## 3. Work the findings

Copilot findings are bug reports, not orders. For each one:

1. **Verify against the code first.** Read the code paths the finding
   names and establish whether the failure scenario is real. Copilot is
   right often enough to take seriously and wrong often enough that an
   unverified "fix" can add the very bug it imagined.
2. **Real finding** → fix it minimally (what the finding needs, no more),
   add a regression test when it is a behavior bug, re-run the repo's fast
   checks, commit with a message that names the finding and what the fix
   does, push. One validated push beats three speculative ones.
3. **Wrong or already-defended finding** → do not change code to appease
   it. Reply on the thread with the evidence: the file, the guard it
   missed, why the scenario cannot happen.
4. Either way, reply briefly on each thread saying what you did, then
   resolve the threads you addressed. Unexplained pushes and silently
   resolved threads make a reviewer re-review from scratch; a one-line
   reply lets them verify in seconds.

Never skip, disable, or quarantine a test to satisfy a finding, and never
push an empty commit to re-trigger review — the re-request below does that.

## 4. Re-request and iterate

- After each push that addresses findings, re-request the Copilot review.
- Iterate until the latest Copilot review on the **current head** raises
  nothing new — its verdict reads positive and no unaddressed comments
  remain. A clean review of an older commit proves nothing.
- **Convergence guard:** if the findings stop converging — each fix draws
  a new or reshaped finding, or the same one returns reworded — stop
  pushing for the bot. Summarize what is still flagged and your own
  assessment for the user instead of looping. Cap the loop at about five
  rounds; a workflow that hasn't converged by then needs a human.

## 5. Merge

Merge only when ALL of these hold on the current head:

- Copilot's latest review is satisfied: nothing new, all threads resolved.
- CI is green.
- The PR is mergeable — no conflicts, `mergeable_state` clean.
- No human reviewer has an unaddressed changes-requested review, and no
  human has asked you to hold off.

Then:

- Match the repo's merge convention: read how the last few PRs landed on
  the default branch (merge commits, squash, or rebase) and do the same.
  If the history is ambiguous, use a merge commit — it preserves the
  review-round history this workflow just created.
- If branch protection requires a human approval, Copilot's review does
  not count as one. Report that the PR is green, reviewed, and waiting on
  a human — do not try to route around the protection.
- After merging: unsubscribe from PR activity if you subscribed, and
  report the outcome — PR number, how many review rounds, what the
  findings were, and the merge commit.

## Failure modes

- **CI goes red mid-loop** → fix CI before anything else; a red head is
  never "waiting on review".
- **Merge conflict** → merge the base branch into the head (never rebase
  or force-push a shared branch), resolve, re-validate locally, push.
- **Permission denied on merge (403)** → report that the PR is reviewed
  and green but you lack merge rights; don't retry, and don't look for
  another way in.
