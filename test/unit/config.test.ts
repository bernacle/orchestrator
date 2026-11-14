import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandEnv, loadRepoConfigFile, PACKAGE_ROOT } from "../../src/config/load.js";
import { RepoConfigSchema } from "../../src/config/schema.js";

const minimal = {
  repo: "o/r",
  linear: { teams: ["O"] },
  agents: { implementer: { adapter: "claude-code" }, reviewer: { adapter: "codex" } },
};

describe("repository config", () => {
  it("defaults to no external permissions and manual merges", () => {
    const c = RepoConfigSchema.parse(minimal);
    expect(c.permissions).toEqual({
      linear: { comment: false, update_state: false },
      github: { push: false, create_pr: false, merge: false },
      agents: { run: false },
    });
    expect(c.merge).toMatchObject({ mode: "manual", require_ci: true, require_independent_review: true, max_fix_attempts: 3 });
    expect(c.forbidden_paths).toContain(".env");
  });

  it("rejects permission-bypass modes", () => {
    expect(RepoConfigSchema.safeParse({ ...minimal, agents: { ...minimal.agents, implementer: { adapter: "claude-code", permission_mode: "bypassPermissions" } } }).success).toBe(false);
    expect(RepoConfigSchema.safeParse({ ...minimal, agents: { ...minimal.agents, reviewer: { adapter: "codex", sandbox: "danger-full-access" } } }).success).toBe(false);
  });

  it("rejects duplicate/no-op check shadowing, screenshot collisions and log path traversal", () => {
    for (const kind of ["setup", "checks"]) {
      const duplicate = RepoConfigSchema.safeParse({ ...minimal, [kind]: [{ name: "test", run: "true" }, { name: "test", run: "pnpm test" }] });
      expect(duplicate.success).toBe(false);
      for (const name of ["../trust", "x/../../credentials", "x\\escape", "x\nheader"]) expect(RepoConfigSchema.safeParse({ ...minimal, [kind]: [{ name, run: "true" }] }).success).toBe(false);
    }
    expect(RepoConfigSchema.safeParse({ ...minimal, checks: [{ name: "screenshots", run: "true" }], screenshots: { run: "real-screenshots", outputs: ["shots/*.png"] } }).success).toBe(false);
  });

  it("requires explicit authorization for auto merge", () => {
    const noAuth = RepoConfigSchema.safeParse({ ...minimal, merge: { mode: "auto" }, permissions: { github: { merge: true } } });
    expect(noAuth.success).toBe(false);
    const wrongRepo = RepoConfigSchema.safeParse({
      ...minimal,
      permissions: { github: { merge: true } },
      merge: { mode: "auto", auto_authorization: { repo: "other/repo", authorized_by: "me", authorized_at: "2026-11-06", actor: "me" } },
    });
    expect(wrongRepo.success).toBe(false);
    const noPermission = RepoConfigSchema.safeParse({
      ...minimal,
      merge: { mode: "auto", auto_authorization: { repo: "o/r", authorized_by: "me", authorized_at: "2026-11-06", actor: "me" } },
    });
    expect(noPermission.success).toBe(false);
    const cannotSkipReview = RepoConfigSchema.safeParse({
      ...minimal,
      permissions: { github: { merge: true } },
      merge: { mode: "auto", require_independent_review: false, auto_authorization: { repo: "o/r", authorized_by: "me", authorized_at: "2026-11-06", actor: "me" } },
    });
    expect(cannotSkipReview.success).toBe(false);
  });

  it("the bundled Analyticool config is valid, manual, and mirrors its CI", () => {
    const { config } = loadRepoConfigFile(join(PACKAGE_ROOT, "config", "repos", "bernacle", "analyticool.yaml"));
    expect(config.repo).toBe("bernacle/analyticool");
    expect(config.merge.mode).toBe("manual");
    expect(config.permissions.github.merge).toBe(false);
    expect(config.agents.implementer.adapter).toBe("claude-code");
    expect(config.agents.reviewer.adapter).toBe("codex");
    expect(config.checks.map((c) => c.run)).toEqual(["pnpm lint", "pnpm format:check", "pnpm typecheck", "pnpm test", "pnpm verify:net-receipts", "python3 verification/net-receipts/oracle.py", "pnpm build"]);
  });

  it("expands ${VAR} and ${VAR:-default}", () => {
    expect(expandEnv("${A}/${B:-x}", { A: "1" })).toBe("1/x");
  });
});
