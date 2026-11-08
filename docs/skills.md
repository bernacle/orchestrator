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

| Stage | Who | What happens | Needs your approval? |
|---|---|---|---|
| 1. Discovery | the model | recognizes an Orchestrator request and loads the skill | no |
| 2. Preparation | `orchestrator context <issue> --json` | read-only: issue reference, repository, configuration, Linear credentials, issue ↔ repository evidence, existing runs, available modes | no |
| 3. Repository authorization | `orchestrator repo init` → `orchestrator repo authorize` | first use only: a proposal you review, then explicit authorization | **yes** |
| 4. Run authorization | `orchestrator run <issue> --execute` | a live run for this issue | **yes** ("start it", "execute"; "implement X with Orchestrator" means prepare) |
| 5. Execution | the engine | in its own clone and worktree, sandboxed (see [isolation.md](isolation.md)) | — |
| 6. Review | the engine | independent reviewer from a different provider | — |
| 7. Merge | you | `merge.mode: manual` by default; the engine never merges in manual mode | yours to do |

Loading the skill is not authorization. Without your explicit go-ahead in the conversation, the skill must not:

- run `--execute`, or resume a live run;
- authorize a repository, or confirm an issue ↔ repository association;
- change orchestrator config or permissions.

The engine enforces the rest regardless of what an agent does: permissions come only from operator-owned config, there are no bypass modes, and every guarantee in the README still applies.

A new natural-language request becomes a **dry run** unless you asked for a live run. For "start the Orchestrator implementation of BRU-488", the skill doesn't ask a second time. It checks that `context` reports no problems, that the `supervised` mode is available, and that a dry run in the conversation has no blockers. Then it starts the live run in the background and reports the run id.

> **The CLI can't tell you from an agent acting for you.** The run-authorization rule lives in the skill, and in the host's permission prompts when the session has them (T3 sessions often run in full-access mode, so then they don't). Two hard stops are available whatever the agent decides:
> - `ORCHESTRATOR_NO_EXECUTE=1` in an environment makes the engine refuse `--execute` and resuming live runs.
> - `permissions.*: false` in a repository's config denies that capability to every caller.

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

- **Claude Code:** `$CLAUDE_CONFIG_DIR/skills` (or `~/.claude/skills`), plus every Claude config dir that T3 provider instances are configured with. T3 can run Claude Code with its own home path per instance. The installer reads `~/.t3/userdata/settings.json` for those paths and never writes it. Override the detection with `--claude-home <dir>` (repeatable).
- **Codex:** `~/.agents/skills` (override with `--codex-skills-dir`). If an Orchestrator-owned copy also exists in `$CODEX_HOME/skills`, the installer removes it, because Codex would list both. A copy it doesn't own is only reported.

The installed skill calls the CLI by its absolute path, so it works without `orchestrator` on `PATH`. If you move the checkout, run `orchestrator skill install --all` again; `skill status` flags a dead path.

Ownership and upgrades:

- Each installed directory has a `.orchestrator-skill.json` marker: owner, version, CLI path, and the sha256 of every file written. Without a marker, a directory is somebody else's skill: install and uninstall leave it alone.
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
2. a confirmation you gave before (`orchestrator associate BRU-488 --repo owner/name --yes`, stored in `~/.orchestrator/associations.json`);
3. the issue's Linear project mapped in the repository config (`linear.projects`);
4. the issue linking to `github.com/<owner>/<repo>` (attachment or description). This is untrusted text, so it can only confirm a repository you already configured and selected.

Without evidence, the request stops with `association_unverified`. The skill shows you both identities and asks. Passing `--repo` explicitly is itself the selection, so no further evidence is needed.

## First use of a repository

Discovery is not authorization. For a repository with no operator config:

1. `orchestrator repo init --json` inspects the repository read-only (`git show`; nothing in the working tree is executed). It reads the remote default branch as last fetched, or HEAD. From there it takes the scripts, the lockfile and package manager, the Node engine and the CI workflow steps. Checks mirror the CI workflow's single-line run steps (installs excluded); without CI, they come from conventional script names. Then it writes a **pending** proposal to `~/.orchestrator/proposals/<owner>/<name>.yaml`. The proposal grants nothing. Any orchestrator-looking config inside the repository is reported and ignored.
2. The skill shows you the proposal summary: tracker, agents, setup and checks, CI steps, execution policy, GitHub and Linear permissions, budget and merge policy.
3. Only after your approval, `orchestrator repo authorize <owner/name> --yes` writes `~/.orchestrator/repos/<owner>/<name>.yaml`. That file has an `authorization` block recording who approved it, when, the scope, and the sha256 of the proposal you reviewed. Add `--read-only` to allow dry runs only.

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
| `needs_configuration` | First use: `orchestrator repo init`, review it, then `orchestrator repo authorize owner/name --yes`. |
| `association_unverified` | Confirm once with `orchestrator associate KEY --repo owner/name --yes`, add a brief, or map the Linear project. |
| `linear_auth` | `orchestrator auth linear login` in a terminal. |
| `workspace_mismatch` | The URL's workspace isn't where the issue lives, or isn't the repository's `linear.workspace`. Use the issue's real URL or the key. |
| `command not found` from the skill | The checkout moved: `orchestrator skill install --all` from the new location. |
