import type { Redactor } from "../core/redact.js";
import { ShellCheckRunner } from "./checks.js";
import { ClaudeCodeAgent, type AgentIsolation } from "./claude.js";
import { CodexAgent } from "./codex.js";
import { GitWorkspace } from "./git.js";
import { GitHubHost } from "./github.js";
import { LinearTracker } from "./linear.js";
import type { Adapters } from "./types.js";

/**
 * `linear` is the key chosen by credentials/linear.ts (env, key file, or the stored account for the
 * request's workspace), plus the explanation to show when there is none.
 */
export function createRealAdapters(
  redactor: Redactor,
  env: NodeJS.ProcessEnv = process.env,
  isolation: AgentIsolation = { denyRead: [], deniedEnv: [] },
  linear: { key: string | undefined; problem?: string | null } = { key: undefined },
): Adapters {
  redactor.add(linear.key);
  return {
    tracker: new LinearTracker(linear.key, undefined, linear.problem ?? undefined),
    codeHost: new GitHubHost(undefined, env),
    workspace: new GitWorkspace(env),
    checks: new ShellCheckRunner(redactor),
    agent(config) {
      switch (config.adapter) {
        case "claude-code":
          return new ClaudeCodeAgent(config, isolation);
        case "codex":
          return new CodexAgent(config);
        case "mock":
          throw new Error('agent adapter "mock" is only available in tests');
      }
    },
  };
}
