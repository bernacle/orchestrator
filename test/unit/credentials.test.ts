import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CredentialError, LinearCredentialStore, resolveLinearKey } from "../../src/credentials/linear.js";
import { credentialPaths } from "../../src/core/isolation.js";

const scratch = mkdtempSync(join(tmpdir(), "orch-cred-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// The file backend everywhere in tests: the macOS Keychain is never touched.
const env = { ORCHESTRATOR_CREDENTIAL_BACKEND: "file" } as NodeJS.ProcessEnv;
let n = 0;
const freshHome = () => ({ home: join(scratch, `h${n++}`) });

describe("Linear credentials", () => {
  it("prefers LINEAR_API_KEY, then LINEAR_API_KEY_FILE (existing behaviour)", () => {
    const paths = freshHome();
    expect(resolveLinearKey({ env: { ...env, LINEAR_API_KEY: " lin_api_env " }, paths })).toMatchObject({ key: "lin_api_env", source: "env LINEAR_API_KEY" });
    const file = join(scratch, "keyfile");
    writeFileSync(file, "lin_api_file\n");
    expect(resolveLinearKey({ env: { ...env, LINEAR_API_KEY_FILE: file }, paths })).toMatchObject({ key: "lin_api_file" });
    expect(resolveLinearKey({ env: { ...env, LINEAR_API_KEY_FILE: join(scratch, "missing") }, paths }).problem).toMatch(/missing or empty/);
  });

  it("explains how to log in when nothing is configured, without asking for the key in chat", () => {
    const r = resolveLinearKey({ env, paths: freshHome() });
    expect(r.key).toBeUndefined();
    expect(r.problem).toMatch(/orchestrator auth linear login/);
    expect(r.problem).toMatch(/Never paste the key into an agent chat/);
  });

  it("persists across sessions (new store instances) and keeps the secret out of the index", () => {
    const paths = freshHome();
    new LinearCredentialStore(paths, env).save({ workspace: "acme", user: "Ada", workspaceName: "Acme" }, "lin_api_secret_1234");
    const later = resolveLinearKey({ env, paths });
    expect(later).toMatchObject({ key: "lin_api_secret_1234", workspace: "acme", problem: null });
    expect(later.source).not.toContain("lin_api");
    const index = readFileSync(join(paths.home, "credentials", "linear.json"), "utf8");
    expect(index).not.toContain("lin_api_secret_1234");
    expect(statSync(join(paths.home, "credentials", "linear", "acme.key")).mode & 0o077).toBe(0);
  });

  it("keeps several workspaces apart and never picks one silently", () => {
    const paths = freshHome();
    const store = new LinearCredentialStore(paths, env);
    store.save({ workspace: "acme", user: "Ada", workspaceName: "Acme" }, "lin_api_acme_1234");
    store.save({ workspace: "globex", user: "Ada", workspaceName: "Globex" }, "lin_api_globex_1234");
    const ambiguous = resolveLinearKey({ env, paths });
    expect(ambiguous.key).toBeUndefined();
    expect(ambiguous.problem).toMatch(/Several Linear workspaces are stored \(acme, globex\)/);
    expect(resolveLinearKey({ env, paths, workspace: "globex" }).key).toBe("lin_api_globex_1234");
    expect(resolveLinearKey({ env, paths, workspace: "ACME" }).key).toBe("lin_api_acme_1234");
    const unknown = resolveLinearKey({ env, paths, workspace: "initech" });
    expect(unknown.key).toBeUndefined();
    expect(unknown.problem).toMatch(/No stored Linear key for workspace "initech" \(stored: acme, globex\)/);
    expect(store.remove("globex")).toBe(true);
    expect(resolveLinearKey({ env, paths }).key).toBe("lin_api_acme_1234");
  });

  it("rejects values that are not API keys", () => {
    const store = new LinearCredentialStore(freshHome(), env);
    expect(() => store.save({ workspace: "acme", user: "u", workspaceName: "A" }, 'x" ; rm -rf /')).toThrow(CredentialError);
    expect(() => store.save({ workspace: "../evil", user: "u", workspaceName: "A" }, "lin_api_ok_123456")).toThrow(CredentialError);
  });

  it("the credentials directory is unreadable from sandboxes", () => {
    expect(credentialPaths({ HOME: "/Users/me" }, "/Users/me/.orchestrator")).toContain("/Users/me/.orchestrator/credentials");
  });
});
