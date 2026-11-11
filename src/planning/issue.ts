import type { Issue, IssueRef } from "../adapters/types.js";

const DONE_STATE_TYPES = new Set(["completed", "canceled"]);

export function isResolved(ref: IssueRef): boolean {
  return DONE_STATE_TYPES.has(ref.state.type);
}

export interface ReadinessSummary {
  parent: IssueRef | null;
  openChildren: IssueRef[];
  blocks: IssueRef[];
  /** Reasons a live run must stop before implementation. */
  blockers: string[];
  warnings: string[];
}

/** The issue's own readiness (not its dependencies, see dependencies.ts). */
export function analyzeReadiness(issue: Issue): ReadinessSummary {
  const openChildren = issue.children.filter((c) => !isResolved(c));
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (isResolved(issue)) blockers.push(`issue is already ${issue.state.name}`);
  if (openChildren.length > 0) {
    blockers.push(`issue has ${openChildren.length} open sub-issue(s) (${openChildren.map((c) => c.key).join(", ")}); run the sub-issues instead`);
  }
  if (issue.parent && isResolved(issue.parent)) warnings.push(`parent ${issue.parent.key} is already ${issue.parent.state.name}`);
  if (issue.state.type === "triage" || issue.state.type === "backlog") warnings.push(`issue is in ${issue.state.name}; confirm it is ready for implementation`);
  return { parent: issue.parent, openChildren, blocks: issue.blocks, blockers, warnings };
}

// Unambiguous phrases may appear without heading markup; generic words ("Done", "Requirements") need a heading.
const AC_HEADING = /^\s*(?:(?:#{1,6}\s*|\*\*|__)?\s*(?:acceptance criteria|definition of done)|(?:#{1,6}\s*|\*\*|__)\s*(?:success criteria|done when|done|requirements))\b[^\n]*$/i;
const ANY_HEADING = /^\s*(?:#{1,6}\s+\S|\*\*[^*]+\*\*\s*:?\s*$)/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/;
const CHECKBOX = /^\s*[-*+]\s+\[[ xX]\]\s+(.+?)\s*$/;

/**
 * Pull acceptance criteria out of an issue description: the list under an
 * "Acceptance criteria"-style heading, or else any markdown checklist.
 */
export function extractAcceptanceCriteria(description: string): { criteria: string[]; source: "section" | "checklist" | "none" } {
  const lines = description.split(/\r?\n/);
  const start = lines.findIndex((l) => AC_HEADING.test(l));
  if (start >= 0) {
    const items: string[] = [];
    const prose: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (ANY_HEADING.test(line) && !LIST_ITEM.test(line)) break;
      const m = line.match(LIST_ITEM);
      if (m?.[1]) items.push(m[1]);
      else if (line.trim()) prose.push(line.trim());
    }
    // A "Done" section written as prose is still the definition of done: one criterion per sentence.
    const criteria = items.length > 0 ? items : prose.join(" ").split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean);
    if (criteria.length > 0) return { criteria, source: "section" };
  }
  const checklist = lines.map((l) => l.match(CHECKBOX)?.[1]).filter((x): x is string => Boolean(x));
  if (checklist.length > 0) return { criteria: checklist, source: "checklist" };
  return { criteria: [], source: "none" };
}

/** At most this many criteria are judged one by one; more would dilute the review. */
export const MAX_CRITERIA = 15;

const normalize = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Criteria the planner derived from the issue that the issue's own list does not already state
 * (compared loosely), capped so the total stays at MAX_CRITERIA.
 */
export function deriveAdditionalCriteria(stated: readonly string[], planned: readonly string[]): string[] {
  const seen = new Set(stated.map(normalize));
  const out: string[] = [];
  for (const c of planned) {
    const n = normalize(c);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(c.trim());
    if (stated.length + out.length >= MAX_CRITERIA) break;
  }
  return out;
}

/** The run's numbered criteria: the issue's own first, then the planner's derived ones. */
export function numberCriteria(ac: { criteria: string[]; derived?: string[] } | undefined): Array<{ id: string; text: string; source: "issue" | "planner" }> {
  if (!ac) return [];
  const all = [...ac.criteria.map((text) => ({ text, source: "issue" as const })), ...(ac.derived ?? []).map((text) => ({ text, source: "planner" as const }))];
  return all.slice(0, Math.max(MAX_CRITERIA, ac.criteria.length)).map((c, i) => ({ id: `AC${i + 1}`, ...c }));
}

export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= max) return slug || "change";
  // Cut at a word boundary rather than mid-word.
  const cut = slug.slice(0, max + 1);
  const boundary = cut.lastIndexOf("-");
  return (boundary > max / 2 ? cut.slice(0, boundary) : slug.slice(0, max)).replace(/-+$/, "") || "change";
}

export function branchNameFor(template: string, issue: Pick<Issue, "key" | "title">): string {
  return template.replaceAll("{key}", issue.key.toLowerCase()).replaceAll("{slug}", slugify(issue.title));
}
