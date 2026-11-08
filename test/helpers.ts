import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { ShellCheckRunner } from "../src/adapters/checks.js";
import { GitWorkspace } from "../src/adapters/git.js";
import { MockAgent, MockCodeHost, MockTracker, makeIssue, type AgentScript } from "../src/adapters/mock/index.js";
import type { Adapters, Issue } from "../src/adapters/types.js";
import { openApp, type App } from "../src/app.js";
import type { AgentConfig } from "../src/config/schema.js";

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

export const approve = { verdict: "approve", summary: "Looks good.", findings: [] };
export const requestChanges = (title = "Missing greeting") => ({
  verdict: "request_changes",
  summary: "One problem.",
  findings: [{ id: "F1", severity: "major", file: "feature.txt", line: 1, title, detail: "Should say hello.", suggestion: "Write hello." }],
});

export interface Harness {
  root: string;
  /** ORCHESTRATOR_HOME for this harness. */
  home: string;
  origin: string;
  clone: string;
  configFile: string;
  app: App;
  /** Close the App and open a new one on the same database (simulates a process restart). */
  reopen(): App;
  tracker: MockTracker;
  host: MockCodeHost;
  implementer: MockAgent;
  reviewer: MockAgent;
  writeConfig(patch?: Record<string, unknown>): void;
  cleanup(): void;
}

export interface HarnessOptions {
  issues?: Issue[];
  implement?: AgentScript;
  review?: AgentScript;
  config?: Record<string, unknown>;
  reviewerProvider?: string;
  protection?: Partial<import("../src/adapters/types.js").BranchProtection>;
}

/** Writes `feature.txt` saying hello. */
export const writeFeature: AgentScript = (task) => {
  writeFileSync(join(task.cwd, "feature.txt"), "hello\n");
  return { text: "Implemented feature.txt" };
};

export function baseConfig(clone: string): Record<string, unknown> {
  return {
    repo: "acme/widget",
    base_branch: "main",
    local_path: clone,
    linear: { teams: ["ACM"], workspace: "mock-workspace" },
    checks: [{ name: "feature-exists", run: "test -f feature.txt" }],
    // The fixture's check only passes after the agent's change; baseline behaviour has its own tests.
    baseline_checks: false,
    agents: {
      implementer: { adapter: "mock", provider: "anthropic-mock" },
      reviewer: { adapter: "mock", provider: "openai-mock" },
    },
    permissions: { agents: { run: true }, github: { push: true, create_pr: true, merge: false }, linear: { comment: true } },
    // The real Seatbelt sandbox is used where it exists; elsewhere tests run checks unsandboxed.
    isolation: { require: process.platform === "darwin" },
    merge: { mode: "manual", max_fix_attempts: 2 },
  };
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" ? deepMerge(a[k] as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}

export function createHarness(opts: HarnessOptions = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "orch-test-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");
  mkdirSync(seed);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "widget", scripts: { test: "true" } }));
  writeFileSync(join(seed, "README.md"), "# widget\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  execFileSync("git", ["clone", "-q", origin, clone]);
  git(clone, "config", "user.email", "t@t");
  git(clone, "config", "user.name", "t");
  const baseSha = git(clone, "rev-parse", "HEAD");

  const configFile = join(root, "widget.yaml");
  let current = deepMerge(baseConfig(clone), opts.config ?? {});
  const writeConfig = (patch: Record<string, unknown> = {}) => {
    current = deepMerge(current, patch);
    writeFileSync(configFile, stringify(current));
  };
  writeConfig();

  const tracker = new MockTracker(Object.fromEntries((opts.issues ?? [makeIssue({ key: "ACM-1" })]).map((i) => [i.key, i])));
  const host = new MockCodeHost(
    { fullName: "acme/widget", defaultBranch: "main", visibility: "private", baseSha, allowAutoMerge: false, mergeMethods: ["squash"], viewerPermission: "write" },
    { branch: "main", protected: false, requiredChecks: [], requiredApprovals: 0, rulesetTypes: [], notes: [], ...opts.protection },
    async (branch) => git(origin, "rev-parse", `refs/heads/${branch}`),
  );
  const implementer = new MockAgent("anthropic-mock", opts.implement ?? writeFeature, "mock-implementer");
  const reviewer = new MockAgent(opts.reviewerProvider ?? "openai-mock", opts.review ?? (() => ({ structured: approve, text: JSON.stringify(approve) })), "mock-reviewer");

  const env: NodeJS.ProcessEnv = { ...process.env, ORCHESTRATOR_HOME: join(root, "home"), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  delete env.T3CODE_CLI_PATH;
  const makeApp = (): App => {
    const app: App = openApp({
      env,
      tracker: () => tracker,
      adapters: (): Adapters => ({
        tracker,
        codeHost: host,
        workspace: new GitWorkspace(env),
        checks: new ShellCheckRunner(app.redactor),
        agent: (cfg: AgentConfig) => {
          const provider = cfg.adapter === "mock" ? cfg.provider : cfg.adapter;
          return provider === "anthropic-mock" ? implementer : reviewer;
        },
      }),
    });
    return app;
  };

  const harness: Harness = {
    root,
    home: join(root, "home"),
    origin,
    clone,
    configFile,
    app: makeApp(),
    reopen: () => {
      harness.app.close();
      harness.app = makeApp();
      return harness.app;
    },
    tracker,
    host,
    implementer,
    reviewer,
    writeConfig,
    cleanup: () => {
      try {
        harness.app.close();
      } catch {
        /* already closed */
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
  return harness;
}
