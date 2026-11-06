import { z } from "zod";

/**
 * Per-repository configuration. Lives in operator-controlled locations only
 * (never inside the target repository) so a repository cannot grant itself
 * permissions or enable automatic merging.
 */

const duration = z.number().int().positive();

export const CheckSchema = z.object({
  name: z.string().min(1),
  run: z.string().min(1),
  timeout_minutes: duration.default(15),
  /** A failing optional check is reported but does not block review. */
  optional: z.boolean().default(false),
});
export type CheckConfig = z.infer<typeof CheckSchema>;

const ClaudeCodeAgentSchema = z.object({
  adapter: z.literal("claude-code"),
  model: z.string().optional(),
  /** Never `bypassPermissions`: the schema rejects it. */
  permission_mode: z.enum(["acceptEdits", "default", "plan", "dontAsk"]).default("acceptEdits"),
  allowed_tools: z.array(z.string()).default([]),
  disallowed_tools: z.array(z.string()).default([]),
  max_budget_usd: z.number().positive().optional(),
  timeout_minutes: duration.default(45),
});

const CodexAgentSchema = z.object({
  adapter: z.literal("codex"),
  model: z.string().optional(),
  /** Never `danger-full-access`: the schema rejects it. */
  sandbox: z.enum(["read-only", "workspace-write"]).default("read-only"),
  timeout_minutes: duration.default(30),
});

const MockAgentSchema = z.object({
  adapter: z.literal("mock"),
  /** Identity used for the "distinct reviewer" invariant in tests. */
  provider: z.string().default("mock"),
  timeout_minutes: duration.default(1),
});

export const AgentSchema = z.discriminatedUnion("adapter", [ClaudeCodeAgentSchema, CodexAgentSchema, MockAgentSchema]);
export type AgentConfig = z.infer<typeof AgentSchema>;

const MergeSchema = z
  .object({
    mode: z.enum(["manual", "auto"]).default("manual"),
    require_ci: z.boolean().default(true),
    require_independent_review: z.boolean().default(true),
    max_fix_attempts: z.number().int().min(0).max(10).default(3),
    method: z.enum(["squash", "merge", "rebase"]).default("squash"),
    /**
     * Required for `mode: auto`. Records who authorized unattended merging,
     * for which repository and GitHub identity. An agent instruction can
     * never substitute for this block.
     */
    auto_authorization: z
      .object({
        repo: z.string(),
        authorized_by: z.string().min(1),
        authorized_at: z.string().min(1),
        /** GitHub login allowed to perform the merge. */
        actor: z.string().min(1),
      })
      .optional(),
  })
  .superRefine((m, ctx) => {
    if (m.mode === "auto" && !m.auto_authorization) {
      ctx.addIssue({ code: "custom", message: "merge.mode=auto requires merge.auto_authorization", path: ["auto_authorization"] });
    }
    if (m.mode === "auto" && !m.require_ci) {
      ctx.addIssue({ code: "custom", message: "merge.mode=auto cannot disable require_ci", path: ["require_ci"] });
    }
    if (m.mode === "auto" && !m.require_independent_review) {
      ctx.addIssue({ code: "custom", message: "merge.mode=auto cannot disable require_independent_review", path: ["require_independent_review"] });
    }
  });
export type MergePolicy = z.infer<typeof MergeSchema>;

/** Explicit grants for every externally visible action. Default: none. */
const PermissionsSchema = z
  .object({
    linear: z.object({ comment: z.boolean().default(false), update_state: z.boolean().default(false) }).prefault({}),
    github: z.object({ push: z.boolean().default(false), create_pr: z.boolean().default(false), merge: z.boolean().default(false) }).prefault({}),
    agents: z.object({ run: z.boolean().default(false) }).prefault({}),
  })
  .prefault({});
export type Permissions = z.infer<typeof PermissionsSchema>;

export const RepoConfigSchema = z
  .object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/name"),
    base_branch: z.string().optional(),
    /**
     * Existing local clone to create worktrees from. When omitted the
     * orchestrator keeps its own clone under ORCHESTRATOR_HOME/clones, so the
     * operator's checkout is never touched.
     */
    local_path: z.string().optional(),
    linear: z
      .object({
        /** Issue key prefixes that belong to this repository, e.g. ["BRU"]. */
        teams: z.array(z.string()).min(1),
        /** Optional Linear project names that further scope matching. */
        projects: z.array(z.string()).default([]),
        /** Workflow state names to move issues to (requires permissions.linear.update_state). */
        states: z.object({ in_progress: z.string().optional(), in_review: z.string().optional() }).prefault({}),
      })
      .prefault({ teams: [] }),
    branch: z.object({ template: z.string().default("orch/{key}-{slug}") }).prefault({}),
    toolchain: z
      .object({
        /** Major Node version the repository needs, e.g. "24". Resolved from nvm if PATH has a different one. */
        node: z.string().optional(),
        env: z.record(z.string(), z.string()).default({}),
      })
      .prefault({}),
    setup: z.array(CheckSchema).default([]),
    checks: z.array(CheckSchema).default([]),
    agents: z.object({
      planner: AgentSchema.optional(),
      implementer: AgentSchema,
      reviewer: AgentSchema,
    }),
    review: z
      .object({
        /** Findings at these severities must be resolved before a PR is opened. */
        blocking_severities: z.array(z.enum(["blocker", "major", "minor", "nit"])).default(["blocker", "major"]),
        /** Reviewer must come from a different provider than the implementer. */
        require_distinct_provider: z.boolean().default(true),
      })
      .prefault({}),
    pull_request: z.object({ draft: z.boolean().default(true), labels: z.array(z.string()).default([]) }).prefault({}),
    /** Files the orchestrator refuses to commit, whatever the agent wrote. */
    forbidden_paths: z.array(z.string()).default([".env", ".env.*", "*.pem", "*.key", "id_rsa*", ".github/workflows/**"]),
    permissions: PermissionsSchema,
    merge: MergeSchema.prefault({}),
  })
  .superRefine((c, ctx) => {
    if (c.merge.auto_authorization && c.merge.auto_authorization.repo !== c.repo) {
      ctx.addIssue({ code: "custom", message: `merge.auto_authorization.repo (${c.merge.auto_authorization.repo}) must equal repo (${c.repo})`, path: ["merge"] });
    }
    if (c.merge.mode === "auto" && !c.permissions.github.merge) {
      ctx.addIssue({ code: "custom", message: "merge.mode=auto requires permissions.github.merge=true", path: ["permissions"] });
    }
  });

export type RepoConfig = z.infer<typeof RepoConfigSchema>;
