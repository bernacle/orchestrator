import { describe, expect, it } from "vitest";
import { makeIssue } from "../../src/adapters/mock/index.js";
import { analyzeDependencies, branchNameFor, extractAcceptanceCriteria, extractDeclaredDependencies, slugify } from "../../src/planning/issue.js";
import { parseAgentPlan, scriptNameFor } from "../../src/planning/plan.js";
import { decideReview, parseReview, ReviewParseError } from "../../src/planning/review.js";
import { forbiddenFiles } from "../../src/core/workflow.js";

describe("acceptance criteria", () => {
  it("reads the list under an Acceptance criteria heading", () => {
    const d = "Intro\n\n## Acceptance criteria\n\n- [ ] A works\n- B is tested\n\n## Notes\n- not a criterion";
    expect(extractAcceptanceCriteria(d)).toEqual({ criteria: ["A works", "B is tested"], source: "section" });
  });
  it("accepts bold headings and numbered lists", () => {
    expect(extractAcceptanceCriteria("**Acceptance Criteria:**\n1. one\n2) two").criteria).toEqual(["one", "two"]);
  });
  it("falls back to any checklist", () => {
    expect(extractAcceptanceCriteria("Stuff\n- [x] done thing\n- [ ] open thing")).toEqual({ criteria: ["done thing", "open thing"], source: "checklist" });
  });
  it("reports none", () => {
    expect(extractAcceptanceCriteria("just prose").source).toBe("none");
  });
  it("reads a prose '## Done' section as sentences (BRU-488 style)", () => {
    const d = "## Scope\n- x\n\n## Done\n\nA developer can complete the flow. Open a focused draft PR, don't auto-merge.\n\n## Dependencies & references\n* BRU-1";
    expect(extractAcceptanceCriteria(d)).toEqual({ criteria: ["A developer can complete the flow.", "Open a focused draft PR, don't auto-merge."], source: "section" });
  });
  it("does not treat prose starting with 'Done' as a heading", () => {
    expect(extractAcceptanceCriteria("Done with the refactor last week.\n- a list item").source).toBe("none");
  });
});

describe("dependencies", () => {
  const ref = (key: string, type: string) => ({ key, title: key, state: { name: type, type } });
  it("blocks on unresolved blockers and open sub-issues, not on resolved ones", () => {
    const d = analyzeDependencies(makeIssue({ key: "X-1", blockedBy: [ref("X-0", "completed"), ref("X-2", "started")], children: [ref("X-3", "unstarted")] }));
    expect(d.unresolved.map((r) => r.key)).toEqual(["X-2"]);
    expect(d.blockers).toHaveLength(2);
    expect(d.blockers[0]).toContain("X-2");
  });
  it("blocks when the issue itself is already done", () => {
    expect(analyzeDependencies(makeIssue({ key: "X-1", state: { name: "Done", type: "completed" } })).blockers[0]).toMatch(/already Done/);
  });
});

describe("declared dependencies", () => {
  const ref = (key: string, type: string) => ({ key, title: key, state: { name: type, type } });
  it("collects issue keys only under a dependencies-style heading", () => {
    const d = "Mentions BRU-1 in prose.\n\n## Dependencies & references\n* Design: [BRU-456](https://linear.app/x/issue/BRU-456/slug)\n* Calc: BRU-463 / PR #6 (merge first)\n\n## Notes\nBRU-999";
    expect(extractDeclaredDependencies(d)).toEqual(["BRU-456", "BRU-463"]);
  });
  it("blocks on unresolved declared dependencies unless the operator accepts them", () => {
    const issue = makeIssue({ key: "BRU-488" });
    const declared = [ref("BRU-456", "started"), ref("BRU-460", "completed")];
    const blocked = analyzeDependencies(issue, declared);
    expect(blocked.blockers).toEqual([expect.stringContaining("declared dependency BRU-456")]);
    expect(blocked.blockers[0]).toContain("--accept-dependency BRU-456");
    const accepted = analyzeDependencies(issue, declared, ["bru-456"]);
    expect(accepted.blockers).toEqual([]);
    expect(accepted.warnings.join(" ")).toMatch(/BRU-456 .* accepted as non-blocking/);
  });
  it("cannot accept away a Linear blocking relation", () => {
    const issue = makeIssue({ key: "BRU-488", blockedBy: [ref("BRU-1", "started")] });
    expect(analyzeDependencies(issue, [], ["BRU-1"]).blockers[0]).toMatch(/cannot be accepted away/);
  });
});

describe("naming", () => {
  it("slugifies and builds branch names", () => {
    expect(slugify("Métrica: Net Receipts (v2)!")).toBe("metrica-net-receipts-v2");
    expect(branchNameFor("orch/{key}-{slug}", { key: "BRU-488", title: "Add revenue cohort chart" })).toBe("orch/bru-488-add-revenue-cohort-chart");
    expect(slugify("Implement Darkroom B+ Studio vertical slice with real metric lifecycle")).toBe("implement-darkroom-b-studio-vertical");
  });
  it("maps package-manager commands to scripts", () => {
    expect(scriptNameFor("pnpm lint")).toBe("lint");
    expect(scriptNameFor("pnpm run format:check")).toBe("format:check");
    expect(scriptNameFor("npm run build -- --x")).toBe("build");
    expect(scriptNameFor("pnpm install --frozen-lockfile")).toBeNull();
    expect(scriptNameFor("make test")).toBeNull();
  });
});

describe("agent plan parsing", () => {
  it("drops self-numbering and rejects non-plans", () => {
    const plan = parseAgentPlan({ summary: "s", steps: ["0. Verify base", "Step 2: Build", "plain"], files: [{ path: "a.ts", change: "edit" }, { nope: 1 }], tests: [], risks: [], open_questions: [] });
    expect(plan!.steps).toEqual(["Verify base", "Build", "plain"]);
    expect(plan!.files).toEqual([{ path: "a.ts", change: "edit" }]);
    expect(parseAgentPlan({ steps: [] })).toBeNull();
  });
});

describe("review decisions", () => {
  it("rejects malformed output instead of approving", () => {
    expect(() => parseReview(null)).toThrow(ReviewParseError);
    expect(() => parseReview({ verdict: "lgtm", findings: [] })).toThrow(/invalid verdict/);
    expect(() => parseReview({ verdict: "approve" })).toThrow(/findings/);
  });
  it("an approve verdict with a blocking finding is not an approval", () => {
    const outcome = parseReview({ verdict: "approve", summary: "", findings: [{ severity: "blocker", title: "SQL injection", detail: "" }] });
    const d = decideReview(outcome, ["blocker", "major"]);
    expect(d.approved).toBe(false);
    expect(d.blocking[0]!.id).toBe("F1");
  });
  it("treats unknown severities as major", () => {
    const outcome = parseReview({ verdict: "request_changes", summary: "", findings: [{ severity: "critical!!", title: "x", detail: "" }] });
    expect(outcome.findings[0]!.severity).toBe("major");
  });
  it("minor findings do not block by default", () => {
    const outcome = parseReview({ verdict: "approve", summary: "", findings: [{ severity: "nit", title: "naming", detail: "" }] });
    expect(decideReview(outcome, ["blocker", "major"]).approved).toBe(true);
  });
});

describe("forbidden paths", () => {
  it("matches basenames, nested globs and ignores deletions", () => {
    const files = [
      { status: "A", path: "apps/demo/.env" },
      { status: "M", path: ".github/workflows/ci.yml" },
      { status: "D", path: "old.pem" },
      { status: "A", path: "src/env.ts" },
    ];
    expect(forbiddenFiles(files, [".env", ".env.*", "*.pem", ".github/workflows/**"])).toEqual(["apps/demo/.env", ".github/workflows/ci.yml"]);
  });
});
