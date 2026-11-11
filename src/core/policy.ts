import type { BranchProtection, PullRequestStatus } from "../adapters/types.js";
import type { MergePolicy, Permissions, RepoConfig } from "../config/schema.js";

/**
 * Every external side effect is named by a permission. The gate answers
 * "may this run perform it?" from operator config plus run mode. Agents
 * cannot influence the answer.
 */
export type Permission =
  | "local.worktree" // create a worktree / commit locally (orchestrator-owned paths)
  | "local.checks" // run configured commands in the worktree
  | "agents.run" // start a coding agent
  | "github.push"
  | "github.create_pr"
  | "github.merge"
  | "linear.comment"
  | "linear.update_state";

export interface GateDecision {
  allowed: boolean;
  reason: string;
}

export class PermissionGate {
  constructor(
    private readonly permissions: Permissions,
    private readonly mode: "dry_run" | "supervised",
  ) {}

  check(permission: Permission): GateDecision {
    if (this.mode === "dry_run") return { allowed: false, reason: "dry run: no side effects" };
    switch (permission) {
      case "local.worktree":
      case "local.checks":
        return { allowed: true, reason: "orchestrator-owned workspace" };
      case "agents.run":
        return grant(this.permissions.agents.run, "permissions.agents.run");
      case "github.push":
        return grant(this.permissions.github.push, "permissions.github.push");
      case "github.create_pr":
        return grant(this.permissions.github.create_pr, "permissions.github.create_pr");
      case "github.merge":
        return grant(this.permissions.github.merge, "permissions.github.merge");
      case "linear.comment":
        return grant(this.permissions.linear.comment, "permissions.linear.comment");
      case "linear.update_state":
        return grant(this.permissions.linear.update_state, "permissions.linear.update_state");
    }
  }

  /** What a supervised run would be allowed to do; used to explain dry runs. */
  static wouldAllow(permissions: Permissions, permission: Permission): GateDecision {
    return new PermissionGate(permissions, "supervised").check(permission);
  }
}

function grant(flag: boolean, name: string): GateDecision {
  return flag ? { allowed: true, reason: `${name}=true` } : { allowed: false, reason: `${name} is not granted in the repository config` };
}

// ---- merge eligibility -------------------------------------------------------------

export interface MergeInputs {
  config: Pick<RepoConfig, "repo" | "merge" | "permissions">;
  pr: PullRequestStatus;
  protection: BranchProtection;
  /** Head SHA the independent reviewer approved. */
  reviewedSha: string | null;
  reviewApproved: boolean;
  unresolvedBlockingFindings: number;
  /** Acceptance criteria the independent reviewer found not met on the reviewed commit. */
  unmetCriteria?: number;
  /** GitHub login the orchestrator is acting as. */
  actor: string;
}

export interface MergeEligibility {
  /** A human may merge: every policy requirement holds. */
  eligible: boolean;
  /** The orchestrator may merge on its own. Implies eligible. */
  autoMerge: boolean;
  ciState: "pass" | "fail" | "pending" | "none";
  reasons: string[];
  autoMergeBlockers: string[];
}

export function ciState(pr: PullRequestStatus, requiredChecks: string[]): MergeEligibility["ciState"] {
  const relevant = requiredChecks.length > 0 ? pr.checks.filter((c) => requiredChecks.includes(c.name)) : pr.checks;
  const missingRequired = requiredChecks.filter((name) => !pr.checks.some((c) => c.name === name));
  if (relevant.length === 0 && missingRequired.length === 0) return "none";
  if (relevant.some((c) => c.bucket === "fail")) return "fail";
  if (missingRequired.length > 0 || relevant.some((c) => c.bucket === "pending")) return "pending";
  return "pass";
}

export function evaluateMerge(input: MergeInputs): MergeEligibility {
  const { config, pr, protection } = input;
  const merge: MergePolicy = config.merge;
  const reasons: string[] = [];
  const ci = ciState(pr, protection.requiredChecks);

  if (pr.state !== "OPEN") reasons.push(`PR is ${pr.state.toLowerCase()}`);
  if (pr.mergeable === "CONFLICTING") reasons.push("PR has merge conflicts");
  if (merge.require_ci) {
    if (ci === "fail") reasons.push("CI is failing");
    else if (ci === "pending") reasons.push("CI is still running");
    else if (ci === "none") reasons.push("no CI checks reported for the PR head");
  }
  if (merge.require_independent_review) {
    if (!input.reviewApproved) reasons.push("no independent review approval");
    if (!input.reviewedSha) reasons.push("no reviewed commit recorded");
    else if (input.reviewedSha !== pr.headSha) {
      reasons.push(`PR head ${pr.headSha.slice(0, 8)} differs from reviewed commit ${input.reviewedSha.slice(0, 8)} (unexpected changes after review)`);
    }
  }
  if (input.unresolvedBlockingFindings > 0) reasons.push(`${input.unresolvedBlockingFindings} unresolved blocking finding(s)`);
  if ((input.unmetCriteria ?? 0) > 0) reasons.push(`${input.unmetCriteria} acceptance criteria not met`);
  if (pr.reviewDecision === "CHANGES_REQUESTED") reasons.push("a GitHub reviewer requested changes");
  if (protection.requiredApprovals > 0 && pr.reviewDecision !== "APPROVED") {
    reasons.push(`branch requires ${protection.requiredApprovals} approving GitHub review(s)`);
  }

  const eligible = reasons.length === 0;
  const autoMergeBlockers: string[] = [];
  if (merge.mode !== "auto") autoMergeBlockers.push("merge.mode is manual");
  else {
    const auth = merge.auto_authorization;
    if (!auth) autoMergeBlockers.push("no merge.auto_authorization");
    else {
      if (auth.repo !== config.repo) autoMergeBlockers.push(`authorization is for ${auth.repo}, not ${config.repo}`);
      if (auth.actor !== input.actor) autoMergeBlockers.push(`acting identity ${input.actor} is not the authorized actor ${auth.actor}`);
    }
    if (!config.permissions.github.merge) autoMergeBlockers.push("permissions.github.merge is not granted");
    // Unattended merges rely on GitHub to enforce the rules, not only on us.
    if (!protection.protected) autoMergeBlockers.push(`base branch ${protection.branch} is not protected`);
    if (protection.requiredChecks.length === 0) autoMergeBlockers.push(`base branch ${protection.branch} has no required status checks`);
    if (pr.isDraft) autoMergeBlockers.push("PR is a draft");
    if (pr.mergeStateStatus !== "CLEAN") autoMergeBlockers.push(`GitHub merge state is ${pr.mergeStateStatus}, not CLEAN`);
    if (process.env.ORCHESTRATOR_DISABLE_MERGE === "1") autoMergeBlockers.push("ORCHESTRATOR_DISABLE_MERGE=1");
  }
  if (!eligible) autoMergeBlockers.unshift("not merge-eligible");

  return { eligible, autoMerge: eligible && autoMergeBlockers.length === 0, ciState: ci, reasons, autoMergeBlockers };
}
