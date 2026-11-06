/** What works today versus what is planned. Kept in code so `orchestrator capabilities` never drifts from the README. */
export const CAPABILITIES: Array<{ area: string; feature: string; status: "supported" | "partial" | "planned"; note: string }> = [
  { area: "runs", feature: "Durable run state (SQLite), timeline, artifacts", status: "supported", note: "ORCHESTRATOR_HOME/orchestrator.db" },
  { area: "runs", feature: "Dry run with full plan and simulated timeline", status: "supported", note: "--dry-run (default unless --execute)" },
  { area: "runs", feature: "Supervised live run (implement → test → review → fix → PR)", status: "supported", note: "--execute; needs permissions in repo config" },
  { area: "runs", feature: "Resume after crash / Ctrl-C, cancel, single-driver lease", status: "supported", note: "resume, cancel" },
  { area: "runs", feature: "Plan approval gate before implementation", status: "planned", note: "today: review the dry run, then --execute" },
  { area: "runs", feature: "Unattended queue / scheduler", status: "planned", note: "one run per command for now" },
  { area: "linear", feature: "Read issue, comments, relations, sub-issues", status: "supported", note: "GraphQL API with LINEAR_API_KEY" },
  { area: "linear", feature: "Block on unresolved dependencies", status: "supported", note: "never silently proceeds" },
  { area: "linear", feature: "Comment progress / move issue state", status: "supported", note: "off unless permissions.linear.* granted" },
  { area: "github", feature: "Branch protection + ruleset inspection", status: "supported", note: "gh api" },
  { area: "github", feature: "Push branch, open draft PR (idempotent)", status: "supported", note: "never force-pushes" },
  { area: "github", feature: "Poll CI, feed failures back to implementer", status: "partial", note: "check names/links only; log excerpts planned" },
  { area: "github", feature: "Merge eligibility report", status: "supported", note: "CI, reviewed SHA == head, findings, GitHub reviews" },
  { area: "github", feature: "Automatic merge", status: "partial", note: "implemented behind merge.mode=auto + auto_authorization + protected branch; not enabled anywhere" },
  { area: "agents", feature: "Claude Code implementer (session resume across fix rounds)", status: "supported", note: "claude -p, acceptEdits + allow-list; no bypass modes" },
  { area: "agents", feature: "Codex independent reviewer (structured findings)", status: "supported", note: "codex exec --sandbox read-only --output-schema" },
  { area: "agents", feature: "Read-only planner agent", status: "supported", note: "--with-agent-plan in dry runs; always in live runs if configured" },
  { area: "agents", feature: "Swap roles per repository (e.g. Codex implements, Claude reviews)", status: "supported", note: "agents.* in repo config" },
  { area: "agents", feature: "More roles (security reviewer, test writer, docs)", status: "planned", note: "" },
  { area: "t3", feature: "/orchestrate skill for T3-hosted Claude Code sessions", status: "supported", note: "orchestrator install-skill" },
  { area: "t3", feature: "Detect T3 session origin, doctor checks T3 server", status: "supported", note: "T3CODE_CLI_PATH, t3 thread list" },
  { area: "t3", feature: "Run implementer inside a T3 thread for live visibility", status: "planned", note: "blocked on `t3 thread start` runtime-mode control" },
];

export function renderCapabilities(): string {
  const icon = { supported: "✓", partial: "◐", planned: "○" } as const;
  const lines: string[] = [];
  let area = "";
  for (const cap of CAPABILITIES) {
    if (cap.area !== area) {
      area = cap.area;
      lines.push("", area);
    }
    lines.push(`  ${icon[cap.status]} ${cap.feature}${cap.note ? `  — ${cap.note}` : ""}`);
  }
  lines.push("", "✓ supported  ◐ partial  ○ planned");
  return lines.join("\n").trimStart();
}
