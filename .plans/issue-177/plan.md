# Issue 177: conclude review after the third revision

Authority: the frozen issue-177 GitHub snapshot, baseline `8d38734a93bc374560d2728e8cff6f9636181585`, and planning action `5c607c42-c222-4f44-a23c-7d95b4bf6bf4`. After a complete, published third-revision ballot, remaining objections become agent-filed follow-up issues. The coordinator verifies and publishes the final revision through its existing PR path. There is no fourth product revision and no automatic repeat vote on the same pin.

## Exact File List to be changed or deleted

Only these existing files are authorized for implementation changes; none will be deleted.

| File | Exact purpose |
| --- | --- |
| `src/steps.ts` | Define the conditional Git-submission follow-up task, its evidence ID, objector participants, and observation/acceptance metadata. |
| `src/state.ts` | Extend the existing final decision schema with a distinguishable revision-limit algorithm, and persist verified follow-up receipts on accepted submissions; register the new task/evidence IDs. |
| `src/machine.ts` | Replace terminal revise/escalate loops with derivation of the capped decision, schedule only its active objectors, and require their receipts before finalization. |
| `src/runLoop.ts` | Derive and journal the capped decision, bind published evidence to follow-up tasks, verify/store issue receipts, recover legacy terminal owner questions, preserve exact final-pin authority, and pass closeout context to PR formatting. |
| `src/protocol.ts` | Add a strict protocol-version-1 follow-up receipt artifact; keep private ballot responses unchanged. |
| `src/evidence.ts` | Validate the Git receipt's common fields, action identity, round, exact revision, and bound-input hash before external issue verification. |
| `src/orderScaffold.ts` | Render the receipt and concrete issue-filing instructions, and describe the finalization base accurately for both decision algorithms. |
| `src/agentLanguage.ts` | Register the new evidence ID and its plain-language subject. |
| `src/githubIssue.ts` | Reuse issue fetching to verify a follow-up target/backlink and extend PR formatting with the closeout reason and follow-up links. |
| `src/finalization.ts` | Make descriptions of the authorized finalization base accurate for a capped decision while retaining the deletion-only and ancestry checks. |
| `src/issueReport.ts` | Display the follow-up task, capped conclusion, verified links, and outstanding filing work without exposing pending ballots. |
| `src/ownerControls.ts` | Integrate terminal decision recovery with owner answers and late drops, preventing a concluded third-round pin from being replaced by a restarted earlier selection. |
| `test/machine.test.ts` | Extend existing round/ballot fixtures to cover cap transitions, incomplete evidence, and conditional objector scheduling. |
| `test/state.test.ts` | Cover strict decision/receipt schemas and compatibility with existing format-4 state. |
| `test/runLoop.test.ts` | Exercise durable cap derivation, filing receipt acceptance, restart/drop recovery, and checked PR publication using existing runner/mirror fixtures. |
| `test/evidence.test.ts` | Extend the existing order/mirror fixtures with valid and incorrectly bound follow-up receipts. |
| `test/orderScaffold.test.ts` | Check filled receipt fields and actionable, replay-safe filing instructions. |
| `test/githubIssue.test.ts` | Test follow-up issue verification and truthful PR formatting with the existing fake command runner. |
| `test/issueReport.test.ts` | Check closeout progress and links while preserving ballot privacy. |
| `test/agentLanguage.test.ts` | Extend the existing all-action fixture to render a valid final-round follow-up action. |
| `README.md` | Replace the statement that reaching the revision limit always requires an owner decision. |
| `docs/coord-driver.md` | Document terminal closeout, agent filing responsibilities, restart behavior, and the existing numbered interactive answer menu. |

## Exact file list to be created

No new product, test, configuration, dependency, or helper files. This planning action creates only `.plans/issue-177/plan.md` as coordination evidence. The new workflow later generates a per-objector receipt under the existing current-issue signals directory; that generated evidence is not a new checked-in product module.

## Reuse and Scope

### Existing behavior and the bounded change

`decide` already waits for all active private responses and a matching published ballot batch. At the cap it currently emits a `revision-limit` owner question for `revise`; `escalate` also blocks on an owner question. `computeConsensusDerived` then refuses every non-unanimous set, and finalization requires that derived decision. Changing only the machine transition would therefore leave finalization stuck.

Retain rounds one and two: revise requests the next round, escalate asks the owner, and unanimous approval may conclude immediately. On round three, collect and publish the final ballots exactly as today. Unanimous approval still takes the existing direct finalization route. Any `revise` or `escalate` now produces a terminal revision-limit decision and follow-up work instead of another owner question. A missing, rejected, unpublished, wrong-round, or stale-roster ballot is not an objection that may be skipped. Checks that fail are also not review objections.

### Persist the actual conclusion

Reuse `ConsensusDerived`, `computeConsensusDerived`, `computeDerivedInputSetHash`, `deriveDecisionId`, `derivedDecisionJournalDetails`, and `persistDerivedDecision`. Extend the existing decision with an algorithm discriminator: preserve `unanimous-active-roster-v1`, and add `revision-limit-active-roster-v1` for a complete third-round batch with at least one objection. Require round three and a nonempty, ordered objector list for the latter variant; reject those extra fields on the unanimous variant. Preserve original dispositions and response digests.

The capped derivation must cite the authorized reviser's accepted round-three product pin and every response through the matching published batch. Include the new policy discriminator in the capped decision's hash domain so it cannot alias an unanimous decision; preserve existing unanimous identities and parsing. Reuse the legacy `consensusPin`/`consensusSha` wire names as the authorized finalization base, but describe the actual algorithm in actions, journal details, status, and PR prose. Never label capped objections as approval or overwrite the ballots.

### Let the objecting agent file the follow-up

Add one conditional task, `R6.follow-up`, with Git evidence `follow-up-published` and a generated required path of `.signals/issue-<issue>/follow-up-ready-<agent>-round-3.json`. It is not a private ballot and does not change `isBallotStep` or the ballot publication protocol. Its participants are precisely the active agents with `revise` or `escalate` in the sealed final batch. The ordinary unanimous, reviewed, and solo routes skip it.

Bind each filing task to the exact final revision and the published canonical ballot evidence, using existing `BoundInput`, `deriveBoundInputs`, materialized inputs, and `buildOrder` rendering. The coordinator supplies the repository, concluding issue URL, agent identity, revision SHA, and a stable filing key derived from issue session + agent + final pin. Do not use the replaceable action UUID as the issue deduplication key.

The task explicitly instructs that objecting agent to create one new GitHub issue containing all of its remaining objections, with a descriptive title, concrete failures/expected behavior, the final revision SHA, an explicit non-closing backlink to the concluding issue, and the stable key. It first searches all issue states in the exact repository for that key and verifies any match. It reuses its own matching issue after retries; if creation's result is uncertain, reconcile before creating again. Use a body file for multiline `gh issue create` content. No coordinator-authored issue creation, automatic assignment to people, or public filing before the final ballot batch is published.

The receipt contains the existing common protocol fields, `actionId`, `inputSetHash`, `round: 3`, `revisionCommitSha`, and `followUpIssueUrl`. The coordinator fills all binding fields in the scaffold. The agent supplies the URL, commits only this receipt, pushes, and uses the ordinary Git completion marker. `evaluateEvidence` verifies the receipt's bindings and the expected branch. An asynchronous run-loop verifier reuses `fetchGitHubIssue`, `githubRepositoryFromOrigin`, and the injectable command-runner pattern to confirm a real, different issue in the same repository with the exact concluding-issue backlink, revision, and stable key. Persist the verified URL/number as accepted-submission metadata, not as a product pin. Reject a wrong issue or missing backlink with a concrete correction; treat a failed lookup as retryable verification, retaining the marker and avoiding duplicate issue creation. Do not depend on a GitHub login uniquely identifying an agent: agents can share credentials, while the bound receipt identifies the submitting agent.

This one task is justified by the requirement that objectors create the follow-ups. Filing during private voting would reveal judgments early; asking the finalizer to file every issue would transfer the required responsibility. Reuse the existing action/receipt lifecycle instead of adding a second task queue or issue-creation service.

### Finalization, recovery, and owner interaction

After all required filing receipts are accepted, order the authorized reviser to finalize the exact third-round pin. Reuse `verifyFinalization`, `verifyFinalizationChecks`, `selectVerification`, `runGateVerification`, the existing durable publication outbox, and `openDraftPullRequest`. The final commit may only perform the existing allowed current-issue cleanup. Final checks still classify the complete change from the frozen baseline and must succeed before PR publication. Add the capped conclusion and verified follow-up links to `formatFinalizationPullRequest`, retaining the concluding issue's `Closes` reference and the configured draft/merge policy. The user requested a PR; this does not authorize changing the configured merge policy.

On restart, older format-4 state remains readable and ordinary decisions remain valid. If a persisted round-three `revision-limit` or `ballot-escalation` question has the complete terminal evidence, clear/supersede only that obsolete question under the existing state lock and derive closeout from those same ballots. Do this before the machine's owner-question early return. Do not synthesize an owner answer, erase accepted evidence, clear a manual pause/hold, or create another ballot action. If terminal evidence is incomplete, preserve it and finish the missing evidence/publication first. A stale owner answer must fail against the retired question; it must not reset the closeout. Journal-before-state recovery must deduplicate the decision and retain accepted filing receipts and PR publication attempts.

For non-reviser drops once the third-round conclusion is fixed, retain the final revision and completed plan/implementation authority. Rebuild only the affected final ballot denominator/evidence and terminal decision for the remaining roster, preserving valid remaining receipts bound to that same pin. Do not recompute earlier winners or normalize a one-agent remainder onto an older implementation pin. The existing refusal to drop the authorized reviser remains. Dropped agents' objections stay in historical published evidence and are reported as dropped, not approved or filed; remaining active objectors still owe receipts. This is the narrow late-drop integration required by the new terminal path, not a rewrite of pre-terminal selection policy.

The baseline already has `startInteractiveSession` numbered owner-question menus and runtime-scoped recovery text through `issueCommand`. Reuse them for earlier escalation and genuine holds. Document number + Enter and `s` to redisplay; do not add a shell-command interpreter at the prompt. Lifecycle hook delivery and general reminder policy are outside this change; the issue's historical examples do not justify replacing those subsystems.

### Existing test support

Extend `consensusResponses`, `consensusBatch`, `acceptedResponseFixture`, and `publishedBallotBatchFixture`; reuse the run-loop `fixture`, temporary runtime directories, fake mirrors, injected process runners, PR opener/merger spies, and durable journal/state helpers. Extend the `order` and `mirror` factories in evidence tests and the existing issue-fetch runner fixtures. Reuse existing finalization ancestry/cleanup and interactive-menu tests unchanged. New logic stays in the owning modules listed above; no new dependency or generic abstraction is needed.

## Tests

Add only the following focused regression groups, extending the listed existing files:

1. **Machine boundaries — `test/machine.test.ts`:** replace the old round-three dead-end expectation with a parameterized revise/escalate case that reaches the capped derivation and only objector filing tasks. Assert no fourth revision, retry ballot, or owner question. Include incomplete/pending/stale final-batch counterexamples and all-approve/below-cap controls. All accepted receipts advance to finalization; a missing receipt cannot be treated as success.
2. **Durable identity — `test/state.test.ts` and `test/runLoop.test.ts`:** old format-4 unanimous records still load; malformed cap rounds/objector sets fail. The cap binds the exact revision and published responses, differs from unanimous identity, and survives journal-append/cursor-write recovery. Seed a legacy cap question and show it closes without discarding votes or clearing pauses/holds. A late non-reviser drop preserves the final pin and does not reopen planning or implementation, including a one-agent remainder.
3. **Filing evidence — `test/evidence.test.ts`, `test/orderScaffold.test.ts`, and `test/githubIssue.test.ts`:** one valid receipt plus table-driven wrong-action/session/round/pin/hash, parent-issue URL, foreign-repository URL, missing backlink/key, and unavailable lookup cases. Check that the generated instructions bind creation to the objector, wait until ballots are public, and search/reuse the stable key on reissue. Use fake GitHub responses, never live issue creation in tests.
4. **Checked closeout — `test/runLoop.test.ts`:** reuse the finalization/publication fixture for a complete third-round dissent path, receipt acceptance, coordinator restart, and PR opening with exact pin/links. Assert that a failing final check produces zero PR calls, accepted filing work is not reissued, a concurrent pause prevents effects, and publication recovery uses the existing PR identity rather than creating a second PR. The coordinator's process runner must never execute issue creation.
5. **Truthful output — `test/githubIssue.test.ts`, `test/issueReport.test.ts`, and `test/agentLanguage.test.ts`:** capped versus unanimous descriptions, backlink/follow-up URLs in PR context, progress for outstanding filing work, no pending private-ballot disclosure, and plain-language rendering of the new task. Extend existing assertions rather than snapshotting entire reports.

Focused implementation command (all named suites exist in the fast configuration):

```sh
pnpm exec vitest run --config vitest.config.ts test/machine.test.ts test/state.test.ts test/runLoop.test.ts test/evidence.test.ts test/orderScaffold.test.ts test/githubIssue.test.ts test/issueReport.test.ts test/agentLanguage.test.ts test/finalization.test.ts test/interactive.test.ts
```

The product commit hook owns `pnpm check:fast`; do not manually duplicate it immediately before committing. The frozen issue configuration assigns the coordinator `pnpm run check`, whose package script runs build, lint/typecheck, fast/system tests, and e2e. If a later action enables coordinator verification, cite its recorded candidate/final results instead of rerunning its suites. No package version bump or hook modification is planned.

For this planning submission, validate the mandatory nonempty headings, exact existing-file map, and authority references, then commit/push only the plan. Product suites are not necessary for this evidence-only action.

## Alternatives Rejected

- Simply advance to finalization at the limit: the current derivation rejects dissent and would leave the finalization authority missing; it also loses agent filing responsibility.
- Treat objections as approval, accept a majority at round three, or drop dissenters automatically: these misstate the final evidence and change participation without owner action.
- Raise the cap, offer another same-pin retry, or require a new owner override: these preserve the reported inability to conclude development on the third revision.
- Put a follow-up URL in a private ballot after publicly filing the issue: this leaks the judgment before all peers finish, and overloads the bounded rationale field if no schema is added.
- Have the coordinator/finalizer author all follow-ups or add a general durable issue-creation queue: the issue explicitly assigns creation to objecting agents, and existing Git action evidence supplies the necessary lifecycle.
- Rewrite interactive controls, lifecycle hooks, or all drop/reselection behavior: the baseline already solves the prompt mechanics; only integration with the new terminal conclusion belongs here.

## Risks and Mitigations

- **A policy closeout looks like unanimous approval.** Keep an explicit algorithm and original ballot citations, and label the reason in generated actions, status, and the PR. Legacy field names are compatibility details, not approval claims.
- **A wrong or stale pin is finalized.** Both derivation and receipt validation require the authorized round-three pin; finalization binds only that pin and retains all ancestry, cleanup, and baseline-relative verification checks.
- **GitHub failure or replay creates duplicate follow-ups.** Give the agent a stable issue key independent of action reissue, require lookup/reconciliation before creation, and preserve durable receipts. External availability can delay filing; it does not authorize a fourth revision or false success. Exactly-once GitHub creation is not claimed across arbitrary agent violations of the reconciliation instructions.
- **Restart or late drop returns to the old loop.** Recover obsolete terminal questions before the owner-question guard, preserve completed product authority, require a matching published denominator, and cover journal/state crash boundaries plus the one-agent case.
- **Follow-up work reveals private voting.** Prepare it only after the final batch is durably published; never pass unclosed response bytes to another agent or report them publicly.
- **The new task expands implementation scope.** Keep it evidence-only, with no product pin or product editing instruction. Continue to enforce the selected plan map, unchanged private ballots, and the configured PR policy.

## Conclusion

Implement a terminal third-revision decision that records dissent honestly, has each active objector file and link a follow-up issue after ballots are published, and then uses the existing verified finalization/PR path. The original issue concludes without a fourth revision or an owner retry loop; unresolved objections remain traceable to their authors and the exact final revision.
