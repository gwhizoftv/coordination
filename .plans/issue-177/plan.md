# Issue 177: conclude at the revision limit

When a consensus ballot at `maxRevisionRounds` (fixed at 3) contains at least one `revise` disposition and no `escalate` disposition, conclude that revision. Do not open a `revision-limit` owner question, and do not start another revision round. Each agent who voted `revise` publishes a follow-up GitHub issue for the remaining objections. The coordinator then runs the existing finalization checks on that revision pin and opens the pull request.

Round 4 stays forbidden. Unanimous `approve` at round 3 still derives `unanimous-active-roster-v1` and goes straight to finalization. An `escalate` disposition still opens the existing owner question.

## Exact File List to be changed or deleted

- `src/steps.ts`
- `src/state.ts`
- `src/machine.ts`
- `src/runLoop.ts`
- `src/protocol.ts`
- `src/evidence.ts`
- `src/orderScaffold.ts`
- `src/githubIssue.ts`
- `src/ownerControls.ts`
- `src/issueReport.ts`
- `src/agentLanguage.ts`
- `docs/coord-driver.md`
- `test/machine.test.ts`
- `test/runLoop.test.ts`
- `test/githubIssue.test.ts`
- `test/evidence.test.ts`
- `test/agentLanguage.test.ts`
- `test/orderScaffold.test.ts`
- `test/cli.test.ts`

## Exact file list to be created

No files are created. The follow-up signal path is a runtime artifact under the existing signals tree, not a new source file.

## Reuse and Scope

Reuse these existing pieces:

- `decide` in `src/machine.ts`, including the round-3 branch that today returns `owner-action-required` with kind `revision-limit`, and `normalizeCurrentStep` / `nextStep` / `globalOrder`.
- `computeConsensusDerived`, `persistDerivedDecision`, `applyDerivedConsensus`, `deriveBoundInputs`, and `publishAcceptedFinalization` in `src/runLoop.ts`. The limit record uses the same consensus slot, decision-id form `consensus:<hash>:r<round>`, and `consensusPin` so `R7.finalize` and `verifyFinalizationChecks` stay the final-check and PR path.
- `fetchGitHubIssue`, `githubRepositoryFromOrigin`, and `formatFinalizationPullRequest` in `src/githubIssue.ts`.
- `evaluateEvidence` join-signal validation in `src/evidence.ts` and `artifactScaffoldValue` in `src/orderScaffold.ts`.
- `applyOwnerAnswer` and `rederiveAfterDrop` in `src/ownerControls.ts`.
- `STEP_DEFINITIONS`, `consensusSteps`, `roundForStep`, and `EvidenceId` in `src/steps.ts`.
- `consensusDerivedSchema`, `stepIdSchema`, `evidenceIdSchema`, and `acceptedSubmissionSchema` in `src/state.ts`.
- `EVIDENCE_IDS` and `AGENT_FACING_SUBJECT` in `src/agentLanguage.ts`.
- The `effectful run loop` fixture in `test/runLoop.test.ts`, the revision-limit case in `test/machine.test.ts`, and the owner-answer case in `test/cli.test.ts`.

Behavior to implement:

1. Add workflow step `R6.follow-up` on gate `gate-6-consensus` with evidence id `follow-up-issue-published`, git submission, and required path `.signals/issue-<n>/follow-up-issue-<agent>-round-<round>.json`. Put it in `consensusSteps` and `globalOrder` between `R6.ballot` and `R7.finalize`. `roundForStep` already keeps a round for every `R6.*` step.
2. `normalizeCurrentStep` returns `R6.follow-up` unchanged for every profile while that is the current step. Solo degradation must not skip a pending follow-up. The step is absent from the solo and reviewed sequences so a normal solo or reviewed issue never enters it. `nextStep("R6.ballot")` would otherwise become the follow-up step, so the ballot handler must not fall through to `nextStep`. Unanimous approval advances explicitly to `R7.finalize`. Follow-up completion advances explicitly to `R7.finalize` with a null round.
3. On a complete, published `R6.ballot`:
   - `escalate` still returns the existing owner question. At round 3 its answers stay `retry` and `abandon`.
   - `revise` with `round < maxRevisionRounds` still advances to `R6.revise` at `round + 1`.
   - `revise` with `round >= maxRevisionRounds` derives a consensus record with algorithm `revision-limit-active-roster-v1` when the stored consensus is missing, for a different round or roster, or still `unanimous-active-roster-v1`. Derivation then advances to `R6.follow-up` at the same round. The pin is the accepted revision `productPin` for that round. The record requires a complete active roster, a published consensus batch, a revision pin, at least one `revise`, and no `escalate`.
   - All `approve` keeps `computeConsensusDerived` and `applyDerivedConsensus`, which advance to `R7.finalize`.
4. New decision `derive-revision-limit` is handled beside `derive-consensus` and calls the same `persistDerivedDecision` helper with the advance target `R6.follow-up`. New decision `dismiss-revision-limit` clears a stored `ownerQuestion` whose kind is `revision-limit` before any other owner-question return. It journals `owner-answer` with `{ questionId, kind, round, automatic: true }` and does not set `lastOwnerAnswer`. The same tick's later progress iteration then takes the conclude path. `decide` does not emit a fresh `revision-limit` question. Ballot-escalation questions stay.
5. Follow-up participants are the active agents whose accepted `R6.ballot` response at that round has disposition `revise`. Approvers receive no action. When no such agent remains, advance to `R7.finalize`. `decide` handles this step before the generic participant loop, the same way it special-cases amendment ballots.
6. The action task tells that agent to create the GitHub issue in this repository, to put the remaining objections in the issue body, and to include the parent issue reference `#<issue>`. The coordinator does not create the issue. The task and the agent-facing subject must stay free of internal step ids, gate ids, and evidence ids. Scaffold the signal in `orderScaffold.ts` with `artifact: "follow-up-issue"`, the action round, and `revisionPin` set from the bound revision pin (placeholder only when that pin is absent). `followUpIssue` and `followUpUrl` stay agent-authored placeholders.
7. `followUpIssueArtifactSchema` in `src/protocol.ts` is a strict protocolVersion 1 artifact with `issue`, `issueSessionId`, `agent`, `artifact: "follow-up-issue"`, `round`, `revisionPin`, `followUpIssue`, and `followUpUrl`. `evaluateEvidence` accepts it only when the common fields match, `round` matches the action round, `followUpIssue` is a different positive issue number, and `revisionPin` equals the bound revision pin. Add evidence id `follow-up-issue-published` and step `R6.follow-up` to the state enums. Extend `consensusDerivedSchema.algorithm` to the union of `unanimous-active-roster-v1` and `revision-limit-active-roster-v1`. The decision-id refine stays `consensus:<hash>:r<round>`.
8. After schema acceptance, `CoordinatorRunLoop` calls a new `assessFollowUpIssue` in `src/githubIssue.ts` through the existing `processRunner` and `fetchGitHubIssue`. The GitHub issue number and URL must match the signal. The body must contain the parent reference as `#<parent>` (not a longer issue number) or the parent issue URL from the start snapshot. A mismatch rejects the submission and reissues the action. It does not open an owner question. Store `followUpIssue` and `followUpUrl` on the accepted submission.
9. `formatFinalizationPullRequest` appends the accepted follow-up issue numbers, and `publishAcceptedFinalization` passes them through. The PR still contains `Closes #<parent>`.
10. `applyOwnerAnswer` rejects `retry` on a `revision-limit` question so a stored question cannot rerun the same ballot. `abandon` still abandons. `revise` stays disallowed by `allowedAnswers` and by the existing round-4 guard.
11. `rederiveAfterDrop` recomputes a stored `revision-limit-active-roster-v1` consensus with the limit function, not `computeConsensusDerived`. Remaining `revise` votes keep the limit record and stay on follow-up. When the new roster is entirely `approve`, store the unanimous record instead. A null result still resets to `R6.ballot`. Add `R6.follow-up` to every drop-reset step list that already names `R6.ballot` or `R7.finalize`. Dropping the authorized reviser stays forbidden.
12. `docs/coord-driver.md` states that a `revise` vote at the configured revision limit concludes that pin: objecting agents file linked follow-up issues, then the coordinator runs final checks and opens the PR. `answer` still cannot create round 4. Escalation is unchanged.

Delivery-uncertain holds, Stop-hook lifecycle, and drop rewinds that happen before a revision-limit consensus are outside this change.

## Tests

Extend existing tests. Each new case fails on the current revision-limit stop and passes after the change.

- `test/machine.test.ts`: replace the "never enters revision round four" expectation. A round-3 ballot with a `revise` vote and a published batch yields `derive-revision-limit`, never `owner-action-required` and never round 4. Once that consensus is stored, the next decision is `advance-step` to `R6.follow-up` at round 3. A stored `revision-limit` owner question yields `dismiss-revision-limit` instead of another owner prompt. Round 2 `revise` still advances to `R6.revise` round 3. Round-3 unanimous `approve` still yields `derive-consensus`. On `R6.follow-up`, only `revise` voters get `prepare-action`; when those submissions are accepted, the decision is `advance-step` to `R7.finalize`.
- `test/runLoop.test.ts`, in the existing `effectful run loop` describe: one tick clears a stored revision-limit question, journals the automatic `owner-answer`, and reaches follow-up preparation without an owner prompt. A second case, with `processRunner` returning a GitHub issue whose body lacks the parent reference, rejects that follow-up submission and does not set an owner question.
- `test/githubIssue.test.ts`: `assessFollowUpIssue` accepts `#<parent>` and the parent issue URL, and rejects a different number, a longer number such as the parent digits plus another digit, a URL mismatch, and a `gh` failure. `formatFinalizationPullRequest` includes the follow-up issue numbers and still contains `Closes #<parent>`.
- `test/evidence.test.ts`: add `R6.follow-up` / `follow-up-issue-published` to the missing-path table, and reject a follow-up signal whose `revisionPin` or `round` disagrees with the order or whose `followUpIssue` equals the parent issue.
- `test/orderScaffold.test.ts`: the follow-up scaffold contains `follow-up-issue`, the bound revision pin, and the action round.
- `test/agentLanguage.test.ts`: the step count and unique subject count become 12. The rendered follow-up action has no agent-language violations. The subject is `the follow-up issue signal`.
- `test/cli.test.ts`: `retry` on a stored revision-limit question fails and leaves the round at 3. The existing `revise` rejection stays. Dropping a non-reviser objector while the limit consensus is stored does not move the issue back to `R6.ballot` or `R4.implement`.

Focused commands while developing:

```sh
pnpm exec vitest run --config vitest.config.ts test/machine.test.ts test/runLoop.test.ts test/githubIssue.test.ts test/evidence.test.ts test/orderScaffold.test.ts test/agentLanguage.test.ts
pnpm exec vitest run --config vitest.system.config.ts test/cli.test.ts
```

The product commit hook runs its classified checks. This plan does not treat that hook, or the coordinator's later pin checks, as checks already run.

## Alternatives Rejected

- Opening round 4. `maxRevisionRounds` is fixed at 3, and the owner asked to conclude the third revision rather than continue development on this issue.
- Keeping the `retry` / `abandon` owner question and teaching the interactive prompt to accept a typed `coord answer` line. Retry reruns the same ballot on the same commit, which is the loop this issue is stuck in. The prompt's numbered menu can remain for escalation questions.
- Having the coordinator create the follow-up issue from the private ballot rationale. The owner assigned that issue to the objecting agent. The coordinator only checks that the cited issue exists and links the parent, then runs the existing final checks and opens the PR.
- Treating the follow-up as optional after the PR. The pull request is the conclusion, and the follow-up gate is what makes the remaining objections exist before that PR body is written.
- A new consensus slot or a fourth derived kind. The finalization path already reads `derived.consensus.consensusPin`. A second algorithm on that record is enough, and the hash inputs differ because the ballot response digests differ.

## Risks and Mitigations

- `nextStep` from `R6.ballot` would enter follow-up after a unanimous approval if the new step sits in `consensusSteps`. The ballot handler advances unanimous approval explicitly to `R7.finalize` and never uses `nextStep` for that step.
- Solo degradation would skip `R6.follow-up` because the solo sequence jumps to `R7.finalize`. `normalizeCurrentStep` keeps the current follow-up step until `decide` advances it. An objector who is the last active agent still files the issue.
- `rederiveAfterDrop` calls `computeConsensusDerived`, which returns null whenever any `revise` vote remains, and would rewind the issue to another ballot. Limit records recompute with the limit function. A roster that is entirely `approve` after the drop stores the unanimous record instead.
- `applyDecisions` is a non-exhaustive `if` chain. Forgetting `dismiss-revision-limit` or `derive-revision-limit` would leave the question in place. The run-loop tick test covers both the dismiss and the failed GitHub check.
- A follow-up issue that merely mentions a longer number, or a URL for a different issue, would look linked. `assessFollowUpIssue` requires the exact parent reference or the snapshot URL, and requires the returned number and URL to match the signal.
- Agent-facing copy that names `R6.follow-up` or the evidence id fails the language check. The task names the GitHub issue and the signal fields only, and the new subject is covered by `test/agentLanguage.test.ts`.

## Conclusion

A `revise` vote at revision round 3 ends development on this issue. The objecting agents file linked follow-up issues, the coordinator checks those issues, and the existing finalization checks and pull request run on the round-3 revision pin. Round 4, unanimous approval, and escalation are unchanged.
