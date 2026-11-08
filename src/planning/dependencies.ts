import type { Issue, IssueRef } from "../adapters/types.js";
import { isResolved } from "./issue.js";

/**
 * Dependency classification.
 *
 *   hard_blocker  Linear "blocked by" relation, unresolved. Blocks; not overridable here (fix it in Linear).
 *   prerequisite  Declared as a prerequisite in the issue text (or by the operator), unresolved, no
 *                 satisfying evidence. Blocks; `--accept-dependency` can override (audited).
 *   satisfied     A prerequisite or blocker that is done: completed in Linear, or its implementation PR
 *                 is merged in the target repo with none still open, or the files the operator said it
 *                 must provide exist at the base commit.
 *   accepted      An unresolved prerequisite the operator explicitly accepted. Does not block; audited.
 *   reference     Mentioned for context ("Design: BRU-456", a "References" section). Informational.
 *   related       Linear "related" relation not mentioned as a prerequisite. Informational.
 */
export type DependencyClass = "hard_blocker" | "prerequisite" | "satisfied" | "accepted" | "reference" | "related";

export interface DependencyEvidence {
  kind: "linear-relation" | "linear-state" | "description" | "github-pr" | "files" | "operator";
  detail: string;
  url?: string;
}

export interface ClassifiedDependency extends IssueRef {
  classification: DependencyClass;
  blocking: boolean;
  reason: string;
  evidence: DependencyEvidence[];
}

// ---- text mentions -------------------------------------------------------------------

export type MentionIntent = "prerequisite" | "reference";

export interface IssueMention {
  key: string;
  intent: MentionIntent;
  heading: string | null;
  line: string;
  /** PR numbers written on the same line ("PR #6"). */
  prNumbers: number[];
  why: string;
}

const ISSUE_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;
const HEADING = /^\s*(?:#{1,6}\s+(.+?)\s*#*\s*$|\*\*([^*]+)\*\*\s*:?\s*$|__([^_]+)__\s*:?\s*$)/;

/** Wording on a line that makes an issue a prerequisite of this one. */
const PREREQ_WORDING = new RegExp(
  [
    String.raw`\bblocked by\b`,
    String.raw`\bdepends on\b`,
    String.raw`\bdependent on\b`,
    String.raw`\bprerequisites?\b`,
    String.raw`\brequires?\b`,
    String.raw`\bneeds?\b[^.\n]{0,40}?\bto (?:land|merge|ship|be (?:merged|done|completed|finished))\b`,
    String.raw`\bmust (?:be )?(?:land|merge|ship|complete|finish|done)\w*\b`,
    String.raw`\b(?:merge|land|ship|finish|complete|verify|wait for)\w*(?:\/[\w-]+)*\b[^.\n]{0,30}\bfirst\b`,
    String.raw`\bafter\b[^.\n]{0,40}\b(?:lands|merges|ships|is (?:merged|done|complete|finished))\b`,
  ].join("|"),
  "i",
);

/** Wording that explicitly downgrades a mention. Wins over PREREQ_WORDING. */
const NOT_PREREQ = /\b(?:not (?:a |an )?(?:hard )?(?:prerequisite|blocker|blocking|required|dependency)|non[- ]blocking|optional|nice[- ]to[- ]have|for (?:context|reference)|see also|follow[- ]?up)\b/i;

/** Headings whose items are prerequisites by default. "Dependencies & references" is not one. */
const PREREQ_HEADING = /^(?:prerequisites?|blocked by|blockers?|depends on|dependencies|dependency|requires|required before|before starting)$/i;

function normalizeHeading(h: string): string {
  return h
    .toLowerCase()
    .replace(/[`*_:]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find every issue key in the description and decide, per line, whether it is
 * written as a prerequisite or as a reference.
 */
export function extractIssueMentions(description: string, selfKey: string): IssueMention[] {
  const out: IssueMention[] = [];
  let heading: string | null = null;
  for (const raw of description.split(/\r?\n/)) {
    const h = raw.match(HEADING);
    if (h) {
      heading = (h[1] ?? h[2] ?? h[3] ?? "").trim();
      continue;
    }
    const keys = [...new Set([...raw.matchAll(ISSUE_KEY)].map((m) => m[1]!))].filter((k) => k !== selfKey);
    if (keys.length === 0) continue;
    const line = raw.trim().slice(0, 300);
    const prNumbers = [...raw.matchAll(/\b(?:PR|pull request|pull)\s*#(\d+)\b/gi)].map((m) => Number(m[1]));
    const headingNorm = heading ? normalizeHeading(heading) : null;
    let intent: MentionIntent = "reference";
    let why: string;
    if (NOT_PREREQ.test(line)) {
      why = `line says it is not a prerequisite ("${line.match(NOT_PREREQ)![0]}")`;
    } else if (PREREQ_WORDING.test(line)) {
      intent = "prerequisite";
      why = `line uses prerequisite wording ("${line.match(PREREQ_WORDING)![0]}")`;
    } else if (headingNorm && PREREQ_HEADING.test(headingNorm)) {
      intent = "prerequisite";
      why = `listed under the "${heading}" heading`;
    } else {
      why = headingNorm ? `mentioned under "${heading}" without prerequisite wording` : "mentioned without prerequisite wording";
    }
    for (const key of keys) out.push({ key, intent, heading, line, prNumbers, why });
  }
  return out;
}

// ---- classification ------------------------------------------------------------------

export interface PrEvidence {
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergedAt: string | null;
  /** How the PR was found. */
  via: "description" | "linear-attachment" | "search";
  /** Where the PR names the issue key. Only title/branch (or a Linear attachment) mark an implementation PR. */
  link: "title" | "branch" | "body" | "none";
}

/** An implementation PR for the issue, not just a PR that mentions it. */
export function isImplementationPr(p: PrEvidence): boolean {
  return p.via === "linear-attachment" || p.link === "title" || p.link === "branch";
}

export interface OperatorDecision {
  role?: "prerequisite" | "reference";
  reason: string;
  /** Files whose presence at the base commit proves the required functionality exists. */
  satisfiedWhenFilesExist?: string[];
  source: string;
}

export interface ClassifyInput {
  issue: Issue;
  mentions: IssueMention[];
  /** Fresh state for each key we know about (relations + fetched mentions). */
  refs: Map<string, IssueRef>;
  prs: Map<string, PrEvidence[]>;
  /** Result of checking `satisfiedWhenFilesExist` at the base commit. */
  files: Map<string, Array<{ path: string; exists: boolean }>>;
  decisions: Record<string, OperatorDecision>;
  /** Keys accepted with --accept-dependency. */
  accepted: string[];
  baseSha: string;
}

export interface DependencyReport {
  items: ClassifiedDependency[];
  blockers: string[];
  warnings: string[];
}

export function classifyDependencies(input: ClassifyInput): DependencyReport {
  const { issue } = input;
  const accepted = new Set(input.accepted.map((k) => k.toUpperCase()));
  const items: ClassifiedDependency[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  const keys = new Set<string>([
    ...issue.blockedBy.map((r) => r.key),
    ...input.mentions.map((m) => m.key),
    ...issue.related.map((r) => r.key),
    ...Object.keys(input.decisions),
  ]);
  keys.delete(issue.key);

  for (const key of keys) {
    const ref = input.refs.get(key) ?? issue.blockedBy.find((r) => r.key === key) ?? issue.related.find((r) => r.key === key) ?? { key, title: "(unknown issue)", state: { name: "unknown", type: "unknown" } };
    const evidence: DependencyEvidence[] = [];
    const mentions = input.mentions.filter((m) => m.key === key);
    const isBlockedBy = issue.blockedBy.some((r) => r.key === key);
    const isRelated = issue.related.some((r) => r.key === key);
    const decision = input.decisions[key];
    const prs = input.prs.get(key) ?? [];
    const resolved = isResolved(ref);

    if (isBlockedBy) evidence.push({ kind: "linear-relation", detail: `Linear: ${issue.key} is blocked by ${key}` });
    if (isRelated) evidence.push({ kind: "linear-relation", detail: `Linear: related to ${key}` });
    for (const m of mentions) evidence.push({ kind: "description", detail: `${m.why}: "${m.line}"` });
    evidence.push({ kind: "linear-state", detail: `${key} is ${ref.state.name} (${ref.state.type}) in Linear` });
    for (const pr of prs) {
      evidence.push({
        kind: "github-pr",
        detail: `PR #${pr.number} ${pr.state.toLowerCase()}${pr.mergedAt ? ` ${pr.mergedAt.slice(0, 10)}` : ""}: ${pr.title} (${isImplementationPr(pr) ? "implementation" : "mentions only"}; found via ${pr.via}, key in ${pr.link})`,
        url: pr.url,
      });
    }
    const fileChecks = input.files.get(key) ?? [];
    for (const f of fileChecks) evidence.push({ kind: "files", detail: `${f.path} ${f.exists ? "exists" : "missing"} at ${input.baseSha.slice(0, 8)}` });
    if (decision) evidence.push({ kind: "operator", detail: `${decision.reason} (${decision.source})` });

    // Implementation PRs: attached to the dependency in Linear, or naming it in title or branch.
    // A PR whose body merely mentions the key is context, not evidence of completion.
    const linked = prs.filter(isImplementationPr);
    const merged = linked.filter((p) => p.state === "MERGED");
    const open = linked.filter((p) => p.state === "OPEN");
    const codeDone = merged.length > 0 && open.length === 0;
    const filesDone = fileChecks.length > 0 && fileChecks.every((f) => f.exists);

    const push = (classification: DependencyClass, reason: string) => {
      const blocking = classification === "hard_blocker" || classification === "prerequisite";
      items.push({ ...ref, classification, blocking, reason, evidence });
    };

    if (isBlockedBy) {
      if (resolved) push("satisfied", `blocked-by relation, but ${key} is ${ref.state.name}`);
      else {
        const hint = codeDone ? ` Merged PR ${merged.map((p) => `#${p.number}`).join(", ")} suggests the Linear state is stale: update ${key} in Linear.` : "";
        const reason = `Linear says ${issue.key} is blocked by ${key}, which is ${ref.state.name}.${hint}${accepted.has(key) ? " (--accept-dependency does not override Linear blocking relations; resolve or unlink it in Linear.)" : ""}`;
        push("hard_blocker", reason);
        blockers.push(`hard blocker ${key} "${ref.title}": ${reason}`);
      }
      continue;
    }

    const textPrereq = mentions.some((m) => m.intent === "prerequisite");
    const role = decision?.role ?? (textPrereq ? "prerequisite" : mentions.length > 0 ? "reference" : "related");

    if (role === "prerequisite") {
      const source = decision?.role ? `operator brief (${decision.source})` : "issue text";
      if (resolved) push("satisfied", `prerequisite per ${source}; ${key} is ${ref.state.name}`);
      else if (codeDone) push("satisfied", `prerequisite per ${source}; Linear says ${ref.state.name}, but implementation PR ${merged.map((p) => `#${p.number}`).join(", ")} is merged and none are open`);
      else if (filesDone) push("satisfied", `prerequisite per ${source}; the required functionality exists at ${input.baseSha.slice(0, 8)} (${fileChecks.map((f) => f.path).join(", ")})`);
      else if (accepted.has(key)) {
        push("accepted", `prerequisite per ${source}, unresolved (${ref.state.name}); accepted by the operator with --accept-dependency`);
        warnings.push(`${key} accepted as non-blocking by the operator although it is ${ref.state.name}`);
      } else {
        const why = open.length ? `implementation PR ${open.map((p) => `#${p.number}`).join(", ")} still open` : "no merged implementation PR found";
        const reason = `prerequisite per ${source}; ${key} is ${ref.state.name} and ${why}`;
        push("prerequisite", reason);
        blockers.push(`prerequisite ${key} "${ref.title}": ${reason}. Resolve it, or pass --accept-dependency ${key} if the required functionality already exists.`);
      }
      continue;
    }
    if (role === "reference") {
      push("reference", decision?.role ? `operator brief classifies it as a reference: ${decision.reason}` : (mentions[0]?.why ?? "mentioned as a reference"));
      continue;
    }
    push("related", `Linear "related" relation only; informational`);
  }

  const order: Record<DependencyClass, number> = { hard_blocker: 0, prerequisite: 1, accepted: 2, satisfied: 3, reference: 4, related: 5 };
  items.sort((a, b) => order[a.classification] - order[b.classification] || a.key.localeCompare(b.key));
  return { items, blockers, warnings };
}

/** Keys we should look up PR evidence for: anything that could be (or is said to be) a prerequisite. */
export function keysNeedingEvidence(issue: Issue, mentions: IssueMention[], decisions: Record<string, OperatorDecision>): string[] {
  const keys = new Set<string>([...issue.blockedBy.map((r) => r.key), ...mentions.map((m) => m.key), ...Object.keys(decisions)]);
  keys.delete(issue.key);
  return [...keys];
}
