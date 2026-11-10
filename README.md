# orchestrator

A supervised engineering orchestrator. One command takes a Linear issue through planning, an isolated implementation, the repository's own checks, and an independent review by a different agent, ending in a draft pull request with the run's state, decisions and evidence recorded locally.

**Install once, then use it from any project.** After `orchestrator skill install --all`, a Claude Code or Codex session in any repository (in T3 or not) understands requests like *"Use Orchestrator to implement BRU-488"*, *"Quero implementar a BRU-488 usando o Orchestrator"* or *"What's the status of the Orchestrator run for BRU-488?"*. The engine identifies the repository from the session's directory, checks that it is authorized and that the issue belongs to it, and prepares a dry run. A live run starts only after you ask for it and confirm a Touch ID / password prompt on your Mac. `/orchestrate BRU-488` (Claude Code) and `$orchestrate BRU-488` (Codex) always work too. See [docs/skills.md](docs/skills.md).

```bash
orchestrator skill install --all                                  # once: Claude Code + Codex skills, user level
orchestrator context BRU-488                                      # read-only: repo, config, credentials, association, runs, next steps
orchestrator run BRU-488                                          # from the project's checkout: repository detected, dry run
orchestrator preflight --repo bernacle/analyticool --agent-probe  # setup + checks + sandbox probe in a throwaway worktree
orchestrator run BRU-488 --repo bernacle/analyticool --dry-run    # plan + simulated timeline, no side effects
orchestrator run BRU-488 --repo bernacle/analyticool --execute    # supervised live run → draft PR (you confirm a Touch ID / password prompt)
orchestrator status [<run-id> | BRU-488]
orchestrator review <run-id | BRU-488>                            # the independent reviewer's findings
orchestrator logs <run-id> -f
orchestrator resume <run-id | BRU-488>
orchestrator cancel <run-id>
```

It coordinates tools you already use (Claude Code, Codex, Linear, GitHub, git, and T3 Code through a skill). It is not another coding agent and not another T3. Everything runs locally, with state in one SQLite file.

## What it guarantees

- **Verified, not self-reported.** Changed files come from `git`, check results from running the checks, approval from a schema-validated review. An agent saying "done" counts for nothing.
- **Independent review.** The reviewer is a different adapter, and by default a different provider: Claude Code implements, Codex reviews in a read-only sandbox. A reviewer "approve" that still lists blocker or major findings is not an approval. Malformed review output blocks the run.
- **What was reviewed is what ships.** The reviewed SHA is recorded. A push only happens if HEAD equals it, the PR head must equal it, and merges use `--match-head-commit`.
- **Dependencies are classified with evidence, and never skipped silently.**
  - A Linear `blocked by` relation is a hard blocker.
  - An issue written as a prerequisite ("depends on", "merge … first", a "Prerequisites" heading) blocks unless it's done: completed in Linear, its implementation PR merged with none open, or the files an operator brief names exist at the base commit.
  - References (a mixed "Dependencies & references" list, "Design: …") and `related` relations are informational.
  - Every classification is shown in the plan with its reason and evidence. `--accept-dependency` overrides a prerequisite explicitly, and is recorded in the audit trail.
- **Isolated execution.** Repository code (install scripts, tests, build) runs in a macOS Seatbelt sandbox with a scrubbed environment: writes confined to the worktree, credentials unreadable, no network for checks. The implementer's shell runs in Claude Code's own sandbox, with no repository hooks, MCP servers or connectors. Tripwires and a secret scan fail the run on anything suspicious. Where no sandbox exists, live runs are blocked. See [docs/isolation.md](docs/isolation.md) for what is *not* covered.
- **Bounded.** Per-call timeouts and budgets, a per-run cost cap and time window, and a maximum number of correction rounds.
- **A person approves every live run.** `--execute` (and every resume of a live run) stops for a macOS system prompt (Touch ID, Apple Watch or your login password) naming the issue, repository, permissions and budget. An agent can't answer it, and there is no flag or file that skips it. See [docs/skills.md](docs/skills.md#live-run-authorization-what-is-enforced-and-what-is-only-instructed) for exactly what this does and doesn't stop.
- **Explicit permissions.** Pushing, opening PRs, commenting on or moving Linear issues, and merging each require a grant in operator-owned config. Dry runs do none of them. Agents never run in bypass modes: the schema rejects `bypassPermissions` and `danger-full-access`.
- **No automatic merges** unless the repository config contains an `auto_authorization` block **and** the base branch is protected with required checks. Analyticool is `manual`.
- **Durable and recoverable.** Runs survive restarts. `resume` continues from the last step without redoing completed actions, Ctrl-C pauses, and `cancel` stops the running agent. Worktrees are kept for inspection.
- **Secrets stay out of logs.** Everything written to the timeline and artifacts is redacted.

## Install

Requirements: Node ≥ 22.5 (24 recommended; the launcher enables `node:sqlite` automatically on older 22/23 releases), git, and `gh` (authenticated). Live runs also need `claude` and `codex` (both logged in).

```bash
git clone https://github.com/bernacle/orchestrator && cd orchestrator
corepack pnpm install
corepack pnpm link --global        # optional: puts `orchestrator` on PATH (or use: pnpm orchestrator …)
orchestrator auth linear login     # paste a Linear API key once (macOS Keychain); or set LINEAR_API_KEY / LINEAR_API_KEY_FILE
orchestrator skill install --all   # Claude Code + Codex skills + ~/.orchestrator/bin/orchestrator launcher; detects T3's Claude config dirs
orchestrator doctor
```

Run `skill install` from a stable checkout or a global install, not a temporary worktree (it refuses those): skills call the `~/.orchestrator/bin/orchestrator` launcher, which finds a Node ≥ 22.5 on its own. `orchestrator skill status` shows where the skill is installed, its version, whether it's current, and where the launcher points. `orchestrator skill verify --all` checks discovery without a model call. Stored Linear keys are per workspace, shared by the CLI and both skills; `orchestrator auth status` shows which one a request would use.

`orchestrator doctor` checks:
- Node, the state directory, `gh` auth and identity
- the Linear key and workspace
- Claude Code, Codex login, the T3 CLI and server
- isolation availability (the check sandbox, and a Claude Code version recent enough for the implementer sandbox)
- for each configured repository: access, branch protection, toolchain, agent assignments, and whether Linear writes would reach the configured workspace

`orchestrator preflight --repo owner/name [--agent-probe]` goes further: it runs the repository's setup and every check in a throwaway sandboxed worktree, exactly as a live run would. With `--agent-probe`, it also proves, from inside the implementer's sandbox, that an allowed check works and that escapes are blocked (about $0.01). Nothing is pushed, and the worktree is removed afterwards.

## Configure a repository

The first time you use Orchestrator in a repository, it proposes a configuration instead of guessing one. `orchestrator repo init` (the skill runs it for you) inspects the checkout read-only: scripts, lockfile, Node engine and CI steps. It writes a pending proposal that grants nothing. `orchestrator repo authorize owner/name` asks you to confirm a system prompt (Touch ID or your password), then turns it into an operator-owned config with a record of who approved which proposal. Files inside the repository can never configure or authorize the orchestrator. Details are in [docs/skills.md](docs/skills.md#first-use-of-a-repository).

There's one YAML file per repository, and it lives with the operator, never in the target repository:

1. `~/.orchestrator/repos/<owner>/<name>.yaml` (local override), then
2. `config/repos/<owner>/<name>.yaml` in this repository (shared defaults).

See [`config/repos/bernacle/analyticool.yaml`](config/repos/bernacle/analyticool.yaml) for a complete example. The essentials:

```yaml
repo: bernacle/analyticool
linear: { teams: [BRU] }            # issue keys this repo handles (a key prefix alone never proves an issue belongs here)
toolchain: { node: "24" }           # or exact "24.21.0"; a repo .nvmrc/.node-version refines it. Resolved from PATH or nvm
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

Swap roles per repository (Codex implements and Claude reviews, for example) by changing `agents`. `isolation`, `limits` and `baseline_checks` are covered in [docs/isolation.md](docs/isolation.md).

### Operator briefs

Scope and dependency decisions for one issue live in `config/briefs/<owner>/<repo>/<KEY>.md`, or `~/.orchestrator/briefs/…` to override locally. A brief is YAML front matter plus Markdown. It's authoritative over the issue text, it's given to the planner, implementer and reviewer, and its SHA-256 is recorded in the plan. See [the BRU-488 brief](config/briefs/bernacle/analyticool/BRU-488.md).

```yaml
---
issue: BRU-488
repo: bernacle/analyticool
dependencies:
  BRU-485: { role: reference, reason: "uses the existing result-prop SDK" }
  BRU-463: { reason: "only the merged calculator is needed", satisfied_when_files_exist: [packages/core/src/net-receipts.ts] }
---
In scope: … Out of scope: …
``` `forbidden_paths` (by default `.env*`, keys, `.github/workflows/**`) are never committed, whatever the agent writes. By default the orchestrator keeps its own clone under `~/.orchestrator/clones`, so your checkout is never touched. Set `local_path` to use an existing clone instead.

## How a run works

```
QUEUED → PLANNING → IMPLEMENTING → TESTING → REVIEWING → PR_OPEN → WAITING_FOR_CI → READY_TO_MERGE → MERGED → COMPLETED
                                      ▲  └──── FIXING ◄──┴───────────────────────────────┘
                     BLOCKED (resumable) · FAILED · CANCELLED
```

1. **PLANNING** works through these steps, then writes `plan.md` / `plan.json`:
   - fetch the issue (description, comments, relations, sub-issues)
   - classify dependencies with Linear, GitHub-PR and file evidence, plus the operator brief
   - extract acceptance criteria
   - inspect the repository at `origin/<base>` (scripts, CI workflow, guidance files, branch protection)
   - resolve the toolchain
   - check agent invariants, and verify isolation (it fails closed)
   - optionally run the read-only planner
2. **IMPLEMENTING** creates a worktree on `orch/<key>-<slug>`, runs setup (sandboxed), and runs the **baseline** checks on the untouched base: a red base blocks the run. The implementer then works in its sandbox. Afterwards the orchestrator checks the tripwires, computes the diff itself, commits it with hooks disabled, and scans the diff for secrets.
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
| Runs | durable state, dry run (also replayable from a Linear snapshot), supervised run, resume/cancel, single-driver lease, preflight, baseline checks, cost/time limits | plan-approval gate, queue/scheduler (disabled until a VM boundary exists) |
| Isolation | scrubbed env, Seatbelt for setup/checks, Claude Code sandbox for the implementer, tripwires, secret scan, fail-closed | Linux (bubblewrap), VM/container boundary |
| Linear | issue, relations, comments; evidence-based dependency classification; operator briefs; milestone comments (workspace-verified) | label-driven intake |
| GitHub | protection/ruleset inspection, push, draft PR, CI polling, merge eligibility | CI log excerpts to the implementer, human review comments as findings, watcher |
| Merging | eligibility report; auto-merge implemented behind explicit authorization + protected branch | enabling it per repository |
| Agents | Claude Code (implementer/planner), Codex (reviewer), per-repo roles | security reviewer, test writer, docs |
| T3 | `/orchestrate` skill, T3 origin detection, T3 server check in doctor | implementer inside a T3 thread (needs runtime-mode control in `t3 thread start`) |

## T3 Code, Claude Code and Codex

T3 has no plugin or slash-command API, but the Claude Code and Codex sessions it hosts load user-level skills. Install them once:

```bash
orchestrator skill install --all
```

Then open any project in T3, start a Claude Code or Codex thread, and describe what you want: *"Implement BRU-488 using Orchestrator"*, *"Can you work on https://linear.app/brunosimplicio/issue/BRU-488 using Orchestrator?"*, *"Resume the Orchestrator run for BRU-488"*.

The skill takes it from there:

1. It runs `orchestrator context` in the session's directory. Main checkouts, T3 worktrees and nested directories all work, and SSH aliases are resolved.
2. It walks you through anything missing: first-use authorization, the issue ↔ repository association, Linear login.
3. It prepares a dry run.
4. It starts a live run only when you explicitly ask for one, and the CLI then asks you to confirm with Touch ID or your password. The agent can't answer that prompt.

Runs never execute in the session's worktree. The model chooses the skill from its description, which is likely but not guaranteed for any given sentence. `/orchestrate BRU-488` and `$orchestrate BRU-488` always work. Everything verified, plus the limitations, is in [docs/skills.md](docs/skills.md). Why T3 threads aren't used as the executor yet is explained in [docs/research.md](docs/research.md#t3-code).

## Dry run on Analyticool

```bash
orchestrator run BRU-488 --repo bernacle/analyticool --dry-run
orchestrator run BRU-488 --repo bernacle/analyticool --dry-run --with-agent-plan   # + read-only planner (~$1–2)
```

These read Linear and GitHub, fetch into the orchestrator's own clone, and record what a live run would do, including the exact agent command lines and which permissions each step needs. Nothing is written to Analyticool, GitHub or Linear.

## License

Apache-2.0, see [LICENSE](LICENSE). The runtime dependencies are MIT (commander, zod) and ISC (yaml).

## Development

```bash
corepack pnpm typecheck
corepack pnpm test               # unit + integration (real git, mocked Linear/GitHub/agents)
corepack pnpm smoke:agents       # real claude + codex against a throwaway repo (~$0.50)
```

- [docs/skills.md](docs/skills.md): the install-once skills, natural-language use, repository detection, first-use authorization, credentials, troubleshooting
- [docs/research.md](docs/research.md): what T3, Claude Code, Codex, GitHub and Linear support, as verified
- [docs/architecture.md](docs/architecture.md): state machine, durability, trust boundaries, dependency model, merge policy
- [docs/isolation.md](docs/isolation.md): what is sandboxed, how it was verified, and what is not covered
- [docs/roadmap.md](docs/roadmap.md): PR watching, auto-merge, unattended runs, more roles

Source map: `src/core` (engine, store, states, policy, workflow), `src/adapters` (Linear, GitHub, git, checks, Claude, Codex, T3, mocks), `src/planning` (issue analysis, plan, prompts, review contract), `src/intake` (issue references, repository discovery, association, first-use proposals, request context), `src/credentials`, `src/skills` (canonical skill rendering, install, verify), `src/cli`.

```bash
corepack pnpm eval:skills        # real Claude Code + Codex calls: does the model pick the skill (and leave it alone when it should)?
```
