# Orchestrator as an installed capability (Claude Code and Codex skills)

Install once. Open any project in T3, Claude Code or Codex. Describe the task. You don't need to open this repository, register projects one by one, or remember a command.

```bash
orchestrator skill install --all      # once per machine
```

Then, in a Claude Code or Codex session in any project:

> Use Orchestrator to implement BRU-488.

> Implement this Linear issue using Orchestrator: https://linear.app/brunosimplicio/issue/BRU-488

> Quero implementar a task BRU-488 do Linear usando o Orchestrator.

> What's the status of the Orchestrator run for BRU-488? · Resume it. · Show me the review findings.

Explicit invocation also works, and is the fallback when the model doesn't pick the skill on its own:

| Surface | Command |
|---|---|
| Claude Code | `/orchestrate BRU-488` |
| Codex | `$orchestrate BRU-488` |
| CLI | `orchestrator run BRU-488` (a dry run; add `--execute` for a live run) |

All three reach the same CLI, engine, durable run store and policies. The skill is a thin front-end: it chooses a command, runs it and reports the result. It never implements, pushes or merges anything itself.

## How a request flows

| Stage | Who | What happens | Who has to say yes, and how it's checked |
|---|---|---|---|
| 1. Discovery | the model | recognizes an Orchestrator request and loads the skill | nobody (loading a skill grants nothing) |
| 2. Preparation | `orchestrator context <issue> --json` | read-only: issue reference, repository, configuration, Linear credentials, issue ↔ repository evidence, existing runs, available modes | nobody |
| 3. Dry run | `orchestrator run <issue>` | plan + simulated timeline; reads Linear and GitHub, fetches into the orchestrator's own clone, changes nothing | nobody |
| 4. Repository authorization | `orchestrator repo init` → `orchestrator repo authorize` | first use only: a proposal you review, then an operator-owned config | **you, in a system prompt** (engine-enforced) |
| 5. Run authorization | `orchestrator run <issue> --execute` | a live run of this issue with this exact scope | **you, in a system prompt** (engine-enforced), every live run and every resume. In a [trusted repository](#trusted-repositories-opt-in): your one-time trust of that repository's exact scope, checked by the engine on every run and resume |
| 6. Execution | the engine | in its own clone and worktree, sandboxed (see [isolation.md](isolation.md)), within the config's `permissions` | — |
| 7. Review | the engine | independent reviewer from a different provider | — |
| 8. Merge | you | `merge.mode: manual` by default; the engine never merges in manual mode | yours to do |

A new natural-language request becomes a **dry run**. "Implement BRU-488 using Orchestrator" means prepare. When you say "start it" or "execute", the skill runs `--execute`, and then **you confirm on your Mac**.

In a trusted repository, "Implement BRU-488 using Orchestrator" is the go-ahead. The skill runs the dry run, and if it is clean, it starts the live run with no prompt. A dry run with blockers still stops there.

## Live-run authorization: what is enforced, and what is only instructed

### Enforced by Orchestrator itself, whatever the agent does

**A person approves every live run, through a channel an agent can't answer.**

- **How it asks.** `orchestrator run … --execute` (and `resume` of a live run, `repo authorize`, `associate`) first checks the request. Then, before anything is created, it asks you to confirm with a **macOS LocalAuthentication prompt**: Touch ID, Apple Watch or your login password.
- **What the prompt names.** The exact scope: issue, repository, agents, the pushes and PRs it may make, the merge mode (automatic merging is spelled out in capitals) and the budget. The same scope is printed to the terminal, so the agent can relay it.
- **Why an agent can't answer it.** The sheet is drawn by the system, which ignores synthetic clicks and keystrokes. It is raised through `/usr/bin/osascript` by absolute path, so a PATH entry can't stand in for it.
- **No stored approval exists to forge.** The answer is used in the process that asked, then discarded. The run records it only as audit (`context.authorization`, a `run.authorized` event, and `~/.orchestrator/audit/approvals.jsonl`). There is no `--yes`, `--approved` or `--confirm` flag, and no environment variable that skips the prompt. Tests inject a stand-in approver in code only.
- **Bound to one scope.** Each approval covers one issue, repository, config file, permission set, agents, limits, merge policy and accepted dependencies. Every new live run asks again.
- **Resume asks again too.** The run store is a file an agent could write, so a stored approval is never accepted as consent on resume.
- **The stored run can't change what a drive does.** Each drive fixes the run's mode, issue and repository when it starts: at the approval for a live run, or when a dry run starts. Effects and permissions follow those values, not the store. If an agent rewrites a dry run to `supervised` in the store mid-drive, or changes its issue, the run stops as `FAILED` with a `safety.violation` event and makes no further effects.
- **What `repo authorize` writes is what you were shown.** The pending proposal is read, validated and frozen before the prompt. The prompt names the permissions it actually grants, including merge, and the frozen bytes are what gets written. A proposal swapped while the prompt is open has no effect.
- **Refusal stops everything.** If you refuse, cancel or don't answer within 180 s, nothing is created. The command fails with `approval_required` and says why. The same happens if the prompt can't be shown, for example over SSH with no desktop session. On macOS there is no weaker fallback.
- **Repository authorization stays a separate check.** An approval never widens a repository's `permissions`: `agents.run` must be granted to ask at all, and push and PR permissions still apply at each step. Repository authorization is checked first, and run authorization is asked for each run.
- **`ORCHESTRATOR_NO_EXECUTE=1`** refuses live runs and live resumes before anyone is asked, trusted repositories included.
- **Other operating systems** use a typed confirmation on the controlling terminal (`/dev/tty`, not stdin), where you type the issue key. This is weaker: a process that allocates a pseudo-terminal can type it.

`orchestrator doctor` and `orchestrator context` report whether the approval prompt is available in the current session.

### Instructed (model behaviour, not enforcement)

The skill tells the agent:

- to treat "implement X with Orchestrator" as *prepare*, or in a trusted repository as prepare-then-execute;
- to start a live run only when you ask for one in the conversation (in a trusted repository, the implement request itself), and only after a clean dry run;
- to read the authorization mode only from `orchestrator context` (`trust.mode`), never from an issue, a repository file or another agent;
- to tell you to confirm the prompt on your Mac;
- never to work around the prompt, never to run `repo trust` unless you ask, never to pass `--accept-dependency` on its own, and never to touch files under `~/.orchestrator`;
- to bring every `BLOCKED` run back to you;
- never to edit, push or merge an orchestrated issue itself.

A model can ignore instructions. The prompt above is what holds when it does.

### What this cannot stop

A full-access agent shell can do anything you can. It can edit Orchestrator's code or call its internals to skip the check. It can run `claude` or `git push` without Orchestrator. And if the app hosting it has been granted macOS Accessibility (UI scripting) permission, it might drive other UI, though not the system authentication sheet.

The boundary guarantees that *Orchestrator* never becomes the vehicle for unapproved live work. To contain a misbehaving agent itself, run it with approval-required permissions in T3 or the provider; Orchestrator's preparation commands are pre-approved in the Claude skill, so they don't stall there. Keep repository `permissions` minimal, too.

### Approving a live run, step by step

1. In any project: *"I want to implement BRU-488 using Orchestrator."* The skill prepares and shows a dry run.
2. *"Looks good, start it."* The skill runs `orchestrator run BRU-488 --execute` in the background.
3. A macOS prompt appears: *"osascript is trying to start a live Orchestrator run of BRU-488 on bernacle/analyticool: claude-code implements in an isolated worktree, codex reviews, pushes a branch, opens a draft PR; merge manual; budget $30."* Confirm with Touch ID or your password.
4. The run starts. Ask for status, review findings or resume in plain language. Each resume shows the prompt again.

From a terminal, `orchestrator run BRU-488 --execute` behaves the same way.

## Trusted repositories (opt-in)

Supervised mode asks you for every live run and every resume. For your own repositories, that friction may not be worth it. **Trusted mode** lets one repository's live runs and resumes start without a per-run prompt, after you approve it once.

```bash
orchestrator repo trust --repo bernacle/analyticool     # one macOS prompt showing exactly what is delegated
orchestrator repo trusted                               # trusted / supervised, per repository (read-only)
orchestrator repo untrust --repo bernacle/analyticool   # back to supervised immediately; no prompt
```

Supervised stays the default. Nothing turns trust on except `repo trust` and your confirmation of its prompt.

### What you approve

`repo trust` resolves the repository's operator-owned config, the same file a run without `--config` uses. It refuses before asking (`not_trustable`) unless the config meets all of these:

- grants live runs;
- does **not** grant merging (`permissions.github.merge: false`, `merge.mode: manual`);
- requires the sandbox (`isolation.require: true`);
- requires a reviewer from a different provider;
- opens draft PRs only.

Then the macOS prompt and the terminal show the **trust scope**:

- the repository, and only that one;
- the config file;
- the agents;
- what is delegated: start and resume live runs with the config's push, draft PR and Linear permissions;
- what is never delegated (see below);
- the per-run budget and time limit, isolation and review settings;
- what ends the trust.

### What the engine enforces

`startRun` and `resumeRun` check trust; the skill only reads the result. On every live run and resume, the engine re-evaluates the trust record against the config that run will actually use. It starts without a prompt only if all of these hold:

- the record verifies: correct seal, this repository, and a key that still exists;
- the config's current trust scope hashes to exactly what you approved;
- the config still meets the conditions above;
- the run has no operator-accepted dependencies, and you didn't pass `--require-approval`.

Otherwise the run asks you in the system prompt, exactly as in supervised mode. The prompt has a `Trust:` line saying why. The trust scope covers:

- the repository and config file path;
- `base_branch`, `local_path` and `linear.workspace`;
- all of `permissions`, `merge`, `agents`, `limits`, `isolation` and `review` (including `review.minor_fix_rounds`);
- `pull_request.draft`, `pull_request.mark_ready_when_delivered`, `forbidden_paths` and `baseline_checks`;
- any per-command `network` overrides.

Changing any of these makes the trust **stale**, even if the change narrows something. So does an Orchestrator update that adds a field to the scope: the 2026-11 review-completion update added `review.minor_fix_rounds` and `pull_request.mark_ready_when_delivered`, so a repository trusted before it asks once more. That includes running from a different `--config`. `context`, `doctor` and `repo trusted` then say what changed, and `orchestrator repo trust` renews it, with a prompt. Check and setup *commands* are not part of the scope: they run in the sandbox either way, just as the per-run approval never covered them.

Every trusted start or resume is audited like an approval:

- `context.authorization` on the run has `basis: "trust"` and the trust id;
- a `run.authorized` event;
- a line in `~/.orchestrator/audit/approvals.jsonl` with channel `trusted-repository`.

Trust and untrust are also logged in `~/.orchestrator/audit/trust.jsonl`.

### Never delegated, in any mode

- **Merging.** A config that grants merge can't be trusted. Merge permission added later makes the trust stale. PRs stay drafts, and you merge them.
- **New permissions.** Trust grants nothing. Every effect still goes through the config's `permissions` and the permission gate, and widening a permission makes the trust stale.
- **Budgets and timeouts.** The cost cap is never reset. A trusted resume keeps the run's original time window, so unattended resumes can't extend a run past `limits.max_run_minutes`. A new window needs `orchestrator resume <run> --require-approval`, which prompts you.
- **Accepted dependencies.** `--accept-dependency` is your judgement that a prerequisite doesn't block. It always prompts.
- **Sandbox, tripwires, secret scan and independent review.** They are unchanged. A tripwire or secret-scan hit ends the run `FAILED`, which no resume can continue. Resuming a `BLOCKED` run re-runs the step that blocked, with every check applied again.
- **Repository authorization, associations, and trust itself.** Each always prompts.
- **`ORCHESTRATOR_NO_EXECUTE=1`.** It refuses live work before trust is even read.

There is no `--yes`, `--force` or similar flag on `repo trust`, `run` or `resume`. Tests check this against the real CLI binary.

### Where trust is stored, and why a file can't grant it

The record lives in `~/.orchestrator/trust/<owner>/<name>.json`, outside the target repository, next to the operator-owned repository configs. A repository file, a Linear issue, or instructions an agent generates can't create it, because a record grants nothing unless its HMAC seal verifies. The seal key is per repository and stored in your login Keychain (a 0600 file under `~/.orchestrator/credentials` elsewhere, unreadable from every sandbox):

- `repo trust` creates a fresh key every time, so an older copy of a record stops verifying;
- `repo untrust` deletes the key, so a restored backup of the record is dead;
- hand-writing a record, or editing an approved one to cover a wider config, fails verification;
- a record copied to another repository fails verification, because trust never transfers;
- the key store can't be switched by an environment variable or by the record itself.

### The trade-off, plainly

**In a trusted repository, Orchestrator no longer verifies that a person approved each run.** Whoever can run `orchestrator run … --execute` in a session, including an AI agent acting on its own judgement, a misread request, or a prompt injection in an issue or repository file, can start a live run. That run can spend up to the per-run budget, push a branch and open a draft PR within the trusted scope, and you won't be asked first. What still holds is everything above: the scope you approved, the permissions, budget and time limits, the sandbox, the independent review, and manual merging. A bad run therefore costs you at most a budget's worth of tokens and a draft PR to close.

Trust is also a weaker lock than the per-run prompt. The prompt can't be answered by any process. A trust record can be forged by a process running as you that *deliberately* reads the repository's seal key from your Keychain and recomputes the seal. That is the same class of attack as editing Orchestrator's own code (see [What this cannot stop](#what-this-cannot-stop)). The seal stops accidental or casual grants: writing a file, copying a record, restoring an old one. It does not stop a determined process running as you.

Use trusted mode for repositories you own, whose config you keep minimal, and whose sessions you accept that risk for. Leave new, shared or sensitive repositories supervised. `orchestrator repo untrust` takes effect immediately.

### Using it from T3

1. Once, in a terminal on your Mac: `orchestrator repo trust --repo bernacle/analyticool`. Read the prompt and confirm it.
2. In Analyticool, in T3: *"Implement BRU-485 using Orchestrator."* The skill runs `context`, which shows `trust.mode: "trusted"`. Then it runs the dry run, and if that is clean, `run --execute` with no prompt. It reports the run, follows CI, and tells you when the draft PR is up.
3. A run that blocks comes back to you. Say *"resume it"* to continue without a prompt, or use `--require-approval` for a new time window.

## Automatic discovery: what is and isn't guaranteed

Both providers show each installed skill's name and description to the model, and the model decides whether a request matches. The skill's description leads with the use case: handing a Linear issue to Orchestrator, and status, resume and review of Orchestrator runs. It accepts keys and linear.app URLs, in any language, and it excludes plain issue discussion. Claude Code also gets the example requests through `when_to_use`. Codex reads only `name` and `description`, so there the examples are folded into the description.

What is verified deterministically (`orchestrator skill verify --all`; unit tests in `test/unit/skills.test.ts`):

- **Codex.** `codex debug prompt-input` renders the exact prompt the model receives, without calling a model. The check passes when the skill appears in its `## Skills` catalog exactly once, from the installed path, with its full description. `agents/openai.yaml` keeps `policy.allow_implicit_invocation: true`.
- **Claude Code.** No offline equivalent exists: `claude plugin validate` accepts broken personal-skill frontmatter. So the check parses the installed `SKILL.md` the way Claude Code does:
  - the frontmatter is on the first line and is valid YAML;
  - `name` matches the directory;
  - `description` + `when_to_use` fit Claude Code's 1,536-character listing cap;
  - model invocation is not disabled.

What is measured, not guaranteed: whether a model picks the skill for a particular sentence. `corepack pnpm eval:skills` makes real Claude Code and Codex calls. They run sandboxed, with only Skill/Read tools for Claude and read-only for Codex, plus `ORCHESTRATOR_NO_EXECUTE=1`. The run covers activation prompts and non-activation prompts (what does BRU-488 mean, summarize its acceptance criteria, list my issues). Results vary across models and runs. The latest results are in the PR description.

`/orchestrate` and `$orchestrate` work whether or not the model would have chosen the skill.

### Provider facts this relies on (verified 2026-11-08)

| | Claude Code 2.1.318 | Codex CLI 0.165.0 |
|---|---|---|
| User-level skill location | `$CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md`, default `~/.claude/skills` ([docs](https://code.claude.com/docs/en/skills)) | `$HOME/.agents/skills/<name>/SKILL.md` ([docs](https://developers.openai.com/codex/skills)). Codex 0.165 also scans `$CODEX_HOME/skills` (seen in `codex debug prompt-input`'s skill roots) |
| Metadata | `name`, `description`, `when_to_use`, `argument-hint`, `metadata`; `disable-model-invocation` must stay unset | `name`, `description` (+ `metadata`); `agents/openai.yaml` for UI text and `policy.allow_implicit_invocation` |
| Automatic selection | from `description` + `when_to_use` | from `description` |
| Explicit | `/orchestrate …` (arguments are appended to the skill as `ARGUMENTS:`) | `$orchestrate …` or `/skills` |
| New/changed skills | picked up live; a skills directory created after the session started needs `/reload-skills` | detected automatically; restart the session if one doesn't appear |
| Known limits | with many skills, descriptions can be dropped from the listing (1% context budget; `/doctor` shows it) | two copies with the same name are both listed; the installer keeps only one |

## Installation details

`orchestrator skill install --all` renders one canonical source into each provider's format. The source is [`integrations/skills/orchestrate/skill.yaml`](../integrations/skills/orchestrate/skill.yaml) (metadata) plus [`SKILL.body.md`](../integrations/skills/orchestrate/SKILL.body.md) (behaviour). Only packaging differs between providers: frontmatter fields, the `/` or `$` sigil, and Codex's `agents/openai.yaml`. Edit the source, never an installed copy.

Targets:

- **Claude Code:** `$CLAUDE_CONFIG_DIR/skills` (or `~/.claude/skills`), plus every Claude config dir that T3 provider instances are configured with, plus `~/.claude` when it exists and `$CLAUDE_CONFIG_DIR` points elsewhere (so install, update and status cover the same homes from a terminal and from a T3 session). T3 can run Claude Code with its own home path per instance; on this machine, T3's "Personal" Claude instance uses `~/.claude-work2`. The installer reads `~/.t3/userdata/settings.json` for those paths and never writes it. Override the detection with `--claude-home <dir>` (repeatable). The Claude package pre-approves (`allowed-tools`) only `context`, `status`, `review`, `run`, `resume`, `repo init` and `repo trusted`. This is safe because the engine gates `run --execute` and `resume` of a live run itself: with its prompt, or with a trust you granted through that prompt. `repo authorize`, `repo trust`, `associate` and `auth` still go through Claude Code's own permission prompt in approval-required sessions.
- **Codex:** `~/.agents/skills` (override with `--codex-skills-dir`). If an Orchestrator-owned copy also exists in `$CODEX_HOME/skills`, the installer removes it, because Codex would list both. A copy it doesn't own is only reported.

### Stable launcher and runtime

Installed skills call one command: **`~/.orchestrator/bin/orchestrator`** (under `$ORCHESTRATOR_HOME`). It is a small shell launcher written by `skill install`. They never call a checkout path or a Node binary directly, which keeps them working when:

- the development worktree is deleted or the checkout moves. Re-running `orchestrator skill install --all` from the new location repoints the launcher, and the skills themselves don't change. If the target is gone, the launcher exits with a message saying exactly that;
- an agent's shell has another Node first on PATH. Codex's login shell resolved `node` to v16. The launcher picks the first Node ≥ 22.5 from: `$ORCHESTRATOR_NODE`, the Node that ran the install, `~/.nvm/versions/node/*`, Homebrew, `/usr/local`, then `PATH`.

Install from a **stable** location: a regular checkout such as `~/Dev/orchestrator`, or a global package install (`corepack pnpm add -g` / `npm install -g` of this package, which ships `bin`, `dist`, `config` and `integrations`). `skill install` **refuses** to point the launcher at a linked git worktree, a temp directory or `~/.t3/worktrees/…`, because those get deleted. `--allow-ephemeral` exists for development only. `skill status` shows the launcher's target and whether it is stable, ephemeral or gone.

Requirements: Node ≥ 22.5 (24 recommended) somewhere the launcher can find, plus `git`, `gh`, `claude` and `codex` on the agent's PATH for live runs.

Ownership and upgrades:

- Each installed directory has a `.orchestrator-skill.json` marker: owner, version, the launcher path, and the sha256 of every file written. Without a marker, a directory is somebody else's skill: install and uninstall leave it alone.
- `install` is idempotent. It also upgrades an outdated, unmodified install.
- `update --all` upgrades existing installs only.
- A file whose hash changed was edited by you. Updates and uninstalls keep it unless you pass `--force`. A forced update first moves your copy to `SKILL.md.orig-<timestamp>`.
- `uninstall` removes only files listed in the marker.
- `skill status` reports each target's state: `current`, `outdated`, `modified`, `not_installed`, `foreign` or `legacy_symlink`. It also shows the installed version, the CLI path, each provider's CLI version, and the known discovery limits.
- The old `orchestrator install-skill` symlink is recognized and replaced. The command remains as a deprecated alias.

## Repository detection

The skill runs the CLI in the session's working directory. The engine identifies the repository from there, read-only. It runs `git rev-parse`, then `git ls-remote --get-url` (which applies `insteadOf` rewrites) for every remote. SSH host aliases such as `git@github-personal:bernacle/analyticool.git` are resolved with `ssh -G`.

- Main checkouts, linked worktrees (T3's `~/.t3/worktrees/...`), and nested directories all resolve the same way.
- Remotes naming the same GitHub repository count once. Remote names and remote order mean nothing: `origin` is not assumed to be the upstream.
- Several GitHub repositories (fork + upstream): if exactly one has operator config, it is chosen, and the reason is shown. Otherwise the request is **ambiguous**: you get the candidates and pick one with `--repo`.
- No GitHub remote: the request stops and says what to do (`--repo owner/name`, or add the remote).
- `--repo owner/name` always wins. It still needs an authorized config and a repository GitHub can read. If the working directory is a different repository, the CLI warns.
- Outside any Git repository, the configured repositories whose `linear.teams` include the issue's team are candidates. The association check below still applies.

The working directory is only used to identify the repository. Runs never execute in it. The engine works in its own clone (`~/.orchestrator/clones`) and its own worktree (`~/.orchestrator/worktrees/<owner>/<repo>/<run-id>`), so the T3 session's worktree, its branch and its uncommitted changes are untouched. `test/integration/intake.test.ts` covers this. Only an operator-set `local_path` makes the engine use an existing clone, and repository discovery never sets it.

## Issue references and association

`BRU-488`, `bru-488`, and `https://linear.app/<workspace>/issue/BRU-488/<slug>` are all accepted. A URL's workspace is used in two ways:

- **Choosing credentials.** The stored key for that workspace is used.
- **Checking the issue.** If the issue resolves somewhere else, the request stops with `workspace_mismatch`. For example: the URL says `bernacle`, but Linear has the issue at `linear.app/brunosimplicio/...`.

The issue's key prefix never decides the repository. BRU-488 being a BRU issue doesn't make it Analyticool work. When the repository was found from the working directory or a team mapping, the engine needs evidence:

1. an operator brief for the issue and repository (`config/briefs/<owner>/<repo>/<KEY>.md`);
2. a confirmation you gave before (`orchestrator associate BRU-488 --repo owner/name`, confirmed in a system prompt, stored in `~/.orchestrator/associations.json`);
3. the issue's Linear project mapped in the repository config (`linear.projects`);
4. the issue linking to `github.com/<owner>/<repo>` (attachment or description). This is untrusted text, so it can only confirm a repository you already configured and selected.

Without evidence, the request stops with `association_unverified`. The skill shows you both identities and asks. Passing `--repo` explicitly is itself the selection, so no further evidence is needed.

## First use of a repository

Discovery is not authorization. For a repository with no operator config:

1. `orchestrator repo init --json` inspects the repository read-only (`git show`; nothing in the working tree is executed). It reads the remote default branch as last fetched, or HEAD. From there it takes the scripts, the lockfile and package manager, the Node engine and the CI workflow steps. Checks mirror the CI workflow's single-line run steps (installs excluded); without CI, they come from conventional script names. Then it writes a **pending** proposal to `~/.orchestrator/proposals/<owner>/<name>.yaml`. The proposal grants nothing. Any orchestrator-looking config inside the repository is reported and ignored.
2. The skill shows you the proposal summary: tracker, agents, setup and checks, CI steps, execution policy, GitHub and Linear permissions, budget and merge policy.
3. `orchestrator repo authorize <owner/name>` asks you to confirm a system prompt, then writes `~/.orchestrator/repos/<owner>/<name>.yaml`. That file has an `authorization` block recording who approved it, when, the scope, and the sha256 of the proposal you reviewed. Add `--read-only` to allow dry runs only.

Proposed defaults:

- Claude Code implements and Codex reviews in a read-only sandbox.
- Isolation is required.
- Limits are $20 and 240 minutes per run.
- Draft PRs only, and merges stay manual.
- Linear writes are off.
- GitHub `push` and `create_pr` are what a supervised run needs: they are granted by authorizing, and only then.

Nothing is ever written into the target repository.

## Linear credentials

Every surface uses the same resolver (`src/credentials/linear.ts`):

1. `LINEAR_API_KEY`, then `LINEAR_API_KEY_FILE`;
2. a key stored with `orchestrator auth linear login`. Run it yourself in a terminal: the key is read from a hidden prompt or stdin, never from arguments or chat. Linear verifies the key, and it is stored under its workspace: in the macOS Keychain, or in a 0600 file in `~/.orchestrator/credentials` on other systems.

Stored keys persist across sessions and are shared by the CLI and both skills; there are no per-provider copies. With several workspaces stored, the workspace comes from the issue URL, the repository's `linear.workspace`, or `--linear-workspace`. Otherwise the request stops instead of picking one. `orchestrator auth status [--verify]` shows which key would be used, never the key itself. Keys are registered with the redactor, kept out of artifacts, and unreadable from the check and agent sandboxes.

## Status, resume, review, budget

- `orchestrator status BRU-488 --json` lists that issue's runs on the working directory's repository. Pass a run id for full detail.
- `orchestrator resume BRU-488` continues the only resumable run, preferring a live run over dry runs. It refuses to guess between several.
- Starting a second live run for an issue with an active one is refused (`active_run_exists`). `context` then offers inspect and resume. A dry run beside an active run is allowed, because it changes nothing.
- `orchestrator review BRU-488 --json` returns the findings the engine recorded, per round, with severity, file, line and the reviewed SHA.
- Every run summary includes the cost so far against `limits.max_run_cost_usd`, plus `max_run_minutes`, check results, the review verdict, the PR URL, merge eligibility and the next step.

JSON output is versioned: `{"schemaVersion": 1, "kind": "...", "data": ...}`. Errors also come back as JSON with a `code` (`needs_configuration`, `association_unverified`, `active_run_exists`, …) when `--json` is given.

## Troubleshooting

| Symptom | Fix |
|---|---|
| The model doesn't use the skill | Use `/orchestrate …` or `$orchestrate …`. Check `orchestrator skill verify --all`. In Claude Code, `/doctor` shows whether the skill listing overflows its budget. |
| `skill status` says `foreign` | Another skill named `orchestrate` exists there. Rename or remove it; the installer never overwrites it. |
| `modified` | You edited the installed copy. Move your change into `integrations/skills/orchestrate/`, or `skill install --force` (your copy is kept as `*.orig-*`). |
| Claude Code in T3 doesn't see it | Check `skill status`: the T3 instance's Claude config dir must be listed. If not, use `--claude-home <that dir>`. If the `skills` directory was just created, run `/reload-skills` or start a new session. |
| Codex lists it twice | Remove the copy that `skill status` reports in `$CODEX_HOME/skills`. |
| `repository_unresolved` | Run from the project checkout, or pass `--repo owner/name`. |
| `needs_configuration` | First use: `orchestrator repo init`, review it, then `orchestrator repo authorize owner/name` and confirm the prompt. |
| `association_unverified` | Confirm once with `orchestrator associate KEY --repo owner/name` (system prompt), add a brief, or map the Linear project. |
| `approval_required` | Nobody confirmed the prompt: refused, cancelled, timed out (180 s), or the prompt couldn't be shown (no desktop session, e.g. SSH). Nothing started. Run it again while you're at the Mac. `orchestrator doctor` shows whether the prompt is available. |
| `approval_required` in a repository you trusted | The trust wasn't used. The prompt's `Trust:` line, `orchestrator context`, and `orchestrator repo trusted` say why: the config's scope changed (stale), the record didn't verify, `--accept-dependency` or `--require-approval` was given, or you ran with another `--config`. Renew with `orchestrator repo trust --repo owner/name`. |
| `not_trustable` | The config grants merging, turns off the sandbox, uses a same-provider reviewer, opens non-draft PRs, or grants no live runs. Trusted mode doesn't cover those configurations. Change the config, or stay supervised. |
| `not_permitted` | The repository's config doesn't grant `permissions.agents.run`: only dry runs. Re-authorize without `--read-only` if you want live runs. |
| `orchestrator: the installation this launcher points at is gone` | The checkout or worktree the launcher pointed at was deleted. Run `orchestrator skill install --all` from a stable checkout or global install. |
| `orchestrator: no Node.js >= 22.5 found` | Install Node 24 (e.g. `nvm install 24`), or set `ORCHESTRATOR_NODE=/path/to/node`. |
| `linear_auth` | `orchestrator auth linear login` in a terminal. |
| `workspace_mismatch` | The URL's workspace isn't where the issue lives, or isn't the repository's `linear.workspace`. Use the issue's real URL or the key. |
| `command not found` from the skill | The launcher isn't installed: `orchestrator skill install --all` from a stable checkout. |
