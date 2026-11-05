/**
 * The local servers a terminal tab printed: JupyterLab's `http://localhost:8888/lab?token=…`,
 * Vite's `Local: http://localhost:5173/`, TensorBoard's `at http://localhost:6006/`.
 *
 * Detection is from the tab's own screen and nothing else (`docs/localhost_viewer_plan.md`,
 * rule 1): Tabtivity never probes a port. A URL is a server only when its host is
 * the machine itself (loopback, or `0.0.0.0`/`::` which a server prints for "every
 * address") or a bare single-label name (a cluster node, `node042`), and it names a
 * port. An agent CLI's OAuth `localhost` callback is a sign-in link, never a server.
 *
 * Pure: the screen is read through `getLine`, like `terminalUrls`.
 */
import type { LineLike } from "./terminalSelection";
import { findWrappedUrls, isSignInUrl } from "./terminalUrls";

/** What a server says it is — a display label only; nothing branches on it. */
export type ServerKind = "jupyter" | "tensorboard" | "vite" | "streamlit" | "gradio" | "generic";

/** A server URL taken apart. `host` is what the remote end of a forward is:
 *  loopback hosts stay as printed (`localhost`, `127.0.0.1`, `::1`), `0.0.0.0` and
 *  `::` become `127.0.0.1`, and a node name is lower-case as printed. */
export interface ServerTarget {
  scheme: "http" | "https";
  host: string;
  port: number;
  /** Path, query and fragment — the part appended to `http://127.0.0.1:<local>`. */
  pathAndQuery: string;
}

export interface ServerUrl extends ServerTarget {
  /** The URL as printed (the clicked and copied text). */
  url: string;
  kind: ServerKind;
  /** Row (0-based buffer line) the URL ended on, for "newest first" and the stopped check. */
  row: number;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const ANY_HOSTS = new Set(["0.0.0.0", "::"]);

/** Whether a [`ServerTarget`] host (already normalised) is the loopback itself,
 *  not a node name that merely starts like one (`localhost-gpu`). */
export function isLoopbackServerHost(host: string): boolean {
  return /^(?:localhost|::1|127(?:\.\d{1,3}){3})$/u.test(host);
}

/** Whether `hostname` (as `URL.hostname` spells it, IPv6 bracketed) is this machine itself. */
function loopbackHost(hostname: string): string | null {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (ANY_HOSTS.has(host)) return "127.0.0.1";
  if (LOOPBACK_HOSTS.has(host)) return host;
  // 127.0.0.0/8 is all loopback.
  if (/^127(?:\.\d{1,3}){3}$/u.test(host)) return host;
  return null;
}

/** A bare single-label host name: a cluster node, no dot, not an address. */
function bareName(hostname: string): string | null {
  const host = hostname.toLowerCase();
  return /^[a-z][a-z0-9_-]*$/u.test(host) ? host : null;
}

function defaultPort(scheme: string): number {
  return scheme === "https:" ? 443 : 80;
}

/**
 * `url` as a server, or null. Loopback and `0.0.0.0`/`::` hosts are servers with or
 * without a printed port (default 80/443, for link routing); a bare node name needs
 * an explicit port to count (`http://intranet/` is an ordinary link). With
 * `requirePort` an unnamed port is null for every host — what the chip needs.
 */
export function parseServerTarget(url: string, requirePort = false): ServerTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  const printedPort = parsed.port !== "";
  if (requirePort && !printedPort) return null;
  const loopback = loopbackHost(parsed.hostname);
  const host = loopback ?? (printedPort ? bareName(parsed.hostname) : null);
  if (!host) return null;
  const port = printedPort ? Number(parsed.port) : defaultPort(parsed.protocol);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    scheme: parsed.protocol === "https:" ? "https" : "http",
    host,
    port,
    pathAndQuery: `${parsed.pathname}${parsed.search}${parsed.hash}`,
  };
}

/** Rows above a URL read for what printed it ("Jupyter Server … is running at:", "VITE v5"). */
const CONTEXT_ROWS = 5;

/** The kind of server, from the URL's own rows and the few above them. Display only. */
export function serverKind(target: ServerTarget, own: string, above: string): ServerKind {
  const near = `${above}\n${own}`;
  if (/tensorboard/iu.test(own)) return "tensorboard";
  if (/jupyter/iu.test(near) || /^\/(?:lab|tree|notebooks?)(?:\/|$)/u.test(target.pathAndQuery) ||
      /[?&]token=/u.test(target.pathAndQuery)) return "jupyter";
  if (/running on local url/iu.test(own)) return "gradio";
  if (/\blocal url:/iu.test(own)) return "streamlit";
  if (/\blocal:/iu.test(own) && /\bvite\b/iu.test(near)) return "vite";
  return "generic";
}

/** A row that ends in a shell prompt character, or says the program was stopped. */
const STOPPED_ROW = /\^C|KeyboardInterrupt|shutting down|server (?:is )?(?:stopped|shut down)|\bTerminated\b|\bKilled\b|[$#%❯➜]$/iu;

/**
 * The servers shown on rows `[fromY, toY]`, newest last, one per port: a later
 * URL for the same port replaces an earlier one (Jupyter prints `localhost` and
 * `127.0.0.1` for one server), and a server whose output ends in a stop message or
 * a shell prompt on a row below its URL is dropped — the program is over.
 */
export function findServerUrls(
  getLine: (y: number) => LineLike | undefined,
  cols: number,
  fromY: number,
  toY: number,
): ServerUrl[] {
  const text = (y: number) => getLine(y)?.translateToString(true) ?? "";
  const byPort = new Map<number, ServerUrl>();
  for (const found of findWrappedUrls(getLine, cols, fromY, toY, true)) {
    if (isSignInUrl(found.url)) continue;
    const target = parseServerTarget(found.url, true);
    if (!target) continue;
    let own = "";
    for (let y = found.start.y; y <= found.end.y; y++) own += ` ${text(y)}`;
    let above = "";
    for (let y = Math.max(0, found.start.y - CONTEXT_ROWS); y < found.start.y; y++) above += `\n${text(y)}`;
    const server: ServerUrl = { ...target, url: found.url, kind: serverKind(target, own, above), row: found.end.y };
    // Re-insert so the Map's order is newest last.
    byPort.delete(target.port);
    byPort.set(target.port, server);
  }
  return [...byPort.values()].filter((server) => {
    for (let y = server.row + 1; y <= toY; y++) {
      if (STOPPED_ROW.test(text(y).trimEnd())) return false;
    }
    return true;
  });
}

/** The page address of a forwarded server: always the loopback's numeric
 *  address, not `localhost` (Jupyter's and Vite's host checks accept it, and it
 *  sidesteps `::1` against `127.0.0.1`). */
export function forwardedUrl(target: Pick<ServerTarget, "scheme" | "pathAndQuery">, localPort: number): string {
  return `${target.scheme}://127.0.0.1:${localPort}${target.pathAndQuery}`;
}

/** The page address of a server running on this machine (a local tab's chip): the
 *  printed URL, with `0.0.0.0` and `::` already read as the loopback. */
export function localPageUrl(target: ServerTarget): string {
  const host = target.host.includes(":") ? `[${target.host}]` : target.host;
  return `${target.scheme}://${host}:${target.port}${target.pathAndQuery}`;
}
