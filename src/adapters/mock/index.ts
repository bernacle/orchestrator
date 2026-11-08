import type {
  AgentResult,
  AgentRunner,
  AgentTask,
  BranchProtection,
  CodeHost,
  Issue,
  IssueTracker,
  PullRequestStatus,
  RepoInfo,
} from "../types.js";

/** In-memory Linear. Records every write so tests can assert on them. */
export class MockTracker implements IssueTracker {
  readonly name = "mock-linear";
  readonly comments: Array<{ key: string; body: string }> = [];
  readonly stateChanges: Array<{ key: string; state: string }> = [];

  constructor(private readonly issues: Record<string, Issue>) {}

  async getIssue(key: string): Promise<Issue> {
    const issue = this.issues[key];
    if (!issue) throw new Error(`issue ${key} not found in this Linear workspace`);
    return structuredClone(issue);
  }
  async comment(key: string, body: string): Promise<{ id: string }> {
    this.comments.push({ key, body });
    return { id: `c${this.comments.length}` };
  }
  async setState(key: string, state: string): Promise<void> {
    this.stateChanges.push({ key, state });
  }
  urlKey = "mock-workspace";
  async whoami() {
    return { user: "mock", workspace: `Mock (${this.urlKey})`, urlKey: this.urlKey };
  }
}

export function makeIssue(overrides: Partial<Issue> & Pick<Issue, "key">): Issue {
  return {
    id: `id-${overrides.key}`,
    title: "Add a feature",
    url: `https://linear.app/x/issue/${overrides.key}`,
    description: "Do the thing.\n\n## Acceptance criteria\n- feature.txt exists\n- it says hello",
    state: { name: "Todo", type: "unstarted" },
    team: { key: overrides.key.split("-")[0]!, name: "Team" },
    project: null,
    labels: [],
    priority: { value: 3, label: "Medium" },
    assignee: null,
    branchName: null,
    parent: null,
    children: [],
    blockedBy: [],
    blocks: [],
    related: [],
    comments: [],
    attachments: [],
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * In-memory GitHub. `ciScript` decides the check results each time a PR is
 * read, so tests can model pending → pass or failures.
 */
export class MockCodeHost implements CodeHost {
  readonly name = "mock-github";
  readonly prs: PullRequestStatus[] = [];
  readonly merges: Array<{ number: number; headSha: string }> = [];
  ciScript: (pr: PullRequestStatus, reads: number) => PullRequestStatus["checks"] = () => [{ name: "CI", bucket: "pass" }];
  /** Overrides the PR head (e.g. simulate a push by someone else). */
  headOverride: string | null = null;
  private reads = 0;

  constructor(
    public repoInfo: RepoInfo,
    public protection: BranchProtection,
    private readonly headOf: (branch: string) => Promise<string>,
    public login = "bot",
  ) {}

  async viewer() {
    return { login: this.login };
  }
  async getRepo(): Promise<RepoInfo> {
    return this.repoInfo;
  }
  async getBranchProtection(): Promise<BranchProtection> {
    return this.protection;
  }
  async findPullRequest(_repo: string, head: string) {
    const pr = this.prs.find((p) => p.headRefName === head);
    return pr ? this.getPullRequest(_repo, pr.number) : null;
  }
  async createPullRequest(input: { repo: string; base: string; head: string; title: string; body: string; draft: boolean }): Promise<PullRequestStatus> {
    const pr: PullRequestStatus = {
      number: this.prs.length + 1,
      url: `https://github.com/${input.repo}/pull/${this.prs.length + 1}`,
      state: "OPEN",
      isDraft: input.draft,
      headRefName: input.head,
      headSha: await this.headOf(input.head),
      baseRefName: input.base,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
      checks: [],
    };
    (pr as PullRequestStatus & { body: string; title: string }).body = input.body;
    (pr as PullRequestStatus & { body: string; title: string }).title = input.title;
    this.prs.push(pr);
    return { ...pr };
  }
  async getPullRequest(_repo: string, number: number): Promise<PullRequestStatus> {
    const pr = this.prs.find((p) => p.number === number);
    if (!pr) throw new Error(`no PR ${number}`);
    if (pr.state === "OPEN") pr.headSha = this.headOverride ?? (await this.headOf(pr.headRefName));
    pr.checks = this.ciScript(pr, this.reads++);
    return { ...pr, checks: [...pr.checks] };
  }
  /** Keyed by issue key. */
  linked: Record<string, import("../types.js").PrEvidence[]> = {};
  async linkedPullRequests(input: { issueKey: string }): Promise<import("../types.js").PrEvidence[]> {
    return this.linked[input.issueKey] ?? [];
  }

  async mergePullRequest(input: { number: number; headSha: string }): Promise<void> {
    const pr = this.prs.find((p) => p.number === input.number)!;
    if (pr.headSha !== input.headSha) throw new Error("head mismatch");
    pr.state = "MERGED";
    this.merges.push(input);
  }
}

export type AgentScript = (task: AgentTask, call: number) => Promise<Partial<AgentResult>> | Partial<AgentResult>;

/** Scripted agent: the script can write files into task.cwd to simulate work. */
export class MockAgent implements AgentRunner {
  readonly id: string;
  readonly calls: AgentTask[] = [];

  constructor(
    readonly provider: string,
    private readonly script: AgentScript,
    id = `mock-${provider}`,
  ) {
    this.id = id;
  }

  describe(task: Omit<AgentTask, "signal" | "env">): string {
    return `mock-agent --role ${task.role} --cwd ${task.cwd}`;
  }

  async run(task: AgentTask): Promise<AgentResult> {
    this.calls.push(task);
    const partial = await this.script(task, this.calls.length);
    return {
      sessionId: task.resumeSessionId ?? task.sessionId ?? `mock-session-${this.provider}`,
      text: "done",
      structured: null,
      ok: true,
      error: null,
      costUsd: 0,
      durationMs: 1,
      transcripts: [],
      ...partial,
    };
  }

  async probe() {
    return { ok: true, detail: "mock" };
  }

  isolationOk = true;
  async verifyIsolation() {
    return { ok: this.isolationOk, detail: this.isolationOk ? "mock isolation" : "mock: isolation unavailable" };
  }
}
