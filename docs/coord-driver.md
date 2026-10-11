# Four Horsemen operator guide (`coord`)

## Authority and safety model

`coord` is an owner-local control-plane process. Owner commands take effect
directly and are journaled; there are no signed drop/override artifacts. After
finalization the driver opens a pull request. Default `prPolicy` is
`coord-open-unmerged` (draft PR; owner merges). `coord-merged` opens a ready PR
and merges it. Legacy `owner-only` is the same as `coord-open-unmerged`.

The coordinator never authors, stages, stashes, or pushes agent work. It may
mutate configured agent clones only for lifecycle readiness: issue/base branch
checkout, discard-only reset/clean, and the managed `AGENTS.md` protocol
overlay/skip-worktree bit. Agents publish work to their own
`issue-<n>/<agent>` origin branches; the coordinator fetches those branches
into an owner-side bare mirror and evaluates blobs at the exact submission SHA.

## Runtime topology

`--coord-runtime` must resolve outside every configured clone. Existing symlinks
within derived runtime paths are rejected.

```text
<workspace-root>/
  mirror.git/
  issue-<n>/
    github-issue.json immutable start-time GitHub title/body snapshot
    start.json       immutable session/config baseline, incl. completesRoot
    cursors.json     workflow pointers (not the Cursor agent): step, roster, pins,
                     acceptedResponses, ballotBatches, evidence tip
    agent-lifecycle.json  coordinator-owned CLI delivery/activity observations
    journal.jsonl    append-only owner/effect audit
    accepted-responses/  coordinator-owned archive of accepted ballot bytes
    agents/<agent>/
      action.md      restricted public order
      render.log     optional human log
      responses/     agent-writable private ballot JSON (one file per actionId)

<parent-of-coord-runtime>/completes/<coord-runtime-name>[/<project>]/
  issue-<n>/<agent>/
    complete         exact pushed SHA or `response <actionId>` marker
```

Agents write at most two runtime paths: the completion marker in the mailbox,
and (for ballot actions) a private response under `agents/<agent>/responses/`.
Neither grant reaches `cursors.json`, `journal.jsonl`, peers, or the
accepted-response archive. Codex ran `--sandbox danger-full-access` purely
because `complete` used to sit under the runtime directory; it now runs
`workspace-write` plus narrow `--add-dir` grants on its own drop and response
directory.

The mailbox grant is exactly `<completesRoot>/issue-<n>/<agent>` — never the
whole mailbox. The response grant is exactly
`<coordRoot>/issue-<n>/agents/<agent>/responses` when that directory exists.
The generated `start-<agent>.sh` resolves both at launch from
`coord.completesRoot`, `coord.workspaceConfig`, and `COORD_ISSUE`.

The identity segments separate products that share one outer runtime directory:
without them, two workspaces would resolve `issue-42/claude/complete` to the same
file. The runtime directory's name is always present; a nested workspace adds
its project, because the project alone is not unique across runtime directories.

`completesRoot` defaults to that derived path, may be set with
`--completes-root` on `coord install` / `coord onboard`, and is claimed at the
mailbox root so a second workspace cannot silently share it; the resolved absolute value is frozen into `start.json` at
`coord start`, and every later command for that issue reads it from there rather
than from a config that a reinstall may have moved.

For a fresh single-product onboard, `<workspace-root>` is the outer runtime directory
and `config.json` is flat beside these paths. Additional products sharing that
outer root use `workspaces/<project>/` as their workspace root. They therefore
receive distinct mirrors, issue-number namespaces, and tmux session names.
Existing nested installs and their compatible legacy outer runtime state remain
resolvable; ambiguous duplicate state fails closed.

`action.md` exposes only an opaque action UUID, the caller identity, required
path, concrete task, exact bound input commits, and absolute completion path —
the last being an absolute path under `completesRoot`, carried in the action
body rather than the restricted front matter.
Internal step/gate/evidence identifiers remain in `cursors.json`.

## Configuration

Start from `config.example.json`:

- `origin`: canonical Git origin used by the bare mirror
- `agents[]`: stable id, clone root, executable launcher, delivery policy, and
  optional foreground harness process
- `branch`: must contain `{issue}` and `{agent}`
- `profile`: persisted default (`solo`, `reviewed`, or `consensus`) used by
  product-resolved start and `coord N`
- `maxRevisionRounds`: fixed at 3 or less; no round 4 is possible
- `prPolicy`: `coord-open-unmerged` (default; draft PR, owner merges),
  `coord-merged` (coord merges), or legacy `owner-only` (same as open-unmerged)
- `digestPaths`: optional additional config-relative, confined source
  templates; the list may be empty
- `contextPaths`: optional confined product-relative files an agent should read
  first to orient — a repo map, an architecture note. Coordination names them
  in a `## Repo context` section of every `action.md`; it never inlines their
  contents, because the measured cost is what enters an agent's context, and
  naming a short list is what replaces a repository-wide search rather than
  adding to it. They are advisory documentation and are deliberately **not**
  digest material: an owner must be able to correct a stale context note
  mid-run without invalidating every published artifact.
- `checks[]`: explicit argv arrays executed in a clean worktree at the final
  pin; no shell is invoked
- `pollIntervalMs`: bounded completion-file polling interval

Any `{worktree}` token in one check argument is replaced with the verification
worktree path. Expansion never creates shell text.

### Coordinator-owned verification

With `verification.mode` `"coordinator"` frozen in `start.json`, coord gates every
implementation and revision product pin before acceptance. It selects candidate
checks from the frozen baseline through the pin and runs them in a worktree
materialized from the mirror. A failure rejects the submission: the agent
receives a reissued action naming the command, exit code and log
(`<issue-root>/verification-logs/`). A coordinator launch error throws instead,
and the submission is re-evaluated on a later tick. Success records the results
on the accepted submission; comparison, ballot and revision actions list each
bound pin's results under `## Coordinator check results for the bound pins`, so
every reviewer reads one execution.

Finalization keeps the consensus-to-final pin check and the baseline
classification, then runs each declared final component. A component with a
trusted receipt for equivalent inputs is skipped (`verification-reused`); every
other component runs. With no receipts, the full declared gate runs.

Receipts live in `<coord-runtime>/verification/receipts/<key>.json`, outside every
clone. The key is a digest of the origin, the input identity (tree id, or a
digest of the tree without coordination evidence), the declared argv, the
frozen policy digest, platform, architecture, Node version, probe outputs,
declared environment digests and the declared dependency paths' digest. A
command, or a cache probe, that modifies tracked files fails the gate before
anything runs or is reused on the changed bytes. A receipt is written only
after an exit-0 run whose declared dependencies were unchanged afterwards, and
every read re-validates the schema and the key. Hook records, agent signals, failed, interrupted or dirty runs never become
receipts.

A per-key lock (`verification/running/`) makes a second runner for the same
key wait and then reuse the owner's receipt (`verification-joined`). An owner
that failed or died leaves no receipt, so the waiter runs the command itself.
A waiter stops after 30 minutes of a live owner holding the key: the submission
stays in verification (`retry`) and is re-evaluated on a later tick, so a hung
runner cannot stall this coordinator, and the key never has two live runners.
`expensive` commands take one of `maxConcurrentExpensive` slots
(`verification/slots/`). A lock is reclaimed only when its owner is proven gone
(same host, dead process); age alone never reclaims it. Verification runs
inside the tick, as finalization always has, with authority re-checked between
steps; while a suite runs, other agents' completions wait for the next tick.

## Advisory sections in `action.md`

Two body sections are rendered only when they have content, so a step with
neither is byte-identical to what it produced before they existed.

- `## Repo context` lists the configured `contextPaths`.
- `## Changed paths for the bound pins` lists, for each bound input that pins a
  product commit, the paths that commit changed against the issue baseline.
  Coordination resolves each pin once per tick, so N agents comparing the same
  pins cost N diffs rather than N×N. The list is capped per pin and marked when
  truncated.

Both are informational. `approvedPaths` remains the only authority over what an
implementation may change, and neither section is read back by any verifier.

Paths in both sections are JSON-encoded strings, one per line. Git permits
backticks and newlines in pathnames, and an advisory hint must never be able to
abort action preparation or forge a heading — so the encoding is total over
valid pathnames rather than rejecting the awkward ones.

Every new run always hashes the exact config bytes and a canonical snapshot of
GitHub issue N from `config.origin`; optional `digestPaths` are added after
those mandatory sources. Agent-authored plans are later protocol evidence, not
owner-provided start input.

## Owner-driven manual lifecycle

`coord manual` is a launch/attach lifecycle, not a workflow profile. From an
onboarded product it resolves the registered config; explicit callers may use
`--product` or `--config <path> --coord-runtime <path>`. It validates all
configured launchers, creates or repairs the workspace's
`coord-manual-<group>` tmux session, reuses live agent panes, respawns dead
panes, creates missing agent windows, opens only missing macOS Terminal clients
titled `coord-manual-<group>/<agent>`, prints the outcome, and returns. On other
platforms it prints tmux attach commands.

There is no coordinator process after launch. Manual mode does not fetch or
snapshot a GitHub issue, initialize the mirror, create `issue-*` runtime state,
write `start.json`, cursors, journals, lifecycle state, `action.md`, or
`complete`, nudge agents, run checks/consensus/finalization, publish a branch,
or open a PR. Owner chat is the task authority and agents work on their own
`<agent>/<name>` scratch branches without fabricating protocol evidence. Git
hooks and all identity, verification, no-main, no-peer, commit-prefix, and
no-force rules remain enabled.

Manual startup refuses while this workspace has a live numeric issue session;
numeric start/resume/run/attach refuses while the exact manual session is live.
This prevents both modes from racing on the same clones. `coord detach manual`
closes exact grouped Terminal titles before killing the exact primary and
linked manual tmux sessions, without touching configuration, clones, runtime,
branches, or another product. Re-run `coord manual` to recover missing/dead UI.
Uninstall performs the same workspace-scoped cleanup even when there are no
`issue-*` directories.

## Starting and running

Confirm the installed driver with `coord --version` (or `-V`). Pre-1.0 releases
use `0.0.N`, and the patch advances on every merge so a merge is visible after
reinstall/refresh. **Nobody bumps it by hand.** The `version-bump-on-merge`
GitHub Action runs on each push to `main`, advances `package.json`, and atomically
pushes a `chore: release 0.0.N` commit and its `v0.0.N` tag back to the repository.
The same run publishes a GitHub Release for that exact tag with generated notes,
so `coord --version` maps to a release page and source archive; npm publishing
and binary assets remain out of scope. Runs are serialized with up to 100 pending
runs queued rather than replaced. Queue overflow cancels additional runs, and
dispatch order is not guaranteed. No branch reserves a version in advance;
because each run fetches main, nearby merges can share a release snapshot. The
first release's generated notes can cover the earlier history.

If only release creation fails after the atomic push, the tag and version commit
are already published. Do **not** rerun the job: it would bump again. Confirm the
release is missing, then run this from an authenticated repository checkout,
replacing `<version>` with the version reported by the successful bump step:

```sh
gh release create "v<version>" --verify-tag --title "v<version>" --generate-notes
```

Nothing on a branch requires or checks a version advance — not `pnpm check:fast`,
not `pnpm check`, not any PR workflow — so an issue branch stays at `main`'s
version for as long as the work takes, and a plan that lists `package.json` for a
bump is listing a file the protocol will never need to change.

After `coord onboard`, the daily command is:

```sh
cd /path/to/onboarded/product
coord 42
```

The positive-number command resolves only the current registered worktree (or
an explicit `--product`), starts issue 42 if no compatible runtime exists, and
then enters the normal run loop. Repeating it resumes durable state without
refetching or rebinding an edited issue. From an unrelated worktree, pass
`--product /path/to/onboarded/product`; coordination never guesses from a
machine-global registry.

`--product` takes a filesystem path, not a project nickname. Relative paths are
resolved from the directory where you invoke `coord`; for example, from a parent
directory use `--product ./my-product` or an absolute path to that onboarded
worktree. A typo reports **working directory does not exist**, while a regular
file reports **working directory is not a directory**. Directory symlinks remain
supported. An existing non-repository directory still reports **not a Git
worktree**, and a repository without a valid owner locator still requires
onboarding. Correcting a path does not bypass those checks.

If the directory is valid but Git cannot be launched, the error retains the OS
failure and may suggest checking PATH; use `command -v git` in the invoking shell.
An inaccessible-directory error instead calls for checking that path's access
permissions. Invalid product selection stops before `wipe-issue` effects, even
with `--force`. These errors alone do not establish earlier repository damage:
check the resolved path and preceding commands rather than running `git init`,
resetting, or re-cloning a repository as a diagnostic repair.

The explicit forms remain available:

```bash
nvm use 26
pnpm install --frozen-lockfile
pnpm check
pnpm build

coord start 42 --product /path/to/onboarded/product

coord start 42 \
  --config /absolute/owner/runtime/config.json \
  --coord-runtime /absolute/owner/runtime

COORD_ISSUE=42 coord run --coord-runtime /absolute/owner/runtime
```

`start` derives the repository from `config.origin`, runs an argv-safe `gh issue
view N --repo owner/repo`, validates the response, and canonicalizes the title
and body. Missing or unreadable issues fail before runtime, mirror, or tmux
effects with create/auth remediation. It then preflights the exact origin
baseline, the running coordinator checkout's real `HEAD` as its trusted source
commit, digest inputs, confined non-symlink executable launchers, mirror, and tmux. It
creates an attachable `coord-<issue>` session and invokes each configured
`start-<agent>.sh` before committing active issue state. A failed partial tmux
launch or later startup write is cleaned up, including the issue snapshot, and
no apparently active issue runtime is left behind.
Once state is committed, a failure in the initial tick is reported without
deleting the resumable runtime or terminating the successfully launched panes.

The coordinator can itself run in a tmux control window so closing the owner
terminal does not stop it. Flat workspaces retain the legacy name; nested
workspaces append the workspace hash printed by tmux/start diagnostics:

```bash
tmux attach -t coord-42
```

On macOS, `coord start` / `coord N` also opens one Terminal.app window per
agent, each attached to that agent's tmux window (separate clients — no Ctrl-b n).
A resume of `coord N` recreates missing tmux sessions and dead agent panes, and
opens Terminal windows that are not already open. Windows are titled on the **tab**
as `coord-N-<group>/<agent>`, where `<group>`
is a stable 10-hex fingerprint of the workspace root. Attach uses `do script`
and sets that tab's custom title only. Detach/wipe close **only tabs whose
title exactly matches those ids** — never bare agent names and never
ungrouped `coord-N/<agent>`. Re-open those views
later with `coord attach N` while the coordinator is already running. `coord detach N` closes matching Terminal windows
(by unique title / window name) then kills the issue tmux sessions, without
wiping runtime, clones, or branches. When `coord N` / `coord run` finishes with
a completed workflow, it runs the same UI teardown automatically and then makes
each participating clone base-ready. A missing/non-worktree clone is skipped. A
dirty clone is eligible for `git reset --hard HEAD` plus `git clean -fd` only
when `HEAD` is exactly that agent's configured `issue-N/<agent>` branch for the
completed issue; dirt on any other branch is left unchanged and logged with a
manual-stash/forced-wipe remediation. Eligible and already-clean clones fetch
origin, check out the configured base at `origin/<base>`, and restore the
managed protocol overlay and skip-worktree bit. If origin is temporarily
unavailable, cleanup uses and identifies the existing local base instead. When
a fresh fetch shows that local base contains commits absent from origin, cleanup
resets the clone's local base to `origin/<base>` (agent clones must not keep
unpushed owner-only history). If any clone cannot be made base-ready, `coord N`
/ `coord run` exit non-zero, print per-clone reasons, append a
`clone-readiness-refused` journal event, and tell the owner to run
`coord reset-clones N` — not raw `git checkout`. The summary distinguishes
discarded, checked-out, refused, and skipped clones, and the coordinator never
creates a cleanup commit or pushes from this path.
`coord reset-clones N` exposes the same base-ready cleanup without deleting
`coord-runtime/issue-N` (analytics stay). `--force` matches wipe's discard
override for unrelated dirt.
`coord uninstall` tears down owner tmux/Terminal for discovered issues and the
exact workspace-grouped manual identity. It never closes bare agent-named tabs
or another product's sessions.

`coord wipe-issue N` is the owner reset for reusing a GitHub issue number: it
checks out each agent clone on the base branch, deletes origin `issue-N/<agent>`
and `*-final` branches, and drops leftover `refs/remotes/origin/issue-N/*`
tracking refs in clones, the product worktree, and `coord-runtime/mirror.git`.
`issue-N/coordinator-evidence` is retained by default (ballot audit trail); pass
`--delete-evidence` to remove it. A local `issue-N/*` branch in the product is
kept when it has uncommitted work or commits that are not just a checkout of the
clone (arbitrary owner branches are not treated as coordinator-owned). Removes
`coord-runtime/issue-N`, and runs the same UI teardown as `detach`. It does
**not** close the GitHub issue or uninstall the product. Without `--force`,
leftover dirt is discarded only when every dirty clone is on its exact branch
for the issue being wiped; ambiguous dirt refuses before any clone is changed.
`--force` remains the explicit override for other clone dirt. Clone-local
skip-worktree on `AGENTS.md` is lifted around reset/clean/base checkout and the
protocol overlay plus bit are restored afterward.

On `coord N` start (and resume), clones already on their exact `issue-N/<agent>`
branch keep local commits, staged/unstaged edits and untracked work. No checkout,
stash, reset or clean runs in that path; a healthy protocol overlay is left
alone, and a missing overlay/bit is repaired without discarding human text.
For clones that need a branch switch, coordination first refuses dirty work in
the entire batch before modifying any clone, then lifts the skip-worktree bit,
checks out the issue baseline (or existing issue branch without resetting it),
and restores the protocol overlay. Agents do not switch branches under
skip-worktree `AGENTS.md`. Completion/wipe cleanup policies are unchanged.

Nudge delivery uses literal `send-keys -l` (not paste-buffer — some TUIs such
as Antigravity ignore paste). Every onboarded agent defaults to `delivery: both`.
Per-agent config controls owner UI:

- `nudgePrelude` — tmux keys before the text (Codex default: `i` for vim insert,
  skipped when Codex's footer already shows `Vim: Insert`)
- `nudgeSubmit` — tmux keys after the text (Claude default: `Escape` then
  `Enter` to leave vim INSERT and dismiss autocomplete; Cursor without vim and
  Antigravity default:
  `Enter` only — Escape dismisses a non-vim Cursor composer and cancels
  Antigravity; Cursor with `editor.vimMode` uses `Escape` then `Enter` so
  INSERT does not treat Enter as a newline; Codex default: `Enter`.
  Old Codex `["C-j", "C-m"]` and `["C-m"]` settings resolve to Enter.
  Stale single `Enter`/`C-m` on Claude, mistaken Escape+Enter on non-vim
  Cursor/Antigravity, and stale `C-m` on Antigravity, are upgraded)

Codex, Claude and Cursor receive one tmux command batch containing literal
text followed by real submit-key events. Blocking `run-shell 'sleep …'` commands
inside the batch wait 300 ms after text and 150 ms between submit keys. The text
gap keeps Enter out of paste detection; the Escape/Enter gap prevents Alt+Enter
in vim mode. These commands must not use `-b`, which would let the following key
run before the sleep finishes. The coordinator does not poll for the
pasted prompt or send fallback submit keys. A matching `UserPromptSubmit` or
`beforeSubmitPrompt` hook is sufficient acceptance evidence; delayed hooks also
clear the corresponding delivery-uncertain hold without resetting the send
budget or clearing other holds/manual pause. A tmux write alone is injection,
not acceptance. AGY keeps its working delivery without a new hook requirement.
The Codex launcher passes `--no-daemon`: the shared app-server would otherwise run
hooks with the `COORD_ISSUE` of whichever launch started it, not this pane's.
Existing clones keep their old `start-codex.sh` until `coord install` rewrites it.
- `terminalProfile` — macOS Terminal.app settings-set name so each agent window
  can use a different look (defaults: Claude 1 / Codex 1 / Cursor 1 / Gemini 1)

A current vendor Stop allows the next prompt even while background work remains;
no idle text, Working indicator or empty-composer confirmation is required.
Without Stop, nudge uses pane readiness. Before the batch, the driver re-reads
`pane_dead`, `pane_current_command`, `pane_in_mode`, and `pane_input_off`; dead,
copy-mode, input-off, and non-harness panes still refuse delivery. Trust dialogs,
usage waits and account-verification overlays still block. AGY retains its 2.5s
pre-delivery recapture, text/submit delays and per-key gates.
If the first delivery is skipped, the action remains ordered. It is eligible
again only after a positive lifecycle observation says the CLI became idle or
the CLI session was replaced. After a successful send, the coordinator records
only `injected`. Native CLI hooks separately establish `accepted`, `queued`,
`working`, `idle`, or `failed`. Missing lifecycle events are normal during a
long turn: their age does not degrade health, warn the owner, pause the issue or
authorize another send. One nudge is allowed per new eligible idle transition.

There is one narrowly scoped recovery for a successful tmux write whose
keystrokes never reached the CLI: no hook may have correlated a turn, pending
input and background work must be absent, and a fresh pane capture must show a
vendor-ready prompt that does not contain the exact action UUID. Only that
positive proof returns the action to `ordered`; elapsed time or a missing
`complete` file alone never authorizes a duplicate.

Cursor panes that report as `node` are treated as ready when
`harnessProcess` is `agent`. Cursor's composer placeholder text is not a
stable idle hint. Cursor submit is Enter when vim is off (Escape dismisses
that composer) and Escape then Enter when `editor.vimMode` is on or
`nudgePrelude` is a non-empty override. Prelude `a` is sent only in that
vim case, and only if the pane is not already INSERT (home
`~/.cursor/cli-config.json`, then clone `.cursor/cli.json`). Typed nudge text
includes both the opaque `actionId` and the SHA-256 digest of the exact
`action.md`. A delayed hook for an older rewrite therefore cannot accept the
current action accidentally.
Phase changes (R1.join → R2.plan, and later RN steps) always print.
Use `coord N -v` for tick-level nudge and roster logs.

### Agent-facing language boundary

Internal step ids (`R1.join`), gate ids (`gate-1-join`), evidence ids
(`join-published`), and delivery vocabulary stay in cursors state, the journal,
analytics, CLI output, and this document. They are the operator's and the
owner's view of the workflow, and nothing here needs sanitizing.

Three surfaces do reach an agent and must stay free of that vocabulary: the
rendered `action.md` body, the typed injection text, and the protocol overlay
installed into a clone. `src/agentLanguage.ts` holds the single banned-term list
plus `agentFacingSubject`, which names the artifact behind an evidence id so a
pin-lineage rejection can be reported without the id itself — those diagnostics
are re-rendered to the agent under `Correct these outstanding items:`.
`test/agentLanguage.test.ts` scans every entry in `STEP_DEFINITIONS`, with and
without bound inputs and with a non-empty correction block, so a new step cannot
be added without being covered.

The checker is a test-time invariant, not a runtime guard: `outstanding` strings
carry git output and branch names from outside the process, so a false positive
must fail a test rather than abort a run loop. Do not "fix" the operator
documentation or analytics tables to satisfy it; they are deliberately out of
scope.

### CLI lifecycle state

The model never writes `waiting.json`, `working.json`, or equivalent state.
The vendor CLI produces deterministic hook/status payloads, `coord agent-event`
validates them, and the coordinator persists only normalized fields. Delivery
(`ordered`, `injected`, `accepted`), execution (`unknown`, `queued`, `working`,
`idle`, `failed`), and observability health (`unknown`, `healthy`, `degraded`)
are separate axes. They are stored outside `cursors.json` so a hook arriving
during Git/tmux work cannot invalidate the workflow authority revision.

Correlation uses the configured clone identity, issue, action UUID and digest,
plus the vendor session/conversation and turn/generation identifiers. A new
session invalidates observations from the replaced process. Antigravity queue
depth, pending tool confirmations and `fullyIdle: false`, and Claude background
tasks/session crons, keep an agent non-idle even after a stop callback. `coord
status` prints all three axes and any pending/background indicators.

While an implementation or revision action remains in flight, each poll
re-resolves the approved file map from the pinned plan evidence and rewrites
`action.md` with the same action UUID. If an extractor upgrade changes those
paths, the changed action digest invalidates stale hook correlation and the
coordinator still applies the lifecycle idle gate before injecting it.

## Agent completion contract

An agent may push any number of intermediate commits. Only `complete` expresses
intent:

```text
0123456789abcdef0123456789abcdef01234567
```

The exact alternative form `commit 0123456789abcdef0123456789abcdef01234567`
is also valid. Uppercase, padding, BOMs, abbreviated SHAs, JSON, prose, and
multiple lines are rejected.

The driver refreshes only the expected origin branch, proves the SHA is
reachable there, and checks the required path/schema/pins against that exact
commit. A failed mechanical check clears `complete` and reissues the same
action with concrete outstanding items. Attempts are diagnostic only and never
drop an agent or advance a gate.

A transient mirror fetch error preserves `complete`, emits no missing-artifact
verdict, and retries with the normal polling cadence. An absent agent is waited
for indefinitely unless the owner explicitly drops it.

Pull-capable agents can fetch their current action without seeing internal step,
gate, evidence, or global cursor state. From an agent clone after onboard:

```sh
coord next --issue 42
```

`coord.workspaceConfig` and `consensus.agentId` supply the runtime and caller.
Explicit forms remain available:

```sh
COORD_AGENT=codex coord next --issue 42 --coord-runtime /path/to/runtime
```

## Profiles

- `solo`: one configured agent; plan, implementation, and finalization use solo
  checks.
- `reviewed`: all configured reviewers participate in plan selection, one
  designated implementer continues with solo final checks.
- `consensus`: every active agent joins, plans, reviews, implements, compares,
  and ballots; one reviser prepares up to three rounds.

Plan and implementation choices are tallied from the exact accepted active
ballot set after the coordinator publishes that gate's evidence batch. Agents
submit private responses; the coordinator archives them, builds one
fast-forward commit on `issue-<n>/coordinator-evidence`, and only then derives
selection or advances. The highest vote count wins; ties use persisted
active-roster order. Selected plans, the implementation owner/pin, and the
authorized reviser are stored separately. Round 1 binds only the selected implementation, and later rounds bind only the preceding accepted revision.
When round 3 ballots conclude, unanimous approval proceeds directly to finalization.
If any active agent objects (`revise` or `escalate`) in the sealed round 3 batch, development
concludes at the third revision: objecting agents are assigned a conditional follow-up task
(`R6.follow-up`) to file and link a GitHub issue citing their unresolved objections, the concluding
issue, the final revision commit SHA, and a stable filing key. Once all objecting receipts are verified,
the coordinator orders the reviser to finalize the third revision commit. There is no fourth revision
and no owner retry loop.

When drops leave one active agent, future unresolved work degrades to the solo
sequence. Completed historical gates and immutable product pins are retained.

## Additive file-map amendments

Implementation and revision actions include an alternative
`plan-amendment-request` JSON scaffold at their existing required signal path.
Use it only for files necessary to the original issue, not feature expansion.
The request binds the current action UUID, input hash, and scope hash, includes
a nonblank `explanation` of the omission, and lists at most 100 unique, exact
repository-relative product paths with nonblank per-file `reason` values.
Ballot judgments retain their separate `rationale` field.
Directory-prefix forms, patterns, traversal, Git metadata, coordination paths,
and files already covered by the effective map are refused. Commit only the
request artifact (leave unfinished product edits unstaged), push, and submit
that commit SHA. It needs no product pin and grants no permission by itself.

The coordinator serializes requests in active-roster order, preserving accepted
product pins and local work. It retires the old orders and opens a private
amendment ballot for **every active agent**, including reviewed profiles and
explicit solo approval. `approve` means the additions are necessary;
`revise` rejects the proposal, not the code. No tally, plurality, timeout, or
owner override can approve a missing vote. Only unanimous approval followed by
successful publication of the canonical ballot batch expands the effective map.

The selected plan remains immutable. Approved exact additions form a durable
overlay bound to that selected plan set; amendment sequence numbers are separate
from revision rounds. Fresh work actions carry the resulting `scopeHash`, which
subsequent readiness signals must echo once any amendment applies. Scope
documents are separately exported: revision `basedOn` still contains only its
single authorized product parent. Rejected requests resume unchanged scope
with the reasons. A new request gets a new sequence and new action UUIDs.

Pending proposals, accepted private responses, and published decisions survive
restart. Failed evidence pushes retry the same frozen SHA; scope never changes
before publication. Pause, holds, and concurrent owner controls retain their
normal authority. Dropping an agent cancels a pending proposal and retires its
orders; existing selection recovery then runs with the reduced roster. Prior
approved overlays apply only while the exact selected plan set is unchanged.
No-amendment format-4 issues load with empty history and keep their ordinary
workflow; no new owner command is required.

## Owner controls

Issue controls accept either an explicit workspace `--coord-runtime` or an
onboarded repository `--product` (the flag spelling is unchanged). Without either,
controls infer the workspace from the current owner or registered agent worktree,
including subdirectories. A crossed/invalid locator is an error, not a fallback.
Resolution preserves flat/nested and legacy ambiguity checks and the issue's
frozen completion mailbox. From unrelated folders, supply the explicit runtime
root. `COORD_ISSUE` may replace `--issue`.

`coord COMMAND --help` and `coord help COMMAND` explain commands without requiring
a repository or changing state. Reports use “repository” in prose; old flag names
such as `--product` and `--write-product` remain compatible.

```bash
coord drop cursor --product /path/to/app --issue 42
coord pause --product /path/to/app --issue 42
coord resume --product /path/to/app --issue 42
coord restart-action --agent codex --product /path/to/app --issue 42
coord answer <question-id> <retry|revise|abandon> --product /path/to/app --issue 42
coord abandon --product /path/to/app --issue 42
```

`drop` refuses the final agent, clears only the dropped agent's local action and
completion, retains other agents' valid accepted evidence and pending intent,
and rederives only unresolved affected actions so their input sets omit that
agent. Later stale completions from the dropped agent are ignored.
An already-authorized reviser cannot be dropped because revision and
finalization may not be silently rebound without a new authorization.

`pause` retains actions, mirror data, journal, tmux sessions, and the foreground
coordinator: manual pauses and safety holds are waiting states, not exits.
While held, no workflow preparation, delivery, acceptance or publication runs;
only already-authorized resource observations remain possible, and manual pause
stops those too. Recovery reports print on meaningful changes, not every poll.
Plain `resume` clears only the manual pause; active safety holds still prevent
advancement. `resume --agent NAME` releases exactly one hold for that active
agent, preserving every other hold and manual pause; an ambiguous selector
fails and lists IDs for `--hold ID` instead. Nudge-loop release still requires
`--reset-nudge-budget`, which is invalid for other hold kinds.

The waiting coordinator observes owner recovery from another shell and continues
without another command. `resume --run` additionally starts a foreground runner
from the existing issue state, with the same manual-session exclusion and
completed-issue cleanup as `run`. Use it only if the coordinator was stopped;
without `--run`, resume remains state-only and safe beside a live coordinator.
There is no concurrent-runner detection. Remaining holds or manual pause still
keep the new runner waiting. Ctrl-C stops the foreground process without clearing
state or stopping the agent harnesses; before switching to manual mode, stop the
runner and use `coord detach N` to close the issue UI.

After recovery, the runner continues from strict versioned state. State changes use a short
exclusive lock plus a monotonic revision, so an in-flight fetch or check cannot
overwrite a concurrent pause, drop, or abandon. `restart-action` reissues pending work without changing a gate. On restart, any persisted
round-3 revision-limit or escalation question with complete terminal evidence is cleared under
the state lock to derive the terminal decision directly. `answer` consumes one typed pending
question, is idempotent for the same answer, and cannot create round 4.
`abandon` stops the workflow while retaining its audit state.

### Foreground interactive controls

`coord N`, `coord run`, and `coord resume --run` enable a lightweight prompt only
when **both** input and output are TTYs. Redirected/non-TTY runs remain log-only:
no raw mode, key reader, or prompt. Existing owner CLI commands remain usable
from another shell; the prompt uses their same locked state mutations and does
not start a second tick loop. Logs clear and redraw the current edit.

| Key | Operation |
| --- | --- |
| `s` | Snapshot of active step/round, roster, commits, publication/PR, holds and queued guidance count |
| `p` / Space | Toggle manual pause, never release holds |
| `a` | Reopen missing agent Terminal clients using the existing attach flow |
| `d` | Numbered active-agent menu; Enter selects, a separate `y` confirms |
| `n` | Request a safe reminder for one agent's current task, without restarting it |
| `r` | Release a selected hold after inspection; a reminder-limit reset asks a separate `y/N` question |
| `?` / `h` | Help |
| Return | Newline and prompt redraw in hotkey mode; no state change |
| `/` | Begin a `/steer <text>` line; Enter queues, Backspace edits, Esc cancels |
| `q` | Quit outside an edit, stopping only the foreground runner |

Owner questions appear as numbered menus with only `allowedAnswers`. Select a
number and press Enter; abandon also requires `y`. The captured question ID is
validated under the same lock as external `coord answer`, so stale selections
cannot answer a replacement question. Esc returns to hotkeys; `s` redisplays a
pending question. Menus likewise capture agent/hold identities and revalidate
them when applied. For a reminder-limit hold, confirming `r` permits four more
sends for that action, exactly like `coord resume --hold ID --reset-nudge-budget`;
it cannot reset a provider's quota. No control silently releases
other holds or manual pause. Unknown printable input is quoted with help;
multi-character plain pastes are inert. Pasted text does not execute hotkeys or confirmations; to paste
guidance, press `/` first. In an edit, `q` is ordinary text.

`n` queues one request in the live runner, bound to the selected task, digest and
session; “requested” does not mean “sent”. An arriving completion is checked
first. Changed activity, assignments, pause/holds, missing files or unavailable
terminal delivery reject the request rather than retargeting it. An explicit
request can overcome a stale working report only with current positive terminal
idle proof; foreground/composer, queued/background work and per-key checks still
veto it. Spacing, four-send limits and uncertain-send reservations still apply.
No action/response file is cleared, task restarted, or send allowance reset by
`n`. Inspect/type directly in the agent terminal when safe proof is unavailable.

There is no force-complete/next-stage key: a drafted plan or idle terminal is not
validated evidence. An **action** is the assigned task in `action.md`; a **turn**
is one agent prompt/response cycle; a **pin** is an exact commit. Use `n` to remind,
`r` to recover a diagnosed hold, or the explicit destructive `restart-action`
command when a replacement assignment is really needed.

`/steer` queues a nonblank single line (maximum 2,000 characters; 32 pending
entries) in `cursors.json` and journals it. At the first actual order preparation
for the next cohort, all pending entries bind atomically to that step, round and
cohort generation. Every recipient, reissue and restart of that cohort sees the
same snapshot, even when more advice is queued between agents. Advice entered
after the snapshot waits for the following cohort; a same-round owner retry is
a new cohort. Skipped/normalized steps do not consume the queue. Amendment
ballots have their own snapshot and preserve the interrupted product cohort's
advice for resumed work. Existing pre-feature in-flight work is not retrofitted.
Git and response actions render this as advisory **Owner guidance**; it cannot
expand the file map, alter pins or paths, or override checks or evidence rules.
There is no external `coord steer` command or in-flight prompt injection.

Quit, Ctrl-C, EOF and termination restore terminal settings and stop waiting;
an already-running workflow effect may finish before the runner exits. They do
not call `detach`, kill tmux, close agent clients, or wipe state, even if that
last tick completes the issue. Normal un-interrupted completion retains its
existing cleanup behavior. Direct typing into agent panes is unchanged.

### Reading progress and startup diagnostics

Each complete status snapshot is enclosed by `----` lines. `[WAIT]` means ordinary
ongoing work, `[OK]` a confirmed result, `[WARN]` uncertainty to inspect, and
`[ACTION]` owner intervention. Task message sent/acknowledged is separate from
submission received/validated. Check preparation, waiting, execution and outcomes
are announced; reused checks are labelled, not claimed as rerun. Branch pushes
and PR operations announce their work too. Ballot contents stay private.

Recovery commands include the actual shell-quoted `--coord-runtime`, so they also
work from another folder. A provider recheck time is not a promise of availability;
an unknown provider failure is not evidence of exhausted quota.

Startup/resume inspect installed hook definitions, clone identity, wiring and
issue branch read-only. Installed files and a matching tmux `COORD_ISSUE` do not
prove an already-running child trusts hooks or inherited that environment. Until
current-session activity and actual-tool containment observations exist, runtime
trust remains “not yet verified”: inspect the trust prompt/hook setup and use
`coord doctor`, repairing/restarting through coord rather than inventing receipts.
Repeated distinct turns without a matching Stop produce an advisory warning;
when turn IDs are absent, completed actions are counted separately and labelled
as actions. Matching current Stop/session replacement clears the episode; stale
callbacks do not. These warnings neither grant readiness nor create holds.

### Delivery safety and unknown holds

All vendors (including Antigravity) share a durable delivery budget for each
unfinished action: one initial send and at most three repeats (including owner reminders), spaced
at least 60, 120 and 240 seconds after the previous send. These are minimum delays,
not permission to send: lifecycle and terminal readiness must still allow it.
The 45-second wait before checking unknown/idle lost delivery is independent of
delivery spacing; it is not an agent-health timeout.
Reissue, coordinator restart, changing error text and fresh idle epochs do not
reset this budget. Partial/ambiguous sends consume a reservation and hold for
owner inspection; a refusal before any key is sent consumes nothing.

Deferral journals are transition-only: each `(agent, actionId, reason code)` is
recorded once, including across restarts. Repeating a reason does not grow the
journal or print another warning. Up to eight distinct unrecognized codes keep
their original diagnostics; one overflow record then signals suppression of
further unknown codes. Status remains available on demand.

An exhausted nudge budget, ambiguous delivery, missing/dead harness, active
Claude usage wait or explicit blocking resource evidence creates a durable whole-issue
hold. The coordinator preserves the roster, selected roles, pins, action files
and incoming completion/response bytes; it does not hand off or pretend work
completed. It does not stop an already-running vendor process. Claude wait UI
vetoes typing even when a prompt is visible, including immediately before keys;
the coordinator never disables Claude's native waiter.

Delivered, unfinished work is presumed to continue even without fresh lifecycle
events or changing terminal output. This does not synthesize acceptance or an
execution event. Quiet work creates no observation warning or hold; completion
continues through normal validation. No prompt is sent merely to test liveness.
Local pane checks run no more than once per minute per action/hold generation;
a dead pane observed at a delivery boundary still holds immediately. Probe cadence
is in memory (restart may probe again), without cursor revisions or writes.
Inspection/capture exceptions leave activity unknown and are retried on that
cadence. Existing tmux harness-loss classification and resource controls remain.

Old observation counters/deadlines remain readable but no longer cause holds.
An `unobservable` hold already persisted by an older coordinator is not released
automatically: inspect the agent and use the scoped owner recovery below once.
Other holds and a manual pause retain their existing semantics.

Use `coord status --issue N` to see the hold ID and recovery instruction. After
inspecting the agent and fixing the underlying problem, from another shell:

```sh
coord resume --issue N --agent claude
# If that agent has multiple holds, select exactly one:
coord resume --issue N --hold HOLD_ID
# A nudge-loop latch requires explicit authorization for a fresh send budget:
coord resume --issue N --agent claude --reset-nudge-budget
coord resume --issue N  # separately clear a manual pause, if present
# Only if the coordinator was stopped: release one hold and restart together.
coord resume --issue N --agent claude --run
```

Include `--product PATH` or `--coord-runtime PATH` as usual. Releasing one hold never
clears another hold or a manual pause, and is audited. Retired actions cannot be
released; `restart-action` and `drop` require resolving holds first. Owner release
acknowledges a hold, not the continuing condition: a fresh local observation of
the same dead pane or wait banner can re-hold immediately, even without new hooks.
Each acknowledged hold generation has a distinct crash-idempotent journal identity.

This intentionally replaces the earlier pushed-tip recovery on harness death:
even a valid submission at origin without a completion receipt does not bypass
a dead-harness hold. Inspect the published work and restore the harness/receipt
before releasing the hold; the coordinator does not synthesize completion.

**Claude native continuation alone does not resume the coordinator.** Even if
Claude resumes overnight and writes `complete`, the issue stays held until the
owner releases it. A new lifecycle callback or completion bytes alone are not
automatic hold-clearance authority.

Delivery-safety holds mean **unknown cause and unknown reset**, not confirmed
quota exhaustion; vendor evidence and narrowly scoped resource recovery are
described below and do not release other safety holds.

### Vendor quota evidence and resource holds

Holds carry vendor evidence when it is available. They report the failure
class (usage window, billing, throttling, context overflow, account,
cancellation, transport or unknown) separately from deadline confidence. A
reset time is shown only when the provider supplied an absolute epoch, and it
is the time of a recheck, not a promise that capacity will be back. Rendered
clock text such as "resets 3:45pm" is never parsed.

- **Claude.** `StopFailure` fields are kept as sanitized diagnostics
  (`error`, `error_details`, `last_assistant_message`). `coord install` adds a
  status-line tee to the clone's `.claude/settings.local.json`. The tee runs
  your effective status-line command on the original bytes and gives coord a
  bounded copy of `rate_limits.five_hour`/`seven_day`. It is installed only
  when precedence is provable. If managed settings or a launcher `--settings`
  outrank the clone, or the command shape is unsupported, telemetry is
  disabled and `coord doctor` says why. Uninstall restores the prior value
  while the tee is still coord's, and your later edits are preserved. A
  matching exhausted window gives an exact deadline. At that deadline plus 30
  seconds, coord re-evaluates the hold once without sending a prompt. It then
  leaves release to you, because a render is not a fresh capacity check.
  Model-family limits, stale telemetry and spend restrictions keep
  `reset unknown`. `autoContinueAtUsageLimit` and launcher arguments are never
  changed.
- **Codex.** Quota reads happen only with an explicit per-agent binding:
  `"codexQuota": { "codexHome": "/abs/path", "accountId": "..." }` on the
  `codex` agent. Each read is one `codex app-server --listen stdio://` helper
  that runs `account/read` and `account/rateLimits/read` and nothing else. It
  has a 10 s lifetime and a 256 KiB output cap, and it is always reaped.
  Reads are triggered only by the initial binding check, by a new hold for
  that agent, or by an exact deadline plus 30 seconds. Limits:
  - at most one helper runs per binding, across issues in this runtime directory;
  - starts are at least 5 minutes apart;
  - after a failed read there are two retries (at +5 then +10 minutes);
  - each action gets six starts in total, and neither restarts nor your
    acknowledgments replenish them.
  Automatic release is off unless the binding names the Codex CLI version you
  validated live: `"validatedVersion": "0.156.1"`. Even then, it needs a
  fresh read in which every bucket explicitly reports no restriction and every
  previously blocked window is back below its limit with the same duration.
  The helper must report that version and the bound home, and the account must
  be unchanged across the read. It removes only that resource hold. Without a
  validated version, quota reads only enrich the hold and you release it. A binding shared by two separately managed runtime directories
  cannot be serialized and is unsupported.
- **Cursor** errors stay unknown and `aborted` is a cancellation. **Antigravity**
  keeps the vendor-independent protections only.

Manual pause, other holds, the nudge budget, roster, reviews and pins are never
changed by resource recovery. Whenever evidence is missing, the report says
`owner release required`.

## Recovery and finalization

On restart, pending completion SHAs are reverified, current actions are reused,
and satisfied origin evidence prevents duplicate advancement. Runtime format
mismatches fail closed (formats 2 and 3 require `coord wipe-issue` and a fresh
start under format 4).

Finalization binds the accepted consensus/product pin to a separate cleanup
pin. From consensus to cleanup, only deletion of the current issue's
`.plans/**`, `.signals/**`, and `.code-reviews/**` files is allowed. The driver
then materializes a clean detached worktree at the cleanup pin and runs every
configured argv check. Any verifier or check failure blocks PR creation. After
accepted R7 the driver pushes `issue-<n>/<chosen-agent>-final` at the cleanup
pin and opens a PR. Ballot evidence stays on `issue-<n>/coordinator-evidence`;
the product PR head is the ballot-free `finalSha`. `coord-open-unmerged` (and
legacy `owner-only`) leaves that PR as a draft for the owner to merge.
`coord-merged` marks it ready and merges it. Publication failures never discard
accepted finalization. `coord status` and a completed `coord N` print the
chosen agent, final pin, published branch, evidence branch/tip, and PR URL.
