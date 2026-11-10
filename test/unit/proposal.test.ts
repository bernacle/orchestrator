import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { RepoInspection } from "../../src/adapters/types.js";
import { resolvePaths } from "../../src/config/load.js";
import { authorizeProposal, buildProposal, localConfigFile, proposalFile } from "../../src/intake/proposal.js";
import { configStatus } from "../../src/intake/resolve.js";

const scratch = mkdtempSync(join(tmpdir(), "orch-proposal-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const paths = () => resolvePaths({ ORCHESTRATOR_HOME: join(scratch, `h${n++}`) });

const inspection = (over: Partial<RepoInspection> = {}): RepoInspection => ({
  root: "/repo",
  headSha: "abc123",
  packageManager: "pnpm@10.0.0",
  scripts: { lint: "eslint .", "format:check": "prettier -c .", typecheck: "tsc -b", test: "vitest run", build: "vite build", dev: "vite" },
  workspaces: [],
  ciWorkflows: [{ file: "ci.yml", runSteps: ["pnpm install --frozen-lockfile", "pnpm lint", "pnpm test"] }],
  guidanceFiles: ["README.md"],
  topLevel: ["package.json", "pnpm-lock.yaml", "src"],
  nodeEngine: ">=24",
  nodeVersionFile: null,
  ...over,
});

describe("first-use configuration", () => {
  it("proposes checks from the repository's scripts, with safe defaults", () => {
    const p = paths();
    const prop = buildProposal({ repo: "acme/app", inspection: inspection(), teams: ["ACM"], agentsAvailable: { claude: true, codex: true }, paths: p });
    expect(prop.summary.setup).toEqual(["pnpm install --frozen-lockfile"]);
    // CI lists lint + test (installs are setup, not checks).
    expect(prop.summary.checks).toEqual(["pnpm lint", "pnpm test"]);
    const noCi = buildProposal({ repo: "acme/app", inspection: inspection({ ciWorkflows: [] }), teams: ["ACM"], agentsAvailable: { claude: true, codex: true }, paths: paths() });
    expect(noCi.summary.checks).toEqual(["pnpm lint", "pnpm format:check", "pnpm typecheck", "pnpm test", "pnpm build"]);
    expect(prop.summary.merge).toMatch(/manual/);
    expect(prop.summary.github).toEqual({ push: true, create_pr: true, merge: false });
    expect(prop.summary.linear).toEqual({ comment: false, update_state: false });
    const cfg = parseYaml(prop.yaml) as { isolation: { require: boolean }; toolchain: { node: string }; agents: { reviewer: { adapter: string; sandbox: string } } };
    expect(cfg.isolation.require).toBe(true);
    expect(cfg.toolchain.node).toBe("24");
    expect(cfg.agents.reviewer).toMatchObject({ adapter: "codex", sandbox: "read-only" });
    // Pending only: no authorized config exists until the operator authorizes it.
    expect(existsSync(proposalFile(p, "acme/app"))).toBe(true);
    expect(configStatus("acme/app", p).status).toBe("missing");
  });

  it("mirrors the CI workflow's verification steps when there is one", () => {
    const prop = buildProposal({
      repo: "acme/app",
      inspection: inspection({ ciWorkflows: [{ file: "ci.yml", runSteps: ["corepack enable", "pnpm install --frozen-lockfile", "pnpm lint", "pnpm verify:receipts", "python3 verification/oracle.py", "echo done", "pnpm build", "for f in a b; do\n  x\ndone", "pnpm lint"] }] }),
      teams: ["ACM"],
      agentsAvailable: { claude: true, codex: true },
      paths: paths(),
    });
    expect(prop.summary.checks).toEqual(["pnpm lint", "pnpm verify:receipts", "python3 verification/oracle.py", "pnpm build"]);
    const cfg = parseYaml(prop.yaml) as { checks: Array<{ name: string }> };
    expect(cfg.checks.map((c) => c.name)).toEqual(["lint", "verify-receipts", "python3-verification-oracle.py", "build"]);
  });

  it("ignores orchestrator config shipped inside the repository", () => {
    const prop = buildProposal({ repo: "acme/app", inspection: inspection({ topLevel: ["package.json", ".orchestrator.yaml", "orchestrator.yml"] }), teams: ["ACM"], agentsAvailable: { claude: true, codex: true }, paths: paths() });
    expect(prop.summary.ignoredRepositoryConfig).toEqual([".orchestrator.yaml", "orchestrator.yml"]);
    expect(prop.summary.warnings[0]).toMatch(/cannot configure or authorize/);
  });

  it("warns when nothing can be verified or the reviewer is missing", () => {
    const prop = buildProposal({ repo: "acme/app", inspection: inspection({ packageManager: null, scripts: {}, topLevel: ["Makefile"] }), teams: [], agentsAvailable: { claude: true, codex: false }, paths: paths() });
    expect(prop.summary.warnings.join("\n")).toMatch(/no checks were detected/);
    expect(prop.summary.warnings.join("\n")).toMatch(/codex is not on PATH/);
    expect(prop.summary.warnings.join("\n")).toMatch(/Linear team key is unknown/);
  });

  it("authorizes only on request, recording who approved which proposal, outside the repository", () => {
    const p = paths();
    const prop = buildProposal({ repo: "acme/app", inspection: inspection(), teams: ["ACM"], agentsAvailable: { claude: true, codex: true }, paths: p });
    const r = authorizeProposal(p, "acme/app", { by: "ada" });
    expect(r.file).toBe(localConfigFile(p, "acme/app"));
    expect(r.file.startsWith(p.home)).toBe(true);
    expect(r.sha256).toBe(prop.sha256);
    const st = configStatus("acme/app", p);
    expect(st).toMatchObject({ status: "authorized", scope: "supervised", authorizedBy: "ada" });
    expect(() => authorizeProposal(p, "acme/app")).toThrow(/already exists/);
    expect(authorizeProposal(p, "acme/app", { replace: true, readOnly: true }).scope).toBe("read_only");
    const ro = parseYaml(readFileSync(r.file, "utf8")) as { permissions: { github: { push: boolean }; agents: { run: boolean } } };
    expect(ro.permissions.github.push).toBe(false);
    expect(ro.permissions.agents.run).toBe(false);
  });

  it("refuses to authorize without a proposal, or with an unknown team", () => {
    const p = paths();
    expect(() => authorizeProposal(p, "acme/none")).toThrow(/no pending proposal/);
    buildProposal({ repo: "acme/app", inspection: inspection(), teams: [], agentsAvailable: { claude: true, codex: true }, paths: p });
    expect(() => authorizeProposal(p, "acme/app")).toThrow(/set linear.teams/);
  });

  it("validates a hand-edited proposal before authorizing it", () => {
    const p = paths();
    buildProposal({ repo: "acme/app", inspection: inspection(), teams: ["ACM"], agentsAvailable: { claude: true, codex: true }, paths: p });
    const file = proposalFile(p, "acme/app");
    writeFileSync(file, readFileSync(file, "utf8").replace("sandbox: read-only", "sandbox: danger-full-access"));
    expect(() => authorizeProposal(p, "acme/app")).toThrow(/invalid configuration/);
  });
});
