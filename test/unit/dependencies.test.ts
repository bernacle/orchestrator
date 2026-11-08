import { describe, expect, it } from "vitest";
import { makeIssue } from "../../src/adapters/mock/index.js";
import type { IssueRef } from "../../src/adapters/types.js";
import { parseBrief } from "../../src/config/brief.js";
import { classifyDependencies, extractIssueMentions, isImplementationPr, type ClassifyInput, type PrEvidence } from "../../src/planning/dependencies.js";

const ref = (key: string, type: string, name = type): IssueRef => ({ key, title: `Title of ${key}`, state: { name, type } });
const pr = (number: number, state: PrEvidence["state"], link: PrEvidence["link"], via: PrEvidence["via"] = "search"): PrEvidence => ({
  number,
  url: `https://github.com/o/r/pull/${number}`,
  title: `PR ${number}`,
  state,
  mergedAt: state === "MERGED" ? "2026-11-01T00:00:00Z" : null,
  via,
  link,
});

/** Same structure as BRU-488's "Dependencies & references" section (anonymised). */
const MIXED_SECTION = [
  "## Scope",
  "- build the studio",
  "",
  "## Dependencies & references",
  "",
  "* Design: [BRU-456](https://linear.app/x/issue/BRU-456/design), `docs/design/SPEC.md`",
  "* Proposal lifecycle: [BRU-460](https://linear.app/x/issue/BRU-460/proposals) / PR #2",
  "* Bounded net calculator: [BRU-463](https://linear.app/x/issue/BRU-463/calc) / PR #6 (merge/CI verify first)",
  "* SDK CSS contract: [BRU-485](https://linear.app/x/issue/BRU-485/sdk)",
  "* Trusted metric evidence ADR: [BRU-483](https://linear.app/x/issue/BRU-483/adr)",
].join("\n");

function input(over: Partial<ClassifyInput> & { description?: string } = {}): ClassifyInput {
  const issue = over.issue ?? makeIssue({ key: "BRU-488", description: over.description ?? MIXED_SECTION, related: ["BRU-456", "BRU-460", "BRU-463", "BRU-465", "BRU-483", "BRU-485"].map((k) => ref(k, "started", "In Progress")) });
  return {
    issue,
    mentions: over.mentions ?? extractIssueMentions(issue.description, issue.key),
    refs: over.refs ?? new Map(issue.related.map((r) => [r.key, r])),
    prs: over.prs ?? new Map(),
    files: over.files ?? new Map(),
    decisions: over.decisions ?? {},
    accepted: over.accepted ?? [],
    baseSha: "a".repeat(40),
  };
}

describe("extractIssueMentions", () => {
  it("does not turn a mixed 'Dependencies & references' section into prerequisites", () => {
    const m = extractIssueMentions(MIXED_SECTION, "BRU-488");
    const intent = Object.fromEntries(m.map((x) => [x.key, x.intent]));
    expect(intent).toEqual({ "BRU-456": "reference", "BRU-460": "reference", "BRU-463": "prerequisite", "BRU-485": "reference", "BRU-483": "reference" });
    expect(m.find((x) => x.key === "BRU-463")!.prNumbers).toEqual([6]);
    expect(m.find((x) => x.key === "BRU-463")!.why).toMatch(/prerequisite wording/);
  });

  it("treats a pure Prerequisites / Blocked by heading as prerequisites", () => {
    const m = extractIssueMentions("## Prerequisites\n- ABC-1\n\n### Blocked by\n- ABC-2\n\n## Notes\n- ABC-3", "ABC-9");
    expect(m.map((x) => `${x.key}:${x.intent}`)).toEqual(["ABC-1:prerequisite", "ABC-2:prerequisite", "ABC-3:reference"]);
  });

  it("recognises prerequisite wording anywhere, and explicit negations", () => {
    const d = ["Depends on ABC-1 landing.", "Needs ABC-2 to be merged.", "Do this after ABC-3 is merged.", "See also ABC-4.", "ABC-5 is not a prerequisite.", "Optional follow-up: ABC-6"].join("\n");
    const intent = Object.fromEntries(extractIssueMentions(d, "ABC-9").map((x) => [x.key, x.intent]));
    expect(intent).toEqual({ "ABC-1": "prerequisite", "ABC-2": "prerequisite", "ABC-3": "prerequisite", "ABC-4": "reference", "ABC-5": "reference", "ABC-6": "reference" });
  });

  it("ignores the issue's own key and handles bold headings", () => {
    const m = extractIssueMentions("**Dependencies**\n- ABC-9 (self)\n- ABC-1", "ABC-9");
    expect(m.map((x) => x.key)).toEqual(["ABC-1"]);
    expect(m[0]!.intent).toBe("prerequisite");
  });
});

describe("classifyDependencies", () => {
  it("BRU-488 shape: references and related issues are informational; the declared prerequisite is satisfied by its merged PR despite a stale Linear state", () => {
    const report = classifyDependencies(input({ prs: new Map([["BRU-463", [pr(6, "MERGED", "title", "description"), pr(5, "MERGED", "body")]]]) }));
    const cls = Object.fromEntries(report.items.map((d) => [d.key, d.classification]));
    expect(cls).toEqual({ "BRU-456": "reference", "BRU-460": "reference", "BRU-463": "satisfied", "BRU-485": "reference", "BRU-483": "reference", "BRU-465": "related" });
    expect(report.blockers).toEqual([]);
    const calc = report.items.find((d) => d.key === "BRU-463")!;
    expect(calc.reason).toMatch(/Linear says In Progress, but implementation PR #6 is merged/);
    expect(calc.evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["description", "linear-state", "github-pr", "linear-relation"]));
    // PR #5 only mentions BRU-463 in its body: recorded, but not counted as the implementation.
    expect(calc.evidence.find((e) => e.detail.startsWith("PR #5"))!.detail).toMatch(/mentions only/);
  });

  it("a declared prerequisite with no merged implementation PR blocks, and says how to override", () => {
    const report = classifyDependencies(input());
    expect(report.items.find((d) => d.key === "BRU-463")!.classification).toBe("prerequisite");
    expect(report.blockers).toHaveLength(1);
    expect(report.blockers[0]).toMatch(/prerequisite BRU-463 .* no merged implementation PR found.*--accept-dependency BRU-463/);
  });

  it("an open implementation PR keeps the prerequisite blocking even if another one merged", () => {
    const report = classifyDependencies(input({ prs: new Map([["BRU-463", [pr(6, "MERGED", "title"), pr(9, "OPEN", "branch")]]]) }));
    expect(report.items.find((d) => d.key === "BRU-463")!.reason).toMatch(/implementation PR #9 still open/);
    expect(report.blockers).toHaveLength(1);
  });

  it("body-only PR mentions never satisfy a prerequisite", () => {
    const report = classifyDependencies(input({ prs: new Map([["BRU-463", [pr(5, "MERGED", "body"), pr(4, "MERGED", "body")]]]) }));
    expect(report.items.find((d) => d.key === "BRU-463")!.classification).toBe("prerequisite");
  });

  it("a Linear attachment counts as the implementation PR", () => {
    expect(isImplementationPr(pr(7, "MERGED", "none", "linear-attachment"))).toBe(true);
  });

  it("operator acceptance turns an unresolved prerequisite into an audited non-blocker", () => {
    const report = classifyDependencies(input({ accepted: ["bru-463"] }));
    const calc = report.items.find((d) => d.key === "BRU-463")!;
    expect(calc).toMatchObject({ classification: "accepted", blocking: false });
    expect(report.warnings[0]).toMatch(/BRU-463 accepted as non-blocking/);
    expect(report.blockers).toEqual([]);
  });

  it("Linear blocked-by relations are hard blockers; stale-state evidence is a hint, not an override", () => {
    const issue = makeIssue({ key: "BRU-488", description: "No text deps.", blockedBy: [ref("BRU-1", "started", "In Progress")] });
    const report = classifyDependencies(input({ issue, accepted: ["BRU-1"], prs: new Map([["BRU-1", [pr(3, "MERGED", "title")]]]) }));
    const d = report.items[0]!;
    expect(d.classification).toBe("hard_blocker");
    expect(d.reason).toMatch(/Merged PR #3 suggests the Linear state is stale/);
    expect(d.reason).toMatch(/does not override Linear blocking relations/);
    expect(report.blockers).toHaveLength(1);
  });

  it("a resolved blocked-by relation is satisfied", () => {
    const issue = makeIssue({ key: "BRU-488", description: "", blockedBy: [ref("BRU-1", "completed", "Done")] });
    expect(classifyDependencies(input({ issue })).items[0]!.classification).toBe("satisfied");
  });

  it("the operator brief can downgrade a mention to a reference, with the reason recorded", () => {
    const report = classifyDependencies(
      input({ description: "## Prerequisites\n- BRU-485", decisions: { "BRU-485": { role: "reference", reason: "the slice uses the existing result-prop SDK", source: "brief x" } } }),
    );
    const sdk = report.items.find((d) => d.key === "BRU-485")!;
    expect(sdk.classification).toBe("reference");
    expect(sdk.reason).toMatch(/operator brief .* existing result-prop SDK/);
    expect(sdk.evidence.at(-1)).toMatchObject({ kind: "operator" });
  });

  it("an unfinished issue is satisfied when the files it must provide exist at the base commit", () => {
    const decisions = { "BRU-463": { reason: "only the bounded calculator is needed", satisfiedWhenFilesExist: ["packages/core/src/net.ts"], source: "brief x" } };
    const ok = classifyDependencies(input({ decisions, files: new Map([["BRU-463", [{ path: "packages/core/src/net.ts", exists: true }]]]) }));
    expect(ok.items.find((d) => d.key === "BRU-463")!.reason).toMatch(/required functionality exists/);
    const missing = classifyDependencies(input({ decisions, files: new Map([["BRU-463", [{ path: "packages/core/src/net.ts", exists: false }]]]) }));
    expect(missing.items.find((d) => d.key === "BRU-463")!.classification).toBe("prerequisite");
  });

  it("an issue we cannot read is never silently dropped", () => {
    const report = classifyDependencies(input({ description: "Blocked by ZZZ-1.", refs: new Map() }));
    expect(report.items[0]).toMatchObject({ key: "ZZZ-1", classification: "prerequisite", blocking: true });
  });
});

describe("parseBrief", () => {
  it("parses front matter, decisions and scope body, and hashes the content", () => {
    const b = parseBrief(
      "---\nissue: BRU-488\nrepo: o/r\ndependencies:\n  BRU-485:\n    role: reference\n    reason: existing SDK suffices\n---\n# Scope\nDescribe → Clarify → Review → Embed.\n",
      "/x/config/briefs/o/r/BRU-488.md",
    );
    expect(b.decisions["BRU-485"]).toMatchObject({ role: "reference", reason: "existing SDK suffices" });
    expect(b.body).toContain("Describe → Clarify");
    expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("rejects a brief without front matter", () => {
    expect(() => parseBrief("# just markdown", "x.md")).toThrow(/front-matter/);
  });
});
