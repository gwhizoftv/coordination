<p align="center">
  <img src="docs/images/coord-banner.jpg" width="100%" alt="Four Horsemen: four coding agents collaborating around a shared software project">
</p>

# Four Horsemen

**Multi-agent CLI/LLM consensus engine and workflow driver for autonomous software development.**

Four Horsemen (`4horsemen`) run by using its `coord` command, short for coordinator.

![Claude Code](https://img.shields.io/badge/agent-Claude_Code-d97757) ![Codex](https://img.shields.io/badge/agent-Codex-10a37f) ![Cursor](https://img.shields.io/badge/agent-Cursor-555555) ![Antigravity](https://img.shields.io/badge/agent-Antigravity-4285f4) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Instead of trusting a single model with a change, give a team of coding agents
the same GitHub issue. Four Horsemen runs Claude Code, Codex, Cursor, and Antigravity
in separate Git clones, coordinates their plans, plan reviews, competitive implementations and peer code reviews, and verifies
the exact commits they submit before publishing a pull request. You choose the
agents, the project's checks, and when to intervene.

## How it works

<p align="center">
  <img src="docs/images/coord-workflow.jpg" width="100%" alt="Workflow overview: a GitHub issue enters independent planning, plan review and voting, implementation, peer code review and revision, then toolchain verification and pull request publication">
</p>

The artwork is an overview; the default **consensus** profile works as follows:

1. **Start with an issue.** `coord N` snapshots the issue's title and body from
   the product's GitHub origin and launches the configured agents.
2. **Plan independently.** Each agent proposes a plan, reviews its peers'
   plans, and votes on the design to implement.
3. **Implement and compare.** Every active agent implements the selected plan
   in its own clone. Peers review the implementations and ballot on a choice.
4. **Revise toward agreement.** One selected reviser addresses the feedback;
   peers ballot on the revision, for up to three rounds. Earlier escalations
   require an owner decision. The third revision concludes after its ballots
   are published: objecting agents file linked follow-up issues, then final
   checks and the configured pull request policy run on that exact revision.
5. **Verify the result.** Finalization removes current-issue coordination
   artifacts and runs every configured check on a clean detached worktree at
   the exact cleanup commit. A failed check blocks PR publication.
6. **Publish a pull request.** The default `coord-open-unmerged` policy opens
   an unmerged draft for owner review. The explicit `coord-merged` policy can
   mark it ready and merge it.

Use **solo** for one agent, **reviewed** for peer plan selection followed by one
implementer, or **consensus** for the full review loop. See
[workflow profiles](docs/coord-driver.md#profiles) for details.

## Why Four Horsemen

- **Review before and after coding.** In consensus mode, peers challenge both
  design plans and concrete implementations.
- **Independent perspectives.** Multiple coding agents propose and compare
  solutions instead of relying on a single model's self-review.
- **Keep your working tree yours.** Default onboarding leaves the product's
  tracked files untouched. Agents use sibling clones; runtime state stays
  outside them. Other developers need no coordination hooks or tooling.
- **Verify more than a completion claim.** Origin-backed commit evidence and
  your project's configured tests and linters gate progress and publication.
- **Stay in control.** Inspect status, pause or resume, reopen agent windows,
  queue steering guidance, and recover holds through the
  [owner controls](docs/coord-driver.md#owner-controls).

Separate clones keep agent work out of your checkout; they are not a universal
security sandbox. Peer agreement and passing checks still need your judgment.

## Requirements

- **Node 26, pnpm 11, and Git** to install and run the driver.
- **GitHub CLI (`gh`)**, authenticated for your product's issue and PR operations.
- **tmux** and the coding-agent harnesses you select, installed and authenticated.
- **Your product's tools**, such as Go, Cargo, or the declared Python test tools.

The driver uses Node/pnpm regardless of your product's language. Public
bootstrap needs no GitHub CLI authentication; product operations do.

## Quick start

Install once per machine, onboard once per product, then run an issue whenever
you have work to delegate. Your product must have a GitHub `origin` remote.

### 1. Install

```sh
curl -fsSL https://raw.githubusercontent.com/gwhizoftv/4horsemen/main/scripts/bootstrap.sh | sh
```

This installs under `~/.local/share/coordination` and links `~/.local/bin/coord`;
add `~/.local/bin` to your PATH if prompted. To inspect the script first or
install from a private fork, see [bootstrap options](docs/setup-workspace.md#bootstrap-once).

### 2. Onboard your repository

```sh
coord onboard /path/to/app
```

The default is all four agents and your own clone. Onboarding creates
the agent clones, proposes checks for the product, and runs `coord doctor`.
Install all four harnesses, or use this alternative for a one-agent start:

```sh
coord onboard /path/to/app --agents codex --profile solo
```

### 3. Run a GitHub issue

```sh
cd /path/to/app
gh issue create --title "Describe the work" --body "Acceptance criteria…"
coord 42
```

Replace `42` with the issue number just created, or use an existing issue and
skip `gh issue create`. No owner-authored plan file is needed. Keep the
coordinator running while the agents work; press `?` for interactive help.

For work assigned directly in agent chats without an issue, use
[`coord manual`](docs/coord-driver.md#owner-driven-manual-lifecycle).
[Explicit start/run commands](docs/coord-driver.md#starting-and-running) and
[hold recovery](docs/coord-driver.md#delivery-safety-and-unknown-holds) are in the
operator guide; stopping the coordinator does not stop its agent harnesses.

## Supported languages

| Product | Detection / setup |
| --- | --- |
| Go | `go.mod`: automatically proposes Go checks |
| Rust | `Cargo.toml`: automatically proposes Cargo checks |
| Node | `package.json`: pnpm, yarn, or npm selected by lockfile; uses existing scripts |
| Make | Recognized `Makefile` targets supply checks |
| Python | Explicit commands via `coord install --declare`; no auto-detection yet |

Review the proposed policy: a language marker alone does not guarantee usable
checks, and installation refuses missing finalization checks. Other languages
work through explicit command declarations. See
[product languages and declarations](docs/setup-workspace.md#product-languages)
for detection precedence, tool requirements, and a complete Python example.

## Platforms

On macOS, the owner UI opens Terminal.app windows for the agents. Other
platforms use tmux without that integration; native Windows is not promised.

## Documentation

| Guide | What you'll find |
| --- | --- |
| [Operator & driver guide](docs/coord-driver.md) | Profiles, owner controls, holds, recovery, tmux, and runtime topology |
| [Workspace setup](docs/setup-workspace.md) | Install options, verification policies, and multi-product setups |
| [Readiness policy](docs/readiness-policy.md) | Agent delivery readiness, lifecycle hooks, and completion evidence |
| [Analytics](docs/analytics.md) | Workflow timing, token measurements, and their limitations |
| [Repository map](docs/repo-map.md) | Source layout and implementation entry points |
| [Contributing](CONTRIBUTING.md) | Human contribution workflow and development checks |
| [Security policy](SECURITY.md) | Private vulnerability-reporting guidance |

## Development

From a checkout of this repository, with Node 26 and pnpm 11:

```sh
pnpm install --frozen-lockfile
pnpm check:fast
pnpm check
./coord --help
```

`check:fast` runs lint, source/test typechecking, and fast tests. `check` adds
the build and end-to-end suite. See [Contributing](CONTRIBUTING.md) before
opening a pull request; using coord's own multi-agent workflow is optional.

## License

MIT — see [LICENSE](LICENSE). Distributed through GitHub, not npm.
