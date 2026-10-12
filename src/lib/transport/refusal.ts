/**
 * A command the browser client cannot run here, as one sentence in the
 * user's language (final review B5). The server answers a refused call with
 * `{code, reason?, feature?, model?}` (`core_dispatch::Refusal`, the model
 * allowlist), and the transport refuses `client`/`off` commands itself with
 * the same shape; nothing turned those into text, so a refused save looked
 * done and a caller printing the error showed `[object Object]`.
 *
 * `asRefusal` is applied to every rejection the transport passes on: a known
 * refusal becomes a {@link RefusalError} — an `Error` whose `message` (and
 * `String(error)`) is the sentence, which keeps its wire fields for callers
 * that branch on `code`. Anything else (a command's own error) is untouched.
 */
import { translate, useI18nStore, type TranslationKey } from "../i18n";

/** The wire shape of a refusal. */
export interface Refusal {
  code: string;
  command?: string;
  reason?: string;
  feature?: string;
  model?: string;
}

const CODE_KEYS: Record<string, TranslationKey> = {
  client: "transport.refusal.client",
  admin: "transport.refusal.admin",
  unknown: "transport.refusal.unknown",
  unsupported: "transport.refusal.unsupported",
  "feature-off": "transport.refusal.featureOff",
  "model-not-allowed": "transport.refusal.modelNotAllowed",
  "ollama-unreachable": "transport.refusal.ollamaUnreachable",
  off: "transport.refusal.off",
};

const OFF_KEYS: Record<string, TranslationKey> = {
  "whole-document-save": "transport.refusal.off.wholeDocumentSave",
  "os-keychain": "transport.refusal.off.osKeychain",
  "headless-owner": "transport.refusal.off.headlessOwner",
  "local-cli-files": "transport.refusal.off.localCliFiles",
};

/** Whether `value` is a refusal this module can put into words. */
export function isRefusal(value: unknown): value is Refusal {
  return (
    typeof value === "object" &&
    value !== null &&
    !(value instanceof Error) &&
    typeof (value as { code?: unknown }).code === "string" &&
    (value as { code: string }).code in CODE_KEYS
  );
}

/** The sentence for `refusal`, in the current language. */
export function refusalText(refusal: Refusal): string {
  const lang = useI18nStore.getState().lang;
  const key = (refusal.code === "off" && refusal.reason && OFF_KEYS[refusal.reason]) || CODE_KEYS[refusal.code];
  return translate(lang, key, { model: refusal.model ?? "" });
}

/** A refused call, as an `Error` that reads as its sentence. */
export class RefusalError extends Error {
  readonly code: string;
  readonly command?: string;
  readonly reason?: string;
  readonly feature?: string;
  readonly model?: string;

  constructor(refusal: Refusal) {
    super(refusalText(refusal));
    this.name = "RefusalError";
    this.code = refusal.code;
    this.command = refusal.command;
    this.reason = refusal.reason;
    this.feature = refusal.feature;
    this.model = refusal.model;
  }

  override toString(): string {
    return this.message;
  }
}

/** A refusal as a {@link RefusalError}; anything else unchanged. */
export function asRefusal(error: unknown, command?: string): unknown {
  if (!isRefusal(error)) return error;
  return new RefusalError({ ...error, command: error.command ?? command });
}
