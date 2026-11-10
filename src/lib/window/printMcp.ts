/**
 * The typed invoke surface for agent print requests (`services::print_mcp`,
 * `commands/print_mcp.rs`): an agent tab asks to print a PDF of its project,
 * and nothing prints until the user approves it in the print preview
 * (`lib/viewers/printRequest.ts`). Like `printing.ts`, no wrapper takes a
 * path: a request is named by its id, and its PDF is the snapshot the backend
 * took at the agent's call.
 */

import { invoke } from "@tauri-apps/api/core";

/** `services::print_mcp::CHANGED_EVENT`. */
export const PRINT_MCP_CHANGED = "print-mcp-changed";

/** The layout the agent asked for (`services::print_mcp::Options`). */
export interface PrintRequestOptions {
  copies: number;
  /** A custom page range ("1-3, 5"); absent = every page. */
  pages?: string;
  grayscale: boolean;
  /** `none` / `long` / `short`; absent leaves the user's own setting. */
  duplex?: "none" | "long" | "short";
  pagesPerSheet?: number;
  booklet: boolean;
}

/** A pending request (`services::print_mcp::RequestView`). */
export interface PrintRequest {
  id: string;
  /** The PTY id of the agent tab that asked (`<scope>:<key>`). */
  tab: string;
  projectId: string;
  /** Project-relative path of the PDF. */
  file: string;
  size: number;
  sha256: string;
  options: PrintRequestOptions;
  note?: string;
  createdAt: string;
  state: string;
}

/** The pending requests, oldest first. Resolves `[]` on a backend without the
 *  command (an older build) rather than rejecting. */
export async function printRequests(): Promise<PrintRequest[]> {
  try {
    return (await invoke<PrintRequest[] | null>("print_mcp_requests")) ?? [];
  } catch {
    return [];
  }
}

/** The request's PDF snapshot. Rejects with `gone` once it ended. */
export async function printRequestPdf(id: string): Promise<Uint8Array> {
  const out = await invoke<ArrayBuffer | number[]>("print_mcp_pdf", { id });
  return out instanceof ArrayBuffer ? new Uint8Array(out) : Uint8Array.from(out);
}

/** Record the user's decision. Rejects with `gone` when it is no longer
 *  pending (withdrawn, expired, its tab closed). */
export function decidePrintRequest(id: string, outcome: "printed" | "rejected"): Promise<void> {
  return invoke("print_mcp_decide", { id, outcome });
}
