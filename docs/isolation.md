# Agent and repository-code isolation (V1)

This page states what the orchestrator isolates, how each claim was verified, and what is **not** covered. None of it is a VM or container boundary. Unattended execution stays disabled until it is.

## What runs, and as whom

| Process | Code it executes | Runs as | Boundary |
|---|---|---|---|
| Orchestrator (git, gh, Linear API) | its own code only | you | none needed: repository hooks and fsmonitor are disabled for every git call (`-c core.hooksPath=/dev/null -c core.fsmonitor=false`) |
| Setup (`pnpm install`) | package lifecycle scripts | you | **Seatbelt** + scrubbed env, network outbound |
| Checks (lint, tests, build, oracle) | repository code, including the agent's changes | you | **Seatbelt** + scrubbed env, **no network** |
| Implementer (Claude Code) | the model's shell commands, plus tests it runs | you | **Claude Code sandbox** (Seatbelt) for Bash; permission fences for file tools |
| Reviewer (Codex) | read-only shell commands | you | **Codex read-only sandbox** (Seatbelt); output redacted |
| Planner (Claude Code) | none (Read/Grep/Glob only) | you | permission fences; no shell |

The main V1 hole was the checks. They execute code the agent just wrote (a test file is code), and they used to run with your full environment, including `GH_TOKEN`, the SSH agent and keychain-backed git credentials.

## Layers

**1. Environment allow-list** (`src/core/isolation.ts: childEnv`). Every child gets PATH, HOME, locale, toolchain variables, and only its *own* agent's auth variables. Always removed: `GH_TOKEN`, `GITHUB_TOKEN`, `LINEAR_API_KEY(_FILE)`, `SSH_AUTH_SOCK`, `GIT_ASKPASS`, `NPM_TOKEN`, AWS keys and `T3CODE_CLI_PATH`. `GH_CONFIG_DIR` points to an empty dir, so `gh` finds no host or token. `GIT_CONFIG_NOSYSTEM=1` and an empty `GIT_CONFIG_GLOBAL` drop system and global credential helpers. Operator `toolchain.env` cannot re-add a denied variable.

**2. Seatbelt for setup and checks** (`seatbeltProfile`, run through `/usr/bin/sandbox-exec`):
- writes denied everywhere except the worktree, temp dirs and package caches (pnpm store, `~/Library/Caches`, `~/.cache`)
- reads denied for `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.t3/userdata`, `~/.codex`, Claude config dirs, `~/Library/Keychains`, and the orchestrator's DB, runs and repo configs
- mach-lookup to the keychain services denied
- network: none for checks (loopback allowed), outbound for setup

**3. Claude Code's own sandbox for the implementer.** It's configured with `--settings`, and `--setting-sources ""` so neither the repository's `.claude/settings*.json` nor your user settings apply:

```json
{ "disableAllHooks": true, "disableClaudeAiConnectors": true, "enableAllProjectMcpServers": false,
  "permissions": { "blockReadsOutsideWorkingDirectories": true, "blockWritesOutsideWorkingDirectories": true, "deny": ["Bash(git push:*)", "Bash(gh:*)", "Bash(curl:*)", "…", "WebFetch", "WebSearch"] },
  "sandbox": { "enabled": true, "failIfUnavailable": true, "allowUnsandboxedCommands": false, "autoAllowBashIfSandboxed": false,
               "filesystem": { "denyRead": ["~/.ssh", "…credential paths…"] }, "network": { "allowedDomains": [] },
               "credentials": { "envVars": [{ "name": "GH_TOKEN", "mode": "deny" }, "…"] } } }
```

More constraints on the implementer:
- Built-in tools are limited to `Bash, Read, Edit, Write, Glob, Grep`: no WebFetch, no WebSearch, no sub-agents.
- `--strict-mcp-config` loads no MCP servers.
- Shell commands must also match the repository's allow-list. Anything else is denied (`--permission-prompts none`).
- `disableClaudeAiConnectors` matters: without it, the implementer could reach your Linear workspace through a claude.ai connector, even with no API key in its environment.

**4. Tripwires.** Around every agent step and every setup/check command, the orchestrator fingerprints:
- shell startup files, `~/.gitconfig`, `~/.npmrc` and `~/.ssh/authorized_keys`/`config`
- Claude/Codex settings
- the clone's `.git/config`, `hooks/`, `info/attributes`, `HEAD`, `packed-refs` and `refs/`

Any change **fails** the run (it never auto-resumes), with the changed paths listed.

**5. Secret scan before publishing.** After every commit, and again before push, the full diff and the PR body are scanned. The scan looks for token shapes (GitHub, Linear, Anthropic/OpenAI, Slack, AWS, private keys) and for the exact values of secrets in your environment, including the `gh` keyring token. A hit fails the run before anything is pushed.

**6. Limits.**
- Per call: Claude `--max-budget-usd`, capped at what is left of the run budget, plus per-agent timeouts.
- Per run: `limits.max_run_cost_usd` and `limits.max_run_minutes` (an operator resume grants a new time window, never more money), and `merge.max_fix_attempts`.

**7. Fail closed.** With `isolation.require: true` (the default), PLANNING blocks a live run in any of these cases:
- the check sandbox is unavailable (anything other than macOS today)
- Claude Code is older than 2.1.314
- an agent cannot confirm its isolation

Claude Code itself refuses to start if its sandbox can't initialise (`failIfUnavailable`).

## How this was verified

The results below come from probes on this machine (macOS, Claude Code 2.1.318). In each case the ground truth was checked from *outside* the sandbox, not taken from the agent's own report.

| Probe | Checks sandbox | Implementer (Claude) Bash |
|---|---|---|
| write `$HOME/…` | blocked (EPERM; file absent afterwards) | blocked (EPERM; file absent) |
| read `~/.ssh` | blocked | blocked |
| read `~/.config/gh/hosts.yml`, `~/.t3/userdata` | blocked | n/a |
| `$GH_TOKEN` / denied env var | empty | empty |
| `gh auth token` | no token | denied by rule |
| keychain lookup (`security find-internet-password`) | denied | denied by rule |
| outbound HTTPS | blocked (checks) | blocked by the proxy (`403 user denied`) |
| Read tool on `~/.gitconfig` | n/a | refused (`blockReadsOutsideWorkingDirectories`) |
| Write tool to `/tmp/…` | n/a | refused (`blockWritesOutsideWorkingDirectories`) |
| write inside the worktree | allowed | allowed |

These are re-checked on every `pnpm test` run on macOS (`test/unit/isolation.test.ts`, "Seatbelt sandbox, for real"). `orchestrator preflight --repo <r> --agent-probe` repeats them in a real worktree of the target repository, together with its setup and checks.

## What is not covered

- **Not a VM.** Seatbelt confines file writes, credential reads and network for shell commands. The agent processes (Claude Code, Codex) still run as you. A bug in Claude Code, Codex or Seatbelt itself is outside this boundary. `sandbox-exec` is deprecated by Apple, although Claude Code and Codex both rely on it.
- **File tools use permission rules, not the OS.** Claude's Read/Edit/Write are fenced by `blockReads/WritesOutsideWorkingDirectories`. That's a permission check inside Claude Code, not a kernel boundary.
- **The reviewer can read.** Codex's read-only sandbox blocks writes and network, not reads. Its output reaches a public PR only after redaction and the secret scan.
- **Setup has network.** Install scripts can reach the internet, but they cannot read credentials or write outside the worktree and caches.
- **Caches are shared.** A sandboxed command can write to the pnpm store and `~/Library/Caches`, so cache poisoning across repositories is possible.
- **Linux and Windows.** There's no check sandbox there yet, so live runs are blocked (fail closed). Bubblewrap support is on the roadmap.
- **Tripwires detect a fixed set of paths** outside the worktree. They're not a complete filesystem audit.

## Unattended execution: disabled

There is no scheduler, queue or daemon. Every live run starts with an explicit `orchestrator run <ISSUE> --execute` from the operator, and it stops at `READY_TO_MERGE` for a human. Before unattended runs are reasonable, the orchestrator would need:
- a VM or container boundary around the whole agent process
- a dedicated low-privilege GitHub identity
- network egress policy for setup

See [roadmap](roadmap.md).
