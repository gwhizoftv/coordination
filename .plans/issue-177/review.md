# Review — issue 177 plans

Bound inputs: claude `0f30e5ec0b55ee7c62b49bbefec13fe91d2510d2`, codex
`29ff9141bb350e934d8e72cd1a145303db4cd344`, antigravity
`a8d047341f304dcb068a2a803f66a48b8089d37f`, cursor
`6b9d1ef94dfa29410a7b919c27a6534283bb105c`, each at
`.plans/issue-177/plan.md`. Code facts below were checked against the baseline
`8d38734a93bc374560d2728e8cff6f9636181585` in this clone.

All four plans agree on the core: a round-3 `revise` must not raise the
`revision-limit` owner question; the final revision pin is finalized through
the existing `R7.finalize` checks and PR path; objecting agents, not the
coordinator, create the follow-up issue. They differ in when the objector
files (during the private ballot vs. after the batch is published) and in how
much surrounding machinery they change.

## Findings

### claude (`0f30e5ec`) — my own plan

1. **Claim (Exact File List, `buildOrder` note and `parseBallotResponse`
   follow-up argument):** a final-round `revise` voter creates its follow-up
   issue *before* submitting the private ballot and cites the URL in the
   rationale.
   **Rule:** a public, irreversible side effect must not be taken on a ballot
   that can still be discarded, and ballot judgments stay private until the
   batch is published.
   **Failure:** at round 3 agent A votes `revise` (and files follow-up issue
   #178) while agent B votes `escalate`. The owner answers `retry`;
   `applyOwnerAnswer` drops every round-3 `R6.ballot` response and re-asks all
   agents. A votes `revise` again and, following the same note, files a second
   issue #179 — or votes `approve` and leaves #178 orphaned with no PR link.
   The same happens when A's response is rejected and reissued for any other
   outstanding item. Separately, #178 is public on GitHub while B and the
   others are still voting, so A's judgment is visible before the batch seals.
   **Correction:** file after the final batch is published, as the codex and
   cursor plans do.

2. **Claim (Exact File List, `src/machine.ts`: "`escalate` handling is
   unchanged (still an owner question)"):** a round-3 escalation keeps
   `allowedAnswers: ["retry", "abandon"]`.
   **Rule:** the issue requires that development concludes on the third
   revision instead of dead-ending; no owner answer at round 3 may loop on the
   same pin.
   **Failure:** one agent escalates at round 3. The owner sees retry|abandon
   only — exactly the dead end quoted in the issue: `retry` re-runs the same
   vote on the same commit and the escalating agent escalates again;
   `abandon` discards three rounds. The plan fixes the `revise` path and
   leaves the identical `escalate` path stuck.
   **Correction:** give a round-3 escalation an answer that concludes (for
   example route it into the same final-round conclusion), or justify keeping
   it explicitly.

3. **Claim (`parseBallotResponse` check):** the rationale must contain
   `https://github.com/<repo>/issues/<n>` with `n !== issue`.
   **Rule:** evidence that an objector "created the new issue" must bind to an
   issue created for this objection.
   **Failure:** a rationale such as "same defect as
   https://github.com/o/r/issues/170, still unfixed" passes the check although
   no follow-up was created; the PR then cites #170 as the filed objection.
   **Correction:** bind the follow-up to a backlink to `#<issue>` (cursor's
   `assessFollowUpIssue`) or a stable key (codex), checked after filing.

### codex (`29ff9141`)

4. **Claim (Reuse and Scope: "Any `revise` or `escalate` now produces a
   terminal revision-limit decision and follow-up work instead of another owner
   question"):**
   **Rule:** an explicit `escalate` asks for an owner decision (README step 4,
   `decide`'s `ballot-escalation` branch); converting it into automatic
   publication must not bypass the owner where the coordinator also merges.
   **Failure:** with `prPolicy: "coord-merged"`, `publishAcceptedFinalization`
   calls `pullRequestMerger` right after opening the PR. A round-3 escalation
   (say "this revision deletes user data; owner must decide") becomes a filed
   follow-up issue and an automatically merged PR, with no owner question at
   any point.
   **Correction:** keep an owner decision for round-3 `escalate` but give it a
   concluding answer, or at least never auto-merge a conclusion that contains
   an escalation.

5. **Claim (Reuse and Scope: filing receipts gate finalization; "External
   availability can delay filing; it does not authorize ... false success"):**
   **Rule:** the issue asks the coordinator to "go ahead with the PR" at the
   third revision; the conclusion must not depend indefinitely on an agent
   that has already lost the vote.
   **Failure:** an objector whose sandbox cannot run `gh`, or whose harness
   has died, never produces an accepted receipt. `R7.finalize` is never
   ordered, so the issue stalls at the revision limit again — now without
   even an owner question, until the owner discovers it must `drop` that
   agent. This applies equally to the cursor and antigravity plans.
   **Correction:** state the owner's escape explicitly (status line naming
   the outstanding filer plus `drop`), or let finalization proceed in parallel
   with filing and add links when they arrive.

6. **Claim (Exact File List, 22 files, including `src/finalization.ts`,
   `src/issueReport.ts`, `src/agentLanguage.ts` and 9 test files):**
   **Rule:** smallest change that fully solves the issue; every changed file
   justified.
   **Failure:** `src/finalization.ts` is changed only to "make descriptions
   ... accurate" — no behavioural requirement — inside the module whose
   deletion-only and ancestry checks guard PR publication; a wording edit
   there carries regression risk to the publish gate with nothing in the issue
   requiring it. The legacy-question recovery, late-drop rebuild, and
   issue-report changes are each justifiable, but together the plan is the
   largest of the four by a wide margin.
   **Correction:** drop the `finalization.ts` edit; keep descriptions in the
   PR body and status only.

### antigravity (`a8d04734`)

7. **Claim (Exact File List omits `src/state.ts`; Reuse adds workflow step
   `R6.objection` and a consensus record with `concludedWithObjections: true`):**
   **Rule:** every path the implementation must change is in a file-list
   section.
   **Failure:** `stepIdSchema` and `evidenceIdSchema` in `src/state.ts` are
   closed `z.enum`s, and `consensusDerivedSchema` is `.strict()`. The first
   tick that sets `issueCursor.stepId = "R6.objection"` or persists
   `concludedWithObjections` writes a `cursors.json` that the next
   `readCursorsState` rejects, halting the coordinator. The implementer
   cannot fix this without editing an unlisted file.
   **Correction:** add `src/state.ts`.

8. **Claim (Exact File List omits `src/agentLanguage.ts`, `src/evidence.ts`,
   `src/githubIssue.ts`):**
   **Rule:** same as finding 7.
   **Failure:** `test/agentLanguage.test.ts` "covers every workflow step and
   every evidence id" asserts exactly 11 steps, each with an
   `agentFacingSubject`; a new step/evidence id fails it until
   `src/agentLanguage.ts` changes. The new artifact cannot be accepted
   without `evaluateEvidence` in `src/evidence.ts`. The plan's PR-body links
   require `formatFinalizationPullRequest` and the follow-up check requires
   `fetchGitHubIssue`, both in `src/githubIssue.ts`.
   **Correction:** list all three plus their tests.

9. **Claim (`src/interactive.ts`: accept typed choice names `retry`/`abandon`
   and `coord answer` strings):**
   **Rule:** quick keys and paste safety in `startInteractiveSession` must keep
   working; the baseline already answers owner questions with a numbered menu.
   **Failure:** in `keys` mode `r` immediately opens the release-hold menu, so
   typing `retry` character by character triggers a hold release prompt
   instead of an answer; and multi-character pasted chunks are deliberately
   discarded ("pasted input is not executed"), so a pasted `coord answer ...`
   line is dropped. Supporting either needs a new input mode, which is scope
   the issue does not need now that the menu exists.
   **Correction:** remove the `interactive.ts` change; document the menu.

10. **Claim (whole plan):** no handling of a run already parked on a
    `revision-limit` owner question, and no treatment of round-3 `escalate`.
    **Rule:** existing runtime state must recover under the new behaviour.
    **Failure:** an issue paused today on the retry|abandon question still
    returns `owner-action-required` from `decide`'s early `ownerQuestion`
    check after upgrade, so it stays stuck. (Cursor's `dismiss-revision-limit`
    and codex's recovery both cover this.)

### cursor (`6b9d1ef9`)

11. **Claim (Behavior 8: "A mismatch rejects the submission and reissues the
    action"; Tests: `assessFollowUpIssue` rejects "a `gh` failure"):**
    **Rule:** a verification failure that is not the agent's fault must not
    cause the agent to repeat an external side effect.
    **Failure:** a transient GitHub outage makes `gh issue view` fail; the
    signal is rejected and the action reissued; the reissued action again
    tells the objector to create the issue, so it files a duplicate follow-up.
    **Correction:** treat lookup failure as retryable verification without
    reissue (codex's approach), and tell the agent to reuse an existing issue
    it created for this round.

12. **Claim (Behavior 3: round-3 `escalate` "answers stay `retry` and
    `abandon`"):** same rule and failure as finding 2 — the round-3
    escalation path keeps the loop the issue describes. Behavior 10 removes
    `retry` only from `revision-limit` questions, not from round-3
    `ballot-escalation`.

13. **Finding 5 (filing gates finalization) applies to this plan.**

### Scope and reuse summary

- claude: smallest (6 source files, 4 test files, no new step) but has the
  privacy/duplication flaw in finding 1, which is structural to filing during
  the ballot.
- codex: complete and careful about privacy, duplicates and recovery, but
  widest scope and changes escalation semantics.
- antigravity: incomplete file map (findings 7–8) and adds unneeded
  interactive scope (finding 9).
- cursor: reuses the consensus record, keeps privacy (files after
  publication), handles legacy questions and drops, with a moderate file list;
  its gaps (findings 11–13) have small corrections.

All four propose focused tests in existing files; none creates a new file.

## Conclusion

Cursor's plan is the best basis: it files follow-ups after the ballot batch is
published, reuses the consensus record and finalization path, recovers parked
`revision-limit` questions, and handles late drops, with a proportionate file
list. It needs three corrections before implementation: lookup failure must
not reissue (finding 11), round-3 escalation needs a concluding answer
(finding 12), and the owner needs a visible escape when an objector never files
(finding 5). Codex's plan is a sound alternative but broader than needed and
silently converts escalations (findings 4 and 6). My own plan should not be
selected as written because filing during the private ballot creates duplicate
or orphan issues on retry (finding 1). Antigravity's plan cannot be
implemented within its own file map (findings 7–8).
