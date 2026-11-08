import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { cliPaths, codexLegacyDirs, defaultTargets, installTo, MARKER, skillEnv, skillStatus, t3ProviderHomes, uninstallFrom, type SkillEnv } from "../../src/skills/install.js";
import { CLAUDE_LISTING_CAP, loadSkillSource, renderSkill } from "../../src/skills/render.js";
import { codexCatalog, parseFrontmatter, verifyClaude } from "../../src/skills/verify.js";

const scratch = mkdtempSync(join(tmpdir(), "orch-skills-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
function env(extra: Record<string, string> = {}): SkillEnv {
  const home = join(scratch, `home${n++}`);
  mkdirSync(home, { recursive: true });
  return skillEnv({ HOME: home, ORCHESTRATOR_T3_SETTINGS: join(home, "t3-settings.json"), ...extra });
}
const CLI = "/opt/orchestrator/bin/orchestrator.js";
const opts = (se: SkillEnv, extra: Partial<Parameters<typeof installTo>[1]> = {}) => ({ cli: CLI, version: "9.9.9+test", se, ...extra });

describe("canonical skill rendering", () => {
  const claude = renderSkill("claude", { cli: CLI, version: "1" });
  const codex = renderSkill("codex", { cli: CLI, version: "1" });
  const fmClaude = parseFrontmatter(claude.files["SKILL.md"]!)!;
  const fmCodex = parseFrontmatter(codex.files["SKILL.md"]!)!;

  it("renders provider packaging from one source, with identical behaviour text", () => {
    expect(Object.keys(claude.files)).toEqual(["SKILL.md"]);
    expect(Object.keys(codex.files).sort()).toEqual(["SKILL.md", "agents/openai.yaml"]);
    const body = (s: string) => s.slice(s.indexOf("\n---", 4) + 4).replace(/[/$]orchestrate\b/g, "<invoke>");
    expect(body(claude.files["SKILL.md"]!)).toBe(body(codex.files["SKILL.md"]!));
    expect(claude.files["SKILL.md"]).toContain(`CLI: \`${CLI}\``);
    expect(claude.files["SKILL.md"]).toContain("/orchestrate BRU-488");
    expect(codex.files["SKILL.md"]).toContain("$orchestrate BRU-488");
    expect(claude.files["SKILL.md"]).not.toMatch(/\{\{\w+\}\}/);
  });

  it("uses each provider's documented metadata", () => {
    expect(fmClaude).toMatchObject({ name: "orchestrate", "argument-hint": expect.any(String) });
    expect(fmClaude["disable-model-invocation"]).toBeUndefined();
    // Only read-only subcommands are pre-approved; run/resume/repo/associate always ask.
    expect(fmClaude["allowed-tools"]).toEqual([`Bash(${CLI} context:*)`, `Bash(${CLI} status:*)`, `Bash(${CLI} review:*)`]);
    expect(fmClaude.when_to_use).toBeTruthy();
    expect(`${fmClaude.description} ${fmClaude.when_to_use}`.length).toBeLessThanOrEqual(CLAUDE_LISTING_CAP);
    // Codex reads only name + description: the examples are folded into the description.
    expect(fmCodex.name).toBe("orchestrate");
    expect(String(fmCodex.description)).toContain("Quero implementar");
    const openai = parseYaml(codex.files["agents/openai.yaml"]!) as { policy: { allow_implicit_invocation: boolean }; interface: { default_prompt: string; short_description: string } };
    expect(openai.policy.allow_implicit_invocation).toBe(true);
    expect(openai.interface.default_prompt).toContain("$orchestrate");
    expect(openai.interface.short_description.length).toBeGreaterThanOrEqual(25);
    expect(openai.interface.short_description.length).toBeLessThanOrEqual(64);
  });

  // Deterministic checks on the discovery text. They do not prove a model will pick the skill:
  // that is measured with real model calls (scripts/eval-skill-activation.ts).
  it("describes the triggers users actually type, in English and Portuguese", () => {
    const listing = `${fmClaude.description} ${fmClaude.when_to_use}`;
    for (const needle of ["Orchestrator", "Linear", "BRU-488", "linear.app/", "status", "resume", "review findings", "dry-run", "Quero implementar", "any language"]) expect(listing).toContain(needle);
    // The key use case comes first (both providers may truncate long descriptions).
    expect(String(fmClaude.description).slice(0, 80)).toMatch(/Linear issue.*Orchestrator/);
  });

  it("excludes ordinary issue discussion and non-Orchestrator implementation", () => {
    expect(String(fmClaude.description)).toMatch(/Not for explaining, summarizing or listing Linear issues, or for implementing an issue\s+without Orchestrator/);
  });

  it("states the authorization boundaries explicitly (providers proceed unless a skill requires approval)", () => {
    const body = claude.files["SKILL.md"]!;
    expect(body).toContain("Loading this skill is not authorization");
    expect((body.match(/\*\*This requires explicit approval\.\*\*|\*\*requires explicit approval\.\*\*/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(body).toMatch(/"Implement X with Orchestrator" is not approval/);
    expect(body).toMatch(/Never ask for, accept or handle an API key/);
    expect(body).toMatch(/untrusted/);
    expect(body.split("\n").length).toBeLessThan(150);
  });
});

describe("skill installation", () => {
  it("installs to the documented user-level locations, honouring CLAUDE_CONFIG_DIR and T3 provider homes", () => {
    const se = env();
    writeFileSync(se.t3Settings!, JSON.stringify({ providerInstances: { p: { driver: "claudeAgent", enabled: true, config: { homePath: join(se.home, ".claude-work2") } }, off: { driver: "claudeAgent", enabled: false, config: { homePath: "/nope" } }, x: { driver: "codex", config: { homePath: "" } } } }));
    expect(defaultTargets("claude", se).map((t) => t.dir)).toEqual([join(se.home, ".claude", "skills"), join(se.home, ".claude-work2", "skills")]);
    expect(defaultTargets("codex", se).map((t) => t.dir)).toEqual([join(se.home, ".agents", "skills")]);
    const withDir = skillEnv({ ...se.env, CLAUDE_CONFIG_DIR: join(se.home, "cfg") });
    expect(defaultTargets("claude", withDir)[0]!.dir).toBe(join(se.home, "cfg", "skills"));
    expect(defaultTargets("claude", se, { claudeHomes: ["/x"] }).map((t) => t.dir)).toEqual(["/x/skills"]);
    expect(t3ProviderHomes(join(se.home, "missing.json"))).toEqual({ claude: [], codex: [] });
  });

  it("is idempotent, records ownership, and reports status", () => {
    const se = env();
    const [target] = defaultTargets("claude", se);
    expect(installTo(target!, opts(se)).action).toBe("installed");
    expect(installTo(target!, opts(se)).action).toBe("unchanged");
    const path = join(target!.dir, "orchestrate");
    const marker = JSON.parse(readFileSync(join(path, MARKER), "utf8"));
    expect(marker).toMatchObject({ owner: "bernacle/orchestrator", provider: "claude", version: "9.9.9+test", cli: CLI });
    expect(skillStatus("claude", se, { cli: CLI, version: "9.9.9+test" })[0]).toMatchObject({ state: "current", installedVersion: "9.9.9+test" });
    expect(verifyClaude(skillStatus("claude", se, { cli: CLI, version: "x" })[0]!).ok).toBe(true);
  });

  it("detects outdated installs and upgrades them", () => {
    const se = env();
    const [target] = defaultTargets("codex", se);
    installTo(target!, opts(se, { cli: "/old/bin/orchestrator.js", version: "0.0.1" }));
    expect(skillStatus("codex", se, { cli: CLI, version: "9.9.9+test" })[0]!.state).toBe("outdated");
    expect(installTo(target!, opts(se, { onlyInstalled: true }))).toMatchObject({ action: "updated", detail: "0.0.1 → 9.9.9+test" });
    expect(readFileSync(join(target!.dir, "orchestrate", "SKILL.md"), "utf8")).toContain(CLI);
  });

  it("update installs nothing new", () => {
    const se = env();
    const [target] = defaultTargets("claude", se);
    expect(installTo(target!, opts(se, { onlyInstalled: true })).action).toBe("not_installed");
    expect(existsSync(join(target!.dir, "orchestrate"))).toBe(false);
  });

  it("keeps operator edits unless forced, and then keeps a copy", () => {
    const se = env();
    const [target] = defaultTargets("claude", se);
    installTo(target!, opts(se, { version: "0.0.1" }));
    const file = join(target!.dir, "orchestrate", "SKILL.md");
    writeFileSync(file, `${readFileSync(file, "utf8")}\nMy local rule.\n`);
    expect(skillStatus("claude", se, { cli: CLI, version: "9.9.9+test" })[0]).toMatchObject({ state: "modified", modifiedFiles: ["SKILL.md"] });
    expect(installTo(target!, opts(se)).action).toBe("skipped");
    expect(readFileSync(file, "utf8")).toContain("My local rule.");
    expect(installTo(target!, opts(se, { force: true })).action).toBe("updated");
    expect(readFileSync(file, "utf8")).not.toContain("My local rule.");
    const backup = readdirSync(join(target!.dir, "orchestrate")).find((f) => f.startsWith("SKILL.md.orig-"));
    expect(readFileSync(join(target!.dir, "orchestrate", backup!), "utf8")).toContain("My local rule.");
  });

  it("never overwrites or removes a skill it does not own, and leaves unrelated skills alone", () => {
    const se = env();
    const [target] = defaultTargets("claude", se);
    mkdirSync(join(target!.dir, "orchestrate"), { recursive: true });
    writeFileSync(join(target!.dir, "orchestrate", "SKILL.md"), "---\nname: orchestrate\ndescription: someone else's\n---\n");
    mkdirSync(join(target!.dir, "other"), { recursive: true });
    writeFileSync(join(target!.dir, "other", "SKILL.md"), "other");
    expect(installTo(target!, opts(se)).action).toBe("skipped");
    expect(uninstallFrom(target!, {}).action).toBe("skipped");
    expect(readFileSync(join(target!.dir, "orchestrate", "SKILL.md"), "utf8")).toContain("someone else's");
    expect(readFileSync(join(target!.dir, "other", "SKILL.md"), "utf8")).toBe("other");
  });

  it("uninstalls only Orchestrator-owned files", () => {
    const se = env();
    const [target] = defaultTargets("codex", se);
    installTo(target!, opts(se));
    const path = join(target!.dir, "orchestrate");
    writeFileSync(join(path, "NOTES.md"), "mine");
    expect(uninstallFrom(target!, {})).toMatchObject({ action: "removed", detail: expect.stringContaining("NOTES.md") });
    expect(readdirSync(path)).toEqual(["NOTES.md"]);
    rmSync(join(path, "NOTES.md"));
    installTo(target!, opts(se));
    expect(uninstallFrom(target!, {}).action).toBe("removed");
    expect(existsSync(path)).toBe(false);
    expect(uninstallFrom(target!, {}).action).toBe("not_installed");
  });

  it("replaces the legacy `install-skill` symlink", () => {
    const se = env();
    const [target] = defaultTargets("claude", se);
    mkdirSync(target!.dir, { recursive: true });
    symlinkSync("/old/checkout/integrations/claude-skill/orchestrate", join(target!.dir, "orchestrate"));
    expect(skillStatus("claude", se, { cli: CLI, version: "1" })[0]!.state).toBe("legacy_symlink");
    expect(installTo(target!, opts(se)).action).toBe("installed");
    expect(existsSync(join(target!.dir, "orchestrate", MARKER))).toBe(true);
  });

  it("removes its own duplicate in $CODEX_HOME/skills so Codex lists the skill once", () => {
    const se = env();
    const legacy = codexLegacyDirs(se)[0]!;
    installTo({ provider: "codex", dir: legacy, why: "old" }, opts(se));
    const [target] = defaultTargets("codex", se);
    expect(skillStatus("codex", se, { cli: CLI, version: "9.9.9+test" })[0]!.notes[0]).toMatch(/Codex lists both copies/);
    installTo(target!, opts(se));
    expect(existsSync(join(legacy, "orchestrate"))).toBe(false);
  });

  it("fails clearly on an unusable directory", () => {
    const se = env();
    const file = join(se.home, "not-a-dir");
    writeFileSync(file, "x");
    expect(() => installTo({ provider: "claude", dir: file, why: "test" }, opts(se))).toThrow();
  });
});

describe("discovery verification helpers", () => {
  it("parses Codex's model-visible skill catalog", () => {
    const dump = JSON.stringify([{ content: [{ text: "## Skills\n### Skill roots\n- `r0` = `/h/.codex/skills`\n- `r1` = `/h/.agents/skills`\n### Available skills\n- orchestrate: Hand a Linear issue to Orchestrator. (file: r1/orchestrate/SKILL.md)\n- other: x (file: r0/other/SKILL.md)\n" }] }]);
    expect(codexCatalog(dump).skills).toEqual([
      { name: "orchestrate", description: "Hand a Linear issue to Orchestrator.", file: "/h/.agents/skills/orchestrate/SKILL.md" },
      { name: "other", description: "x", file: "/h/.codex/skills/other/SKILL.md" },
    ]);
  });

  it("flags frontmatter Claude Code could not match", () => {
    const se = env();
    const [target] = defaultTargets("claude", se);
    installTo(target!, opts(se));
    writeFileSync(join(target!.dir, "orchestrate", "SKILL.md"), "---\nname: orchestrate\ndescription: [broken\n---\n");
    expect(verifyClaude(skillStatus("claude", se, { cli: CLI, version: "x" })[0]!).ok).toBe(false);
  });

  it("flags a baked CLI command whose Node or launcher disappeared", () => {
    expect(cliPaths("/opt/node/bin/node /opt/orchestrator/bin/orchestrator.js")).toEqual(["/opt/node/bin/node", "/opt/orchestrator/bin/orchestrator.js"]);
    expect(cliPaths("'/Users/a b/node' /x/orchestrator.js")).toEqual(["/Users/a b/node", "/x/orchestrator.js"]);
    const se = env();
    const [target] = defaultTargets("claude", se);
    installTo(target!, opts(se, { cli: "/gone/node /gone/bin/orchestrator.js" }));
    expect(skillStatus("claude", se, { cli: "/gone/node /gone/bin/orchestrator.js", version: "9.9.9+test" })[0]!.notes.join()).toMatch(/no longer exist/);
  });

  it("loads the canonical source", () => {
    expect(loadSkillSource().meta.name).toBe("orchestrate");
  });
});
