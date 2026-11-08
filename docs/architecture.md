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

## Intake (before a run exists)

`src/intake` turns a request into a run, or into a precise reason why not. `orchestrator context` prints its result, and `startRun` goes through the same function, so a skill's preparation and the engine's own gate can't disagree. It resolves, in order:

1. the issue reference (a key or a Linear URL; the URL's workspace is kept);
2. the repository (`--repo`, `--config`, the working directory's GitHub remotes, or the team mapping outside a repository; ambiguity is reported, never guessed);
3. operator-owned configuration (missing → first-use proposal);
4. the Linear credential for the request's workspace;
5. the issue ↔ repository association (evidence required unless `--repo` was explicit);
6. existing runs (a second live run is refused).

Only then is a run created. The resolution is stored on the run (`context.options.intake`). See [skills.md](skills.md).

## Trust boundaries

| Claim | Who decides | How |
|---|---|---|
| "I changed X" | orchestrator | `git status` / `git diff --name-status base...HEAD` in the worktree; no diff means BLOCKED |
| "Tests pass" | orchestrator | runs the configured checks itself, recording exit codes and logs |
| "Approved" | orchestrator | reviewer (different provider, read-only sandbox) returns schema-validated findings; approved only if `verdict=approve` **and** no findings at blocking severities; malformed output means BLOCKED, never approval |
| "What was reviewed is what ships" | orchestrator + GitHub | reviewed SHA recorded; push only if HEAD == reviewed SHA; PR head must equal it; merge uses `--match-head-commit` |
| "Safe to commit" | orchestrator | `forbidden_paths` (`.env*`, keys, CI workflows, agent config by default) block the run; the diff and PR text are scanned for secrets before push |
| "Nothing escaped the worktree" | orchestrator | tripwire fingerprints of shell rc files, git config/hooks/refs and agent settings, compared around every agent and check step |
| "Allowed to push / PR / comment / merge" | operator config | `permissions.*`, default all false; dry runs deny everything |
| "This repository may be used" | operator | an operator-owned config (`config/repos/` or `~/.orchestrator/repos/`, written by `repo authorize` on first use); files in the repository are ignored |
| "This issue belongs to this repository" | operator / evidence | explicit `--repo`, a brief, a saved confirmation, a mapped Linear project, or the issue linking to the repository; never the key prefix |
| "Start a live run" | operator | `--execute`; skills require the user's explicit request; `ORCHESTRATOR_NO_EXECUTE=1` disables it |

The implementer can't approve its own work, because the reviewer is a different adapter and the config can require a different provider (`review.require_distinct_provider`, on by default). Invariants are checked at PLANNING, and a violation blocks the run.

## Dependency model

`src/planning/dependencies.ts` classifies every issue the target issue relates to or mentions:

| Class | Source | Blocks? | Becomes non-blocking when |
|---|---|---|---|
| `hard_blocker` | Linear "blocked by" relation | yes | the blocker is completed in Linear (update or unlink it there; `--accept-dependency` does not override Linear) |
| `prerequisite` | prerequisite wording on the issue's line ("depends on", "requires", "merge … first", "after X lands"), a pure "Prerequisites"/"Blocked by"/"Dependencies" heading, or the operator brief | yes | completed in Linear; **or** its implementation PR is merged with none open; **or** the files the brief names exist at the base commit; **or** the operator passes `--accept-dependency` (audited) |
| `satisfied` | any of the above, already done | no | |
| `accepted` | operator override | no | |
| `reference` | mentioned without prerequisite wording, e.g. a mixed "Dependencies & references" list, "Design: …", "see also", "optional" | no | |
| `related` | Linear "related" relation only | no | |

*Implementation PR* means a PR in the target repository that carries the key in its title or branch, or that is attached to the issue in Linear. A PR whose body merely mentions the key is recorded as context and never counts as completion. Explicit negations ("not a prerequisite", "optional", "follow-up") override wording heuristics. An issue that can't be read from Linear keeps an unknown state, so a prerequisite on it stays blocking. Every item carries its evidence (relation, description line, Linear state, PRs, files, operator decision), and the plan shows all of it.

## Isolation

See [isolation.md](isolation.md). In short:
- children get an allow-listed environment
- setup and checks run under a Seatbelt profile
- the implementer's Bash runs in Claude Code's sandbox, with file tools fenced and repository settings, hooks, MCP and connectors excluded
- the orchestrator never runs repository hooks itself
- tripwires and secret scans turn suspected escapes into FAILED runs
- live runs block when isolation can't be verified

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

- **Isolation is not a VM.** See [isolation.md](isolation.md#what-is-not-covered). Unattended runs stay disabled.
- **CI feedback is check names and links**, not log excerpts (see roadmap).
- **Prerequisite wording is heuristic.** Ambiguous text is classified conservatively in the direction stated by the wording on that line, and the evidence is shown. Operator briefs exist for the cases the heuristic gets wrong.
- **Snapshot replays** (`--issue-snapshot`) are for dry runs only, and are labelled stale in the plan.
- **One driver per run, one machine.** Leases detect dead processes only on the same host. That's adequate for a local tool.

## Deliberate non-goals (v1)

No hosted services, queues or event bus. No custom T3 UI. No new coding agent. No unattended scheduler yet. No permission-bypass modes, anywhere.
