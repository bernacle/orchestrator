import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isIP } from "node:net";
import { z } from "zod";
import { canonical } from "./approval.js";
import { runProcess } from "./exec.js";
import { systemTrustKeys, type TrustKeyStore } from "./trust.js";

export const REMOTE_PORT = 47832;
const base64url = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/);
export const RemoteSettingsSchema = z.object({
  origin: z.string().refine((s) => {
    try {
      const u = new URL(s);
      return u.origin === s && u.protocol === "https:" && !u.port && /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(u.hostname);
    } catch { return false; }
  }, "expected an exact https://device.personal-tailnet.ts.net origin (no path or port)"),
  personalTailnet: z.string().min(1),
  owner: z.string().min(1).regex(/^[\x21-\x7e]+$/),
  devices: z.array(z.string().regex(/^n[A-Za-z0-9]+$/)).min(1),
  serverNodeId: z.string().regex(/^n[A-Za-z0-9]+$/),
}).strict();
export type RemoteSettings = z.infer<typeof RemoteSettingsSchema>;
const RegistrySchema = RemoteSettingsSchema.extend({
  version: z.literal(1), installation: base64url, generation: base64url,
  credential: z.object({ id: base64url, publicKey: base64url }).strict(),
  enrolledAt: z.string().datetime(), seal: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type RemoteRegistry = z.infer<typeof RegistrySchema>;
export class RemoteApprovalError extends Error { override name = "RemoteApprovalError"; }
export const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

/** Public keys/settings only. Same trusted-engine/HMAC boundary as repository trust, not host compromise protection. */
export class RemoteApprovalStore {
  readonly file: string;
  private readonly keyAccount: string;
  constructor(home: string, private readonly keys: TrustKeyStore = systemTrustKeys({ home })) {
    this.file = join(home, "credentials", "remote-approval.json");
    this.keyAccount = `@remote-approval:${digest(resolve(home))}`; // Separate installations; not an owner/name repository.
  }
  exists(): boolean { return existsSync(this.file); }
  read(): RemoteRegistry {
    if (!this.exists()) throw new RemoteApprovalError("remote approval is not enrolled; use local Touch ID, then enroll on your personal tailnet");
    const parsed = RegistrySchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
    if (!parsed.success) throw new RemoteApprovalError("invalid remote approval registry; local enrollment is required");
    const { seal, ...record } = parsed.data;
    const key = this.keys.get(this.keyAccount);
    if (!key || !/^[0-9a-f]{64}$/.test(key)) throw new RemoteApprovalError("remote approval seal key is missing or revoked");
    const expected = createHmac("sha256", Buffer.from(key, "hex")).update(canonical(record)).digest();
    if (!timingSafeEqual(expected, Buffer.from(seal, "hex"))) throw new RemoteApprovalError("remote approval registry seal does not verify");
    return parsed.data;
  }
  save(settings: RemoteSettings, credential: RemoteRegistry["credential"]): RemoteRegistry {
    const record = { ...RemoteSettingsSchema.parse(settings), version: 1 as const, installation: randomBytes(32).toString("base64url"), generation: randomBytes(16).toString("base64url"), credential, enrolledAt: new Date().toISOString() };
    const key = randomBytes(32).toString("hex");
    const sealed = RegistrySchema.parse({ ...record, seal: createHmac("sha256", Buffer.from(key, "hex")).update(canonical(record)).digest("hex") });
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    this.keys.set(this.keyAccount, key); // Rotate: restoring any earlier registry fails closed.
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(sealed, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
    return sealed;
  }
  remove(): void { this.keys.delete(this.keyAccount); rmSync(this.file, { force: true }); }
}

export interface PrivateTransport {
  check(settings: RemoteSettings): Promise<void>;
  device(ip: string): Promise<{ id: string; owner: string }>;
}
export type TransportExec = (args: string[]) => Promise<unknown>;
const realExec: TransportExec = async (args) => {
  const r = await runProcess("tailscale", args, { timeoutMs: 10_000 });
  if (r.exitCode !== 0) throw new RemoteApprovalError("Tailscale read-only inspection failed; configure the personal tailnet separately");
  return JSON.parse(r.stdout);
};

/** No login, switch, serve, funnel, policy, or other mutation is ever issued by this module. */
export function tailscaleTransport(exec: TransportExec = realExec): PrivateTransport {
  return {
    async check(settings) {
      const status = await exec(["status", "--json"]) as { Version?: string; BackendState?: string; CurrentTailnet?: { Name?: string }; Self?: { ID?: string; DNSName?: string }; CertDomains?: string[] };
      const version = status.Version?.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
      // The Serve forwarding-header behavior is verified against upstream v1.102.2.
      if (!version || version[0]! < 1 || (version[0] === 1 && (version[1]! < 102 || (version[1] === 102 && version[2]! < 2)))) throw new RemoteApprovalError("remote approval requires Tailscale 1.102.2 or newer; no network configuration was changed");
      const hostname = new URL(settings.origin).hostname;
      if (status.BackendState !== "Running" || status.CurrentTailnet?.Name !== settings.personalTailnet || status.Self?.ID !== settings.serverNodeId || status.Self?.DNSName?.replace(/\.$/, "") !== hostname || !status.CertDomains?.includes(hostname)) {
        throw new RemoteApprovalError("personal tailnet, server identity or verified HTTPS hostname does not match enrollment; existing Tailscale configuration was not changed");
      }
      const serve = await exec(["serve", "status", "--json"]) as { TCP?: Record<string, { HTTPS?: boolean }>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>; Foreground?: unknown };
      const hasFunnel = (v: unknown): boolean => !!v && typeof v === "object" && Object.entries(v).some(([k, b]) => k === "AllowFunnel" ? !!b && typeof b === "object" && Object.values(b).some(Boolean) : hasFunnel(b));
      const host = `${hostname}:443`;
      const expectedTCP = { "443": { HTTPS: true } };
      const expectedWeb = { [host]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${REMOTE_PORT}` } } } };
      // An extra raw TCP forward could tunnel attacker-supplied proxy headers to this listener.
      const allowedKeys = ["TCP", "Web", "AllowFunnel", "Foreground"];
      if (Object.keys(serve).some((k) => !allowedKeys.includes(k)) || hasFunnel(serve) || (serve.Foreground && Object.keys(serve.Foreground).length) || canonical(serve.TCP) !== canonical(expectedTCP) || canonical(serve.Web) !== canonical(expectedWeb)) {
        throw new RemoteApprovalError("remote approval requires private HTTPS Serve at / to loopback, an exclusive origin, and Funnel disabled; configure it separately");
      }
    },
    async device(ip) {
      if (!isIP(ip)) throw new RemoteApprovalError("missing verified source address");
      const who = await exec(["whois", "--json", ip]) as { Node?: { StableID?: string; Tags?: string[] }; UserProfile?: { LoginName?: string } };
      if (!who.Node?.StableID || who.Node.Tags?.length || !who.UserProfile?.LoginName) throw new RemoteApprovalError("unidentified or tagged remote device");
      return { id: who.Node.StableID, owner: who.UserProfile.LoginName };
    },
  };
}
