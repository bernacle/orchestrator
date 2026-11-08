import { existsSync, readFileSync } from "node:fs";
import type { Redactor } from "../core/redact.js";
import { ShellCheckRunner } from "./checks.js";
import { ClaudeCodeAgent, type AgentIsolation } from "./claude.js";
import { CodexAgent } from "./codex.js";
import { GitWorkspace } from "./git.js";
import { GitHubHost } from "./github.js";
import { LinearTracker } from "./linear.js";
import type { Adapters } from "./types.js";

/**
 * Linear key from LINEAR_API_KEY, or from the file named by
 * LINEAR_API_KEY_FILE (works with secret managers that hand out files).
 */
export function linearApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.LINEAR_API_KEY) return env.LINEAR_API_KEY.trim();
  if (env.LINEAR_API_KEY_FILE && existsSync(env.LINEAR_API_KEY_FILE)) return readFileSync(env.LINEAR_API_KEY_FILE, "utf8").trim();
  return undefined;
}

export function createRealAdapters(redactor: Redactor, env: NodeJS.ProcessEnv = process.env, isolation: AgentIsolation = { denyRead: [], deniedEnv: [] }): Adapters {
  const key = linearApiKey(env);
  redactor.add(key);
  return {
    tracker: new LinearTracker(key),
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
