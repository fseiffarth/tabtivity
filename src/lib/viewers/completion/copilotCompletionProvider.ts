import { invoke } from "@tauri-apps/api/core";
import { aiIsOff } from "../../aiSwitch";
import type { RemoteSpec, Settings } from "../../../types";
import type { TranslationKey } from "../../i18n";
import { isProseLang } from "./autocomplete";
import {
  CompletionAcceptance, inlineCandidate, offsetToPosition,
  type CompletionCandidate, type CompletionDocument, type CompletionProvider, type CompletionRange,
} from "./completionProvider";

/** Credential files no consent covers, mirroring `services::copilot::policy`
 * so they stay on Ollama instead of failing against the backend's refusal. */
export function copilotSecretFile(path: string): boolean {
  const name = (path.split(/[/\\]/).pop() ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  return name === ".env" || name.startsWith(".env.") || ext === "env"
    || [".npmrc", ".netrc", ".pgpass", ".pypirc", ".git-credentials", "credentials"].includes(name)
    || ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"].some((key) => name.startsWith(key))
    || ["pem", "key", "p12", "pfx", "jks", "keystore"].includes(ext);
}

/** UI hint only; the backend also checks canonical roots and the connection. */
export function copilotRemoteConsentMatches(identity: string | undefined, remote: RemoteSpec): boolean {
  if (!identity) return false;
  try {
    const binding: unknown = JSON.parse(identity);
    return Array.isArray(binding) && binding.length === 5
      && binding[0] === remote.host && binding[1] === (remote.user ?? null)
      && binding[2] === (remote.port ?? 22) && binding[3] === remote.remote_path;
  } catch { return false; }
}

/** Copilot serves a file only when every gate agrees: the experimental flag,
 * the chosen provider, a project that opted in, and a code language —
 * or a text file (Markdown, LaTeX, plain text) when the project also opted
 * its text files in. Credential files never qualify. Anything else keeps
 * Ollama, which never leaves the machine. The backend re-checks all of it
 * (`services::copilot::policy`); this only picks the path. */
export function copilotServes(settings: Settings | null | undefined, enabled: boolean,
  projectId: string | null | undefined, remote: RemoteSpec | false, language: string, path: string): projectId is string {
  if (!enabled || !projectId || settings?.code_completion_provider !== "copilot") return false;
  if (!language || copilotSecretFile(path)) return false;
  const policy = settings.completion_project_policies?.[projectId];
  if (policy?.copilot !== true || policy.local_only === true || !!remote !== !!policy.remote) return false;
  if (remote && !copilotRemoteConsentMatches(policy.remote, remote)) return false;
  return !isProseLang(language) || policy.copilot_text === true;
}

type ServerCandidate = { id: string; insertText: string; range?: CompletionRange | null };

/** The language server owns model, length and context, so none of Ollama's
 * length modes or attached references apply. One adapter per request. */
/** Why a Copilot request failed, for the editor's status: the backend's
 *  `copilot_*` error code (an invoke rejection) mapped to a message key, with
 *  the code itself for one this table does not know yet. Null for the two
 *  that are not failures (a cancel, a document that moved on). */
export function copilotFailureReason(error: unknown): { key: TranslationKey; code?: string } | null {
  const code = /copilot_[a-z_]+/.exec(String(error))?.[0];
  if (!code) return { key: "fileViewer.copilotFailed" };
  if (code === "copilot_cancelled" || code === "copilot_stale_document") return null;
  const key = COPILOT_FAILURES[code];
  return key ? { key } : { key: "fileViewer.copilotFailedCode", code };
}

const COPILOT_FAILURES: Record<string, TranslationKey> = {
  copilot_not_signed_in: "fileViewer.copilotNotSignedIn",
  copilot_no_sign_in: "fileViewer.copilotNotSignedIn",
  copilot_sign_in_failed: "fileViewer.copilotSignInFailed",
  copilot_not_installed: "fileViewer.copilotNotInstalled",
  copilot_invalid_installation: "fileViewer.copilotBrokenInstall",
  copilot_version_mismatch: "fileViewer.copilotBrokenInstall",
  copilot_no_consent: "fileViewer.copilotNoteConsent",
  copilot_disabled: "fileViewer.copilotNoteConsent",
  copilot_remote_project: "fileViewer.copilotNoteConsent",
  copilot_code_only: "fileViewer.copilotNoteText",
  copilot_local_only: "fileViewer.copilotLocalOnly",
  copilot_secret_file: "fileViewer.copilotSecretFile",
  copilot_outside_project: "fileViewer.copilotOutsideProject",
  copilot_invalid_path: "fileViewer.copilotOutsideProject",
  copilot_invalid_project: "fileViewer.copilotOutsideProject",
  copilot_timeout: "fileViewer.copilotTimeout",
  copilot_server_error: "fileViewer.copilotServerError",
  copilot_server_closed: "fileViewer.copilotServerStopped",
  copilot_spawn_failed: "fileViewer.copilotServerStopped",
  copilot_restart_limit: "fileViewer.copilotRestartLimit",
  copilot_fence_unavailable: "fileViewer.copilotNoFence",
  copilot_unsupported_platform: "fileViewer.copilotUnsupported",
  copilot_remote_disconnected: "fileViewer.copilotRemoteDisconnected",
  copilot_document_limit: "fileViewer.copilotBusy",
  copilot_request_limit: "fileViewer.copilotBusy",
};

export class CopilotCompletionProvider implements CompletionProvider {
  readonly id = "copilot";
  readonly capabilities = { streaming: false, lengthModes: false, references: false };

  constructor(private options: {
    projectId: string; editor: string; automatic: boolean; tabSize: number; insertSpaces: boolean;
  }) {}

  async complete(document: CompletionDocument, signal: AbortSignal,
    publish: (candidates: CompletionCandidate[]) => void): Promise<CompletionCandidate[]> {
    // The AI switch (`lib/aiSwitch.ts`): no suggestion while AI is off.
    if (aiIsOff()) return [];
    const position = offsetToPosition(document.text, document.caret);
    if (!position) return [];
    const { projectId, editor, automatic, tabSize, insertSpaces } = this.options;
    let requestId: string | undefined;
    const cancel = () => {
      if (requestId) void invoke("copilot_cancel", { projectId, editor, requestId }).catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      requestId = await invoke<string>("copilot_prepare", { projectId, editor });
      if (signal.aborted) { cancel(); signal.throwIfAborted(); }
      const items = await invoke<ServerCandidate[]>("copilot_complete", {
        projectId, requestId, path: document.path, editor, version: document.version, text: document.text,
        language: document.language, position, automatic, tabSize, insertSpaces,
      });
      signal.throwIfAborted();
      const result = items.flatMap((item) => {
        const candidate = inlineCandidate(document,
          { insertText: item.insertText, range: item.range ?? undefined }, item.id);
        return candidate ? [{ ...candidate, model: this.id }] : [];
      });
      publish(result);
      return result;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
}

/** Shown once, partial acceptance cumulatively, full acceptance once — for the
 * candidate currently ghosted in one editor. Ollama candidates are ignored. */
export class CopilotFeedback {
  private current: { id: string; acceptance: CompletionAcceptance } | null = null;

  constructor(private projectId: string, private editor: string) {}

  show(candidate: CompletionCandidate | undefined) {
    if (candidate?.provider !== "copilot") { this.current = null; return; }
    if (this.current?.id === candidate.id) return;
    this.current = { id: candidate.id, acceptance: new CompletionAcceptance(candidate) };
    this.send("copilot_shown", { candidate: candidate.id });
  }

  /** `text` is what just entered the document from the front of the ghost. */
  accept(text: string) {
    if (!this.current) return;
    const step = this.current.acceptance.accept(text);
    if (!step) { this.current = null; return; }
    this.send("copilot_accepted", {
      candidate: this.current.id, acceptedLength: step.full ? undefined : step.acceptedLength,
    });
    if (step.full) this.current = null;
  }

  close() {
    this.current = null;
    this.send("copilot_close_editor", {});
  }

  private send(command: string, payload: Record<string, unknown>) {
    void invoke(command, { projectId: this.projectId, editor: this.editor, ...payload }).catch(() => {});
  }
}
