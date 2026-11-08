# Integration research

What each tool supports today, verified on 2026-11-06 against the installed versions. Everything here came from `--help` output, the tool's own JSON output, or the official API. Nothing relies on undocumented endpoints or internal databases.

| Tool | Version checked | Integration surface used |
|---|---|---|
| T3 Code | `t3 v0.1.3` | `t3` CLI (`thread list/start/send/show`, `--json`) |
| Claude Code | `2.1.318` | `claude -p` (print mode) |
| Codex | `codex-cli 0.165.0` | `codex exec`, `codex exec resume`, `codex review` |
| GitHub | `gh 2.101.0` | `gh api`, `gh pr create/view/list/merge` |
| Linear | GraphQL API | `https://api.linear.app/graphql` with a personal API key |

## T3 Code

**Supported surface.** The `t3` launcher (`~/.t3/bin/t3`, exposed to T3-hosted sessions as `T3CODE_CLI_PATH`) talks to the running T3 server:

- `t3 thread list --project <path> --json` lists threads with `threadId`, `status`, `providerInstanceId`, `model`, `runtimeMode`, `branch`, `worktreePath` and linked PRs.
- `t3 thread start <project> <message> [--provider --model --worktree <base> --branch <name> --wait --json]` starts a thread, optionally in a new git worktree. `--wait` exits 1 on failure and 2 when the agent is waiting for an answer.
- `t3 thread send <thread> <message> [--wait]` queues a message as the next turn. It does not interrupt.
- `t3 thread show <thread> --json [--messages N]` returns thread state and recent messages.
- `t3 project add|remove|rename`, `t3 app [path]` (opens the desktop app), `t3 doctor`, `t3 service`.

**Limitations that shaped the design**

1. **No runtime-mode control from the CLI.** `t3 thread start` has no flag for runtime or permission mode. Threads inherit the project default, and threads started on this machine report `runtimeMode: "full-access"`. A T3 thread therefore can't be used as the implementer without breaking the "never use permission-bypass modes" rule. The orchestrator runs Claude Code and Codex directly with explicit, auditable permission flags.
2. **No plugin or slash-command API.** T3 can't register a custom `/orchestrate` command. What T3 does have is agent sessions (Claude Code, Codex), and those load user-level *skills*. Orchestrator ships one canonical skill, rendered for both providers by `orchestrator skill install --all` (see [skills.md](skills.md)). The model can pick it from an ordinary request, or you can invoke it with `/orchestrate` or `$orchestrate`. Either way, the skill drives the `orchestrator` CLI. Verified details:
   - **Claude config dir.** T3 can launch Claude Code with a per-instance home path (Settings → Providers). Here, the "Personal" instance runs with `CLAUDE_CONFIG_DIR=~/.claude-work2`, so skills in `~/.claude/skills` are invisible to it. The installer reads the configured paths from `~/.t3/userdata/settings.json` (read-only) and installs to each.
   - **Codex.** T3's Codex instance uses the default `CODEX_HOME`. Codex 0.165 scans both `~/.agents/skills` (documented) and `~/.codex/skills`, and lists a skill twice if it is in both.
   - **Working directory.** T3 sessions start in the project root or in a T3 worktree (`~/.t3/worktrees/<project>/<id>`), and the skill runs the CLI there. T3 exposes no thread id or project id to the session, only `T3CODE_CLI_PATH`. The repository is therefore identified from git remotes, not from T3.
   - **SSH aliases.** T3's own `repositoryIdentity` for a remote like `git@github-personal:owner/repo.git` reports `provider: unknown`, because it doesn't resolve SSH aliases. Orchestrator resolves them with `ssh -G`.
3. **No CLI to post status without starting a turn.** `t3 thread send` delivers a message *to the agent*, which starts a model turn. That makes it unsuitable for progress pings. Progress lives in `orchestrator status/logs`, and the skill reads those.
4. **No thread id in the environment.** T3 sessions expose `T3CODE_CLI_PATH`, but not the current thread id. The orchestrator records that a run started from inside T3 (`origin: t3`), but can't yet link the exact thread.

**What would unlock deeper integration** (requests for T3, not workarounds): a `--runtime-mode` flag on `thread start`, a non-turn "annotation" message type, and the current thread id exposed to child processes.

## Claude Code

Non-interactive execution is fully supported:

- `claude -p` reads the prompt from stdin. `--output-format json` returns one result object with `result`, `session_id`, `is_error`, `subtype`, `total_cost_usd` and `structured_output` (when `--json-schema` is given).
- **Sessions:** `--session-id <uuid>` pre-assigns the id, and `--resume <id>` continues it. The orchestrator saves the id *before* launch, so a crash mid-run resumes the same session, and fix rounds continue the implementer's context.
- **Permissions without bypass:** `--permission-mode acceptEdits` auto-accepts file edits. `--allowedTools` and `--disallowedTools` take rule patterns such as `Bash(pnpm test:*)`. `--permission-prompts none` denies anything that would prompt, since no human is attached. `--tools Read,Grep,Glob` limits the planner to read-only tools.
- **Budget:** `--max-budget-usd` caps spend per invocation.
- `--dangerously-skip-permissions` and `--permission-mode bypassPermissions` exist. The config schema rejects them, and no code path emits them.

**Sandboxing (verified 2026-11-08, see [isolation.md](isolation.md))**
- Claude Code's `sandbox` settings confine **Bash and its child processes** using Seatbelt on macOS: writes limited to the working directory, a network proxy with a domain allow-list (empty denies everything), `filesystem.denyRead`, and `credentials.envVars` deny.
- `failIfUnavailable: true` makes it refuse to start without the sandbox, and `allowUnsandboxedCommands: false` removes the unsandboxed-retry escape hatch.
- Read/Edit/Write are *not* covered by the OS sandbox. `permissions.blockReadsOutsideWorkingDirectories` (≥ 2.1.257) and `blockWritesOutsideWorkingDirectories` (≥ 2.1.314) fence them.
- `--setting-sources ""` loads no user, project or local settings, so repository hooks and allow rules don't apply. `--strict-mcp-config` loads no MCP servers. `disableClaudeAiConnectors` removes claude.ai connectors, which would otherwise give an agent your Linear workspace.
- Corepack must be allowed to read and write `~/.cache/node/corepack`, or `pnpm` fails inside the sandbox. Preflight caught this.

When the orchestrator itself runs inside a Claude Code session, it strips `CLAUDECODE` / `CLAUDE_CODE_*` from the child environment so the implementer starts as an independent session.

## Codex

- `codex exec [--json] [-o last.txt] [--output-schema schema.json] [--sandbox read-only|workspace-write] [-C dir] -` runs non-interactively. `--json` emits JSONL events, and `thread.started` carries the session id.
- `codex exec resume <id>` continues a session. `codex review [--base <branch>|--commit <sha>|--uncommitted]` runs a built-in review with free-text output.
- **Reviewer choice:** the orchestrator uses `codex exec --sandbox read-only -c approval_policy="never" --output-schema …` rather than `codex review`, because the schema makes findings machine-checkable (`verdict`, findings with `severity`, `file`, `line`). The read-only sandbox means the reviewer cannot change the code it judges. As a second guard, the orchestrator checks that HEAD and the working tree are unchanged after review.
- `--dangerously-bypass-approvals-and-sandbox` and `danger-full-access` exist. The schema rejects them.

## GitHub (`gh`)

- **Repository facts:** `gh api repos/{o}/{r}` (default branch, merge methods, our permission), `gh api repos/{o}/{r}/commits/{branch}` (base SHA).
- **Protection:** `gh api repos/{o}/{r}/branches/{b}` (classic protection flag and required checks) plus `gh api repos/{o}/{r}/rules/branches/{b}` (rulesets, readable without admin). Classic required-review counts need admin access to read, and are reported as unknown.
- **PRs:** `gh pr create --draft --body-file`, `gh pr list --head`, and `gh pr view --json number,url,state,isDraft,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup`.
- **Merging:** `gh pr merge --squash --match-head-commit <sha>` refuses to merge if the head moved. That's how "merge only what was reviewed" is enforced at the API level. `--admin` (bypass requirements) is never used.
- **Finding for Analyticool:** `main` has **no branch protection and no rulesets**, and `allow_auto_merge` is off. GitHub enforces nothing, so the orchestrator's `auto` merge mode refuses to run on an unprotected branch. Manual mode works.

## Linear

- The official GraphQL API. `issue(id: "BRU-488")` accepts the human identifier. One query fetches the description, state, team, project, labels, parent, children, `relations` and `inverseRelations` (blocking edges are stored once; an inverse `blocks` edge means "blocked by"), comments and attachments.
- Writes used: `commentCreate`, and `issueUpdate(stateId)` after resolving the team's workflow state by name. Both are behind explicit permissions.
- Auth: a personal API key in `LINEAR_API_KEY` (or a file path in `LINEAR_API_KEY_FILE`), sent as the raw `Authorization` header.
- **Finding:** the Linear connector available to the Claude session that built this was attached to a different workspace, so it could not see `BRU-*` issues. The orchestrator does not depend on any agent's MCP connectors. It uses its own key, which keeps runs reproducible from a plain terminal.

## Local toolchain

- Analyticool pins Node 24 (`engines`, `.nvmrc`) and `pnpm@10.34.9` (`packageManager`). On this machine the default `node` is 23.1, and the Homebrew `pnpm` shim fails. With nvm's Node 24 first on `PATH`, corepack resolves pnpm 10.34.9 correctly. The orchestrator therefore resolves the toolchain per repository (`toolchain.node`), finds the matching Node in nvm's install directory, and prepends it to `PATH` for checks and agents. It never installs anything.
- Node ≥ 22.13 ships `node:sqlite`, so durable state needs no native dependencies.
