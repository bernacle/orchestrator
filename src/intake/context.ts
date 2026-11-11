import type { Issue } from "../adapters/types.js";
import type { App } from "../app.js";
import { sandboxSupport } from "../core/isolation.js";
import { describeTrustState } from "../core/trust.js";
import type { RunRecord } from "../core/store.js";
import type { RunContext } from "../core/workflow.js";
import { cliInvocation, summarizeRun, type RunSummary } from "../report/summary.js";
import { evaluateAssociation, type AssociationResult } from "./association.js";
import { parseIssueRef, type IssueRef } from "./issue-ref.js";
import { configStatus, selectRepository, type ConfigStatus, type RepoSelection } from "./resolve.js";

/**
 * Everything the engine can establish about a request *without* starting anything: the issue
 * reference, the repository, its authorization, Linear credentials, the issue/repository
 * association, existing runs, the execution modes available, and what to do next.
 *
 * `orchestrator context` prints this; `startRun` goes through the same function, so a skill's
 * preparation and the engine's own gate cannot disagree.
 */

export type ProblemCode =
  | "repository_unresolved"
  | "needs_configuration"
  | "invalid_configuration"
  | "linear_auth"
  | "linear_issue"
  | "workspace_mismatch"
  | "association_unverified"
  | "active_run_exists";

export interface Problem {
  code: ProblemCode;
  message: string;
}

export interface NextAction {
  id: string;
  command: string;
  description: string;
  /** The user must approve this in the conversation before an agent runs it. */
  needsUserApproval: boolean;
  /** Must be run by the user in their own terminal (credential entry). */
  userRunsIt?: boolean;
  /** The repository is trusted: the engine starts this without a per-run system prompt. */
  trusted?: boolean;
}

export interface ExecutionMode {
  id: "dry_run" | "dry_run_with_agent_plan" | "supervised";
  command: string;
  available: boolean;
  description: string;
  missing: string[];
  /** Live mode only: how the engine authorizes it ("trusted": no per-run prompt; "per_run_approval": a system prompt). */
  authorization?: "trusted" | "per_run_approval";
}

export interface RequestContext {
  request: { input: string; issue: IssueRef; cwd: string };
  repository: Omit<RepoSelection, "discovery"> & {
    worktree: { root: string | null; mainCheckout: string | null; linked: boolean; t3: boolean } | null;
    remotes: Array<{ name: string; url: string; github: string | null; note?: string }>;
  };
  configuration:
    | { status: "authorized"; source: string; scope: string; authorizedBy: string | null; authorizedAt: string | null; permissions: unknown; limits: unknown; merge: { mode: string }; agents: Record<string, string> }
    | { status: "missing"; expected: string }
    | { status: "invalid"; error: string }
    | { status: "unknown" };
  linear: { source: string; workspace: string | null; problem: string | null };
  issue: { fetched: boolean; key: string; title?: string; url?: string; state?: string; team?: string; project?: string | null; error?: string; fromSnapshot?: boolean };
  association: AssociationResult | null;
  runs: { active: RunSummary[]; recent: RunSummary[] };
  modes: ExecutionMode[];
  /** How a person approves a live run here (enforced by the engine, not by the skill). */
  approval: { channel: string; available: boolean; detail: string } | null;
  /**
   * The repository's authorization mode, as the engine will apply it (core/trust.ts). "trusted":
   * live runs and resumes start without a per-run prompt. Anything else: supervised, every live run
   * and resume asks. Only `orchestrator repo trust` (with a system prompt) can make it trusted.
   */
  trust: { mode: "trusted" | "supervised"; status: "trusted" | "untrusted" | "stale" | "invalid"; detail: string; trustedBy: string | null; trustedAt: string | null; changed: string[]; renew: string | null } | null;
  problems: Problem[];
  warnings: string[];
  nextActions: NextAction[];
}

export interface InspectInput {
  issueRef: string;
  repo?: string;
  configFile?: string;
  cwd?: string;
  /** Replayed issue (dry runs from a snapshot); skips Linear. */
  snapshotIssue?: Issue;
  /** Override the workspace used to choose a stored Linear key. */
  linearWorkspace?: string;
  /** Read the issue from Linear (needed for the association check). Default true. */
  fetchIssue?: boolean;
}

export async function inspectRequest(app: App, input: InspectInput): Promise<RequestContext & { loaded: Extract<ConfigStatus, { status: "authorized" }>["loaded"] | null; selection: RepoSelection; fetchedIssue: Issue | null }> {
  const ref = parseIssueRef(input.issueRef);
  const cwd = input.cwd ?? process.cwd();
  const problems: Problem[] = [];
  const warnings: string[] = [];
  const cli = cliInvocation(app.env);

  const selection = await selectRepository({
    ...(input.repo ? { repo: input.repo } : {}),
    ...(input.configFile ? { configFile: input.configFile } : {}),
    cwd,
    issueKey: ref.key,
    paths: app.paths,
    deps: app.discovery,
  });
  warnings.push(...selection.warnings);
  const d = selection.discovery;
  const repository: RequestContext["repository"] = {
    status: selection.status,
    repo: selection.repo,
    source: selection.source,
    reason: selection.reason,
    candidates: selection.candidates,
    warnings: selection.warnings,
    worktree: d?.inGitRepo ? { root: d.worktreeRoot, mainCheckout: d.mainCheckout, linked: d.isLinkedWorktree, t3: d.t3Worktree } : null,
    remotes: (d?.remotes ?? []).map((r) => ({ name: r.name, url: r.url, github: r.github?.repo ?? null, ...(r.note ? { note: r.note } : {}) })),
  };
  if (selection.status !== "resolved") problems.push({ code: "repository_unresolved", message: selection.reason });

  // ---- configuration (operator-owned only)
  let cfg: ConfigStatus | null = null;
  let configuration: RequestContext["configuration"] = { status: "unknown" };
  if (selection.repo) {
    cfg = configStatus(selection.repo, app.paths, input.configFile);
    if (cfg.status === "authorized") {
      const c = cfg.loaded.config;
      configuration = {
        status: "authorized",
        source: cfg.loaded.source,
        scope: cfg.scope,
        authorizedBy: cfg.authorizedBy,
        authorizedAt: cfg.authorizedAt,
        permissions: c.permissions,
        limits: c.limits,
        merge: { mode: c.merge.mode },
        agents: Object.fromEntries(Object.entries(c.agents).filter(([, v]) => v).map(([k, v]) => [k, v!.adapter])),
      };
    } else if (cfg.status === "missing") {
      configuration = cfg;
      problems.push({ code: "needs_configuration", message: `${selection.repo} has no orchestrator configuration yet. First use needs a proposal and your authorization (nothing in the repository can grant it).` });
    } else {
      configuration = cfg;
      problems.push({ code: "invalid_configuration", message: cfg.error });
    }
  }
  const loaded = cfg?.status === "authorized" ? cfg.loaded : null;

  // ---- Linear workspace + credentials
  const configWorkspace = loaded?.config.linear.workspace?.toLowerCase() ?? null;
  if (ref.workspace && configWorkspace && ref.workspace !== configWorkspace) {
    problems.push({ code: "workspace_mismatch", message: `the URL is from Linear workspace "${ref.workspace}", but ${selection.repo} is configured for "${configWorkspace}" (linear.workspace)` });
  }
  const workspace = input.linearWorkspace?.toLowerCase() ?? ref.workspace ?? configWorkspace;
  const needsLinear = !input.snapshotIssue && input.fetchIssue !== false;
  const resolved = needsLinear ? app.trackerFor(workspace) : null;
  const linear = resolved
    ? { source: resolved.credential.source, workspace: resolved.credential.workspace ?? workspace, problem: resolved.credential.problem }
    : { source: input.snapshotIssue ? "issue snapshot" : "not checked", workspace, problem: null };
  if (linear.problem) problems.push({ code: "linear_auth", message: linear.problem });

  // ---- the issue (needed to check the association)
  let fetchedIssue: Issue | null = input.snapshotIssue ?? null;
  const issue: RequestContext["issue"] = { fetched: false, key: ref.key };
  const tracker = resolved?.tracker;
  if (!fetchedIssue && tracker && !linear.problem) {
    try {
      fetchedIssue = await tracker.getIssue(ref.key);
    } catch (err) {
      issue.error = (err as Error).message;
      problems.push({ code: "linear_issue", message: `could not read ${ref.key} from Linear: ${issue.error}` });
    }
  }
  if (fetchedIssue) {
    Object.assign(issue, { fetched: true, title: fetchedIssue.title, url: fetchedIssue.url, state: fetchedIssue.state.name, team: fetchedIssue.team.key, project: fetchedIssue.project, ...(input.snapshotIssue ? { fromSnapshot: true } : {}) });
    if (ref.workspace && fetchedIssue.url && !fetchedIssue.url.toLowerCase().includes(`linear.app/${ref.workspace}/`)) {
      problems.push({ code: "workspace_mismatch", message: `the URL names workspace "${ref.workspace}", but the credential resolved ${ref.key} at ${fetchedIssue.url}` });
    }
  }

  // ---- association (explicit selection is itself the operator's statement)
  let association: AssociationResult | null = null;
  if (selection.repo && loaded) {
    if (selection.source === "explicit" || selection.source === "config_file") {
      association = { verified: true, evidence: [{ kind: "explicit_repo", detail: selection.source === "explicit" ? `repository selected explicitly with --repo ${selection.repo}` : `repository from the explicit config file ${input.configFile}` }], conflicts: [], remedy: null };
    } else if (fetchedIssue) {
      association = evaluateAssociation({ issue: fetchedIssue, repo: selection.repo, config: loaded.config, paths: app.paths, explicitRepo: false, workspace: linear.workspace });
      if (!association.verified) problems.push({ code: "association_unverified", message: association.remedy! });
    }
    if (association?.conflicts.length) warnings.push(`the issue also links to ${association.conflicts.join(", ")}`);
  }

  // ---- existing runs
  const runs = { active: [] as RunSummary[], recent: [] as RunSummary[] };
  if (selection.repo) {
    const all = app.store.runsFor(ref.key, selection.repo, 10) as Array<RunRecord<RunContext>>;
    runs.active = all.filter((r) => r.mode === "supervised" && !["COMPLETED", "FAILED", "CANCELLED"].includes(r.state)).map((r) => summarizeRun(app.store, r));
    runs.recent = all.slice(0, 5).map((r) => summarizeRun(app.store, r));
    if (runs.active.length) problems.push({ code: "active_run_exists", message: `${ref.key} already has an active run on ${selection.repo}: ${runs.active.map((r) => `${r.id} (${r.state}${r.driving ? ", running now" : ""})`).join(", ")}. Inspect or resume it instead of starting another.` });
  }

  // ---- modes the engine can actually execute
  const repoFlag = selection.source === "explicit" || selection.source === "config_file" ? ` --repo ${selection.repo}` : "";
  const target = `${cli} run ${ref.input.trim()}${repoFlag}`;
  const missingForAny = problems.filter((p) => p.code !== "active_run_exists").map((p) => p.message);
  const dryMissing = missingForAny;
  const perms = loaded?.config.permissions;
  const liveMissing = [...missingForAny];
  if (runs.active.length) liveMissing.push("an active run exists for this issue");
  if (loaded) {
    if (!perms!.agents.run) liveMissing.push("permissions.agents.run is not granted");
    if (!perms!.github.push) liveMissing.push("permissions.github.push is not granted");
    if (!perms!.github.create_pr) liveMissing.push("permissions.github.create_pr is not granted");
    const sb = sandboxSupport();
    if (!sb.available && loaded.config.isolation.require) liveMissing.push(`no sandbox: ${sb.detail}`);
  }
  if (app.env.ORCHESTRATOR_NO_EXECUTE) liveMissing.push("ORCHESTRATOR_NO_EXECUTE is set: live runs are disabled in this environment");
  const trustState = loaded ? app.trust.evaluate(loaded) : null;
  const trusted = trustState?.status === "trusted";
  const trust: RequestContext["trust"] = trustState
    ? {
        mode: trusted ? "trusted" : "supervised",
        status: trustState.status,
        detail: describeTrustState(trustState),
        trustedBy: trustState.status === "trusted" || trustState.status === "stale" ? trustState.record.trustedBy : null,
        trustedAt: trustState.status === "trusted" || trustState.status === "stale" ? trustState.record.trustedAt : null,
        changed: trustState.status === "stale" ? trustState.changed : [],
        renew: trustState.status === "stale" || trustState.status === "invalid" ? `${cli} repo trust ${loaded!.config.repo}` : null,
      }
    : null;
  if (trustState && (trustState.status === "stale" || trustState.status === "invalid")) warnings.push(describeTrustState(trustState));
  const approval = app.approvalStatus ? await app.approvalStatus() : null;
  // A trusted repository needs no prompt to start; without trust, a live run needs one that can be shown.
  if (approval && !approval.available && !trusted) liveMissing.push(approval.detail);
  const modes: ExecutionMode[] = [
    { id: "dry_run", command: `${target} --dry-run --json`, available: dryMissing.length === 0, description: "plan and simulate: reads Linear and GitHub, fetches into the orchestrator's own clone, changes nothing", missing: dryMissing },
    {
      id: "dry_run_with_agent_plan",
      command: `${target} --dry-run --with-agent-plan --json`,
      available: dryMissing.length === 0 && Boolean(loaded?.config.agents.planner),
      description: `dry run plus the read-only planner agent${loaded?.config.agents.planner?.adapter === "claude-code" && loaded.config.agents.planner.max_budget_usd ? ` (up to $${loaded.config.agents.planner.max_budget_usd})` : ""}; changes nothing`,
      missing: loaded && !loaded.config.agents.planner ? [...dryMissing, "no planner agent configured"] : dryMissing,
    },
    {
      id: "supervised",
      command: `${target} --execute`,
      available: liveMissing.length === 0,
      description: `${trusted ? "live run in a trusted repository (no per-run prompt)" : "supervised live run"}: isolated worktree, ${loaded?.config.agents.implementer.adapter ?? "implementer"} implements, ${loaded?.config.agents.reviewer.adapter ?? "reviewer"} reviews, branch pushed, draft PR opened; merge stays ${loaded?.config.merge.mode ?? "manual"}`,
      missing: liveMissing,
      authorization: trusted ? "trusted" : "per_run_approval",
    },
  ];

  // ---- next actions, most urgent first
  const next: NextAction[] = [];
  const has = (code: ProblemCode) => problems.some((p) => p.code === code);
  if (has("repository_unresolved")) {
    for (const cand of selection.candidates) next.push({ id: "choose_repository", command: `${cli} context ${ref.input.trim()} --repo ${cand.repo} --json`, description: `use ${cand.repo}${cand.configured ? " (configured)" : ""}`, needsUserApproval: true });
    if (!selection.candidates.length) next.push({ id: "choose_repository", command: `${cli} context ${ref.input.trim()} --repo OWNER/NAME --json`, description: "name the GitHub repository explicitly", needsUserApproval: true });
  }
  if (has("needs_configuration")) {
    next.push({ id: "propose_configuration", command: `${cli} repo init${repoFlag || (selection.repo ? ` --repo ${selection.repo}` : "")} --team ${fetchedIssue?.team.key ?? ref.key.split("-")[0]} --json`, description: "discover the repository's checks and write a pending proposal (grants nothing)", needsUserApproval: false });
    next.push({ id: "authorize_repository", command: `${cli} repo authorize ${selection.repo}`, description: "authorize the reviewed proposal; the user confirms a system prompt (add --read-only to grant no remote writes)", needsUserApproval: true });
  }
  if (has("linear_auth")) next.push({ id: "linear_login", command: `${cli} auth linear login${workspace ? ` --workspace ${workspace}` : ""}`, description: "store a Linear API key once (the user runs this in a terminal; never paste keys into chat)", needsUserApproval: true, userRunsIt: true });
  if (has("association_unverified")) next.push({ id: "confirm_association", command: `${cli} associate ${ref.key} --repo ${selection.repo}`, description: `record that ${ref.key} is ${selection.repo} work; the user confirms a system prompt`, needsUserApproval: true });
  for (const r of runs.active) {
    next.push({ id: "inspect_run", command: `${cli} status ${r.id} --json`, description: `inspect ${r.id} (${r.state})`, needsUserApproval: false });
    if (!r.driving) next.push({ id: "resume_run", command: `${cli} resume ${r.id}`, description: `resume ${r.id} from ${r.state}${r.blockedFrom ? ` (blocked in ${r.blockedFrom})` : ""}${trusted ? "; trusted repository: no per-run prompt" : ""}`, needsUserApproval: true, ...(trusted ? { trusted: true } : {}) });
  }
  if (problems.length === 0) {
    next.push({ id: "dry_run", command: modes[0]!.command, description: modes[0]!.description, needsUserApproval: false });
    if (modes[2]!.available) {
      next.push(
        trusted
          ? { id: "execute", command: modes[2]!.command, description: `${modes[2]!.description}. The user trusted ${loaded!.config.repo} (orchestrator repo trust), so the engine starts it without a system prompt; the user's request to implement the issue with Orchestrator is the go-ahead`, needsUserApproval: false, trusted: true }
          : { id: "execute", command: modes[2]!.command, description: `${modes[2]!.description}. The CLI asks the user to confirm with Touch ID / password on this Mac before anything starts`, needsUserApproval: true },
      );
    }
  }

  return {
    request: { input: input.issueRef, issue: ref, cwd },
    repository,
    configuration,
    linear,
    issue,
    association,
    runs,
    modes,
    approval,
    trust,
    problems,
    warnings,
    nextActions: next,
    loaded,
    selection,
    fetchedIssue,
  };
}

/** The JSON view (drops internal handles). */
export function publicContext(ctx: Awaited<ReturnType<typeof inspectRequest>>): RequestContext {
  const { loaded: _l, selection: _s, fetchedIssue: _f, ...rest } = ctx;
  return rest;
}
