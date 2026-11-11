import { describe, expect, it } from "vitest";
import { makeIssue } from "../../src/adapters/mock/index.js";
import { RepoConfigSchema } from "../../src/config/schema.js";
import { evaluateMerge } from "../../src/core/policy.js";
import { describeTrust, trustEligibility, trustScope } from "../../src/core/trust.js";
import { deriveAdditionalCriteria, MAX_CRITERIA, numberCriteria } from "../../src/planning/issue.js";
import { parseAgentPlan } from "../../src/planning/plan.js";
import { prOwnedByRun, prOwnerMarker, pullRequestBody } from "../../src/planning/prompts.js";
import { criteriaReport, declinedAll, decideReview, parseImplementerReport, parseReview, REVIEW_OUTPUT_SCHEMA, type Criterion } from "../../src/planning/review.js";

const criteria: Criterion[] = [
  { id: "AC1", text: "renders two themes", source: "issue" },
  { id: "AC2", text: "keeps axes readable", source: "planner" },
];
const f = (id: string, severity: string, actionable?: boolean) => ({ id, severity, file: null, line: null, title: id, detail: "", suggestion: null, ...(actionable === undefined ? {} : { actionable }) });
const verdicts = (...s: string[]) => s.map((status, i) => ({ id: `AC${i + 1}`, status, evidence: `e${i + 1}` }));

describe("review decision", () => {
  it("a criterion found not met blocks an approval, like a major finding", () => {
    const d = decideReview(parseReview({ verdict: "approve", summary: "", findings: [], criteria: verdicts("met", "not_met") }), ["blocker", "major"], criteria);
    expect(d.approved).toBe(false);
    expect(d.unmetCriteria.map((c) => c.id)).toEqual(["AC2"]);
    expect(d.reasons.join(" ")).toMatch(/acceptance criteria not met: AC2/);
  });

  it("a criterion with no verdict, or an unknown one, needs a person and is never met", () => {
    const d = decideReview(parseReview({ verdict: "approve", summary: "", findings: [], criteria: [{ id: "ac1", status: "probably", evidence: "" }] }), ["blocker", "major"], criteria);
    expect(d.approved).toBe(true);
    expect(d.criteria.map((c) => c.status)).toEqual(["needs_human", "needs_human"]);
    expect(d.needsHuman[1]!.evidence).toMatch(/no verdict/);
  });

  it("only actionable, non-blocking minor findings go to the minor round; never nits", () => {
    const d = decideReview(
      parseReview({ verdict: "approve", summary: "", findings: [f("M1", "minor", true), f("M2", "minor"), f("M3", "minor", false), f("N1", "nit", true)], criteria: [] }),
      ["blocker", "major"],
    );
    expect(d.actionableMinor.map((x) => x.id)).toEqual(["M1", "M2"]);
    // Minor configured as blocking is a correction, not a minor round.
    expect(decideReview(parseReview({ verdict: "approve", summary: "", findings: [f("M1", "minor")], criteria: [] }), ["blocker", "major", "minor"]).actionableMinor).toEqual([]);
  });

  it("older reviews without criteria still decide as before", () => {
    const d = decideReview({ verdict: "approve", summary: "", findings: [] }, ["blocker", "major"]);
    expect(d.approved).toBe(true);
    expect(d.criteria).toEqual([]);
  });

  it("the review schema requires criteria and actionable for structured-output APIs", () => {
    expect(REVIEW_OUTPUT_SCHEMA.required).toContain("criteria");
    expect(REVIEW_OUTPUT_SCHEMA.properties.findings.items.required).toContain("actionable");
  });

  it("a criterion judged twice keeps its worst verdict", () => {
    const d = decideReview(
      parseReview({ verdict: "approve", summary: "", findings: [], criteria: [...verdicts("not_met", "met"), { id: "ac1", status: "met", evidence: "" }] }),
      ["blocker", "major"],
      criteria,
    );
    expect(d.approved).toBe(false);
    expect(d.criteria[0]!.status).toBe("not_met");
  });

  it("criteriaReport keeps every criterion in order", () => {
    expect(criteriaReport(null, criteria).map((c) => [c.id, c.status])).toEqual([
      ["AC1", "needs_human"],
      ["AC2", "needs_human"],
    ]);
  });
});

describe("implementer report", () => {
  it("parses dispositions and drops malformed ones", () => {
    const r = parseImplementerReport({ summary: "s", findings: [{ id: "R1", status: "fixed", note: "x" }, { id: "R2", status: "maybe" }, { status: "declined" }] });
    expect(r?.findings).toEqual([{ id: "R1", status: "fixed", note: "x" }]);
    expect(parseImplementerReport("nope")).toBeNull();
  });

  it("declinedAll needs every requested id declined with a reason", () => {
    const report = { summary: "", findings: [{ id: "F1", status: "declined" as const, note: "out of scope" }, { id: "AC2", status: "declined" as const, note: "" }] };
    expect(declinedAll(report, ["F1"])).toBe(true);
    expect(declinedAll(report, ["f1"])).toBe(true);
    expect(declinedAll(report, ["F1", "AC2"])).toBe(false); // AC2 has no reason
    expect(declinedAll(report, ["F1", "F9"])).toBe(false);
    expect(declinedAll(null, ["F1"])).toBe(false);
    expect(declinedAll(report, [])).toBe(false);
  });
});

describe("criteria from the planner", () => {
  it("adds only requirements the issue's own list does not state, capped", () => {
    expect(deriveAdditionalCriteria(["Renders two themes."], ["renders two themes", "Axes stay readable", "axes stay readable!"])).toEqual(["Axes stay readable"]);
    // Non-Latin text is compared, not dropped.
    expect(deriveAdditionalCriteria(["Gráfico legível"], ["gráfico legível", "Добавить тесты"])).toEqual(["Добавить тесты"]);
    const many = Array.from({ length: 30 }, (_, i) => `req ${i}`);
    expect(deriveAdditionalCriteria(["a", "b"], many)).toHaveLength(MAX_CRITERIA - 2);
  });

  it("numbers the issue's criteria first and never drops them", () => {
    const n = numberCriteria({ criteria: ["a", "b"], derived: ["c"] });
    expect(n).toEqual([
      { id: "AC1", text: "a", source: "issue" },
      { id: "AC2", text: "b", source: "issue" },
      { id: "AC3", text: "c", source: "planner" },
    ]);
    expect(numberCriteria({ criteria: Array.from({ length: 20 }, (_, i) => `x${i}`) })).toHaveLength(20);
    expect(numberCriteria(undefined)).toEqual([]);
  });

  it("parses the planner's acceptance_criteria, tolerating older plans", () => {
    expect(parseAgentPlan({ summary: "s", acceptance_criteria: [" one ", "", 3] })?.acceptance_criteria).toEqual(["one"]);
    expect(parseAgentPlan({ summary: "s" })?.acceptance_criteria).toEqual([]);
  });
});

describe("PR description", () => {
  const base = {
    issue: makeIssue({ key: "ACM-1" }),
    runId: "acm-1-abc123",
    changedFiles: [{ status: "A", path: "x.ts" }],
    checks: [],
    review: { verdict: "approve" as const, summary: "ok", findings: [] },
    attempts: 1,
    implementer: "claude-code",
    reviewer: "codex",
    reviewedSha: "b".repeat(40),
  };

  it("ticks only criteria the reviewer found met and flags the rest at the top", () => {
    const body = pullRequestBody({
      ...base,
      criteria: [
        { ...criteria[0]!, status: "met", evidence: "test covers it" },
        { ...criteria[1]!, status: "needs_human", evidence: "a design call" },
      ],
    });
    expect(body).toContain("- [x] **AC1** renders two themes: test covers it");
    expect(body).toContain("- [ ] **AC2** keeps axes readable _(derived from the issue's scope)_ — ⚠️ **needs your judgement**: a design call");
    expect(body).toContain("1 acceptance criterion needs your judgement before merging: AC2");
    expect(body.indexOf("[!IMPORTANT]")).toBeLessThan(body.indexOf("## Acceptance criteria"));
  });

  it("reports CI and carries the run's marker", () => {
    const body = pullRequestBody({ ...base, criteria: [], ci: { state: "pass", sha: base.reviewedSha, checks: [{ name: "build", bucket: "pass" }] } });
    expect(body).toContain("✅ Passed on `bbbbbbbbbbbb`: `build`");
    expect(prOwnedByRun(body, base.runId)).toBe(true);
    expect(prOwnedByRun(body, "other-run")).toBe(false);
    expect(prOwnedByRun("A person's text", base.runId)).toBe(false);
    // PRs opened before the marker existed only carry the footer: never treated as the engine's to rewrite.
    expect(prOwnedByRun("Prepared by the orchestrator (run `acm-1-abc123`). …", base.runId)).toBe(false);
    expect(body.startsWith(prOwnerMarker(base.runId))).toBe(true);
  });

  it("explains a rejected minor round and lists what stayed open", () => {
    const body = pullRequestBody({
      ...base,
      criteria: [],
      minorRound: { status: "reverted", approvedSha: "c".repeat(40), findings: [f("R2", "minor") as never], reason: "review: R3 [major]" },
    });
    expect(body).toContain("was not accepted (review: R3 [major])");
    expect(body).toContain("delivers the last approved commit `cccccccccccc`");
    expect(body).toContain("R2 [minor]");
  });
});

describe("delivery policy", () => {
  const cfg = (extra: Record<string, unknown> = {}) =>
    RepoConfigSchema.parse({
      repo: "o/r",
      linear: { teams: ["O"] },
      agents: { implementer: { adapter: "claude-code" }, reviewer: { adapter: "codex" } },
      permissions: { agents: { run: true }, github: { push: true, create_pr: true } },
      ...extra,
    });

  it("defaults: one minor round, PRs stay drafts", () => {
    const c = cfg();
    expect(c.review.minor_fix_rounds).toBe(1);
    expect(c.pull_request.mark_ready_when_delivered).toBe(false);
    expect(() => cfg({ review: { minor_fix_rounds: 2 } })).toThrow();
  });

  it("marking PRs ready is part of what a trust delegates, and shown to the person", () => {
    const off = trustScope({ config: cfg(), source: "x.yaml" });
    const on = trustScope({ config: cfg({ pull_request: { mark_ready_when_delivered: true } }), source: "x.yaml" });
    expect(on.hash).not.toBe(off.hash);
    expect(trustEligibility(cfg({ pull_request: { mark_ready_when_delivered: true } }))).toEqual([]);
    const shown = describeTrust(on.scope);
    expect(shown.reason).toMatch(/marks them ready for review once every check, CI and the review pass/);
    expect(shown.details.join("\n")).toMatch(/minor-finding rounds 1/);
  });

  it("unmet acceptance criteria make a PR ineligible", () => {
    const pr = {
      number: 1,
      url: "u",
      state: "OPEN" as const,
      isDraft: false,
      headRefName: "b",
      headSha: "a".repeat(40),
      baseRefName: "main",
      mergeable: "MERGEABLE" as const,
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
      checks: [{ name: "CI", bucket: "pass" as const }],
    };
    const e = evaluateMerge({
      config: cfg(),
      pr,
      protection: { branch: "main", protected: false, requiredChecks: [], requiredApprovals: 0, rulesetTypes: [], notes: [] },
      reviewedSha: pr.headSha,
      reviewApproved: true,
      unresolvedBlockingFindings: 0,
      unmetCriteria: 1,
      actor: "bot",
    });
    expect(e.eligible).toBe(false);
    expect(e.reasons).toContain("1 acceptance criteria not met");
  });
});
