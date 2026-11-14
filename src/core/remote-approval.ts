import { randomBytes, createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { auditApproval, canonical, macosApprover, systemApprover, approvalChannelStatus, type ApprovalRequest, type Approver } from "./approval.js";
import { digest, REMOTE_PORT, RemoteApprovalError, RemoteApprovalStore, RemoteSettingsSchema, tailscaleTransport, type PrivateTransport, type RemoteRegistry, type RemoteSettings } from "./remote-config.js";
import { remotePage } from "./remote-page.js";

export const REMOTE_CHANNEL = "remote-passkey";
export const REMOTE_TIMEOUT_MS = 10 * 60_000;
export type ApprovalChannel = "local" | "remote";
export interface CeremonyDeps {
  transport?: PrivateTransport;
  now?: () => number;
  log?: (line: string) => void;
  /** Code-only test seams; no CLI flag/config/env can change the binding or deadline. */
  listenPort?: number;
  timeoutMs?: number;
  onListen?: (port: number) => void;
  signal?: AbortSignal;
}
const logLine = (line: string) => process.stderr.write(`${line}\n`);
const rpID = (settings: RemoteSettings) => new URL(settings.origin).hostname;
function requireSameOriginCeremony(response: AuthenticationResponseJSON | RegistrationResponseJSON): void {
  const data = JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8")) as { crossOrigin?: unknown; topOrigin?: unknown };
  if ((data.crossOrigin !== undefined && data.crossOrigin !== false) || data.topOrigin !== undefined) throw new RemoteApprovalError("cross-origin passkey ceremonies are not allowed");
}
export function operationChallenge(payload: unknown, nonce: string): string {
  return createHash("sha256").update("orchestrator-remote-approval-v1\0").update(nonce).update("\0").update(canonical(payload)).digest("base64url");
}

/** Each ceremony lives in this process only. There are no durable approval tokens to import/replay. */
export async function serveCeremony<T>(input: {
  settings: RemoteSettings;
  display: Record<string, unknown>;
  options: unknown;
  signal?: AbortSignal;
  validate(): void;
  verify(body: unknown, publish: (message: string) => void): Promise<T>;
}, deps: CeremonyDeps = {}): Promise<T> {
  const transport = deps.transport ?? tailscaleTransport();
  await transport.check(input.settings);
  input.validate();
  if (input.signal?.aborted) throw new RemoteApprovalError("remote approval cancelled");
  const deadline = (input.display.expiresAt as string);
  const now = deps.now ?? Date.now;
  let closed = false, busy = false;
  let resolveResult!: (v: T) => void, rejectResult!: (err: Error) => void;
  const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // Attach immediately: a listen failure must not leave an unhandled rejection.
  void result.catch(() => {});
  const check = () => {
    if (closed || now() >= Date.parse(deadline)) throw new RemoteApprovalError("approval expired, cancelled or already consumed");
    input.validate();
  };
  const reject = (err: Error) => { closed = true; rejectResult(err); };
  const server = createServer(async (req, res) => {
    const nonce = randomBytes(16).toString("base64url");
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Permissions-Policy", "publickey-credentials-get=(self), publickey-credentials-create=(self)");
    const json = (code: number, value: unknown) => { if (!res.writableEnded) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); } };
    try {
      await authorizeHttp(req, input.settings, transport);
      check();
      await transport.check(input.settings); // Fail closed if tailnet/Serve/Funnel changed mid-ceremony.
      check();
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(remotePage(nonce)); return;
      }
      if (req.method === "GET" && req.url === "/request") { json(200, { ...input.display, options: input.options }); return; }
      if (req.method !== "POST" || !["/verify", "/deny"].includes(req.url ?? "")) { json(404, { error: "not found" }); return; }
      if (req.headers["content-type"] !== "application/json") { json(415, { error: "JSON required" }); return; }
      if (busy) { json(409, { error: "a verification is already in progress" }); return; }
      busy = true; // Claim synchronously, before reading/verifying; concurrent assertions cannot both grant.
      try {
        const body = await readBody(req);
        check();
        if (req.url === "/deny") { json(200, { message: "denied" }); reject(new RemoteApprovalError("remote approval denied")); return; }
        const value = await input.verify(body, (message) => json(202, { message }));
        await transport.check(input.settings);
        check();
        closed = true; // Consume BEFORE making the result available to the engine.
        json(200, { message: "Verified. The engine may apply this exact operation." });
        if (res.writableFinished) resolveResult(value);
        else if (res.destroyed) reject(new RemoteApprovalError("approval response disconnected"));
        else {
          res.once("finish", () => resolveResult(value));
          res.once("close", () => { if (!res.writableFinished) reject(new RemoteApprovalError("approval response disconnected")); });
        }
      } finally { busy = false; }
    } catch (err) {
      if (res.writableEnded) reject(err as Error); // Enrollment already displayed its candidate; a local refusal ends it.
      json(403, { error: "Request refused. Check the engine for details or request a fresh approval." });
      (deps.log ?? logLine)(`Remote approval refused: ${(err as Error).message}`);
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on("error", reject);
  const abort = () => reject(new RemoteApprovalError("remote approval cancelled"));
  input.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => reject(new RemoteApprovalError("remote approval expired")), Math.max(1, Date.parse(deadline) - now()));
  try {
    await new Promise<void>((resolve, fail) => { server.once("error", fail); server.listen(deps.listenPort ?? REMOTE_PORT, "127.0.0.1", () => { server.off("error", fail); resolve(); }); });
    const address = server.address();
    deps.onListen?.(typeof address === "object" && address ? address.port : REMOTE_PORT);
    (deps.log ?? logLine)(JSON.stringify({ type: "approval.pending", channel: REMOTE_CHANNEL, url: input.settings.origin, expiresAt: deadline, requestDigest: input.display.digest }));
    return await result;
  } finally {
    closed = true;
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    server.close(); server.closeAllConnections();
  }
}

async function authorizeHttp(req: IncomingMessage, settings: RemoteSettings, transport: PrivateTransport): Promise<void> {
  const host = new URL(settings.origin).host;
  // Serve overwrites these forwarding headers. Local same-user code is inside the existing host trust boundary.
  if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.host !== host || req.headers["x-forwarded-host"] !== host || req.headers["x-forwarded-proto"] !== "https" || req.headers["tailscale-funnel-request"] || req.headers["tailscale-user-login"] !== settings.owner) throw new RemoteApprovalError("private owner-authenticated HTTPS required");
  if (req.method === "POST" && req.headers.origin !== settings.origin) throw new RemoteApprovalError("wrong approval origin");
  if (req.headers.origin && req.headers.origin !== settings.origin) throw new RemoteApprovalError("cross-origin request");
  const navigation = req.method === "GET" && req.url === "/" && req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "document";
  if (!navigation && req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"]))) throw new RemoteApprovalError("cross-site request");
  const ip = req.headers["x-forwarded-for"];
  if (typeof ip !== "string" || ip.includes(",")) throw new RemoteApprovalError("ambiguous source device");
  const device = await transport.device(ip);
  if (device.owner !== settings.owner || !settings.devices.includes(device.id)) throw new RemoteApprovalError("device not authorized for approval");
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 32_768) throw new RemoteApprovalError("approval response too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function remoteApprover(store: RemoteApprovalStore, deps: CeremonyDeps = {}): Approver {
  return {
    channel: REMOTE_CHANNEL,
    async request(req) {
      const record = store.read();
      if (!req.binding || req.binding.safeguards !== true || !req.validate) throw new RemoteApprovalError("remote operation lacks an engine scope binding or mandatory safeguards");
      const binding = JSON.parse(JSON.stringify(req.binding)) as Record<string, unknown>;
      const snapshot = { purpose: req.purpose, repo: req.repo, issue: req.issue, scopeHash: req.scopeHash, reason: req.reason, details: [...req.details], binding };
      const payload = { installation: record.installation, generation: record.generation, ...snapshot,
        expiresAt: new Date((deps.now ?? Date.now)() + (deps.timeoutMs ?? REMOTE_TIMEOUT_MS)).toISOString() };
      const challenge = operationChallenge(payload, randomBytes(32).toString("base64url"));
      const options = await generateAuthenticationOptions({ rpID: rpID(record), challenge: new Uint8Array(Buffer.from(challenge, "base64url")), userVerification: "required", timeout: REMOTE_TIMEOUT_MS, allowCredentials: [{ id: record.credential.id }] });
      const validate = () => {
        if ((deps.now ?? Date.now)() >= Date.parse(payload.expiresAt) || req.signal?.aborted) throw new RemoteApprovalError("remote approval expired or cancelled");
        if (digest(store.read()) !== digest(record)) throw new RemoteApprovalError("credential or channel configuration changed; request a fresh approval");
        if (canonical({ purpose: req.purpose, repo: req.repo, issue: req.issue, scopeHash: req.scopeHash, reason: req.reason, details: req.details, binding: req.binding }) !== canonical(snapshot)) throw new RemoteApprovalError("operation changed while awaiting approval");
        req.validate!();
      };
      await serveCeremony({ settings: record, signal: req.signal,
        display: { ...payload, repo: req.repo, reason: req.reason, details: req.details, digest: digest(payload), enrollment: false }, options, validate,
        async verify(body) {
          const response = body as AuthenticationResponseJSON;
          if (response.id !== record.credential.id) throw new RemoteApprovalError("unregistered approval credential");
          requireSameOriginCeremony(response);
          const verified = await verifyAuthenticationResponse({ response, expectedChallenge: challenge, expectedOrigin: record.origin, expectedRPID: rpID(record), requireUserVerification: true,
            credential: { id: record.credential.id, publicKey: new Uint8Array(Buffer.from(record.credential.publicKey, "base64url")), counter: 0 } });
          // Synced passkeys can report zero counters. Fresh, consumed challenges supply replay protection.
          if (!verified.verified || !verified.authenticationInfo.userVerified) throw new RemoteApprovalError("passkey did not verify");
        },
      }, deps);
      validate();
      return { approved: true, channel: REMOTE_CHANNEL, at: new Date().toISOString(), user: record.owner, detail: `passkey verified for single-use operation ${digest(payload)}` };
    },
  };
}

/** Enrollment never accepts remote assertions as bootstrap authority. Local Touch ID approves the exact candidate. */
export async function enrollRemote(store: RemoteApprovalStore, settings: RemoteSettings, home: string, deps: CeremonyDeps & { local?: Approver } = {}): Promise<RemoteRegistry> {
  if (process.platform !== "darwin" && !deps.local) throw new RemoteApprovalError("initial enrollment requires macOS LocalAuthentication");
  settings = RemoteSettingsSchema.parse(settings);
  const previous = store.exists() ? digest(store.read()) : null;
  const expiresAt = new Date((deps.now ?? Date.now)() + (deps.timeoutMs ?? REMOTE_TIMEOUT_MS)).toISOString();
  const payload = { purpose: "enroll_remote_approval", settings, previous, expiresAt };
  const challenge = operationChallenge(payload, randomBytes(32).toString("base64url"));
  const options = await generateRegistrationOptions({ rpName: "Orchestrator approvals", rpID: rpID(settings), userID: randomBytes(32), userName: settings.owner, challenge: new Uint8Array(Buffer.from(challenge, "base64url")), attestationType: "none", supportedAlgorithmIDs: [-7, -257], authenticatorSelection: { residentKey: "required", userVerification: "required", authenticatorAttachment: "platform" } });
  const credential = await serveCeremony({ settings, options, signal: deps.signal,
    display: { repo: "Enroll personal approval passkey", reason: "Create the passkey on your iPhone, then compare the fingerprint and confirm on your Mac.", details: [settings.origin, `Personal tailnet: ${settings.personalTailnet}`, `Owner: ${settings.owner}`, `Authorized devices: ${settings.devices.join(", ")}`], binding: payload, expiresAt, digest: digest(payload), enrollment: true },
    validate: () => { if ((store.exists() ? digest(store.read()) : null) !== previous) throw new RemoteApprovalError("enrollment changed concurrently"); },
    async verify(body, publish) {
      requireSameOriginCeremony(body as RegistrationResponseJSON);
      const verified = await verifyRegistrationResponse({ response: body as RegistrationResponseJSON, expectedChallenge: challenge, expectedOrigin: settings.origin, expectedRPID: rpID(settings), requireUserPresence: true, requireUserVerification: true, supportedAlgorithmIDs: [-7, -257] });
      if (!verified.verified || !verified.registrationInfo.userVerified) throw new RemoteApprovalError("registration did not verify");
      const credential = { id: verified.registrationInfo.credential.id, publicKey: Buffer.from(verified.registrationInfo.credential.publicKey).toString("base64url") };
      const fingerprint = digest({ settings, credential });
      publish(`Candidate fingerprint: ${fingerprint}\nCompare this exact fingerprint with the Mac prompt. Enrollment is pending local confirmation; this page does not confirm it.`);
      const request: ApprovalRequest = { purpose: "enroll_remote_approval", repo: "orchestrator/remote-approval", issue: null, scopeHash: fingerprint,
        reason: `enroll Orchestrator passkey ${fingerprint} for ${settings.origin} on PERSONAL tailnet ${settings.personalTailnet}; owner ${settings.owner}; devices ${settings.devices.join(", ")}`,
        details: [`Candidate fingerprint: ${fingerprint}`, `Settings and public key are bound to this fingerprint.`, `Expires: ${expiresAt}`] };
      const approval = await (deps.local ?? macosApprover()).request(request);
      auditApproval(home, request, approval);
      if (!approval.approved) throw new RemoteApprovalError("local enrollment was not approved");
      return credential;
    },
  }, deps);
  if ((deps.now ?? Date.now)() >= Date.parse(expiresAt) || deps.signal?.aborted || (store.exists() ? digest(store.read()) : null) !== previous) throw new RemoteApprovalError("enrollment expired, cancelled or changed");
  return store.save(settings, credential);
}

export function configuredApprover(home: string, channel?: ApprovalChannel): Approver {
  const store = new RemoteApprovalStore(home);
  return channel === "local" || (!channel && !store.exists()) ? systemApprover() : remoteApprover(store);
}
export async function configuredApprovalStatus(home: string, channel?: ApprovalChannel): Promise<{ channel: string; available: boolean; detail: string }> {
  const store = new RemoteApprovalStore(home);
  if (channel === "local" || (!channel && !store.exists())) return approvalChannelStatus();
  try {
    const record = store.read();
    await tailscaleTransport().check(record);
    return { channel: REMOTE_CHANNEL, available: true, detail: `passkey approval via ${record.origin} on the pinned personal tailnet; --approval-channel local selects Touch ID` };
  } catch (err) { return { channel: REMOTE_CHANNEL, available: false, detail: `${(err as Error).message}; use --approval-channel local for Touch ID` }; }
}
