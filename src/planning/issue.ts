import type { Issue, IssueRef } from "../adapters/types.js";

const DONE_STATE_TYPES = new Set(["completed", "canceled"]);

export function isResolved(ref: IssueRef): boolean {
  return DONE_STATE_TYPES.has(ref.state.type);
}

export interface DependencySummary {
  blockedBy: Array<IssueRef & { resolved: boolean }>;
  /** Issues named under a "Dependencies"-style heading in the description (not Linear relations). */
  declared: Array<IssueRef & { resolved: boolean; accepted: boolean }>;
  unresolved: IssueRef[];
  blocks: IssueRef[];
  related: IssueRef[];
  parent: IssueRef | null;
  openChildren: IssueRef[];
  /** Reasons a live run must stop before implementation. */
  blockers: string[];
  warnings: string[];
}

/**
 * @param declared  states of issues the description lists as dependencies
 * @param accepted  keys the operator explicitly accepted as non-blocking (audited)
 */
export function analyzeDependencies(issue: Issue, declared: IssueRef[] = [], accepted: string[] = []): DependencySummary {
  const acceptedSet = new Set(accepted.map((k) => k.toUpperCase()));
  const blockedBy = issue.blockedBy.map((r) => ({ ...r, resolved: isResolved(r) }));
  const relationKeys = new Set(blockedBy.map((r) => r.key));
  const declaredDeps = declared
    .filter((r) => !relationKeys.has(r.key) && r.key !== issue.key)
    .map((r) => ({ ...r, resolved: isResolved(r), accepted: acceptedSet.has(r.key) }));
  const unresolved = [...blockedBy.filter((r) => !r.resolved), ...declaredDeps.filter((r) => !r.resolved && !r.accepted)];
  const openChildren = issue.children.filter((c) => !isResolved(c));
  const blockers: string[] = [];
  const warnings: string[] = [];

  for (const dep of blockedBy.filter((r) => !r.resolved)) {
    blockers.push(`blocked by ${dep.key} "${dep.title}" (${dep.state.name})${acceptedSet.has(dep.key) ? " — Linear blocking relations cannot be accepted away; resolve or unlink it" : ""}`);
  }
  for (const dep of declaredDeps.filter((r) => !r.resolved)) {
    if (dep.accepted) warnings.push(`declared dependency ${dep.key} (${dep.state.name}) accepted as non-blocking by the operator`);
    else blockers.push(`declared dependency ${dep.key} "${dep.title}" is ${dep.state.name}; resolve it, or pass --accept-dependency ${dep.key} if it is not a prerequisite`);
  }
  if (isResolved(issue)) blockers.push(`issue is already ${issue.state.name}`);
  if (openChildren.length > 0) {
    blockers.push(`issue has ${openChildren.length} open sub-issue(s) (${openChildren.map((c) => c.key).join(", ")}); run the sub-issues instead`);
  }
  if (issue.parent && isResolved(issue.parent)) warnings.push(`parent ${issue.parent.key} is already ${issue.parent.state.name}`);
  if (issue.state.type === "triage" || issue.state.type === "backlog") warnings.push(`issue is in ${issue.state.name}; confirm it is ready for implementation`);

  return { blockedBy, declared: declaredDeps, unresolved, blocks: issue.blocks, related: issue.related, parent: issue.parent, openChildren, blockers, warnings };
}

const DEP_HEADING = /^\s*(?:#{1,6}\s*|\*\*|__)\s*(?:dependencies|dependency|depends on|prerequisites?|requires|blocked by)\b/i;
const ISSUE_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;

/** Issue keys listed under a "Dependencies"-style heading. Prose elsewhere is not treated as a dependency. */
export function extractDeclaredDependencies(description: string): string[] {
  const lines = description.split(/\r?\n/);
  const keys = new Set<string>();
  let inSection = false;
  for (const line of lines) {
    if (DEP_HEADING.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^\s*#{1,6}\s+\S/.test(line)) inSection = false;
    if (inSection) for (const m of line.matchAll(ISSUE_KEY)) keys.add(m[1]!);
  }
  return [...keys];
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
