# Roadmap

`orchestrator capabilities` prints the current support matrix. This is the plan for what comes next, roughly in order. Each step keeps the same rules: operator-owned policy, verified results, no permission bypass.

## 1. First supervised live run (next)

1. `orchestrator preflight --repo bernacle/analyticool --agent-probe` (green on 2026-11-08).
2. `orchestrator run BRU-488 --repo bernacle/analyticool --dry-run --with-agent-plan` with a fresh Linear key. Review the plan, the dependency evidence and the open questions, and answer the questions in the brief if you want them decided.
3. `orchestrator run BRU-488 --repo bernacle/analyticool --execute`, then watch with `orchestrator logs <id> -f`.
4. Expected result: a **draft** PR, with the run parked in `READY_TO_MERGE` (manual). A human reviews and merges.
5. Afterwards, tune `allowed_tools`, timeouts and budgets from the transcripts in `runs/<id>/`.

## 1b. Isolation toward unattended runs

- Linux check sandbox (bubblewrap), with the same profile semantics. Until it exists, live runs on Linux are blocked.
- An egress allow-list for setup (registry only) instead of open outbound.
- Per-run cache directories, to rule out cache poisoning across repositories.
- A VM or container around the whole agent process, plus a dedicated low-privilege GitHub identity. **Both are prerequisites** for any unattended mode.

## 2. Plan approval gate

Add `approval: { plan: required }` per repository. The run parks in a new `AWAITING_APPROVAL` state after PLANNING, and `orchestrator approve <run-id>` (recorded in the timeline with the operator's identity) releases it. This makes "dry run, then execute" a single supervised run.

## 3. PR watching

- Done: `orchestrator watch` follows a delivered run in the foreground, recording a merge or close (read-only). `status`, `context` and `report` reconcile too. There is no daemon. The delivery report and macOS notifications are also done.
- Feed CI *log excerpts* to the implementer (`gh run view --log-failed`), not just failing check names.
- Pick up human GitHub review comments on the PR as findings for another FIXING round, with the human marked as the reviewer.
- Detect a base branch that moved and rebase safely (never force-push without a recorded human decision).

## 4. Automatic merges

The code path exists (`evaluateMerge`, the `READY_TO_MERGE` handler, `gh pr merge --match-head-commit`), but it is disabled everywhere. To enable it for a repository:

1. Enable branch protection or a ruleset on the base branch, with required status checks (and ideally required reviews).
2. Add `merge.mode: auto` plus `merge.auto_authorization { repo, authorized_by, authorized_at, actor }`, and `permissions.github.merge: true`, in the operator config.
3. Use a dedicated GitHub identity (a GitHub App or bot account) with only the repository permissions it needs. Never an admin token.
4. Start with low-risk labels only (for example `auto-merge-ok` on the Linear issue), then widen.

`ORCHESTRATOR_DISABLE_MERGE=1` is a global kill switch.

## 5. Unattended execution

- A queue command: `orchestrator queue --team BRU --label orchestrator-ready` picks issues whose dependencies are resolved, one run per repository at a time.
- A concurrency limit per repository, plus a global budget (`max_budget_usd` per day).
- Notifications on BLOCKED or READY_TO_MERGE (Linear comment, macOS notification, or a T3 thread once T3 offers a non-turn message type).

## 6. T3 integration

Done: user-level skills for Claude Code and Codex, natural-language activation, repository detection from the session's directory, first-use authorization (see [skills.md](skills.md)). Next:

- Ask T3 to expose the current thread id and project id to sessions, so runs can link back to the exact thread instead of only `origin: t3`.
- GitHub Issues and Jira as trackers (issue references already carry a `tracker` field; association evidence is tracker-agnostic).
- A plan-approval handshake: `run --execute --from-dry-run <id>` that refuses to start when the live plan differs from the approved dry run.

- When `t3 thread start` gains a runtime-mode flag, add a `t3-thread` implementer adapter, so implementation happens in a visible T3 thread and worktree. The `t3 thread start --worktree --branch --wait --json` surface is already sufficient for everything else.
- Link runs to the originating T3 thread once T3 exposes the thread id to child processes.
- Use `t3 thread list --json` (`linkedPullRequest`) to show T3 sessions working on the same branch.

## 7. More roles

- Security reviewer: a second read-only review pass with its own schema, required for labelled issues.
- Test writer: writes tests from the acceptance criteria *before* implementation. The implementer must make them pass, and must not edit them.
- Docs and changelog updater.
- Dependency-change role with an explicit permission (today the implementer cannot run `pnpm add`).

## 8. Packaging

- Publish to npm (`npx @bernacle/orchestrator`), and add a `brew` formula.
- Run `orchestrator init owner/repo` to generate a starter config from the repository's CI workflow.
