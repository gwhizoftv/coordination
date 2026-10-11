import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assessFollowUpIssue,
  followUpKey,
  fetchGitHubIssue,
  formatFinalizationPullRequest,
  githubRepositoryFromOrigin,
  readGitHubIssueSnapshot,
  renderGitHubIssueSnapshot
} from "../src/githubIssue.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GitHub issue snapshots", () => {
  it("derives supported repositories and binds lookup to origin rather than cwd", async () => {
    expect(githubRepositoryFromOrigin("https://github.com/acme/app.git")).toBe("acme/app");
    expect(githubRepositoryFromOrigin("git@github.com:acme/app.git")).toBe("acme/app");
    expect(githubRepositoryFromOrigin("/tmp/app.git")).toBeNull();
    const calls: string[][] = [];
    const snapshot = await fetchGitHubIssue({
      origin: "https://github.com/acme/app.git",
      issue: 42,
      cwd: "/unrelated/repository",
      runner: async (argv) => {
        calls.push([...argv]);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            number: 42,
            title: "Work",
            body: "Do it",
            url: "https://github.com/acme/app/issues/42"
          }),
          stderr: ""
        };
      }
    });
    expect(calls[0]).toEqual([
      "gh",
      "issue",
      "view",
      "42",
      "--repo",
      "acme/app",
      "--json",
      "number,title,body,url"
    ]);
    expect(snapshot.repository).toBe("acme/app");
    expect(renderGitHubIssueSnapshot(snapshot)).toBe(`${JSON.stringify(snapshot, null, 2)}\n`);
  });

  it("fails with issue-first remediation on a missing or unreadable issue", async () => {
    await expect(
      fetchGitHubIssue({
        origin: "https://github.com/acme/app.git",
        issue: 999,
        cwd: "/tmp",
        runner: async () => ({ exitCode: 1, stdout: "", stderr: "issue not found" })
      })
    ).rejects.toThrow(/Create GitHub issue 999.*gh auth status/);
  });

  it("rejects malformed and mismatched responses", async () => {
    const input = {
      origin: "https://github.com/acme/app.git",
      issue: 7,
      cwd: "/tmp"
    };
    await expect(
      fetchGitHubIssue({ ...input, runner: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }) })
    ).rejects.toThrow(/invalid snapshot/);
    await expect(
      fetchGitHubIssue({
        ...input,
        runner: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            number: 8,
            title: "wrong",
            body: "",
            url: "https://github.com/acme/app/issues/8"
          }),
          stderr: ""
        })
      })
    ).rejects.toThrow(/issue 8 while issue 7/);
  });

  it("normalizes an empty GitHub issue body to an empty string", async () => {
    const snapshot = await fetchGitHubIssue({
      origin: "https://github.com/acme/app.git",
      issue: 3,
      cwd: "/tmp",
      runner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          number: 3,
          title: "Body optional",
          body: null,
          url: "https://github.com/acme/app/issues/3"
        }),
        stderr: ""
      })
    });
    expect(snapshot.body).toBe("");
  });

  it("reads a durable runtime snapshot and formats finalization PR text", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-issue-snap-"));
    roots.push(root);
    const path = join(root, "github-issue.json");
    const snapshot = {
      repository: "acme/app",
      number: 112,
      title: "Have PR's include the issue title",
      body: "Close on merge.",
      url: "https://github.com/acme/app/issues/112"
    };
    writeFileSync(path, renderGitHubIssueSnapshot(snapshot));
    expect(readGitHubIssueSnapshot(path)).toEqual(snapshot);
    expect(
      formatFinalizationPullRequest({
        issue: 112,
        title: snapshot.title,
        finalSha: "a".repeat(40),
        draft: true,
        evidenceBranch: "issue-112/coordinator-evidence",
        evidenceTip: "c".repeat(40)
      })
    ).toEqual({
      title: "Issue 112: Have PR's include the issue title",
      body: [
        "Closes #112",
        "",
        `Draft PR for issue 112. Owner merges. Final pin: ${"a".repeat(40)}.`,
        "",
        `Ballot evidence branch: issue-112/coordinator-evidence (tip ${"c".repeat(40)}).`,
        "That branch is coordinator-authored publication of action-bound ballot responses, not a cryptographic agent signature."
      ].join("\n")
    });
    expect(
      formatFinalizationPullRequest({
        issue: 112,
        title: "  ",
        finalSha: "b".repeat(40),
        draft: false
      }).title
    ).toBe("Issue 112: coordinated implementation");
  });
});


describe("follow-up issue verification", () => {
  const input = { origin: "git@github.com:acme/app.git", issue: 1, issueSessionId: "session",
    agent: "codex", revisionCommitSha: "e".repeat(40), url: "https://github.com/acme/app/issues/2", cwd: "/tmp" };
  const body = ["Remaining objections: the regression test is missing.", "Related to https://github.com/acme/app/issues/1",
    `Revision: ${input.revisionCommitSha}`, `Tracking key: ${followUpKey(input.issueSessionId, input.agent, input.revisionCommitSha)}`].join("\n");
  const result = (text: string, url = input.url) => ({ exitCode: 0, stderr: "",
    stdout: JSON.stringify({ number: 2, title: "Follow-up", body: text, url }) });

  it("reads an existing issue and never creates one on success or retry", async () => {
    const calls: string[][] = [];
    const runner = async (argv: readonly string[]) => { calls.push([...argv]); return result(body); };
    const accepted = await assessFollowUpIssue({ ...input, runner });
    expect(accepted).toEqual({ status: "satisfied", followUp: { number: 2, url: input.url, revisionCommitSha: input.revisionCommitSha } });
    expect(await assessFollowUpIssue({ ...input, runner })).toEqual(accepted);
    expect(calls).toEqual(Array.from({ length: 2 }, () => ["gh", "issue", "view", "2", "--repo", "acme/app", "--json", "number,title,body,url"]));
    for (const stderr of ["network timeout", "HTTP 429", "authentication required"]) {
      expect(await assessFollowUpIssue({ ...input, runner: async () => ({ exitCode: 1, stdout: "", stderr }) }))
        .toMatchObject({ status: "retry", outstanding: [expect.stringContaining("retaining the receipt")] });
    }
  });

  it("rejects wrong repositories, parent reuse, fabricated issues and stale binding lines", async () => {
    let calls = 0;
    const runner = async () => { calls++; return result(body); };
    for (const url of ["https://github.com/other/app/issues/2", "https://github.com/acme/app/issues/1", "https://github.com/acme/app/pull/2",
      "https://github.com/acme/app/issues/2?x=1"]) {
      expect((await assessFollowUpIssue({ ...input, url, runner })).status).toBe("rejected");
    }
    expect(calls).toBe(0);
    for (const text of [body.replace("Related to", "Closes"), body.replace(input.revisionCommitSha, "a".repeat(40)),
      body.replace("Tracking key:", "wrong key:")]) {
      expect((await assessFollowUpIssue({ ...input, runner: async () => result(text) })).status).toBe("rejected");
    }
    expect((await assessFollowUpIssue({ ...input, runner: async () => result(body, "https://github.com/acme/app/issues/3") })).status).toBe("rejected");
    expect((await assessFollowUpIssue({ ...input, runner: async () => ({ exitCode: 1, stdout: "", stderr: "Could not resolve to an Issue with the number of 2" }) })).status).toBe("rejected");
    expect(followUpKey("session", "codex", input.revisionCommitSha)).not.toBe(followUpKey("session", "claude", input.revisionCommitSha));
  });

  it.each([true, false])("reports capped closeout without changing draft policy %s", (draft) => {
    const pr = formatFinalizationPullRequest({ issue: 1, title: "Close out", finalSha: input.revisionCommitSha, draft,
      closeout: { round: 3, followUps: [{ agent: "codex", url: input.url }], droppedAgents: ["claude"] } });
    expect(pr.body).toContain("Closes #1");
    expect(pr.body).toContain("not unanimous approval");
    expect(pr.body).toContain(input.url);
    expect(pr.body).toContain("Dropped agents: claude");
    expect(pr.body).toContain(draft ? "Owner merges" : "Coordinator merges");
  });
});
