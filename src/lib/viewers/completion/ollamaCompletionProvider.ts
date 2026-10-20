import { invoke } from "@tauri-apps/api/core";
import { aiIsOff } from "../../aiSwitch";
import { listen } from "@tauri-apps/api/event";
import type { AutocompleteMode } from "../../../types";
import { CompletionCache, completionModels, completionModelOrder, completionWindow, pickCompletionModel } from "./autocomplete";
import type { CompletionReference } from "./completionContext";
import { offsetToPosition, type CompletionCandidate, type CompletionDocument, type CompletionProvider } from "./completionProvider";

/** Ollama keeps its bounded context and stream/cache behavior behind the same
 * candidate interface as language-server providers. One adapter per editor. */
export class OllamaCompletionProvider implements CompletionProvider {
  readonly id = "ollama";
  readonly capabilities = { streaming: true, lengthModes: true, references: true };
  private cache = new CompletionCache();

  constructor(private options: {
    endpoint: string;
    scope?: string;
    preferred?: string;
    preferredProse?: string;
    mode: AutocompleteMode;
    candidate: number;
    context: (signal: AbortSignal) => Promise<CompletionReference[]>;
  }, cache?: CompletionCache) {
    if (cache) this.cache = cache;
  }

  async complete(document: CompletionDocument, signal: AbortSignal,
    publish: (candidates: CompletionCandidate[]) => void): Promise<CompletionCandidate[]> {
    // The AI switch (`lib/aiSwitch.ts`): no suggestion while AI is off.
    if (aiIsOff()) return [];
    let requestId: string | undefined;
    let unlisten: (() => void) | undefined;
    const cancel = () => {
      if (requestId) void invoke("cancel_text_completion", { requestId }).catch(() => {});
      unlisten?.();
      unlisten = undefined;
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      const detailed = await completionModels(this.options.endpoint, () => invoke("list_ollama_models_detailed"));
      signal.throwIfAborted();
      const loaded = detailed.filter((m) => m.running && (!m.capabilities?.length || m.capabilities.includes("completion")));
      const model = pickCompletionModel(loaded, completionModelOrder(document.language, this.options.preferred, this.options.preferredProse));
      if (!model) throw new Error("not_running");
      const context = await this.options.context(signal);
      signal.throwIfAborted();
      const { prefix, suffix } = completionWindow(document.text, document.caret);
      const { mode, candidate } = this.options;
      const key = JSON.stringify([this.id, document.path, this.options.scope, this.options.endpoint,
        prefix, suffix, model, document.language, mode, context, candidate]);
      const position = offsetToPosition(document.text, document.caret);
      if (!position) return [];
      const candidates = (text: string): CompletionCandidate[] => text ? [{
        provider: this.id, id: requestId ?? key, version: document.version, text, at: document.caret,
        range: { start: position, end: position }, model: model.name, mode, acceptedPrefix: 0,
      }] : [];
      const cached = this.cache.get(key);
      if (cached !== undefined) {
        const result = candidates(cached);
        publish(result);
        return result;
      }
      requestId = await invoke<string>("prepare_text_completion");
      if (signal.aborted) { cancel(); signal.throwIfAborted(); }
      unlisten = await listen<string>(`text-completion-${requestId}`, (event) => {
        if (!signal.aborted) publish(candidates(event.payload));
      });
      signal.throwIfAborted();
      const text = await invoke<string>("complete_text", {
        prefix, suffix, model: model.name, language: document.language === "plain" ? "" : document.language,
        mode, candidate, insert: model.capabilities?.includes("insert") === true,
        requestId, context: context.length ? context : undefined,
        projectId: document.projectId ?? this.options.scope,
      });
      signal.throwIfAborted();
      this.cache.set(key, text);
      const result = candidates(text);
      publish(result);
      return result;
    } finally {
      cancel();
      signal.removeEventListener("abort", cancel);
    }
  }
}
