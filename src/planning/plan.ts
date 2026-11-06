import type { BranchProtection, Issue, PullRequestStatus, RepoInfo, RepoInspection } from "../adapters/types.js";
import type { ResolvedToolchain } from "../adapters/checks.js";
import type { AgentConfig, CheckConfig, RepoConfig } from "../config/schema.js";
import { PermissionGate, type Permission } from "../core/policy.js";
import type { RunState } from "../core/states.js";
import type { DependencySummary } from "./issue.js";

// ---- agent-produced implementation plan ------------------------------------------

export interface AgentPlan {
  summary: string;
  steps: string[];
  files: Array<{ path: string; change: string }>;
  tests: string[];
  risks: string[];
  open_questions: string[];
}

export const AGENT_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "steps", "files", "tests", "risks", "open_questions"],
  properties: {
    summary: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
    files: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["path", "change"], properties: { path: { type: "string" }, change: { type: "string" } } },
    },
    tests: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    open_questions: { type: "array", items: { type: "string" } },
  },
} as const;

export function parseAgentPlan(value: unknown): AgentPlan | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  // Planners often number their own steps; the renderer numbers them already.
  const unnumbered = (xs: string[]) => xs.map((s) => s.replace(/^\s*(?:step\s*)?\d+[.):]\s+/i, ""));
  if (typeof v.summary !== "string") return null;
  return {
    summary: v.summary,
    steps: unnumbered(strings(v.steps)),
    files: Array.isArray(v.files)
      ? v.files.filter((f): f is { path: string; change: string } => typeof f?.path === "string").map((f) => ({ path: f.path, change: String(f.change ?? "") }))
      : [],
    tests: strings(v.tests),
    risks: strings(v.risks),
    open_questions: strings(v.open_questions),
  };
}

// ---- execution plan --------------------------------------------------------------

export interface PlannedAction {
  id: string;
  permission: Permission | "read";
  description: string;
  command?: string;
  /** Would a supervised run be allowed to do this under the current config? */
  allowedLive: boolean;
  gate: string;
}

export interface PlannedStage {
  state: RunState;
  summary: string;
  actions: PlannedAction[];
  exits: string[];
}

export interface PlannedCheck {
  kind: "setup" | "check";
  name: string;
  command: string;
  optional: boolean;
  timeoutMinutes: number;
  verification: "script-found" | "script-missing" | "not-a-script";
  inCi: boolean;
}

export interface AgentAssignment {
  role: "planner" | "implementer" | "reviewer";
  adapter: string;
  provider: string;
  model: string;
  access: string;
  command: string;
}

export interface ExecutionPlan {
  version: 1;
  runId: string;
  mode: "dry_run" | "supervised";
  generatedAt: string;
  configSource: string;
  issue: Pick<Issue, "key" | "title" | "url" | "state" | "team" | "project" | "labels" | "priority" | "assignee" | "updatedAt"> & { commentCount: number };
  acceptanceCriteria: { criteria: string[]; source: "section" | "checklist" | "none" };
  dependencies: DependencySummary;
  repository: {
    repo: string;
    baseBranch: string;
    baseSha: string;
    visibility: string;
    viewerPermission: string;
    protection: BranchProtection;
    clonePath: string;
    inspectedRef: string;
    inspectedSha: string;
    packageManager: string | null;
    nodeEngine: string | null;
    guidanceFiles: string[];
    workspaces: string[];
  };
  toolchain: ResolvedToolchain["node"];
  workspace: { branch: string; worktreePath: string; branchExists: { local: boolean; remote: boolean }; existingPr: Pick<PullRequestStatus, "number" | "url" | "state"> | null };
  agents: AgentAssignment[];
  invariants: Array<{ rule: string; ok: boolean; detail: string }>;
  checks: PlannedCheck[];
  ci: { workflows: string[]; steps: string[]; notCoveredLocally: string[] };
  policy: {
    merge: RepoConfig["merge"];
    reviewBlockingSeverities: string[];
    permissions: Record<string, { allowed: boolean; reason: string }>;
    autoMergePreview: string[];
  };
  agentPlan: AgentPlan | null;
  stages: PlannedStage[];
  blockers: string[];
  warnings: string[];
}

/** `pnpm lint`, `pnpm run test:unit`, `npm run x`, `yarn x` → script name. */
export function scriptNameFor(command: string): string | null {
  const m = command.trim().match(/^(?:corepack\s+)?(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/);
  if (!m?.[1]) return null;
  return ["install", "i", "ci", "exec", "dlx", "add", "x"].includes(m[1]) ? null : m[1];
}

export function planChecks(config: RepoConfig, inspection: RepoInspection): { checks: PlannedCheck[]; notCoveredLocally: string[]; ciSteps: string[] } {
  const ciSteps = inspection.ciWorkflows.flatMap((w) => w.runSteps.map((s) => s.trim()));
  const describe = (kind: PlannedCheck["kind"], c: CheckConfig): PlannedCheck => {
    const script = scriptNameFor(c.run);
    return {
      kind,
      name: c.name,
      command: c.run,
      optional: c.optional,
      timeoutMinutes: c.timeout_minutes,
      verification: script === null ? "not-a-script" : script in inspection.scripts ? "script-found" : "script-missing",
      inCi: ciSteps.includes(c.run.trim()),
    };
  };
  const checks = [...config.setup.map((c) => describe("setup", c)), ...config.checks.map((c) => describe("check", c))];
  const configured = new Set(checks.map((c) => c.command.trim()));
  const notCoveredLocally = ciSteps.filter((s) => !configured.has(s));
  return { checks, notCoveredLocally, ciSteps };
}

export function agentAssignment(role: AgentAssignment["role"], cfg: AgentConfig, provider: string, command: string): AgentAssignment {
  const access =
    role === "implementer"
      ? cfg.adapter === "claude-code"
        ? `edits auto-accepted (${cfg.permission_mode}); shell limited to allow-list [${cfg.allowed_tools.filter((t) => t.startsWith("Bash")).join(", ") || "none"}]; git push/commit and gh denied`
        : cfg.adapter === "codex"
          ? `sandbox ${cfg.sandbox}`
          : "mock"
      : cfg.adapter === "codex"
        ? "read-only sandbox, approvals disabled"
        : cfg.adapter === "claude-code"
          ? "read-only tools (Read, Grep, Glob)"
          : "mock";
  return { role, adapter: cfg.adapter, provider, model: ("model" in cfg && cfg.model) || "provider default", access, command };
}

export interface BuildPlanInput {
  runId: string;
  mode: "dry_run" | "supervised";
  now: Date;
  config: RepoConfig;
  configSource: string;
  issue: Issue;
  criteria: { criteria: string[]; source: "section" | "checklist" | "none" };
  dependencies: DependencySummary;
  repoInfo: RepoInfo;
  baseBranch: string;
  protection: BranchProtection;
  inspection: RepoInspection;
  inspectedRef: string;
  clonePath: string;
  toolchain: ResolvedToolchain["node"];
  branch: string;
  worktreePath: string;
  branchExists: { local: boolean; remote: boolean };
  existingPr: PullRequestStatus | null;
  agents: AgentAssignment[];
  invariants: Array<{ rule: string; ok: boolean; detail: string }>;
  agentPlan: AgentPlan | null;
  extraBlockers: string[];
  extraWarnings: string[];
}

export function buildExecutionPlan(input: BuildPlanInput): ExecutionPlan {
  const { config } = input;
  const { checks, notCoveredLocally, ciSteps } = planChecks(config, input.inspection);
  const blockers = [...input.dependencies.blockers, ...input.extraBlockers];
  const warnings = [...input.dependencies.warnings, ...input.extraWarnings];

  for (const inv of input.invariants) if (!inv.ok) blockers.push(`${inv.rule}: ${inv.detail}`);
  for (const c of checks) if (c.verification === "script-missing") blockers.push(`check "${c.name}" runs \`${c.command}\` but package.json has no such script`);
  if (input.criteria.source === "none") warnings.push("issue has no explicit acceptance criteria; the reviewer will judge against the description");
  if (input.toolchain.source === "unresolved") blockers.push(`repository needs Node ${input.toolchain.requested} but it is not on PATH or in nvm (found ${input.toolchain.version ?? "none"})`);
  if (!input.protection.protected) warnings.push(`${input.baseBranch} has no branch protection or rulesets: GitHub will not enforce CI or reviews, so only manual merges are possible`);
  if (input.inspection.headSha !== input.repoInfo.baseSha) {
    warnings.push(`inspected ${input.inspectedRef} at ${input.inspection.headSha.slice(0, 8)}, but ${input.baseBranch} on GitHub is ${input.repoInfo.baseSha.slice(0, 8)}; a live run fetches first`);
  }
  if (input.branchExists.remote && !input.existingPr) warnings.push(`branch ${input.branch} already exists on origin without a PR; a live run would build on it`);
  if (input.existingPr) warnings.push(`PR #${input.existingPr.number} (${input.existingPr.state.toLowerCase()}) already exists for ${input.branch}; a live run reuses it`);
  for (const q of input.agentPlan?.open_questions ?? []) warnings.push(`planner open question: ${q}`);
  if (notCoveredLocally.length) warnings.push(`CI runs steps not in local checks: ${notCoveredLocally.join(", ")}`);

  const perm = (p: Permission) => PermissionGate.wouldAllow(config.permissions, p);
  const act = (id: string, permission: Permission | "read", description: string, command?: string): PlannedAction => {
    const g = permission === "read" ? { allowed: true, reason: "read-only" } : perm(permission);
    return { id, permission, description, ...(command ? { command } : {}), allowedLive: g.allowed, gate: g.reason };
  };

  const impl = input.agents.find((a) => a.role === "implementer")!;
  const rev = input.agents.find((a) => a.role === "reviewer")!;
  const max = config.merge.max_fix_attempts;
  const setupChecks = checks.filter((c) => c.kind === "setup");
  const runChecks = checks.filter((c) => c.kind === "check");

  const stages: PlannedStage[] = [
    {
      state: "PLANNING",
      summary: "Resolve the issue, dependencies and repository; build this plan.",
      actions: [
        act("issue.fetch", "read", `Fetch ${input.issue.key} with comments and relations from Linear`),
        act("repo.inspect", "read", `Inspect ${config.repo}@${input.baseBranch} (protection, scripts, CI, guidance files)`),
        ...(config.agents.planner ? [act("agent.plan", "agents.run", `Read-only planning with ${config.agents.planner.adapter}`)] : []),
      ],
      exits: ["BLOCKED if dependencies are unresolved, the config is inconsistent, or checks cannot run", "otherwise IMPLEMENTING"],
    },
    {
      state: "IMPLEMENTING",
      summary: `${impl.adapter} implements the issue in an isolated worktree; the orchestrator commits the result.`,
      actions: [
        act("git.fetch", "local.worktree", `Fetch origin in ${input.clonePath}`),
        act("git.worktree", "local.worktree", `Create worktree ${input.worktreePath} on new branch ${input.branch} from origin/${input.baseBranch}`, `git worktree add --no-track -b ${input.branch} ${input.worktreePath} origin/${input.baseBranch}`),
        ...setupChecks.map((c) => act(`setup.${c.name}`, "local.checks", `Setup: ${c.name}`, c.command)),
        act("agent.implement", "agents.run", `Start ${impl.adapter} (${impl.model}) as implementer: ${impl.access}`, impl.command),
        act("verify.diff", "read", "Compute changed files with git (agent self-report is not trusted); refuse forbidden paths"),
        act("git.commit", "local.worktree", "Commit the verified changes in the worktree"),
      ],
      exits: ["BLOCKED if the agent fails or makes no changes", "otherwise TESTING"],
    },
    {
      state: "TESTING",
      summary: "Run repository checks in the worktree.",
      actions: runChecks.map((c) => act(`check.${c.name}`, "local.checks", `${c.name}${c.optional ? " (optional)" : ""}, timeout ${c.timeoutMinutes}m`, c.command)),
      exits: [`FIXING if a required check fails (max ${max} correction rounds)`, "FAILED when rounds are exhausted", "otherwise REVIEWING"],
    },
    {
      state: "REVIEWING",
      summary: `${rev.adapter} (${rev.provider}) reviews the diff independently; the orchestrator decides approval from structured findings.`,
      actions: [
        act("agent.review", "agents.run", `Start ${rev.adapter} as reviewer: ${rev.access}`, rev.command),
        act("verify.review", "read", `Approve only if verdict=approve and no ${config.review.blocking_severities.join("/")} findings; reviewed SHA is recorded`),
      ],
      exits: [`FIXING with actionable findings (max ${max} rounds)`, "BLOCKED on malformed reviewer output", "otherwise PR_OPEN"],
    },
    {
      state: "FIXING",
      summary: "Send failing checks or findings back to the same implementer session, then re-test and re-review.",
      actions: [act("agent.fix", "agents.run", `Resume the ${impl.adapter} session with the feedback`), act("git.commit", "local.worktree", "Commit the verified fix")],
      exits: ["TESTING"],
    },
    {
      state: "PR_OPEN",
      summary: "Publish the reviewed commit.",
      actions: [
        act("verify.head", "read", "Verify worktree HEAD equals the reviewed SHA"),
        act("git.push", "github.push", `Push ${input.branch} to origin (never force)`, `git push --set-upstream origin HEAD:refs/heads/${input.branch}`),
        act(
          "github.pr",
          "github.create_pr",
          input.existingPr ? `Reuse PR #${input.existingPr.number}` : `Open a ${config.pull_request.draft ? "draft " : ""}PR into ${input.baseBranch}`,
          `gh pr create --repo ${config.repo} --base ${input.baseBranch} --head ${input.branch}${config.pull_request.draft ? " --draft" : ""}`,
        ),
        act("linear.comment", "linear.comment", `Comment the PR link on ${input.issue.key}`),
      ],
      exits: ["WAITING_FOR_CI"],
    },
    {
      state: "WAITING_FOR_CI",
      summary: "Poll GitHub checks for the PR head.",
      actions: [
        act(
          "github.checks",
          "read",
          input.protection.requiredChecks.length
            ? `Wait for required checks: ${input.protection.requiredChecks.join(", ")}`
            : `Wait for all reported checks (no required checks configured; CI workflows: ${input.inspection.ciWorkflows.map((w) => w.file).join(", ") || "none"})`,
        ),
      ],
      exits: ["FIXING on CI failure (shares the correction budget)", "BLOCKED if the PR head changes after review", "otherwise READY_TO_MERGE"],
    },
    {
      state: "READY_TO_MERGE",
      summary: `Evaluate merge eligibility. merge.mode=${config.merge.mode}.`,
      actions: [
        act("merge.evaluate", "read", "Check CI, independent approval, reviewed SHA == PR head, no blocking findings, GitHub review state"),
        act("linear.comment", "linear.comment", `Report merge eligibility on ${input.issue.key}`),
        config.merge.mode === "auto"
          ? act("github.merge", "github.merge", "Merge with --match-head-commit (only if every auto-merge rule holds)")
          : act("github.merge", "read", "No automatic merge: a human merges the PR (manual mode)"),
      ],
      exits: ["stays READY_TO_MERGE until a human merges (manual)", "MERGED → COMPLETED"],
    },
  ];

  const permissions: Record<string, { allowed: boolean; reason: string }> = {};
  for (const p of ["agents.run", "github.push", "github.create_pr", "github.merge", "linear.comment", "linear.update_state"] as const) permissions[p] = perm(p);

  const autoMergePreview: string[] = [];
  if (config.merge.mode !== "auto") autoMergePreview.push("merge.mode is manual: the orchestrator never merges");
  if (!input.protection.protected) autoMergePreview.push(`${input.baseBranch} is unprotected: auto mode would refuse to merge`);
  if (input.protection.requiredChecks.length === 0) autoMergePreview.push(`${input.baseBranch} has no required status checks: auto mode would refuse to merge`);

  return {
    version: 1,
    runId: input.runId,
    mode: input.mode,
    generatedAt: input.now.toISOString(),
    configSource: input.configSource,
    issue: {
      key: input.issue.key,
      title: input.issue.title,
      url: input.issue.url,
      state: input.issue.state,
      team: input.issue.team,
      project: input.issue.project,
      labels: input.issue.labels,
      priority: input.issue.priority,
      assignee: input.issue.assignee,
      updatedAt: input.issue.updatedAt,
      commentCount: input.issue.comments.length,
    },
    acceptanceCriteria: input.criteria,
    dependencies: input.dependencies,
    repository: {
      repo: config.repo,
      baseBranch: input.baseBranch,
      baseSha: input.repoInfo.baseSha,
      visibility: input.repoInfo.visibility,
      viewerPermission: input.repoInfo.viewerPermission,
      protection: input.protection,
      clonePath: input.clonePath,
      inspectedRef: input.inspectedRef,
      inspectedSha: input.inspection.headSha,
      packageManager: input.inspection.packageManager,
      nodeEngine: input.inspection.nodeEngine,
      guidanceFiles: input.inspection.guidanceFiles,
      workspaces: input.inspection.workspaces,
    },
    toolchain: input.toolchain,
    workspace: {
      branch: input.branch,
      worktreePath: input.worktreePath,
      branchExists: input.branchExists,
      existingPr: input.existingPr ? { number: input.existingPr.number, url: input.existingPr.url, state: input.existingPr.state } : null,
    },
    agents: input.agents,
    invariants: input.invariants,
    checks,
    ci: { workflows: input.inspection.ciWorkflows.map((w) => w.file), steps: ciSteps, notCoveredLocally },
    policy: { merge: config.merge, reviewBlockingSeverities: config.review.blocking_severities, permissions, autoMergePreview },
    agentPlan: input.agentPlan,
    stages,
    blockers,
    warnings,
  };
}
