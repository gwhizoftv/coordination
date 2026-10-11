# Issue 177 implementation comparison

## Comparison

Recommend the Codex implementation. It preserves the third-round product authority through the reproduced drop sequence, rejects the incorrect parent backlink, and refuses the legacy terminal retry. No blocking defect was found in that pin during this review. The three peer pins need the corrections below before selection.

| Implementation | Exact bound product pin | Assessment |
| --- | --- | --- |
| Codex | `e1a33b92f3ff4f2b33752f3c2d54ab1b5249e9f5` | Preferred; passes the targeted counterexamples below. |
| Claude | `9d8d25436530ced335f15843350413c969af1d60` | Successive drops can reopen planning; backlink and legacy-answer validation need correction. |
| Cursor | `5e7f8fee93746dc11083bca7f0029d1137982620` | Same drop, backlink, and legacy-answer defects; permanent missing issues also remain retryable. |
| Antigravity | `3cf68ba1181b8e6e4d2ccdd7c46d38692adb193b` | Preserves the pin in the tested drop sequence, but backlink, lookup, and legacy-answer validation need correction. |

Source paths and line numbers below refer to each implementation's exact exported worktree named in action `0ebe7444-801a-4ce9-9fe4-f9a741b6f505`. The supplied changed-path lists and direct worktree reads were used; no peer fetch or Git diff was needed.

### Findings

1. **Claude `src/ownerControls.ts:151`; Cursor `src/ownerControls.ts:147` — P1: preserve the terminal product pin after the last objector leaves.** Once round three has concluded, a later non-reviser drop must retain the completed plan, implementation, and accepted third-round revision even if the remaining ballots are unanimous. Both implementations enable their preservation branch only while the previous decision uses `revision-limit-active-roster-v1`. With four agents, Codex as reviser, and only Claude objecting, dropping Claude produces a unanimous decision for the remaining three. Dropping approving non-reviser Cursor before finalization then takes the ordinary selection-recomputation path. The published earlier selection batches have the old roster, so the implementations reset to `R3.plan-ballot` and remove the accepted `R6.revise` submission. This repeats the completed product work that issue 177 requires the coordinator to conclude. The executed two-drop reproduction produced that reset in both pins. Codex retained the revision and requested reduced-roster final-ballot publication; Antigravity retained the revision at finalization. Extend the drop test with four agents and a single objector: remove that objector first, then an approving non-reviser, and assert the original round-three revision remains accepted and neither planning nor implementation is reopened.

2. **Claude `src/githubIssue.ts:238`; Cursor `src/githubIssue.ts:163`; Antigravity `src/githubIssue.ts:224` — P2: verify the exact concluding issue backlink.** The verified follow-up must link the concluding issue, not an issue whose number merely starts with its number. Each cited implementation uses a substring check for a URL backlink; Antigravity also uses a substring check for `#177`. For parent issue 177, a follow-up issue whose only backlink is `Related to https://github.com/acme/app/issues/1770`, with the correct revision and filing key, is accepted by all three helpers. This lets the receipt satisfy the finalization gate while the follow-up links a different issue. The actual helpers returned Claude `verified`, Cursor `ok`, and Antigravity `ok: true`; Codex rejected the same incorrect backlink. Add a case with parent 177 and backlink 1770, keeping every other receipt field correct, and require rejection.

3. **Cursor `src/githubIssue.ts:145`; Antigravity `src/githubIssue.ts:220` — P2: return a correctable rejection for a nonexistent follow-up issue.** An unavailable GitHub service may defer verification, but a receipt naming a permanently nonexistent issue must reach the agent's correction path. These catch blocks classify every fetch error as retryable. With a successful command invocation returning exit 1 and `GraphQL: Could not resolve to an Issue with the number of 200. (repository.issue)`, the helpers return retry, and the run loop retains the submitted completion for another lookup. If the agent mistyped the issue number, repeated ticks keep checking that same nonexistent issue without reissuing a correction action, indefinitely preventing closeout. The injected-runner reproduction returned retry for both pins, whereas Codex and Claude rejected the missing issue. Extend the unavailable-lookup test with this permanent missing-number response and require rejection while retaining retry behavior for an outage.

4. **Claude `src/ownerControls.ts:308`; Cursor `src/ownerControls.ts:297`; Antigravity `src/ownerControls.ts:304` — P2: reject the old terminal retry before recovery has derived a decision.** A persisted round-three owner question must not offer another same-pin vote or erase the completed terminal evidence under the new closeout policy. A pre-upgrade runtime can contain a complete published third-round ballot, a `revision-limit` question allowing `retry`, and no derived consensus. Calling `applyOwnerAnswer(..., "retry")` before the recovery tick succeeds in all three peers and removes every accepted third-round response. Cursor's additional check only protects a state that already has the capped decision, which this legacy state lacks. An owner following the previously displayed recovery instruction consequently recreates the retry loop. The executed legacy-state reproduction left zero accepted responses in all three peers; Codex rejected the answer and retained them. Test the answer before, as well as after, terminal recovery, and assert that it cannot discard the final votes.

### Scope, reuse, and coverage

All four pins use the same approved 22 product paths: 12 existing source files, eight existing test files, and the two existing documentation files. The additional changed paths listed by the coordinator are planning/review/participation artifacts. None adds a product module, dependency, hook change, version bump, or unrelated subsystem. Each extends the existing machine, derived-decision state, Git evidence lifecycle, GitHub command-runner interface, owner controls, and finalization/PR path. The new conditional `R6.follow-up` step has a direct issue requirement; no independent task service is introduced.

Codex reuses the existing roster invalidation and final-ballot publication flow while preserving completed product authority for any stored round-three conclusion. Its strict backlink format and missing-issue classification pass the verification counterexamples. Its focused tests cover receipt bindings, journal/state recovery, terminal owner-answer rejection, and late drops. The review's multi-drop probe also covers the transition from capped objections to unanimous remaining ballots.

Claude adds a terminal-consensus rebuild helper and retains historical objections for PR reporting. Its drop test removes successive objectors until one agent remains, so it does not exercise another drop after the decision has already become unanimous. Cursor has focused journal recovery, pause/hold, publication reuse, and one-survivor tests; its late-answer test starts with the capped decision already stored. Antigravity's terminal-round handling preserves the accepted revision in the successive-drop probe, and its tests cover restart, receipt verification, and PR links. The peer GitHub verification tests omit an issue-number prefix collision. These are coverage gaps in otherwise relevant existing test suites, not reasons to introduce another test framework or broaden the file map.

### Verification evidence

Read the existing issue runtime `journal.jsonl`. The following recorded hook observations all have exit code 0:

| Agent | `pnpm run check:fast` precommit sequence | `pnpm run test:e2e` prepush sequence |
| --- | --- | --- |
| Codex | 1845 | 1892 |
| Claude | 1935 | 1963 |
| Cursor | 2561 | 2692 |
| Antigravity | 2860 | 2878 |

These records identify staged index trees and outgoing push ranges and explicitly label themselves **advisory hook observations**. They are existing publication evidence, not coordinator candidate/final verification certificates. No coordinator final-suite pass is claimed.

For this comparison, executed focused Node source probes against all four exported pins. A TypeScript loader loaded each pin's actual modules, injected fake GitHub command results, and used disposable runtime directories for owner-control transitions. The probes covered the prefix backlink, permanent missing issue, legacy retry, and successive drops described above. The temporary runtimes were removed. No live issue was created, no product file was changed, and no broad product suite was rerun. The expected failures were reproduced despite the recorded passing hooks.

### Recommendation

Select `e1a33b92f3ff4f2b33752f3c2d54ab1b5249e9f5` as the implementation base, retaining the normal subsequent review, revision, and coordinator verification gates. The findings identify concrete peer behavior that should be corrected if another pin is selected.
