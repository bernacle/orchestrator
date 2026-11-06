# Architecture

The orchestrator is a small, persistent state machine. It coordinates existing agents (Claude Code, Codex) and existing systems (Linear, GitHub, git). It does not write code itself, and it trusts nothing an agent says about its own work.

```
               ┌──────────────── operator-owned config (per repo) ───────────────┐
               │  checks · agents · permissions · merge policy · forbidden paths   │
               └───────────────────────────────┬──────────────────────────────────┘
 orchestrator CLI ── app.ts ── Engine (state loop, lease, cancel, effect ledger) ── HANDLERS (workflow.ts)
        │                          │                                                  │
        │                    SQLite store                                    Adapter contracts
        │              runs · events · artifacts · effects        IssueTracker  CodeHost  Workspace  CheckRunner  AgentRunner
        │                                                            Linear       gh CLI     git        /bin/sh     claude / codex
   /orchestrate skill (T3-hosted Claude Code) ──► same CLI
```

## Lifecycle

```
QUEUED → PLANNING → IMPLEMENTING → TESTING → REVIEWING → PR_OPEN → WAITING_FOR_CI → READY_TO_MERGE → MERGED → COMPLETED
                                     ▲  │        │                       │
                                     │  ▼        ▼                       ▼
                                     FIXING ◄────┴───────────────────────┘   (shared correction budget)
any working state → BLOCKED (resumable) | FAILED | CANCELLED
```

- The transition table in `src/core/states.ts` is the single source of truth. `Store.transition` rejects anything not listed. Every state change is one SQLite transaction (state, context patch, version bump, timeline event) with an optimistic version check.
- **FIXING never goes straight to PR_OPEN.** Every fix is re-tested and re-reviewed.
- **BLOCKED** means a human must act: an unresolved dependency, a missing permission, an agent failure, malformed reviewer output, or an unexpected error. It records `blocked_from`, and `resume` re-enters that state after reloading the config (so granting a permission and resuming works).
- **FAILED** is definitive: the correction budget ran out, or an invariant was violated (for example, the worktree changed during review).
- **Resting states** (`BLOCKED`, `WAITING_FOR_CI`, `READY_TO_MERGE`) hand control back. A state that transitions to itself ("CI still pending") ends the drive loop, and `resume` checks again.

## Durability, idempotency, retries

- **State** lives in `ORCHESTRATOR_HOME/orchestrator.db`, using WAL and `node:sqlite` (no native modules). Artifacts (prompts, transcripts, check logs, review JSON, plan) live in `ORCHESTRATOR_HOME/runs/<run-id>/`, with SHA-256 recorded in the `artifacts` table. Everything is redacted before it is written.
- **Effect ledger.** Every side effect goes through `ctx.effect({ key, permission, run, simulate })`. A `completed` key is never re-executed, and its stored result is reused. That's how a resumed run skips the push or the agent round it already did. An effect interrupted mid-flight is stored as `failed` and re-runs on resume. Effects that create things are also idempotent in their own right (worktrees are reused, existing PRs are found by branch first).
- **Session pinning.** The Claude session id is saved *before* the agent starts, so a crash resumes the same conversation with `--resume`.
- **Leases.** One process drives a run at a time (`lease_owner` = host:pid:nonce, TTL renewed every second). A dead local pid frees the lease immediately.
- **Retries.** Transient network errors retry a step twice with backoff. Anything else parks the run in BLOCKED with the error message.
- **Cancellation.** `orchestrator cancel` sets a flag. The driving process notices within a second and aborts the running agent or check (SIGTERM, then SIGKILL, to the whole process group), then moves to CANCELLED. Ctrl-C *interrupts*: the run keeps its state and can be resumed. Worktrees are always kept for inspection.

## Trust boundaries

| Claim | Who decides | How |
|---|---|---|
| "I changed X" | orchestrator | `git status` / `git diff --name-status base...HEAD` in the worktree; no diff means BLOCKED |
| "Tests pass" | orchestrator | runs the configured checks itself, recording exit codes and logs |
| "Approved" | orchestrator | reviewer (different provider, read-only sandbox) returns schema-validated findings; approved only if `verdict=approve` **and** no findings at blocking severities; malformed output means BLOCKED, never approval |
| "What was reviewed is what ships" | orchestrator + GitHub | reviewed SHA recorded; push only if HEAD == reviewed SHA; PR head must equal it; merge uses `--match-head-commit` |
| "Safe to commit" | orchestrator | `forbidden_paths` (`.env*`, keys, CI workflows by default) block the run |
| "Allowed to push / PR / comment / merge" | operator config | `permissions.*`, default all false; dry runs deny everything |

The implementer can't approve its own work, because the reviewer is a different adapter and the config can require a different provider (`review.require_distinct_provider`, on by default). Invariants are checked at PLANNING, and a violation blocks the run.

## Configuration and multi-repo

- One YAML file per repository: `ORCHESTRATOR_HOME/repos/<owner>/<name>.yaml` overrides the bundled `config/repos/<owner>/<name>.yaml`.
- **Config never comes from the target repository.** A repository can't grant itself permissions or turn on auto-merge. Repository *guidance* (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`) is passed to agents as input. It is not policy.
- `--repo` is optional. Without it, the issue's team key (`BRU`) is matched against `linear.teams`, and an ambiguous match is an error.
- By default the orchestrator keeps its own clone under `ORCHESTRATOR_HOME/clones`, and worktrees live under `ORCHESTRATOR_HOME/worktrees/<owner>/<repo>/<run-id>`. The operator's checkout is never touched. `local_path` opts into using an existing clone.
- `toolchain.node` pins the Node major version. It is resolved from PATH or nvm and prepended to PATH for checks and agents.

## Dry runs

A dry run executes every *read* for real: Linear issue, relations, GitHub repo and protection, a fetch into the orchestrator-owned clone, inspection at `origin/<base>`, and toolchain resolution. It then builds the same `ExecutionPlan` a live run uses, and walks the remaining states, recording each planned action as a simulated effect. Each action carries the permission a live run would need and whether the current config grants it. `--with-agent-plan` additionally runs the read-only planner. That costs tokens but changes nothing.

## Adapters

`src/adapters/types.ts` defines five small contracts. Real implementations wrap supported CLIs and APIs only. `src/adapters/mock` provides in-memory versions, and the integration tests combine those with a real git origin, real worktrees and the real check runner.

Adding an agent means implementing `AgentRunner` (`run`, `describe`, `probe`) and adding a config variant. Roles are assigned per repository (`agents.planner|implementer|reviewer`).

## Merge policy

`evaluateMerge` (`src/core/policy.ts`) is a pure function, unit-tested case by case.

- **Eligible** (a human may merge): PR open, no conflicts, CI passing (required checks if configured, otherwise all checks), independent approval recorded, reviewed SHA == PR head, no unresolved blocking findings, no GitHub "changes requested", required approvals met.
- **Auto-merge** additionally requires: `merge.mode: auto`, `merge.auto_authorization` (repo, who authorized it, when, and the GitHub login allowed to merge) matching the acting identity, `permissions.github.merge`, a **protected** base branch **with required status checks**, a non-draft PR, `mergeStateStatus == CLEAN`, and no `ORCHESTRATOR_DISABLE_MERGE=1`. The schema refuses `auto` without authorization, and refuses `auto` combined with `require_ci: false` or `require_independent_review: false`.

Analyticool is configured `manual`, and its `main` is unprotected, so the auto path would refuse even if enabled.

## Known limitations (v1)

- **Repository agent settings apply.** Claude Code loads the target repository's project settings (`CLAUDE.md`, `.claude/skills`, and any hooks in `.claude/settings*.json`). That is usually what you want for the implementer. But hooks are code from the repository, so check them before the first live run. Analyticool currently has skills and agents, and no settings file or hooks.
- **The implementer is not OS-sandboxed.** Claude Code's permission rules are the boundary: edits are auto-accepted, the shell is allow-listed, and git push/commit and `gh` are denied. The orchestrator's own checks run as the operator. Codex as an implementer would use its `workspace-write` sandbox.
- **CI feedback is check names and links**, not log excerpts (see roadmap).
- **Declared dependencies are heading-based.** Issue keys under a "Dependencies" / "Prerequisites" / "Blocked by" heading are treated as dependencies, conservatively including plain references. The operator accepts non-prerequisites explicitly.
- **One driver per run, one machine.** Leases detect dead processes only on the same host. That's adequate for a local tool.

## Deliberate non-goals (v1)

No hosted services, queues or event bus. No custom T3 UI. No new coding agent. No unattended scheduler yet. No permission-bypass modes, anywhere.
