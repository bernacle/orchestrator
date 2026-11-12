# orchestrator

A supervised engineering orchestrator. One command takes a Linear issue through planning, an isolated implementation, the repository's own checks, and an independent review by a different agent, ending in a draft pull request with the run's state, decisions and evidence recorded locally.

**Install once, then use it from any project.** After `orchestrator skill install --all`, a Claude Code or Codex session in any repository (in T3 or not) understands requests like *"Use Orchestrator to implement BRU-488"*, *"Quero implementar a BRU-488 usando o Orchestrator"* or *"What's the status of the Orchestrator run for BRU-488?"*. The engine identifies the repository from the session's directory, checks that it is authorized and that the issue belongs to it, and prepares a dry run. A live run starts only after you ask for it and confirm a Touch ID / password prompt on your Mac, unless you opted that one repository into [trusted mode](docs/skills.md#trusted-repositories-opt-in). `/orchestrate BRU-488` (Claude Code) and `$orchestrate BRU-488` (Codex) always work too. See [docs/skills.md](docs/skills.md).

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
orchestrator repo trust --repo bernacle/analyticool                # opt-in trusted mode: one Touch ID prompt, then no per-run prompts for this repo
orchestrator repo untrust --repo bernacle/analyticool              # back to supervised (no prompt)
orchestrator repo trusted                                         # which repositories are trusted or supervised
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
- **A person approves every live run** by default. `--execute` (and every resume of a live run) stops for a macOS system prompt (Touch ID, Apple Watch or your login password) naming the issue, repository, permissions and budget. An agent can't answer it, and there is no flag or file that skips it. See [docs/skills.md](docs/skills.md#live-run-authorization-what-is-enforced-and-what-is-only-instructed) for exactly what this does and doesn't stop.
- **Trusted mode is opt-in, per repository.** `orchestrator repo trust --repo owner/name` asks you once, in the same system prompt, to delegate that repository's exact scope. Live runs and resumes of it then start without a per-run prompt. Permissions, budgets, sandbox, tripwires, independent review and manual merging are unchanged. Any change to the config's scope makes runs ask again until you renew. A config that grants merging can't be trusted. The trade-off is in [docs/skills.md](docs/skills.md#trusted-repositories-opt-in).
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
review:
  blocking_severities: [blocker, major]
  minor_fix_rounds: 1                 # one bounded round for actionable minor findings after an approval (0: off)
pull_request:
  draft: true
  mark_ready_when_delivered: false    # opt in: mark the draft ready once CI, checks and the review pass (never merges)
push:                                 # optional: the identity the orchestrator's own git push uses
  url: git@github-personal:bernacle/analyticool.git   # e.g. an SSH host alias whose key can push (must name this repo)
  # ssh_identity_file: ~/.ssh/id_personal             # or a specific key inside ~/.ssh (IdentitiesOnly)
merge:
  mode: manual
  require_ci: true
  require_independent_review: true
  max_fix_attempts: 3
```

Swap roles per repository (Codex implements and Claude reviews, for example) by changing `agents`. `isolation`, `limits` and `baseline_checks` are covered in [docs/isolation.md](docs/isolation.md).

### Screenshots of UI changes

For UI work, the orchestrator itself generates the screenshots from the implementation, using a command the repository already has:

```yaml
screenshots:
  run: pnpm build && pnpm test:smoke        # e.g. Playwright smoke tests that call page.screenshot
  outputs: ["docs/design/**/screenshots/*.png"]
  when_changed: ["apps/**", "packages/react/**"]   # required only for changes touching these (empty: always)
```

- **When it runs:** after the checks pass, in the check sandbox (scrubbed env, credentials unreadable, no network except localhost). Like every repository command, it can't read your home directory beyond the worktree, the pinned Node and specific caches.
- **What is kept:** only plain PNG files this run of the command wrote (new or rewritten, by inode/mtime/size) that match `outputs`, within `max_files` and `max_file_mb`. "Plain" means image chunks only, valid checksums, nothing after the end, and safe file names. Their bytes are scanned for secrets, because the pre-push diff scan can't see inside binaries. They're committed to the branch in a commit of their own.
- **Who sees them:** they're attached to the reviewer's prompt (`codex exec --image`) and embedded in the PR body, pinned to the reviewed commit.
- **When it fails:** a failing command, no images, an unusable file, stray writes, or an image under `outputs` the command didn't produce (hand-made or stale) goes back to the implementer like a failing check, and the step's leftovers are discarded. The implementer can't run the command and must never make images by hand.
- **Environment check:** the baseline and `orchestrator preflight` also run the command on the untouched base. A machine that can't take screenshots (no browser, server won't start) blocks before any agent works.

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
   - extract acceptance criteria (the issue's own list, plus verifiable requirements the read-only planner reads in its scope, numbered AC1…)
   - inspect the repository at `origin/<base>` (scripts, CI workflow, guidance files, branch protection)
   - resolve the toolchain
   - check agent invariants, and verify isolation (it fails closed)
   - choose the branch: the template's name, or a run-scoped one (`…-<run suffix>`) when that branch already exists locally, on origin, as a PR, or for another run. Existing branches, worktrees and PRs are never touched
   - verify publishing before any agent works: `git push --dry-run` with the configured push identity (nothing is written) and the GitHub account's write access. If either fails, the run stops here with the fix
   - optionally run the read-only planner
2. **IMPLEMENTING** creates a worktree on `orch/<key>-<slug>`, runs setup (sandboxed), and runs the **baseline** checks on the untouched base: a red base blocks the run. The implementer then works in its sandbox. Afterwards the orchestrator checks the tripwires, computes the diff itself, commits it with hooks disabled, and scans the diff for secrets.
3. **TESTING** runs every configured check, recording exit codes and logs. When they pass and `screenshots` applies, it generates, validates and commits the screenshots.
4. **REVIEWING** runs the reviewer on `git diff base...HEAD`, with the issue, the numbered acceptance criteria, the verified check results and any orchestrator-generated screenshots. The reviewer returns findings and **one verdict per criterion** (`met`, `not_met`, `needs_human`). A criterion that is `not_met` blocks approval like a major finding; one with no verdict counts as `needs_human`, never as met.
5. **FIXING** sends failing checks, blocking findings, unmet criteria or CI failures back to the *same* implementer session (Claude `--resume`). In review rounds the implementer answers each finding (`fixed` or `declined`, with a reason), and the reviewer verifies those answers. A round that declines everything with reasons is re-reviewed rather than blocked. Every fix is re-tested and re-reviewed. The budget is `max_fix_attempts`.
   - **Minor findings.** After an approval, the reviewer's actionable `minor` findings (never nits) get **one** extra round (`review.minor_fix_rounds`). Its result is re-checked and re-reviewed. If it isn't approved, or breaks a check, the engine restores the approved commit, re-runs the checks on it, and delivers it with its approval; the PR lists what stayed open. This round never uses up `max_fix_attempts`.
6. **PR_OPEN** pushes (never force-pushes) and opens or reuses a **draft** PR. Its description lists the criteria (ticked only when the reviewer found them met, with criteria that need your judgement flagged at the top), the changes, the orchestrator-run checks, CI, screenshots, the review and its history. The orchestrator keeps the description of its own PR in step after every push and CI result. It never edits a PR it didn't write.
7. **WAITING_FOR_CI** polls GitHub checks (`--ci-wait`, 30 min by default), then hands back. `resume` checks again.
8. **READY_TO_MERGE** reports merge eligibility. With `pull_request.mark_ready_when_delivered`, the draft is marked ready for review once every gate passes on the reviewed commit. In `manual` mode the run parks here and a human merges.
9. **Completion.** A read-only reconciliation records what a person did to the PR:
   - merged → MERGED → COMPLETED, with who merged and whether the merged head was the reviewed commit (commits added outside Orchestrator are listed);
   - closed without merging → CANCELLED.

   It never pushes, merges or runs a step, so it needs no resume and no approval. `status`, `context`, `report` and `orchestrator watch <run>` (a bounded foreground loop, no daemon) all run it.

**Bounded recovery.** The engine handles the interruptions BRU-485 needed a person for. Each recovery is recorded in the timeline and the delivery report, and stays within the run's cost and time limits.
- **Agent failures:** a crashed or hung implementer round is retried once, in the same session. A reviewer that crashed, or whose output didn't match the schema, is retried once, and told what was wrong. A spent budget is never retried, and neither is a safety stop: tripwires, secret-scan hits, forbidden paths, or a reviewer that changed code.
- **CI failures:** the implementer gets the end of the failed GitHub Actions steps' logs, redacted, labelled untrusted and capped at 12k characters, within the usual correction budget. Required checks are never skipped or weakened.
- **Branch collisions** and **push identity** are handled in planning, as described above.

**Delivery report and notifications.**
- Whenever a run settles (delivered, blocked, failed, completed), `runs/<id>/delivery.md` and `delivery.json` are rewritten from durable state. They cover:
  - the outcome and what is left for you;
  - the PR and reviewed commit;
  - checks and CI;
  - every acceptance criterion with evidence;
  - open findings;
  - review history;
  - screenshots;
  - recovery attempts;
  - **API-equivalent usage** (Claude Code's estimate; not a charge on a subscription).

  `orchestrator report <run>` prints the report.
- On macOS, a notification tells you when a run is blocked or failed, when its PR is ready for your review, and when it completed after your merge. Each fires once; `ORCHESTRATOR_NOTIFY=0` turns them off.

All artifacts live in `~/.orchestrator/runs/<run-id>/`: prompts, agent transcripts, check logs, review JSON, plan, merge report. `orchestrator status <run-id>` lists them along with every external action the run took.

## Supported today vs planned

Run `orchestrator capabilities` for the live list.

| | Supported | Planned |
|---|---|---|
| Runs | durable state, dry run (also replayable from a Linear snapshot), supervised run, resume/cancel, single-driver lease, preflight, baseline checks, cost/time limits | plan-approval gate, queue/scheduler (disabled until a VM boundary exists) |
| Isolation | scrubbed env, Seatbelt for setup/checks, Claude Code sandbox for the implementer, tripwires, secret scan, fail-closed | Linux (bubblewrap), VM/container boundary |
| Linear | issue, relations, comments; evidence-based dependency classification; operator briefs; milestone comments (workspace-verified) | label-driven intake |
| GitHub | protection/ruleset inspection, push, draft PR (description kept in sync, opt-in mark ready), CI polling, merge eligibility, merge/close reconciliation, `watch` | CI log excerpts to the implementer, human review comments as findings |
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
4. It starts a live run only when you explicitly ask for one, and the CLI then asks you to confirm with Touch ID or your password. The agent can't answer that prompt. In a repository you trusted (`orchestrator repo trust`), "Implement BRU-488 using Orchestrator" goes straight from a clean dry run to the live run and draft PR, with no prompt.

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
