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
- **Minor-finding round.** An approval with actionable `minor` findings goes REVIEWING → FIXING (trigger `minor`) once per run, then TESTING → REVIEWING as usual. If that result fails a check or isn't approved, FIXING (trigger `revert`, no agent) resets the worktree to the approved commit. That commit is always an ancestor of HEAD and was never pushed past. TESTING re-checks it, and REVIEWING reuses its recorded approval because the tree is identical. Then it goes to PR_OPEN. No new states or transitions, and the correction budget (`max_fix_attempts`) counts neither round.
- **Acceptance criteria** are numbered per run (`AC1…`: the issue's own list, then the planner's derived ones). The reviewer gives each a verdict. `not_met` blocks approval and merge eligibility. A missing or unknown verdict is `needs_human`, which is never shown as met.
- **BLOCKED** means a human must act: an unresolved dependency, a missing permission, an agent failure, malformed reviewer output, or an unexpected error. It records `blocked_from`, and `resume` re-enters that state after reloading the config (so granting a permission and resuming works). The unblock is narrow: the drive leaves a block only if the run was BLOCKED when the drive started, on the same block (state and reason) the person approved in the resume prompt, and only once. A run resumed while not BLOCKED (interrupted, killed CLI) gets no unblock, and any block reached later in a drive ends it: a new blocker always goes back to a person.
- **Baseline.** With `baseline_checks`, IMPLEMENTING runs every check on the untouched base before the agent starts. Only a green, clean baseline is saved as the accepted `baseline` and reused when the step is re-entered. A red one is kept in `baselineFailure` for audit and blocks the run; each attempt uses fresh effect keys (`baseline.<n>.<check>`), so an approved resume re-runs every check instead of replaying the red result. Only an interrupted attempt continues with its own completed checks.
- **FAILED** is definitive: the correction budget ran out, or an invariant was violated (for example, the worktree changed during review).
- **Bounded recovery** happens inside the step that failed, under its own effect keys (`….retry`):
  - one retry of an implementer round (resuming its session);
  - one retry of a reviewer crash or schema mismatch.

  A failed or unusable agent result is recorded as a failed effect, never a completed one. An approved resume after such a block runs the agent again, with its one retry, instead of replaying the failure. A usable result is reused, including a retry that finished before an interruption: the first attempt is not run again. An agent call's cost is added once, when it runs, never again when its result is reused. Every agent call's timeout is capped at exactly what is left of the run's time window. Before an implementer is retried, what it left in the worktree goes through the forbidden-path and secret checks, so a retry can never erase the evidence of a violation.

  Safety stops are `FailedError`s from tripwires, secret scans and changed-code checks, and they are never retried. Branch collisions and push access are settled in PLANNING, before any agent runs. Branches on origin are checked with `git ls-remote`, not the clone's tracking refs. Until a run's worktree exists on its branch, every attempt creates the branch (`worktree add -b`, which fails if the branch exists). That includes an attempt after a failed creation or an approved resume, so a run never attaches to a branch that appeared after planning. Before an implementer is retried, untracked files the secret scan cannot read block the retry rather than count as clean. The push identity is passed per command and never written to a git config file:
  - `push.url` is the push destination itself, so the clone's own `remote.origin.pushurl` is not pushed to as well;
  - `push.ssh_identity_file` is passed through `GIT_SSH_COMMAND`, and must be inside `~/.ssh`. Setup, checks and the Claude Code implementer are denied `~/.ssh`. The Codex reviewer's read-only sandbox doesn't deny reads (see isolation.md), the same as for any other key there.
- **Reconciliation** (core/reconcile.ts) records a person's merge or close of the run's PR. It works without a drive or approval:
  - It reads the PR, and a commit comparison when the merged head isn't the reviewed commit.
  - Then it moves the run (from `WAITING_FOR_CI`, `READY_TO_MERGE` or `BLOCKED`) through `READY_TO_MERGE → MERGED → COMPLETED`, or to `CANCELLED`.
  - It uses only existing transitions, and takes the run's lease, so a driving process is never raced.
  - No step handler or effect runs, so nothing can be pushed, merged or edited.
- **Settling** (core/settle.ts) runs after every drive and reconciliation:
  - It rewrites `runs/<id>/delivery.{md,json}` from durable state.
  - It sends the one notification the state deserves, deduplicated by `notify.sent` timeline events. Events don't bump the run's version, so they never conflict with a driver.
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
| "Start (or resume) a live run" | a person, at a system prompt | `--execute` stops for macOS LocalAuthentication (Touch ID / password) naming the run's scope; the answer is used in-process and never stored as authority, so nothing an agent writes can stand in for it (`core/approval.ts`); each drive pins the run's mode, issue and repository and stops if the store disagrees, so a dry run can't be rewritten into a live one (`core/engine.ts`); `ORCHESTRATOR_NO_EXECUTE=1` refuses first |
| "Start (or resume) a live run in a trusted repository" | a person, once, at the same system prompt (`repo trust`) | the engine accepts a sealed trust record (`core/trust.ts`) instead of a per-run prompt only while the run's config has exactly the approved trust scope and still meets trusted mode's conditions (no merge, sandbox required, distinct reviewer, draft PRs); trust grants no permission, never covers accepted dependencies or a new time window, and doesn't transfer between repositories; see [skills.md](skills.md#trusted-repositories-opt-in) for the trade-off |
| "Authorize this repository / confirm this association" | a person, at a system prompt | same prompt before `repo authorize` writes config or `associate` saves a mapping |

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
- `toolchain.node` pins the Node version: `"24"` accepts any 24.x.y, `"24.21.0"` requires exactly that. The repository's `.nvmrc` / `.node-version` at the base commit refines it (config `"24"` with `.nvmrc` `24.21.0` requires 24.21.0) unless `toolchain.node_version_file: false`; a disagreement blocks. The `node` children would run is probed with the scrubbed child environment, in the directory checks run in (asdf/mise choose by directory). If it does not match, a matching nvm install is prepended to PATH. Planning, every live step, `preflight` and `doctor` use the same resolution (`resolveRunToolchain`), and a live step blocks instead of running checks or agents on a non-matching Node.

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
