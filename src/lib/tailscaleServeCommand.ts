import { invoke } from "@tauri-apps/api/core";

/** The line the guides show: what the user would type themselves. */
export function tailscaleServeLine(port: number): string {
  return `tailscale serve --bg http://127.0.0.1:${port}`;
}

/**
 * The line the "Set up in terminal" buttons run (2442s): the backend's, which
 * names the Tailscale CLI this machine actually has — on a Mac the one inside
 * `Tailscale.app`, which is on no PATH — quoted for the terminal's shell. A
 * backend that cannot answer (an older build) gets the plain line.
 */
export async function tailscaleServeCommand(port: number): Promise<string> {
  try {
    const line = await invoke<string>("mobile_tailscale_serve_command", { port });
    if (typeof line === "string" && line.includes(" serve --bg ")) return line;
  } catch {
    // Fall through to the plain line.
  }
  return tailscaleServeLine(port);
}
