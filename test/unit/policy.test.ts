import { describe, expect, it } from "vitest";
import type { BranchProtection, PullRequestStatus } from "../../src/adapters/types.js";
import { RepoConfigSchema } from "../../src/config/schema.js";
import { ciState, evaluateMerge, PermissionGate } from "../../src/core/policy.js";

const SHA = "a".repeat(40);
const pr = (over: Partial<PullRequestStatus> = {}): PullRequestStatus => ({
  number: 7,
  url: "https://github.com/o/r/pull/7",
  state: "OPEN",
  isDraft: false,
  headRefName: "orch/x",
  headSha: SHA,
  baseRefName: "main",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  checks: [{ name: "CI", bucket: "pass" }],
  ...over,
});
const protectedMain: BranchProtection = { branch: "main", protected: true, requiredChecks: ["CI"], requiredApprovals: 0, rulesetTypes: ["required_status_checks"], notes: [] };
const unprotected: BranchProtection = { ...protectedMain, protected: false, requiredChecks: [], rulesetTypes: [] };

const config = (merge: Record<string, unknown> = {}, permissions: Record<string, unknown> = {}) =>
  RepoConfigSchema.parse({
    repo: "o/r",
    linear: { teams: ["O"] },
    agents: { implementer: { adapter: "claude-code" }, reviewer: { adapter: "codex" } },
    permissions,
    merge,
  });

const autoConfig = () =>
  config({ mode: "auto", auto_authorization: { repo: "o/r", authorized_by: "owner", authorized_at: "2026-11-06", actor: "bot" } }, { github: { merge: true } });

const base = { reviewedSha: SHA, reviewApproved: true, unresolvedBlockingFindings: 0, actor: "bot" };

describe("evaluateMerge", () => {
  it("manual mode: eligible but never auto-merges", () => {
    const r = evaluateMerge({ ...base, config: config(), pr: pr(), protection: protectedMain });
    expect(r.eligible).toBe(true);
    expect(r.autoMerge).toBe(false);
    expect(r.autoMergeBlockers).toContain("merge.mode is manual");
  });

  it("auto mode merges only when everything holds", () => {
    expect(evaluateMerge({ ...base, config: autoConfig(), pr: pr(), protection: protectedMain }).autoMerge).toBe(true);
  });

  it.each([
    ["unprotected base", { protection: unprotected }, /not protected/],
    ["draft PR", { pr: pr({ isDraft: true }) }, /draft/],
    ["wrong actor", { actor: "intruder" }, /not the authorized actor/],
    ["head moved after review", { pr: pr({ headSha: "b".repeat(40) }) }, /unexpected changes after review/],
    ["CI failing", { pr: pr({ checks: [{ name: "CI", bucket: "fail" }] }) }, /CI is failing/],
    ["CI pending", { pr: pr({ checks: [{ name: "CI", bucket: "pending" }] }) }, /CI is still running/],
    ["no approval", { reviewApproved: false }, /no independent review approval/],
    ["blocking findings", { unresolvedBlockingFindings: 2 }, /2 unresolved blocking/],
    ["GitHub changes requested", { pr: pr({ reviewDecision: "CHANGES_REQUESTED" }) }, /requested changes/],
    ["conflicts", { pr: pr({ mergeable: "CONFLICTING" }) }, /conflicts/],
  ])("auto mode refuses: %s", (_name, over, pattern) => {
    const r = evaluateMerge({ ...base, config: autoConfig(), pr: pr(), protection: protectedMain, ...over });
    expect(r.autoMerge).toBe(false);
    expect([...r.reasons, ...r.autoMergeBlockers].join(" | ")).toMatch(pattern);
  });

  it("honours the ORCHESTRATOR_DISABLE_MERGE kill switch", () => {
    process.env.ORCHESTRATOR_DISABLE_MERGE = "1";
    try {
      expect(evaluateMerge({ ...base, config: autoConfig(), pr: pr(), protection: protectedMain }).autoMerge).toBe(false);
    } finally {
      delete process.env.ORCHESTRATOR_DISABLE_MERGE;
    }
  });
});

describe("ciState", () => {
  it("treats a missing required check as pending", () => {
    expect(ciState(pr({ checks: [] }), ["CI"])).toBe("pending");
  });
  it("only considers required checks when some are configured", () => {
    expect(ciState(pr({ checks: [{ name: "CI", bucket: "pass" }, { name: "flaky", bucket: "fail" }] }), ["CI"])).toBe("pass");
  });
  it("reports none when nothing ran and nothing is required", () => {
    expect(ciState(pr({ checks: [] }), [])).toBe("none");
  });
});

describe("PermissionGate", () => {
  it("denies everything in dry runs", () => {
    const g = new PermissionGate(config({}, { agents: { run: true }, github: { push: true } }).permissions, "dry_run");
    expect(g.check("agents.run").allowed).toBe(false);
    expect(g.check("local.worktree").allowed).toBe(false);
  });
  it("grants only what the config grants", () => {
    const g = new PermissionGate(config({}, { agents: { run: true } }).permissions, "supervised");
    expect(g.check("agents.run").allowed).toBe(true);
    expect(g.check("github.push")).toEqual({ allowed: false, reason: "permissions.github.push is not granted in the repository config" });
    expect(g.check("github.merge").allowed).toBe(false);
  });
});
