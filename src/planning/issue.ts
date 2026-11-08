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
