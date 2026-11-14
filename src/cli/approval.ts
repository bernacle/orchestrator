import type { Command } from "commander";
import { resolvePaths } from "../config/load.js";
import { configuredApprovalStatus, enrollRemote } from "../core/remote-approval.js";
import { RemoteApprovalStore, RemoteSettingsSchema } from "../core/remote-config.js";
import { output, printJson } from "./common.js";

/** These commands never configure Tailscale. Enrollment is an explicit, local operator ceremony. */
export function registerApprovalCommands(program: Command): void {
  const approval = program.command("approval").description("Optional personal-tailnet passkey approval (no public service; local Touch ID remains available)");
  approval.command("status").description("Read-only: inspect the selected approval channel; never enables access")
    .option("--json", "versioned JSON")
    .action(async (opts: { json?: boolean }) => {
      output.json = !!opts.json;
      const status = await configuredApprovalStatus(resolvePaths().home, output.approvalChannel);
      if (opts.json) printJson("approval_status", status);
      else console.log(`${status.channel}: ${status.available ? "available" : "unavailable"}\n${status.detail}`);
    });
  approval.command("enroll").description("Create an iPhone passkey at a preconfigured personal HTTPS origin, then authorize its exact fingerprint with local Touch ID. Does not configure or switch Tailscale")
    .requiredOption("--origin <https-origin>", "dedicated HTTPS origin on your personal tailnet")
    .requiredOption("--personal-tailnet <name>", "exact personal tailnet name from tailscale status (never a work tailnet)")
    .requiredOption("--server-node <stable-id>", "Mac stable node ID from tailscale status")
    .requiredOption("--owner <login>", "exact Tailscale owner login")
    .requiredOption("--device <stable-id>", "authorized personal device stable ID (repeatable)", (v: string, a: string[]) => [...a, v], [] as string[])
    .action(async (opts: { origin: string; personalTailnet: string; serverNode: string; owner: string; device: string[] }) => {
      const home = resolvePaths().home;
      const settings = RemoteSettingsSchema.parse({ origin: opts.origin, personalTailnet: opts.personalTailnet, serverNodeId: opts.serverNode, owner: opts.owner, devices: opts.device });
      const controller = new AbortController();
      // The enrollment command still expires if interrupted/disconnected; SIGINT exits without a saved key.
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      try {
        const record = await enrollRemote(new RemoteApprovalStore(home), settings, home, { signal: controller.signal });
        console.log(`Enrolled passkey for ${record.origin}. Remote approvals require this passkey and an authorized device. --approval-channel local selects Touch ID.`);
      } finally { process.off("SIGINT", stop); }
    });
  approval.command("disable").description("Revoke remote approval credentials and pending requests. Does not change Tailscale; needs no approval")
    .action(() => { new RemoteApprovalStore(resolvePaths().home).remove(); console.log("Remote approval revoked. Tailscale configuration was not changed. Local Touch ID is available."); });
}
