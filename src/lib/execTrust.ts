import { invoke } from "@tauri-apps/api/core";
import { translate, useI18nStore } from "./i18n";
import { useExecTrustStore } from "../stores/execTrust";
import { NAMES } from "./brand";

/**
 * Frontend half of `services::exec_trust`: a gated backend command (commit,
 * push, publish, TeX build, format) fails with `tabtivity-trust-required:<json>`
 * when it would run project-supplied code the user has not approved in its
 * current form. {@link withExecTrust} shows that request, records the approval
 * and re-runs the action; a decline surfaces as an ordinary error.
 */

export type TrustKind = "git_hooks" | "latexmkrc" | "prettier";

export interface TrustItem {
  label: string;
  preview: string;
  truncated: boolean;
}

export interface TrustRequest {
  kind: TrustKind;
  dir: string;
  fingerprint: string;
  /** An approval existed and the files changed since. */
  changed: boolean;
  items: TrustItem[];
}

const PREFIX = NAMES.trustRequiredPrefix;

export function parseTrustRequest(err: unknown): TrustRequest | null {
  const text = typeof err === "string" ? err : err instanceof Error ? err.message : null;
  if (!text || !text.startsWith(PREFIX)) return null;
  try {
    const parsed = JSON.parse(text.slice(PREFIX.length)) as TrustRequest;
    return parsed && typeof parsed.fingerprint === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Thrown when the user declines; its message is the localized "not run" note. */
export class ExecTrustDeclinedError extends Error {
  constructor(readonly kind: TrustKind) {
    super(translate(useI18nStore.getState().lang, "execTrust.declined"));
    this.name = "ExecTrustDeclinedError";
  }

  // Callers render errors with `String(e)`; show the note, not "Name: note".
  override toString(): string {
    return this.message;
  }
}

/** Run `action`; if a gate asks, show the request, approve, and run it again. */
export async function withExecTrust<T>(action: () => Promise<T>): Promise<T> {
  // One action can pass more than one gate, and a file can change between the
  // prompt and the approval — a few rounds, never an endless loop.
  for (let round = 0; ; round++) {
    try {
      return await action();
    } catch (err) {
      const request = parseTrustRequest(err);
      if (!request || round >= 3) throw err;
      const approved = await useExecTrustStore.getState().ask(request);
      if (!approved) throw new ExecTrustDeclinedError(request.kind);
      await invoke("exec_trust_approve", {
        kind: request.kind,
        dir: request.dir,
        fingerprint: request.fingerprint,
      });
    }
  }
}

/** `invoke` for a gated command. */
export function invokeTrusted<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return withExecTrust(() => invoke<T>(cmd, args));
}
