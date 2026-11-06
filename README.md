# orchestrator

A supervised engineering orchestrator. One command takes a Linear issue through planning, an isolated implementation, the repository's own checks, and an independent review by a different agent, ending in a draft pull request with the run's state, decisions and evidence recorded locally.

```bash
orchestrator run BRU-488 --repo bernacle/analyticool --dry-run    # plan + simulated timeline, no side effects
orchestrator run BRU-488 --repo bernacle/analyticool --execute    # supervised live run → draft PR
orchestrator status
orchestrator logs <run-id> -f
orchestrator resume <run-id>
orchestrator cancel <run-id>
```

It coordinates tools you already use (Claude Code, Codex, Linear, GitHub, git, and T3 Code through a skill). It is not another coding agent and not another T3. Everything runs locally, with state in one SQLite file.

## What it guarantees

- **Verified, not self-reported.** Changed files come from `git`, check results from running the checks, approval from a schema-validated review. An agent saying "done" counts for nothing.
- **Independent review.** The reviewer is a different adapter, and by default a different provider: Claude Code implements, Codex reviews in a read-only sandbox. A reviewer "approve" that still lists blocker or major findings is not an approval. Malformed review output blocks the run.
- **What was reviewed is what ships.** The reviewed SHA is recorded. A push only happens if HEAD equals it, the PR head must equal it, and merges use `--match-head-commit`.
- **Dependencies are never skipped silently.** Linear `blocked by` relations *and* issues listed under a "Dependencies" heading in the description are checked. An unresolved one blocks the run, unless the operator accepts a description dependency explicitly with `--accept-dependency`, which is recorded in the audit trail.
- **Explicit permissions.** Pushing, opening PRs, commenting on or moving Linear issues, and merging each require a grant in operator-owned config. Dry runs do none of them. Agents never run in bypass modes: the schema rejects `bypassPermissions` and `danger-full-access`.
- **No automatic merges** unless the repository config contains an `auto_authorization` block **and** the base branch is protected with required checks. Analyticool is `manual`.
- **Durable and recoverable.** Runs survive restarts. `resume` continues from the last step without redoing completed actions, Ctrl-C pauses, and `cancel` stops the running agent. Worktrees are kept for inspection.
- **Secrets stay out of logs.** Everything written to the timeline and artifacts is redacted.

## Install

Requirements: Node ≥ 22.5 (24 recommended; the launcher enables `node:sqlite` automatically on older 22/23 releases), git, and `gh` (authenticated). Live runs also need `claude` and `codex` (both logged in).

```bash
git clone https://github.com/bernacle/orchestrator && cd orchestrator
corepack pnpm install
corepack pnpm link --global        # puts `orchestrator` on PATH (or use: pnpm orchestrator …)
export LINEAR_API_KEY=lin_api_…    # or LINEAR_API_KEY_FILE=/path/to/file
orchestrator doctor
```

`orchestrator doctor` checks Node, the state directory, `gh` auth and identity, the Linear key and workspace, Claude Code, Codex login, the T3 CLI and server, and, for each configured repository, access, branch protection, toolchain resolution and agent assignments.

## Configure a repository

There's one YAML file per repository, and it lives with the operator, never in the target repository:

1. `~/.orchestrator/repos/<owner>/<name>.yaml` (local override), then
2. `config/repos/<owner>/<name>.yaml` in this repository (shared defaults).

See [`config/repos/bernacle/analyticool.yaml`](config/repos/bernacle/analyticool.yaml) for a complete example. The essentials:

```yaml
repo: bernacle/analyticool
linear: { teams: [BRU] }            # issue keys this repo handles (lets you omit --repo)
toolchain: { node: "24" }           # resolved from PATH or nvm, prepended for checks and agents
setup:  [{ name: install, run: pnpm install --frozen-lockfile }]
checks: [{ name: lint, run: pnpm lint }, { name: test, run: pnpm test }]
agents:
  planner:     { adapter: claude-code }
  implementer: { adapter: claude-code, permission_mode: acceptEdits, allowed_tools: [Read, Edit, Write, "Bash(pnpm test:*)"] }
  reviewer:    { adapter: codex, sandbox: read-only }
permissions:
  agents: { run: true }
  github: { push: true, create_pr: true, merge: false }
  linear: { comment: false, update_state: false }
merge:
  mode: manual
  require_ci: true
  require_independent_review: true
  max_fix_attempts: 3
```

Swap roles per repository (Codex implements and Claude reviews, for example) by changing `agents`. `forbidden_paths` (by default `.env*`, keys, `.github/workflows/**`) are never committed, whatever the agent writes. By default the orchestrator keeps its own clone under `~/.orchestrator/clones`, so your checkout is never touched. Set `local_path` to use an existing clone instead.

## How a run works

```
QUEUED → PLANNING → IMPLEMENTING → TESTING → REVIEWING → PR_OPEN → WAITING_FOR_CI → READY_TO_MERGE → MERGED → COMPLETED
                                      ▲  └──── FIXING ◄──┴───────────────────────────────┘
                     BLOCKED (resumable) · FAILED · CANCELLED
```

1. **PLANNING** fetches the issue (description, comments, relations, sub-issues), checks dependencies, extracts acceptance criteria, inspects the repository at `origin/<base>` (scripts, CI workflow, guidance files, branch protection), resolves the toolchain, checks agent invariants, optionally runs the read-only planner, and writes `plan.md` / `plan.json`.
2. **IMPLEMENTING** creates a worktree on `orch/<key>-<slug>` and runs setup. The implementer works with edits auto-accepted and a shell allow-list; `git push`/`commit` and `gh` are denied. The orchestrator then computes the diff itself and commits it.
3. **TESTING** runs every configured check, recording exit codes and logs.
4. **REVIEWING** runs the reviewer on `git diff base...HEAD`, with the issue, the acceptance criteria and the verified check results.
5. **FIXING** sends failing checks, blocking findings or CI failures back to the *same* implementer session (Claude `--resume`). Every fix is re-tested and re-reviewed. The budget is `max_fix_attempts`.
6. **PR_OPEN** pushes (never force-pushes) and opens or reuses a **draft** PR whose body lists the changes, the orchestrator-run checks, and the review.
7. **WAITING_FOR_CI** polls GitHub checks (`--ci-wait`, 30 min by default), then hands back. `resume` checks again.
8. **READY_TO_MERGE** reports merge eligibility. In `manual` mode the run parks here, a human merges, and `resume` records the merge.

All artifacts live in `~/.orchestrator/runs/<run-id>/`: prompts, agent transcripts, check logs, review JSON, plan, merge report. `orchestrator status <run-id>` lists them along with every external action the run took.

## Supported today vs planned

Run `orchestrator capabilities` for the live list.

| | Supported | Planned |
|---|---|---|
| Runs | durable state, dry run, supervised run, resume/cancel, single-driver lease | plan-approval gate, queue/scheduler |
| Linear | read issue + relations + comments, dependency blocking, gated comments/state changes | label-driven intake |
| GitHub | protection/ruleset inspection, push, draft PR, CI polling, merge eligibility | CI log excerpts to the implementer, human review comments as findings, watcher |
| Merging | eligibility report; auto-merge implemented behind explicit authorization + protected branch | enabling it per repository |
| Agents | Claude Code (implementer/planner), Codex (reviewer), per-repo roles | security reviewer, test writer, docs |
| T3 | `/orchestrate` skill, T3 origin detection, T3 server check in doctor | implementer inside a T3 thread (needs runtime-mode control in `t3 thread start`) |

## T3 Code

T3 has no plugin or slash-command API, but the Claude Code sessions it hosts load skills. Install the skill once:

```bash
orchestrator install-skill          # links integrations/claude-skill/orchestrate into ~/.claude/skills
```

Then, in a T3 Claude Code thread, type `/orchestrate BRU-488`. The skill defaults to a dry run, never adds `--execute` on its own initiative, and reports the CLI's results verbatim. Why T3 threads aren't used as the executor yet is explained in [docs/research.md](docs/research.md#t3-code).

## Dry run on Analyticool

```bash
orchestrator run BRU-488 --repo bernacle/analyticool --dry-run
orchestrator run BRU-488 --repo bernacle/analyticool --dry-run --with-agent-plan   # + read-only planner (~$1–2)
```

These read Linear and GitHub, fetch into the orchestrator's own clone, and record what a live run would do, including the exact agent command lines and which permissions each step needs. Nothing is written to Analyticool, GitHub or Linear.

## Development

```bash
corepack pnpm typecheck
corepack pnpm test               # unit + integration (real git, mocked Linear/GitHub/agents)
corepack pnpm smoke:agents       # real claude + codex against a throwaway repo (~$0.50)
```

- [docs/research.md](docs/research.md): what T3, Claude Code, Codex, GitHub and Linear support, as verified
- [docs/architecture.md](docs/architecture.md): state machine, durability, trust boundaries, merge policy
- [docs/roadmap.md](docs/roadmap.md): PR watching, auto-merge, unattended runs, more roles

Source map: `src/core` (engine, store, states, policy, workflow), `src/adapters` (Linear, GitHub, git, checks, Claude, Codex, T3, mocks), `src/planning` (issue analysis, plan, prompts, review contract), `src/cli`.
