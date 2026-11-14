import { createHash } from "node:crypto";
import { canonical } from "../../src/core/approval.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepoConfigSchema, type RepoConfig } from "../../src/config/schema.js";
import { scopeExpansions, trustScope, TrustStore, type TrustKeyStore } from "../../src/core/trust.js";

const config = () => RepoConfigSchema.parse({ repo: "acme/widget", linear: { teams: ["ACM"] }, agents: { implementer: { adapter: "claude-code" }, reviewer: { adapter: "codex" } }, permissions: { agents: { run: true }, github: { push: true, create_pr: true } }, checks: [{ name: "test", run: "pnpm test" }] });
const loaded = (c = config()) => ({ config: c, source: "/operator/widget.yaml" });
const scope = (c: RepoConfig) => trustScope(loaded(c)).scope;
const expand = (change: (c: RepoConfig) => void) => { const a = config(), b = config(); change(b); return scopeExpansions(scope(a), scope(b)); };

describe("trust authority partial order", () => {
  it.each([
    ["permission removal", (c: RepoConfig) => { c.permissions.github.push = false; }],
    ["lower limits", (c: RepoConfig) => { c.limits.max_run_cost_usd = 1; c.limits.max_run_minutes = 10; }],
    ["stronger forbidden set", (c: RepoConfig) => { c.forbidden_paths.push("private/**"); c.forbidden_paths.reverse(); }],
    ["extra mandatory check", (c: RepoConfig) => { c.checks.push({ name: "postgres", run: "verify-pg", optional: false, timeout_minutes: 10 }); }],
    ["explicit default network", (c: RepoConfig) => { c.checks[0]!.network = "none"; }],
    ["less setup network", (c: RepoConfig) => { c.isolation.setup_network = "none"; }],
    ["model within existing authority", (c: RepoConfig) => { c.agents.reviewer = { ...c.agents.reviewer, model: "another-model" } as typeof c.agents.reviewer; }],
    ["stricter review", (c: RepoConfig) => { c.review.blocking_severities.push("minor"); c.review.minor_fix_rounds = 0; }],
  ])("keeps trust for %s", (_name, change) => expect(expand(change)).toEqual([]));

  it.each([
    ["new permission", "permissions", (c: RepoConfig) => { c.permissions.github.merge = true; }],
    ["higher limit", "limits", (c: RepoConfig) => { c.limits.max_run_minutes += 1; }],
    ["workflow relaxation", "forbiddenPaths", (c: RepoConfig) => { c.forbidden_paths = c.forbidden_paths.filter((s) => s !== ".github/workflows/**").concat(".github/workflows/ci.yml"); }],
    ["external check network", "commandNetwork", (c: RepoConfig) => { c.checks[0]!.network = "outbound"; }],
    ["external default network", "isolation", (c: RepoConfig) => { c.isolation.checks_network = "outbound"; }],
    ["extra reads", "isolation", (c: RepoConfig) => { c.isolation.read_paths.push("/extra"); }],
    ["removed check", "verification", (c: RepoConfig) => { c.checks = []; }],
    ["optionalized check", "verification", (c: RepoConfig) => { c.checks[0]!.optional = true; }],
    ["no-op check", "verification", (c: RepoConfig) => { c.checks[0]!.run = "true"; }],
    ["disabled baseline", "baselineChecks", (c: RepoConfig) => { c.baseline_checks = false; }],
    ["weaker review", "review", (c: RepoConfig) => { c.review.blocking_severities = []; }],
    ["no CI", "merge", (c: RepoConfig) => { c.merge.require_ci = false; }],
  ])("requires consent for %s", (_name, field, change) => expect(expand(change)).toContain(field));

  it("normalizes default/override network and catches removal of a restrictive override", () => {
    const a = config(); a.isolation.checks_network = "outbound"; a.checks[0]!.network = "none";
    const b = structuredClone(a); delete b.checks[0]!.network;
    expect(scopeExpansions(scope(a), scope(b))).toContain("commandNetwork");
  });
});

describe("safeguard floor ratchet and legacy migration", () => {
  let home: string;
  afterEach(() => home && rmSync(home, { recursive: true, force: true }));
  function store() {
    home = mkdtempSync(join(tmpdir(), "orch-scope-"));
    const map = new Map<string, string>();
    const keys: TrustKeyStore = { name: "memory", get: (k) => map.get(k) ?? null, set: (k, v) => { map.set(k, v); }, delete: (k) => { map.delete(k); } };
    return new TrustStore({ home }, keys);
  }
  it("pins an added check without asking, then refuses its removal and rollback", () => {
    const trust = store(), c = config(), original = trustScope(loaded(c));
    trust.write({ scope: original.scope, scopeHash: original.hash, trustedBy: "operator", trustedAt: new Date().toISOString(), channel: "local", detail: "approved" });
    const old = readFileSync(trust.file(c.repo), "utf8");
    c.checks.push({ name: "postgres", run: "pg-check", optional: false, timeout_minutes: 10 });
    expect(trust.evaluate(loaded(c)).status).toBe("trusted");
    expect(trust.narrow(loaded(c)).status).toBe("trusted");
    c.checks.pop();
    expect(trust.evaluate(loaded(c))).toMatchObject({ status: "stale", changed: ["verification"] });
    writeFileSync(trust.file(c.repo), old);
    expect(trust.evaluate(loaded(c)).status).toBe("invalid");
  });
  it("retains a valid legacy delegation, anchors current checks on first use, and never approves a legacy expansion", () => {
    const trust = store(), c = config(), original = trustScope(loaded(c));
    delete original.scope.verification;
    original.scope.commandNetwork = []; // Legacy scope only recorded explicit overrides.
    trust.write({ scope: original.scope, scopeHash: createHash("sha256").update(canonical(original.scope)).digest("hex"), trustedBy: "operator", trustedAt: new Date().toISOString(), channel: "local", detail: "legacy" });
    const wider = structuredClone(c); wider.isolation.read_paths.push("/private");
    expect(trust.evaluate(loaded(wider)).status).toBe("stale");
    expect(trust.narrow(loaded(c)).status).toBe("trusted");
    c.checks = [];
    expect(trust.evaluate(loaded(c))).toMatchObject({ status: "stale", changed: ["verification"] });
  });
});
