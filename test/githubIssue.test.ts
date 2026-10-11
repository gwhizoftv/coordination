import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchGitHubIssue,
  formatFinalizationPullRequest,
  githubRepositoryFromOrigin,
  readGitHubIssueSnapshot,
  renderGitHubIssueSnapshot,
  verifyFollowUpIssue
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

  it("states a revision-limit conclusion and its follow-up issues in the PR body", () => {
    const { body } = formatFinalizationPullRequest({
      issue: 177,
      title: "Review limits",
      finalSha: "a".repeat(40),
      draft: true,
      closeout: {
        round: 3,
        objections: [
          { agent: "codex", disposition: "revise", followUp: { number: 180, url: "https://github.com/acme/app/issues/180" } },
          { agent: "cursor", disposition: "escalate", followUp: null }
        ]
      }
    });
    expect(body.split("\n")).toEqual([
      "Closes #177",
      "",
      `Draft PR for issue 177. Owner merges. Final pin: ${"a".repeat(40)}.`,
      "",
      "Concluded at the revision limit (round 3): this revision is finalized with objections on record, not with " +
        "unanimous approval. Each objecting agent filed its remaining objections as a follow-up issue:",
      "- codex (revise): https://github.com/acme/app/issues/180",
      "- cursor (escalate): dropped before filing a follow-up issue"
    ]);
  });
});

describe("follow-up issue verification", () => {
  const revision = "d".repeat(40);
  const key = "coord-follow-up-0123456789abcdef";
  const goodBody = `Remaining objections.\n\nFinal revision ${revision}\nFollow-up to #177 (https://github.com/acme/app/issues/177)\nFiling key: ${key}`;
  const verify = (claimedUrl: string, body: string | null, failure?: string) =>
    verifyFollowUpIssue({
      origin: "https://github.com/acme/app.git",
      parentIssue: 177,
      claimedUrl,
      revisionSha: revision,
      filingKey: key,
      cwd: "/runtime",
      runner: async (argv) => {
        const number = Number(argv[3]);
        if (failure !== undefined) return { exitCode: 1, stdout: "", stderr: failure };
        return { exitCode: 0, stderr: "", stdout: JSON.stringify({
          number, title: "Follow-up", body, url: `https://github.com/acme/app/issues/${number}` }) };
      }
    });

  it("accepts a different issue in the repository that links the concluding issue, revision, and key", async () => {
    expect(await verify("https://github.com/acme/app/issues/180", goodBody)).toEqual({
      status: "verified", number: 180, url: "https://github.com/acme/app/issues/180"
    });
    expect((await verify("https://github.com/acme/app/issues/180", goodBody.replace(/Follow-up to .*\n/, "See https://github.com/acme/app/issues/177\n"))).status)
      .toBe("verified");
  });

  it.each([
    ["the concluding issue itself", "https://github.com/acme/app/issues/177", goodBody],
    ["another repository", "https://github.com/other/app/issues/180", goodBody],
    ["no backlink", "https://github.com/acme/app/issues/180", goodBody.replace(/Follow-up to .*\n/, "")],
    ["a longer issue number only", "https://github.com/acme/app/issues/180", goodBody.replace(/Follow-up to .*\n/, "See #1770\n")],
    ["no final revision", "https://github.com/acme/app/issues/180", goodBody.replace(revision, "")],
    ["no filing key", "https://github.com/acme/app/issues/180", goodBody.replace(key, "")],
    ["a closing keyword", "https://github.com/acme/app/issues/180", `${goodBody}\nCloses #177`]
  ])("rejects %s", async (_case, url, body) => {
    expect((await verify(url, body)).status).toBe("rejected");
  });

  it("rejects a missing issue but reports a failed lookup as unavailable, never as a reason to file again", async () => {
    expect(await verify("https://github.com/acme/app/issues/999", null,
      "GraphQL: Could not resolve to an issue or pull request with the number of 999.")).toMatchObject({ status: "rejected" });
    expect(await verify("https://github.com/acme/app/issues/180", null, "error connecting to api.github.com"))
      .toMatchObject({ status: "unavailable" });
  });
});
