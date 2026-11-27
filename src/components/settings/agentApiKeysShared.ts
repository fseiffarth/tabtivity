/**
 * What Manage CLIs → API keys shares between its rows: the status payload of
 * `agent_api_keys_status` (`services::agent_api_keys`) and the limit and token
 * formatting. Split out so the custom-endpoint rows (`AgentCustomEndpointsRows`)
 * and the provider rows (`AgentApiKeysRows`) do not import each other.
 */
import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "../../types";

/** One model's month on a provider, input and output apart. */
export interface ApiModelUsage {
  model: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  requests: number;
  billed: number;
  usd: number;
}

/** A custom OpenAI-compatible endpoint's facts (`ProviderStatus.endpoint`).
 *  Never the key. */
export interface ApiEndpointStatus {
  /** The slot `1..=8`: the provider id is `custom-<slot>`. */
  slot: number;
  label: string;
  baseUrl: string;
  /** The base URL's host (and port). */
  host: string;
  /** Model ids the endpoint listed when it was added or last refreshed. */
  modelCount: number;
}

export interface ApiProviderStatus {
  id: string;
  saved: boolean;
  /** The monthly limit in billed tokens (`agent_api_token_limits`) as the
   *  backend reads it. */
  limitTokens?: number | null;
  /** Billed tokens this month: what the limit counts. */
  billed?: number;
  /** Their cost by the price table — an estimate, shown only. */
  spentUsd?: number;
  /** False for a custom endpoint: it has no price table ("no price"). */
  priced?: boolean;
  /** Present only for a custom endpoint (`custom-<n>`). */
  endpoint?: ApiEndpointStatus;
  /** An older build's dollar limit while no token limit is set: a hint. */
  legacyLimitUsd?: number | null;
  /** `open`, `reached`, or `noLimit` (refused until a limit is set). */
  budget?: "open" | "reached" | "noLimit";
  /** Models priced at the provider's highest rate (not in the table). */
  unknownModels?: string[];
  /** This month by model, most billed first: input and output apart. */
  models?: ApiModelUsage[];
  /** The workspace a saved Anthropic key that is not scoped to one names. */
  workspace?: string | null;
}

/** `agent_api_keys_status` (`services::agent_api_keys`). Never a key. */
export interface AgentApiKeyStatus {
  /** The keyring can be read now; while locked every `saved` reads false. */
  readable: boolean;
  /** `keychain` (a desktop's OS store) or `vault` (a server's sealed store,
   *  opened only by a paired device — nothing here can unlock it). */
  store?: "keychain" | "vault";
  providers: ApiProviderStatus[];
  clis: {
    id: string;
    enabled: boolean;
    /** The providers the CLI can take a key for: the built-ins and, for
     *  OpenCode, a `custom-<n>` id per configured custom endpoint. */
    providers: string[];
    ready: boolean;
    /** A hosted server's administrator offers this user a key for the CLI. */
    adminOffered?: boolean;
    /** This user runs the CLI on the administrator's key. */
    usesAdmin?: boolean;
    /** Through the server's key broker: this month's use and budget. */
    adminBroker?: { month: string; billed: number; budget?: number | null } | null;
  }[];
  /** UTC month counted (`YYYY-MM`) and the day the count restarts. */
  month?: string;
  resetsOn?: string;
  /** This month's count restarted: the ledger file could not be read. */
  ledgerRestarted?: string | null;
  /** When the price table was read off the vendors' pages. */
  pricesDate?: string;
}

/** The monthly limit a new key's row proposes, in million billed tokens. */
export const DEFAULT_API_LIMIT_MTOK = 5;
/** The backend's `api_usage::MAX_LIMIT`, billed tokens. */
const MAX_API_LIMIT_TOKENS = 1_000_000_000_000;
const MILLION = 1_000_000;

/** A typed limit (million billed tokens) as whole billed tokens, or `null`
 *  when it is not a usable one. */
export function parseApiLimit(text: string): number | null {
  const n = Number(text.trim());
  if (text.trim() === "" || !Number.isFinite(n)) return null;
  const tokens = Math.round(n * MILLION);
  return tokens > 0 && tokens <= MAX_API_LIMIT_TOKENS ? tokens : null;
}

/** Billed tokens as the limit field shows them: millions, no trailing zeros. */
export const asMillions = (tokens: number) => String(Number((tokens / MILLION).toFixed(6)));

export const usd = (n: number) => `$${n.toFixed(2)}`;
export const tokenCount = (n: number) =>
  new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);

/** Provider names as their vendors spell them. */
const API_KEY_PROVIDERS: Record<string, string> = {
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  openai: "OpenAI",
};

/** A provider id as the rows name it: a vendor's spelling, a custom
 *  endpoint's own label (never the raw `custom-<n>`), else the id. */
export function apiProviderName(id: string, providers: ApiProviderStatus[]): string {
  return API_KEY_PROVIDERS[id] ?? providers.find((p) => p.id === id)?.endpoint?.label ?? id;
}

/** The limits a limit write starts from. A patch replaces the whole
 *  `agent_api_token_limits` map, and the window's cached copy does not know
 *  the limit `agent_api_custom_endpoint_add` wrote in the backend after the
 *  settings were loaded: spreading the cache would erase it, and that
 *  endpoint would then be refused for having no limit. So read the file's
 *  map; the cache only when it cannot be read. */
export async function currentApiLimits(cached: Record<string, number> | undefined): Promise<Record<string, number>> {
  try {
    const fresh = await invoke<Settings | null>("get_settings");
    if (fresh && typeof fresh === "object") return fresh.agent_api_token_limits ?? {};
  } catch {
    // Unreadable now: the cached map is the best there is.
  }
  return cached ?? {};
}
