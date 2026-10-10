# Plan: Conclude Development at Revision Limit and Track Objections in Follow-up Issues

## Exact File List to be changed or deleted

- `src/steps.ts`
- `src/protocol.ts`
- `src/machine.ts`
- `src/runLoop.ts`
- `src/orderScaffold.ts`
- `src/interactive.ts`
- `test/machine.test.ts`
- `test/runLoop.test.ts`
- `test/interactive.test.ts`

## Exact file list to be created

None.

## Reuse and Scope

### Reuse
- `src/steps.ts`: Reuse `STEP_DEFINITIONS`, `WorkflowStepId`, `roundForStep`, `isBallotStep`, and `stepsForProfile` to integrate the `R6.objection` workflow step.
- `src/protocol.ts`: Reuse `commonArtifactFields` and discriminated union `publishedArtifactSchema` to define and validate `objectionIssueArtifactSchema`.
- `src/machine.ts`: Reuse `decide`, `hasAccepted`, `hasResponse`, and `needsConsensusDerive` to transition from `R6.ballot` to `R6.objection` when `round >= start.maxRevisionRounds` and objections exist.
- `src/runLoop.ts`: Reuse `computeConsensusDerived`, `formatFinalizationPullRequest`, `openDraftPullRequest`, and `runVerification` to conclude on the third revision product pin, track follow-up issues, and open the PR.
- `src/githubIssue.ts`: Reuse `fetchGitHubIssue` and `readGitHubIssueSnapshot` to verify that follow-up issues created on GitHub exist and link to the concluding issue.
- `src/orderScaffold.ts`: Reuse existing action markdown generators to guide objecting agents on creating the GitHub issue with `gh issue create` and publishing `.signals/issue-${issue}/objection-issue-${agent}.json`.
- `src/interactive.ts`: Reuse `startInteractiveSession`, `showMenu`, and `commands.answer` while updating key and line input handling to accept choice names (`retry`, `abandon`) and `coord answer` commands.
- `test/`: Reuse existing test fixtures, mock runners, and harness helpers in `test/machine.test.ts`, `test/runLoop.test.ts`, and `test/interactive.test.ts`.

### Scope
- Scope is strictly focused on:
  1. Concluding development at the maximum revision round (round 3) when objections exist instead of halting on the dead-end `revision-limit` owner question.
  2. Ordering objecting agents to file a new GitHub issue detailing their remaining objections and linking to the concluding issue.
  3. Deriving consensus at round 3 once objection signals are published, proceeding through `R7.finalize`, and including follow-up issue references in the final PR.
  4. Allowing owner answers to be typed directly in the interactive prompt.
- Out of scope:
  - Modifying solo or reviewed workflow profiles (which do not loop through `R6.ballot`).
  - Altering revision rounds 1 or 2 (which continue normal revision cycles upon revise votes).
  - Bumping the hard revision limit beyond round 3.

## Tests

1. `test/machine.test.ts`:
   - Replace the legacy `never enters revision round four` test (which asserted halting on `owner-action-required: revision-limit`) with a test asserting that when `round === 3` in `R6.ballot` and objections are present, the machine transitions to `R6.objection` for the objecting agent(s).
   - Test that when all objecting agents have submitted their `objection-issue` artifacts, the machine derives consensus.
2. `test/runLoop.test.ts`:
   - Add test verifying end-to-end consensus derivation when revision round 3 has objections: objecting agent publishes `objection-issue` signal citing a new GitHub issue, consensus is derived with `concludedWithObjections: true`, `R7.finalize` proceeds, and `formatFinalizationPullRequest` includes the follow-up issue link in the PR body.
3. `test/interactive.test.ts`:
   - Add test verifying that `startInteractiveSession` accepts textual choice names (`retry`, `abandon`) and `coord answer` command strings when an owner question is presented, rather than silently ignoring non-numeric keystrokes.

## Alternatives Rejected

1. *Prompting the owner with `retry` or `abandon` on round 3 revision limit*:
   - Rejected because round 4 is forbidden by workflow invariants; retrying re-runs the vote on the same rejected commit and causes an infinite loop, while abandon discards all three rounds of work.
2. *Having the coordinator automatically create the follow-up issue without agent involvement*:
   - Rejected because the objecting agent authored the specific findings, technical rationale, and test cases that motivated the objection. Having the objecting agent create the issue ensures accurate problem framing and preserves reviewer attribution, directly fulfilling the requirement that "the objecting agent must create the new issue."
3. *Silently ignoring objections and forcing unanimous approval*:
   - Rejected because legitimate technical concerns would be erased without resolution or tracking.
4. *Increasing the revision limit to 4 or higher*:
   - Rejected because higher revision limits postpone convergence without solving the underlying disagreement; concluding at round 3 while spinning off follow-up issues guarantees forward progress without deadlocks.

## Risks and Mitigations

1. *Risk*: Objecting agent is unresponsive or unable to file the GitHub issue.
   *Mitigation*: Existing agent lifecycle mechanisms (holds, reminders, and `coord drop`) remain active. Dropping an unresponsive agent recalculates the active denominator and allows the issue to proceed.
2. *Risk*: GitHub CLI rate limiting or transient failure during `gh issue create`.
   *Mitigation*: The agent action specifies retryable CLI commands and allows specifying an already-created issue number if manual intervention is required.
3. *Risk*: Follow-up issue is created without linking back to the concluding issue.
   *Mitigation*: The coordinator validates the follow-up issue body via `fetchGitHubIssue` to confirm it explicitly references `#<concluding-issue>` before accepting the submission.

## Conclusion

This plan resolves the deadlock at revision limits by replacing the stalled `owner-action-required: revision-limit` prompt with an automated conclusion workflow: objecting agents file a follow-up GitHub issue linking to the concluding issue, the coordinator concludes development on the round 3 revision commit, finalizes through `R7.finalize`, and opens the PR referencing the follow-up issue. Interactive prompt handling is also hardened so owner question choices can be entered directly.
