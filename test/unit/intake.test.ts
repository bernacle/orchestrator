import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { makeIssue } from "../../src/adapters/mock/index.js";
import { resolvePaths } from "../../src/config/load.js";
import { RepoConfigSchema } from "../../src/config/schema.js";
import { evaluateAssociation, linkedRepositories, saveAssociation } from "../../src/intake/association.js";
import { looksLikeIssueRef, parseIssueRef } from "../../src/intake/issue-ref.js";
import { defaultDiscoveryDeps, discoverRepository, parseGitHubRemote, splitRemoteUrl, type DiscoveryDeps } from "../../src/intake/repo-discovery.js";
import { configStatus, selectRepository } from "../../src/intake/resolve.js";

const scratch = mkdtempSync(join(tmpdir(), "orch-intake-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

/** Real git; SSH aliases resolved from a table instead of ~/.ssh/config. */
const deps = (aliases: Record<string, string> = {}): DiscoveryDeps => ({ ...defaultDiscoveryDeps(process.env), sshHostname: async (a) => aliases[a] ?? null });

function repoWith(name: string, remotes: Record<string, string>): string {
  const dir = join(scratch, name);
  mkdirSync(join(dir, "packages", "app"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "x\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  for (const [r, url] of Object.entries(remotes)) git(dir, "remote", "add", r, url);
  return dir;
}

function homeWithConfigs(name: string, repos: Array<{ repo: string; teams: string[]; projects?: string[] }>) {
  const home = join(scratch, name);
  for (const r of repos) {
    const [owner, n] = r.repo.split("/");
    mkdirSync(join(home, "repos", owner!), { recursive: true });
    writeFileSync(
      join(home, "repos", owner!, `${n}.yaml`),
      stringify({ repo: r.repo, linear: { teams: r.teams, ...(r.projects ? { projects: r.projects } : {}) }, agents: { implementer: { adapter: "mock", provider: "a" }, reviewer: { adapter: "mock", provider: "b" } } }),
    );
  }
  return resolvePaths({ ORCHESTRATOR_HOME: home });
}

describe("issue references", () => {
  it.each([
    ["BRU-488", "BRU-488", null],
    ["bru-488", "BRU-488", null],
    [" BRU-488 ", "BRU-488", null],
    ["https://linear.app/bernacle/issue/BRU-488", "BRU-488", "bernacle"],
    ["https://linear.app/Bernacle/issue/bru-488/implement-darkroom-b-studio", "BRU-488", "bernacle"],
    ["linear.app/acme/issue/ACM-12?foo=1", "ACM-12", "acme"],
    ["<https://linear.app/acme/issue/ACM-12#comment-1>", "ACM-12", "acme"],
  ])("%s → %s", (input, key, workspace) => {
    const ref = parseIssueRef(input);
    expect(ref.key).toBe(key);
    expect(ref.workspace).toBe(workspace);
  });

  it.each(["BRU", "488", "https://github.com/bernacle/analyticool/issues/488", "https://linear.app/acme/project/foo", "bru-488-1a2b3c"])("rejects %s", (input) => {
    expect(() => parseIssueRef(input)).toThrow();
  });

  it("tells run ids from issue references", () => {
    expect(looksLikeIssueRef("bru-488-bee82e")).toBe(false);
    expect(looksLikeIssueRef("BRU-488")).toBe(true);
  });
});

describe("GitHub remotes", () => {
  it.each([
    ["git@github.com:bernacle/analyticool.git", "bernacle/analyticool"],
    ["git@github.com:bernacle/analyticool", "bernacle/analyticool"],
    ["ssh://git@github.com/bernacle/analyticool.git", "bernacle/analyticool"],
    ["ssh://git@github.com:22/bernacle/analyticool", "bernacle/analyticool"],
    ["https://github.com/bernacle/analyticool.git", "bernacle/analyticool"],
    ["https://github.com/bernacle/analyticool/", "bernacle/analyticool"],
    ["https://user@github.com/bernacle/analyticool", "bernacle/analyticool"],
    ["git@github-personal:bernacle/analyticool.git", "bernacle/analyticool"],
  ])("%s → %s", async (url, repo) => {
    const r = await parseGitHubRemote(url, deps({ "github-personal": "github.com" }));
    expect(r.github?.repo).toBe(repo);
  });

  it("does not treat other hosts or local paths as GitHub", async () => {
    expect((await parseGitHubRemote("git@gitlab.com:a/b.git", deps())).github).toBeNull();
    expect((await parseGitHubRemote("git@unknown-alias:a/b.git", deps())).note).toMatch(/not github.com/);
    expect((await parseGitHubRemote("https://github.example.com/a/b", deps())).github).toBeNull();
    expect((await parseGitHubRemote("/srv/git/widget.git", deps())).github).toBeNull();
    expect(splitRemoteUrl("../relative/path")).toBeNull();
  });
});

describe("repository discovery", () => {
  const main = repoWith("main", { origin: "git@github.com:acme/widget.git" });

  it("identifies a main checkout and a nested directory", async () => {
    for (const cwd of [main, join(main, "packages", "app")]) {
      const d = await discoverRepository(cwd, deps());
      expect(d.inGitRepo).toBe(true);
      expect(d.isLinkedWorktree).toBe(false);
      expect(d.candidates.map((c) => c.repo)).toEqual(["acme/widget"]);
    }
  });

  it("identifies a linked worktree by its shared remotes, and reports the main checkout", async () => {
    const wt = join(scratch, "linked");
    git(main, "worktree", "add", "-q", "-b", "feature", wt);
    const d = await discoverRepository(wt, deps());
    expect(d.isLinkedWorktree).toBe(true);
    expect(d.worktreeRoot).toBe(execFileSync("realpath", [wt], { encoding: "utf8" }).trim());
    expect(d.mainCheckout).toBe(execFileSync("realpath", [main], { encoding: "utf8" }).trim());
    expect(d.candidates.map((c) => c.repo)).toEqual(["acme/widget"]);
  });

  it("collapses remotes that point at the same repository, and keeps forks distinct", async () => {
    const fork = repoWith("fork", { origin: "git@github.com:me/widget.git", upstream: "https://github.com/acme/widget.git", mirror: "git@github.com:ACME/widget" });
    const d = await discoverRepository(fork, deps());
    // `git remote` lists remotes alphabetically; selection never depends on that order.
    expect(d.candidates.map((c) => [c.repo.toLowerCase(), c.remotes.sort()]).sort()).toEqual([
      ["acme/widget", ["mirror", "upstream"]],
      ["me/widget", ["origin"]],
    ]);
  });

  it("reports directories outside any repository", async () => {
    const plain = join(scratch, "plain");
    mkdirSync(plain, { recursive: true });
    expect((await discoverRepository(plain, deps())).inGitRepo).toBe(false);
  });
});

describe("repository selection", () => {
  const paths = homeWithConfigs("home-sel", [{ repo: "acme/widget", teams: ["ACM"] }]);

  it("selects the only GitHub repository of the working directory", async () => {
    const dir = repoWith("sel-one", { origin: "git@github.com:acme/widget.git" });
    const s = await selectRepository({ cwd: dir, issueKey: "ACM-1", paths, deps: deps() });
    expect(s).toMatchObject({ status: "resolved", repo: "acme/widget", source: "cwd" });
  });

  it("does not use 'origin' to break a tie: fork + upstream with no config is ambiguous", async () => {
    const dir = repoWith("sel-fork", { origin: "git@github.com:me/gadget.git", upstream: "git@github.com:acme/gadget.git" });
    const s = await selectRepository({ cwd: dir, issueKey: "ACM-1", paths, deps: deps() });
    expect(s.status).toBe("ambiguous");
    expect(s.candidates.map((c) => c.repo).sort()).toEqual(["acme/gadget", "me/gadget"]);
    expect(s.reason).toMatch(/--repo/);
  });

  it("picks the one configured repository among fork and upstream, and says why", async () => {
    const dir = repoWith("sel-fork-configured", { origin: "git@github.com:me/widget.git", upstream: "git@github.com:acme/widget.git" });
    const s = await selectRepository({ cwd: dir, issueKey: "ACM-1", paths, deps: deps() });
    expect(s).toMatchObject({ status: "resolved", repo: "acme/widget", source: "cwd" });
    expect(s.reason).toMatch(/only acme\/widget has operator configuration/);
    expect(s.warnings[0]).toMatch(/me\/widget/);
  });

  it("stops when the repository has no GitHub remote", async () => {
    const none = repoWith("sel-none", {});
    const local = repoWith("sel-local", { origin: "/srv/git/widget.git" });
    for (const dir of [none, local]) {
      const s = await selectRepository({ cwd: dir, issueKey: "ACM-1", paths, deps: deps() });
      expect(s.status).toBe("no_github_remote");
      expect(s.repo).toBeNull();
    }
  });

  it("an explicit --repo wins, with a warning when the working directory is another repository", async () => {
    const dir = repoWith("sel-explicit", { origin: "git@github.com:acme/other.git" });
    const s = await selectRepository({ repo: "acme/widget", cwd: dir, issueKey: "ACM-1", paths, deps: deps() });
    expect(s).toMatchObject({ status: "resolved", repo: "acme/widget", source: "explicit" });
    expect(s.warnings[0]).toMatch(/belongs to acme\/other, not acme\/widget/);
  });

  it("outside a repository, falls back to the team mapping (association still required)", async () => {
    const plain = join(scratch, "plain-sel");
    mkdirSync(plain, { recursive: true });
    expect(await selectRepository({ cwd: plain, issueKey: "ACM-9", paths, deps: deps() })).toMatchObject({ status: "resolved", source: "team", repo: "acme/widget" });
    expect((await selectRepository({ cwd: plain, issueKey: "ZZZ-9", paths, deps: deps() })).status).toBe("not_found");
    const two = homeWithConfigs("home-two", [{ repo: "acme/a", teams: ["ACM"] }, { repo: "acme/b", teams: ["ACM"] }]);
    expect((await selectRepository({ cwd: plain, issueKey: "ACM-9", paths: two, deps: deps() })).status).toBe("ambiguous");
  });

  it("reports missing configuration for an unknown repository", () => {
    expect(configStatus("acme/unknown", paths)).toMatchObject({ status: "missing" });
    expect(configStatus("acme/widget", paths)).toMatchObject({ status: "authorized", scope: "operator_file" });
  });
});

describe("issue ↔ repository association", () => {
  const paths = homeWithConfigs("home-assoc", [{ repo: "acme/widget", teams: ["ACM"], projects: ["Widget"] }]);
  const config = RepoConfigSchema.parse({ repo: "acme/widget", linear: { teams: ["ACM"] }, agents: { implementer: { adapter: "mock" }, reviewer: { adapter: "mock" } } });
  const eval_ = (issue: ReturnType<typeof makeIssue>, cfg = config) => evaluateAssociation({ issue, repo: "acme/widget", config: cfg, paths, explicitRepo: false });

  it("never treats the team prefix alone as evidence", () => {
    const r = eval_(makeIssue({ key: "ACM-1" }));
    expect(r.verified).toBe(false);
    expect(r.remedy).toMatch(/orchestrator associate ACM-1 --repo acme\/widget --yes/);
  });

  it("accepts a link from the issue to the repository, and reports links to others", () => {
    const r = eval_(makeIssue({ key: "ACM-2", description: "See https://github.com/acme/widget/pull/7 and github.com/acme/other.", attachments: [] }));
    expect(r.verified).toBe(true);
    expect(r.evidence.map((e) => e.kind)).toEqual(["issue_link"]);
    expect(r.conflicts).toEqual(["acme/other"]);
    expect(linkedRepositories({ description: "", attachments: [{ title: "PR", url: "https://github.com/Acme/Widget/pull/1" }] })).toEqual(["Acme/Widget"]);
  });

  it("accepts a mapped Linear project", () => {
    const mapped = RepoConfigSchema.parse({ ...config, linear: { teams: ["ACM"], projects: ["Widget"] } });
    expect(eval_(makeIssue({ key: "ACM-3", project: "Widget" }), mapped).evidence.map((e) => e.kind)).toEqual(["project_mapping"]);
    expect(eval_(makeIssue({ key: "ACM-3", project: "Other" }), mapped).verified).toBe(false);
  });

  it("accepts an operator confirmation saved outside the repository", () => {
    saveAssociation(paths, { tracker: "linear", issue: "ACM-4", repo: "acme/widget", workspace: null, confirmedBy: "tester" });
    const r = eval_(makeIssue({ key: "ACM-4" }));
    expect(r.evidence).toEqual([expect.objectContaining({ kind: "confirmed", detail: expect.stringContaining("tester") })]);
    expect(eval_(makeIssue({ key: "ACM-5" })).verified).toBe(false);
  });

  it("accepts an operator brief for the issue and repository", () => {
    mkdirSync(join(paths.home, "briefs", "acme", "widget"), { recursive: true });
    writeFileSync(join(paths.home, "briefs", "acme", "widget", "ACM-6.md"), "---\nissue: ACM-6\nrepo: acme/widget\n---\nScope.\n");
    expect(eval_(makeIssue({ key: "ACM-6" })).evidence.map((e) => e.kind)).toEqual(["brief"]);
  });
});
