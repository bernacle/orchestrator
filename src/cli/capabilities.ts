/** What works today versus what is planned. Kept in code so `orchestrator capabilities` never drifts from the README. */
export const CAPABILITIES: Array<{ area: string; feature: string; status: "supported" | "partial" | "planned"; note: string }> = [
  { area: "runs", feature: "Durable run state (SQLite), timeline, artifacts", status: "supported", note: "ORCHESTRATOR_HOME/orchestrator.db" },
  { area: "runs", feature: "Dry run with full plan and simulated timeline", status: "supported", note: "--dry-run (default unless --execute)" },
  { area: "runs", feature: "Supervised live run (implement → test → review → fix → PR)", status: "supported", note: "--execute; needs permissions in repo config" },
  { area: "runs", feature: "Resume after crash / Ctrl-C, cancel, single-driver lease", status: "supported", note: "resume, cancel" },
  { area: "runs", feature: "Plan approval gate before implementation", status: "planned", note: "today: review the dry run, then --execute" },
  { area: "runs", feature: "Unattended queue / scheduler", status: "planned", note: "disabled: needs a VM/container boundary first (docs/isolation.md)" },
  { area: "runs", feature: "Run limits: cost cap, wall clock, correction rounds", status: "supported", note: "limits.*, merge.max_fix_attempts" },
  { area: "runs", feature: "Preflight: setup + checks + implementer sandbox probe in a throwaway worktree", status: "supported", note: "orchestrator preflight --repo r --agent-probe" },
  { area: "runs", feature: "Baseline checks on the untouched base", status: "supported", note: "a red base blocks before the agent starts" },
  { area: "isolation", feature: "Scrubbed environment for agents and repository commands", status: "supported", note: "no GH/Linear tokens, SSH agent or credential helpers" },
  { area: "isolation", feature: "Seatbelt sandbox for setup/checks (writes, credential reads, network)", status: "supported", note: "macOS; Linux (bubblewrap) planned, fails closed meanwhile" },
  { area: "isolation", feature: "Claude Code sandbox for implementer Bash; file tools fenced to the worktree", status: "supported", note: "no repo hooks, MCP servers or claude.ai connectors" },
  { area: "isolation", feature: "Tripwires outside the worktree; secret scan before commit and push", status: "supported", note: "violations FAIL the run" },
  { area: "isolation", feature: "VM/container boundary around the whole agent process", status: "planned", note: "prerequisite for unattended runs" },
  { area: "linear", feature: "Read issue, comments, relations, sub-issues", status: "supported", note: "GraphQL API; key from env or `orchestrator auth linear login`" },
  { area: "linear", feature: "Dependency classification with evidence (blocked-by, prerequisite, reference, related)", status: "supported", note: "merged implementation PRs and operator briefs count as evidence" },
  { area: "linear", feature: "Operator briefs: per-issue scope and dependency decisions", status: "supported", note: "config/briefs/<owner>/<repo>/<KEY>.md, hashed into the plan" },
  { area: "linear", feature: "Milestone comments (PR opened, merge-ready) / move issue state", status: "supported", note: "off unless granted; workspace verified before every write" },
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
  { area: "skills", feature: "One canonical skill for Claude Code and Codex, user-level install/update/status/uninstall", status: "supported", note: "orchestrator skill install --all" },
  { area: "skills", feature: "Natural-language activation (\"use Orchestrator for BRU-488\")", status: "supported", note: "the model's choice from the description; measured with pnpm eval:skills; /orchestrate and $orchestrate always work" },
  { area: "skills", feature: "Discovery check without a model call", status: "partial", note: "Codex: exact catalog via codex debug prompt-input; Claude Code: frontmatter parse only" },
  { area: "intake", feature: "Repository from the working directory (checkouts, linked worktrees, SSH aliases, forks)", status: "supported", note: "orchestrator context <issue>; ambiguity is never guessed" },
  { area: "intake", feature: "Issue keys and Linear URLs; workspace checked against the URL", status: "supported", note: "" },
  { area: "intake", feature: "Issue ↔ repository association with evidence (never the key prefix alone)", status: "supported", note: "briefs, saved confirmations, project mapping, issue links" },
  { area: "intake", feature: "First-use repository proposal + explicit authorization, stored outside the repository", status: "supported", note: "orchestrator repo init / repo authorize" },
  { area: "intake", feature: "Stored Linear credentials per workspace", status: "supported", note: "orchestrator auth linear login (macOS Keychain; 0600 file elsewhere)" },
  { area: "intake", feature: "Versioned JSON output for skills and scripts", status: "supported", note: "--json on context, run, status, resume, review, skill, auth" },
  { area: "intake", feature: "GitHub Issues / Jira as trackers", status: "planned", note: "issue references carry a tracker field" },
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
