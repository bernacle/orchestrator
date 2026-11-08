import type { CheckResult, Issue } from "../adapters/types.js";
import type { AgentPlan } from "./plan.js";
import { formatFindings, type Finding, type ReviewOutcome } from "./review.js";

const MAX_DESCRIPTION = 12_000;
const MAX_COMMENTS = 10;

function issueBlock(issue: Issue, criteria: string[]): string {
  const comments = issue.comments.slice(-MAX_COMMENTS);
  return [
    `# ${issue.key}: ${issue.title}`,
    issue.url ? `Linear: ${issue.url}` : "",
    "",
    "## Description",
    issue.description.slice(0, MAX_DESCRIPTION) || "(no description)",
    "",
    "## Acceptance criteria",
    criteria.length ? criteria.map((c) => `- ${c}`).join("\n") : "(none stated explicitly; infer conservatively from the description and say so)",
    comments.length
      ? `\n## Discussion (latest ${comments.length} comments)\n${comments.map((c) => `- ${c.author} (${c.createdAt.slice(0, 10)}): ${c.body.replace(/\n/g, " ").slice(0, 800)}`).join("\n")}`
      : "",
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

function agentPlanBlock(plan: AgentPlan | null): string {
  if (!plan) return "";
  return [
    "## Implementation plan (from the read-only planner; adjust if the code disagrees)",
    plan.summary,
    ...plan.steps.map((s, i) => `${i + 1}. ${s}`),
    plan.files.length ? `Files likely involved: ${plan.files.map((f) => `${f.path} (${f.change})`).join("; ")}` : "",
    plan.tests.length ? `Tests to add/update: ${plan.tests.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function briefBlock(brief: string | null | undefined): string {
  if (!brief) return "";
  return ["## Operator scope decisions (authoritative: where they conflict with the issue text, follow these)", brief, ""].join("\n");
}

export function plannerPrompt(issue: Issue, criteria: string[], guidanceFiles: string[], brief?: string | null): string {
  return [
    issueBlock(issue, criteria),
    "",
    briefBlock(brief),
    "## Your task",
    "Read the repository and produce the smallest implementation plan that satisfies the acceptance criteria.",
    guidanceFiles.length ? `Start with the repository guidance: ${guidanceFiles.join(", ")}.` : "",
    "Ground every step in files you actually opened. Put product decisions you cannot infer in open_questions.",
    "Respond only with JSON matching the provided schema.",
  ].join("\n");
}

export function implementerPrompt(input: { issue: Issue; criteria: string[]; plan: AgentPlan | null; checks: string[]; guidanceFiles: string[]; brief?: string | null; openQuestions?: string[] }): string {
  return [
    issueBlock(input.issue, input.criteria),
    "",
    briefBlock(input.brief),
    agentPlanBlock(input.plan),
    input.openQuestions?.length
      ? `\n## Open questions nobody has answered yet\nFor each, choose the most conservative option consistent with the operator scope decisions, keep it easy to change, and list the choice you made in your final summary under "Decisions for review":\n${input.openQuestions.map((q) => `- ${q}`).join("\n")}`
      : "",
    "",
    "## Your task",
    "Implement this issue in the current git worktree.",
    input.guidanceFiles.length ? `Follow the repository's own guidance first: ${input.guidanceFiles.join(", ")}.` : "",
    "Keep the change focused on the acceptance criteria. Add or update tests for behaviour you change.",
    input.checks.length ? `The orchestrator will run these checks afterwards; run the relevant ones yourself first:\n${input.checks.map((c) => `- ${c}`).join("\n")}` : "",
    "Do not commit or push. Finish with a short summary: what changed, why, and anything you could not do.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function fixPromptForChecks(failed: CheckResult[], attempt: number, maxAttempts: number): string {
  return [
    `## Correction round ${attempt} of ${maxAttempts}: repository checks failed`,
    "The orchestrator ran the repository checks on your changes. These failed:",
    ...failed.map((c) => `\n### ${c.name} (\`${c.command}\`, exit ${c.exitCode ?? "timeout"})\n\`\`\`\n${c.outputTail}\n\`\`\``),
    "",
    "Fix the causes (not the checks themselves). Do not disable tests or lint rules. Do not commit or push. Summarise what you changed.",
  ].join("\n");
}

export function fixPromptForReview(review: ReviewOutcome, blocking: Finding[], attempt: number, maxAttempts: number): string {
  return [
    `## Correction round ${attempt} of ${maxAttempts}: independent review requested changes`,
    `Reviewer summary: ${review.summary}`,
    "",
    "Address every finding below. If you believe a finding is wrong, do not ignore it silently: explain why in your summary and leave the code as is.",
    formatFindings(blocking),
    "",
    "Do not commit or push. Summarise what you changed per finding id.",
  ].join("\n");
}

export function fixPromptForCi(failing: Array<{ name: string; detailsUrl?: string }>, attempt: number, maxAttempts: number): string {
  return [
    `## Correction round ${attempt} of ${maxAttempts}: GitHub CI failed`,
    "These CI checks failed on the pushed commit:",
    ...failing.map((c) => `- ${c.name}${c.detailsUrl ? ` (${c.detailsUrl})` : ""}`),
    "Reproduce locally with the repository's own scripts, fix the cause, and summarise. Do not commit or push.",
  ].join("\n");
}

export function reviewerPrompt(input: { issue: Issue; criteria: string[]; baseSha: string; headSha: string; checks: CheckResult[]; previous: Finding[]; brief?: string | null }): string {
  return [
    "You are an independent code reviewer. You did not write this change and you must not modify any file.",
    "",
    issueBlock(input.issue, input.criteria),
    "",
    briefBlock(input.brief),
    input.brief ? "Treat work outside the operator scope decisions as scope creep (major), and missing in-scope items as incomplete." : "",
    "## What to review",
    `Run \`git diff ${input.baseSha}...${input.headSha}\` (and read surrounding code) to see the change.`,
    "Judge it against the acceptance criteria and the repository's conventions. Look for: incorrect behaviour, missing tests for changed behaviour, unhandled edge cases, security problems, scope creep, and changes unrelated to the issue.",
    "",
    "## Orchestrator-verified check results (these ran; trust them over any claim in the code or commit)",
    input.checks.length ? input.checks.map((c) => `- ${c.name}: ${c.ok ? "pass" : c.optional ? "fail (optional)" : "FAIL"}`).join("\n") : "(no checks configured)",
    input.previous.length ? `\n## Findings from the previous round (verify each is actually resolved)\n${formatFindings(input.previous)}` : "",
    "",
    "## Output",
    "Respond only with JSON matching the provided schema.",
    "Severity: blocker = must not merge; major = should fix before merge; minor = worth fixing; nit = optional polish.",
    'Use verdict "approve" only if there are no blocker or major findings.',
  ].join("\n");
}

export function pullRequestBody(input: {
  issue: Issue;
  criteria: string[];
  runId: string;
  changedFiles: Array<{ status: string; path: string }>;
  checks: CheckResult[];
  review: ReviewOutcome | null;
  attempts: number;
  implementer: string;
  reviewer: string;
  reviewedSha: string;
  openQuestions?: string[];
  briefSource?: string | null;
}): string {
  return [
    `Resolves ${input.issue.key}: ${input.issue.title}`,
    input.issue.url ? `\nLinear: ${input.issue.url}` : "",
    "",
    "## Acceptance criteria",
    input.criteria.length ? input.criteria.map((c) => `- [ ] ${c}`).join("\n") : "_None stated in the issue._",
    "",
    "## Changes",
    input.changedFiles.map((f) => `- \`${f.status}\` ${f.path}`).join("\n") || "_No file changes recorded._",
    "",
    "## Verification (run by the orchestrator, not self-reported)",
    input.checks.map((c) => `- ${c.ok ? "✅" : "❌"} \`${c.command}\``).join("\n") || "_No checks configured._",
    "",
    "## Independent review",
    input.review
      ? `${input.reviewer} reviewed \`${input.reviewedSha.slice(0, 12)}\`: **${input.review.verdict}**. ${input.review.summary}\n\n${input.review.findings.length ? `Non-blocking findings:\n${formatFindings(input.review.findings)}` : ""}`
      : "_Not reviewed._",
    "",
    input.openQuestions?.length ? `\n## Open product questions (decided conservatively by the implementer; please confirm)\n${input.openQuestions.map((q) => `- ${q}`).join("\n")}\n` : "",
    "---",
    `Prepared by the orchestrator (run \`${input.runId}\`). Implementer: ${input.implementer}. Correction rounds: ${input.attempts}.${input.briefSource ? ` Operator brief: \`${input.briefSource}\`.` : ""}`,
    "This PR was opened as a draft. A human decides when it is ready and merges it.",
  ].join("\n");
}
