import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalRequest, Approver } from "../../src/core/approval.js";
import { configuredApprover, enrollRemote, operationChallenge, remoteApprover } from "../../src/core/remote-approval.js";
import { digest, REMOTE_PORT, RemoteApprovalStore, RemoteSettingsSchema, tailscaleTransport, type PrivateTransport, type RemoteSettings } from "../../src/core/remote-config.js";
import type { TrustKeyStore } from "../../src/core/trust.js";

const settings: RemoteSettings = { origin: "https://mac.personal.ts.net", personalTailnet: "personal", owner: "me@example.com", devices: ["nPhone"], serverNodeId: "nMac" };
const hash = (b: string | Buffer) => createHash("sha256").update(b).digest();
const encode = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
function authenticator() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
  const id = randomBytes(32);
  return {
    credential: { id: encode(id), publicKey: encode(cose) },
    response(challenge: string, opts: { origin?: string; rp?: string; flags?: number; type?: string; crossOrigin?: boolean; wrongSignature?: boolean } = {}) {
      const clientData = Buffer.from(JSON.stringify({ type: opts.type ?? "webauthn.get", challenge, origin: opts.origin ?? settings.origin, crossOrigin: opts.crossOrigin ?? false }));
      const authData = Buffer.concat([hash(opts.rp ?? "mac.personal.ts.net"), Buffer.from([opts.flags ?? 5]), Buffer.alloc(4)]);
      const signature = sign("sha256", Buffer.concat([authData, hash(clientData)]), privateKey);
      if (opts.wrongSignature) signature[5] = signature[5]! ^ 1;
      return { id: encode(id), rawId: encode(id), type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: encode(clientData), authenticatorData: encode(authData), signature: encode(signature), userHandle: null } };
    },
    registration(challenge: string) {
      const length = Buffer.alloc(2); length.writeUInt16BE(id.length);
      const authData = Buffer.concat([hash("mac.personal.ts.net"), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), length, id, cose]);
      const attestationObject = isoCBOR.encode(new Map<string, string | Uint8Array | Map<string, never>>([["fmt", "none"], ["authData", authData], ["attStmt", new Map<string, never>()]]));
      return { id: encode(id), rawId: encode(id), type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: encode(Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin: settings.origin, crossOrigin: false }))), attestationObject: encode(attestationObject), transports: ["internal"] } };
    },
  };
}

const homes: string[] = [], controllers: AbortController[] = [], pending: Promise<unknown>[] = [];
afterEach(async () => { controllers.splice(0).forEach((c) => c.abort()); await Promise.allSettled(pending.splice(0)); homes.splice(0).forEach((h) => rmSync(h, { recursive: true, force: true })); });
function storage() {
  const home = mkdtempSync(join(tmpdir(), "orch-remote-test-")); homes.push(home);
  const map = new Map<string, string>();
  const keys: TrustKeyStore = { name: "memory", get: (k) => map.get(k) ?? null, set: (k, v) => { map.set(k, v); }, delete: (k) => { map.delete(k); } };
  return { home, store: new RemoteApprovalStore(home, keys) };
}
const privateTransport: PrivateTransport = { check: async () => {}, device: async () => ({ id: "nPhone", owner: settings.owner }) };
const request = (): ApprovalRequest => ({ purpose: "resume_live_run", repo: "acme/widget", issue: "ACM-1", scopeHash: digest("exact scope"), reason: "Continue this run; no new time window", details: ["Sandbox, independent review, CI and manual merge required"], binding: { safeguards: true, operation: { runId: "acm-1-abc", version: 4, state: "BLOCKED", blockedFrom: "VERIFYING", reason: "environment unavailable", acceptedDependencies: [], newTimeWindow: false }, configHash: digest("config") }, validate: () => {} });
function send(port: number, path: string, body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? "GET" : "POST"): Promise<{ status: number; data: any; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers: { host: "mac.personal.ts.net", "x-forwarded-host": "mac.personal.ts.net", "x-forwarded-proto": "https", "x-forwarded-for": "100.64.0.10", "tailscale-user-login": settings.owner, ...(body !== undefined ? { origin: settings.origin, "content-type": "application/json" } : {}), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (b: Buffer) => chunks.push(b));
      res.on("end", () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode!, data: res.headers["content-type"]?.startsWith("application/json") ? JSON.parse(text) : text, headers: res.headers }); });
    });
    req.on("error", reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end();
  });
}
async function begin(opts: { req?: ApprovalRequest; transport?: PrivateTransport; timeoutMs?: number; now?: () => number; store?: RemoteApprovalStore; auth?: ReturnType<typeof authenticator> } = {}) {
  const auth = opts.auth ?? authenticator(), store = opts.store ?? storage().store;
  if (!store.exists()) store.save(settings, auth.credential);
  const controller = new AbortController(); controllers.push(controller);
  let ready!: (port: number) => void;
  const port = new Promise<number>((r) => { ready = r; });
  const req = opts.req ?? request(); req.signal = controller.signal;
  const logs: string[] = [];
  const result = remoteApprover(store, { transport: opts.transport ?? privateTransport, listenPort: 0, onListen: ready, timeoutMs: opts.timeoutMs, now: opts.now, log: (line) => logs.push(line) }).request(req);
  void result.catch(() => {}); pending.push(result);
  return { auth, store, req, controller, result, logs, port: await Promise.race([port, result.then(() => { throw Error("no listener"); })]) };
}

describe("independently verified passkey assertions", () => {
  it("requires a real signature and consumes it once, even for synced passkeys with zero counters", async () => {
    const h = await begin();
    const page = await send(h.port, "/");
    expect(page.headers["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
    expect(page.headers["cache-control"]).toBe("no-store");
    const { data } = await send(h.port, "/request");
    expect(data.options.userVerification).toBe("required");
    expect(data.binding.operation).toMatchObject({ runId: "acm-1-abc", version: 4, newTimeWindow: false });
    const response = h.auth.response(data.options.challenge);
    const grants = await Promise.allSettled([send(h.port, "/verify", response), send(h.port, "/verify", response)]);
    expect(grants.filter((g) => g.status === "fulfilled" && g.value.status === 200), h.logs.join("\n")).toHaveLength(1);
    expect(await h.result).toMatchObject({ approved: true, channel: "remote-passkey", user: settings.owner });
  });
  it.each([
    ["wrong signature", { wrongSignature: true }], ["wrong origin", { origin: "https://evil.example" }],
    ["wrong RP ID", { rp: "other.personal.ts.net" }], ["missing UV", { flags: 1 }], ["missing presence", { flags: 4 }],
    ["cross-origin assertion", { crossOrigin: true }], ["registration instead of assertion", { type: "webauthn.create" }],
  ])("refuses %s, then accepts an authentic assertion", async (_name, opts) => {
    const h = await begin(), { data } = await send(h.port, "/request");
    expect((await send(h.port, "/verify", h.auth.response(data.options.challenge, opts))).status).toBe(403);
    expect((await send(h.port, "/verify", h.auth.response(data.options.challenge))).status).toBe(200);
    expect((await h.result).approved).toBe(true);
  });
  it("refuses agent-fabricated approval JSON, unknown keys and challenge replay across operations", async () => {
    const h = await begin(), { data } = await send(h.port, "/request");
    expect((await send(h.port, "/verify", { approved: true, channel: "macos-local-authentication" })).status).toBe(403);
    expect((await send(h.port, "/verify", authenticator().response(data.options.challenge))).status).toBe(403);
    const old = h.auth.response(data.options.challenge);
    await send(h.port, "/verify", old); await h.result;
    const changed = request(); changed.repo = "acme/other"; changed.purpose = "trust_repository";
    const next = await begin({ auth: h.auth, store: h.store, req: changed });
    expect((await send(next.port, "/verify", old)).status).toBe(403);
    const fresh = (await send(next.port, "/request")).data;
    await send(next.port, "/verify", next.auth.response(fresh.options.challenge)); await next.result;
  });
  it("does not accept a changed operation, configuration validation failure, or revoked registry", async () => {
    for (const mutate of [
      (h: Awaited<ReturnType<typeof begin>>) => { h.req.binding!.operation = { runId: "another-run" }; },
      (h: Awaited<ReturnType<typeof begin>>) => { h.req.validate = () => { throw Error("config changed"); }; },
      (h: Awaited<ReturnType<typeof begin>>) => { h.store.remove(); },
    ]) {
      const h = await begin(), { data } = await send(h.port, "/request"); mutate(h);
      expect((await send(h.port, "/verify", h.auth.response(data.options.challenge))).status).toBe(403);
      h.controller.abort(); await expect(h.result).rejects.toThrow();
    }
  });
  it("expires and cancels without accepting credentials or producing a stored approval", async () => {
    const h = await begin({ timeoutMs: 60 });
    await expect(h.result).rejects.toThrow(/expired/);
    const next = await begin(); next.controller.abort(); await expect(next.result).rejects.toThrow(/cancelled/);
  });
  it("binds every operation component and expiry into the challenge", () => {
    const base = { repo: "acme/widget", purpose: "resume", runId: "one", scope: "a", expiresAt: "soon" };
    const original = operationChallenge(base, "nonce");
    for (const key of Object.keys(base)) expect(operationChallenge({ ...base, [key]: "different" }, "nonce")).not.toBe(original);
    expect(operationChallenge(base, "other nonce")).not.toBe(original);
  });
});

describe("private HTTP boundary", () => {
  it("allows an authorized top-level navigation from T3 without allowing cross-site scope reads", async () => {
    const h = await begin();
    const headers = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    expect((await send(h.port, "/", undefined, headers)).status).toBe(200);
    expect((await send(h.port, "/request", undefined, headers)).status).toBe(403);
  });
  it.each([
    ["wrong owner", { "tailscale-user-login": "colleague@example.com" }],
    ["Funnel", { "tailscale-funnel-request": "?1" }], ["HTTP", { "x-forwarded-proto": "http" }],
    ["wrong host", { host: "evil.example" }], ["forged forwarded host", { "x-forwarded-host": "evil.example" }],
    ["ambiguous device address", { "x-forwarded-for": "100.64.0.10, 100.64.0.11" }],
    ["cross-site", { "sec-fetch-site": "cross-site" }],
  ])("does not disclose scope through %s", async (_name, headers) => {
    const h = await begin(); expect((await send(h.port, "/request", undefined, headers)).status).toBe(403);
  });
  it("requires an allowed device in addition to the owner and passkey", async () => {
    const h = await begin({ transport: { ...privateTransport, device: async () => ({ id: "nCoworker", owner: settings.owner }) } });
    expect((await send(h.port, "/request")).status).toBe(403);
  });
  it("requires exact Origin and JSON POSTs and exposes no CORS grant", async () => {
    const h = await begin();
    const response = await send(h.port, "/verify", {}, { origin: "https://evil.example" });
    expect(response.status).toBe(403); expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect((await send(h.port, "/verify", undefined)).status).toBe(404);
    expect((await send(h.port, "/verify", {}, { "content-type": "text/plain" })).status).toBe(415);
  });
});

describe("enrollment and sealed public-key registry", () => {
  it("keeps local approval as an explicit option and never silently falls back from an invalid registry", async () => {
    const { store, home } = storage();
    const localChannel = process.platform === "darwin" ? "macos-local-authentication" : "controlling-terminal";
    expect(configuredApprover(home).channel).toBe(localChannel);
    store.save(settings, authenticator().credential);
    writeFileSync(store.file, "{}"); // Invalid before any real key store can be accessed.
    expect(configuredApprover(home).channel).toBe("remote-passkey");
    await expect(configuredApprover(home).request(request())).rejects.toThrow(/invalid/);
    expect(configuredApprover(home, "local").channel).toBe(localChannel);
  });
  it("refuses remote operations lacking mandatory safeguards before opening a listener", async () => {
    const { store } = storage(); store.save(settings, authenticator().credential);
    const req = request(); req.binding!.safeguards = false;
    await expect(remoteApprover(store, { transport: privateTransport }).request(req)).rejects.toThrow(/safeguards/);
  });
  it("commits only the exact verified candidate after local authentication; no enrollment window can substitute another key", async () => {
    const { home, store } = storage(), auth = authenticator();
    const controller = new AbortController(); controllers.push(controller);
    let portReady!: (p: number) => void, approveLocal!: () => void, asked!: (r: ApprovalRequest) => void;
    const portPromise = new Promise<number>((r) => { portReady = r; }), askedPromise = new Promise<ApprovalRequest>((r) => { asked = r; });
    const local: Approver = { channel: "test-local", async request(req) { asked(req); await new Promise<void>((r) => { approveLocal = r; }); return { approved: true, at: new Date().toISOString(), user: "operator", channel: "test-local", detail: "test approval" }; } };
    const logs: string[] = [];
    const result = enrollRemote(store, settings, home, { transport: privateTransport, local, signal: controller.signal, listenPort: 0, onListen: portReady, log: (line) => logs.push(line) });
    pending.push(result);
    const port = await portPromise, { data } = await send(port, "/request");
    const submitted = await send(port, "/verify", auth.registration(data.options.challenge));
    expect(submitted.status, logs.join("\n")).toBe(202);
    const req = await askedPromise;
    expect(req.scopeHash).toBe(digest({ settings, credential: auth.credential }));
    expect(req.reason).toContain(settings.origin); expect(req.reason).toContain(req.scopeHash);
    expect(store.exists()).toBe(false);
    expect((await send(port, "/verify", authenticator().registration(data.options.challenge))).status).toBe(409);
    approveLocal();
    const saved = await result;
    expect(saved.credential).toEqual(auth.credential); expect(store.read()).toEqual(saved);
  });
  it("detects edited settings/keys, restored credentials and explicit revocation", () => {
    const { store } = storage(), auth = authenticator();
    store.save(settings, auth.credential); const original = readFileSync(store.file, "utf8");
    writeFileSync(store.file, original.replace("nPhone", "nAgent")); expect(() => store.read()).toThrow(/seal/);
    store.save(settings, auth.credential); writeFileSync(store.file, original); expect(() => store.read()).toThrow(/seal/);
    store.remove(); writeFileSync(store.file, original); expect(() => store.read()).toThrow(/revoked/);
  });
  it.each(["http://mac.personal.ts.net", "https://mac.work.ts.net/path", "https://mac.personal.ts.net:444", "https://example.com"])("refuses unpinnable origin %s", (origin) => expect(RemoteSettingsSchema.safeParse({ ...settings, origin }).success).toBe(false));
});

describe("Tailscale adapter only inspects, never enables remote access", () => {
  const status = { Version: "1.102.2", BackendState: "Running", CurrentTailnet: { Name: "personal" }, Self: { ID: "nMac", DNSName: "mac.personal.ts.net." }, CertDomains: ["mac.personal.ts.net"] };
  const serve = () => ({ TCP: { "443": { HTTPS: true } }, Web: { "mac.personal.ts.net:443": { Handlers: { "/": { Proxy: `http://127.0.0.1:${REMOTE_PORT}` } } } }, AllowFunnel: { "mac.personal.ts.net:443": false } });
  it("accepts the pinned private service using read-only commands", async () => {
    const calls: string[][] = [];
    const transport = tailscaleTransport(async (args) => { calls.push(args); return args[0] === "status" ? status : args[0] === "whois" ? { Node: { StableID: "nPhone" }, UserProfile: { LoginName: settings.owner } } : serve(); });
    await transport.check(settings); expect(await transport.device("100.64.0.10")).toEqual({ id: "nPhone", owner: settings.owner });
    expect(calls).toEqual([["status", "--json"], ["serve", "status", "--json"], ["whois", "--json", "100.64.0.10"]]);
  });
  it.each(["work tailnet", "different Mac", "no HTTPS", "Funnel", "shared origin", "wrong target", "raw TCP bypass", "service bypass", "foreground bypass", "old Tailscale"])("fails closed for %s without changing configuration", async (problem) => {
    const s = structuredClone(status), v = serve();
    if (problem === "work tailnet") s.CurrentTailnet.Name = "work";
    if (problem === "old Tailscale") s.Version = "1.100.0";
    if (problem === "different Mac") s.Self.ID = "nOther";
    if (problem === "no HTTPS") s.CertDomains = [];
    if (problem === "Funnel") v.AllowFunnel["mac.personal.ts.net:443"] = true;
    if (problem === "shared origin") (v.Web["mac.personal.ts.net:443"].Handlers as Record<string, unknown>)["/other"] = { Proxy: "http://127.0.0.1:8080" };
    if (problem === "wrong target") v.Web["mac.personal.ts.net:443"].Handlers["/"].Proxy = "http://0.0.0.0:9999";
    if (problem === "raw TCP bypass") (v.TCP as Record<string, unknown>)["8443"] = { TCPForward: `127.0.0.1:${REMOTE_PORT}` };
    if (problem === "service bypass") (v as Record<string, unknown>).Services = { "svc:attack": { TCP: { "8443": { TCPForward: `127.0.0.1:${REMOTE_PORT}` } } } };
    if (problem === "foreground bypass") (v as Record<string, unknown>).Foreground = { attack: { TCP: { "8443": { TCPForward: `127.0.0.1:${REMOTE_PORT}` } } } };
    const commands: string[][] = [];
    await expect(tailscaleTransport(async (args) => { commands.push(args); return args[0] === "status" ? s : v; }).check(settings)).rejects.toThrow();
    expect(commands.every((args) => args.join(" ") === "status --json" || args.join(" ") === "serve status --json")).toBe(true);
  });
});
