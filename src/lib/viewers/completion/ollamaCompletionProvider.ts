import { invoke } from "@tauri-apps/api/core";
import { aiIsOff } from "../../aiSwitch";
import { listen } from "@tauri-apps/api/event";
import type { AutocompleteMode } from "../../../types";
import { CompletionCache, completionModels, completionModelOrder, completionWindow, pickCompletionModel, type CompletionModel } from "./autocomplete";
import { referenceBudget, referenceSetId, trimReferences, type CompletionReference } from "./completionContext";
import {
  offsetToPosition, type CompletionCandidate, type CompletionDocument, type CompletionProvider, type CompletionStats,
} from "./completionProvider";

/** Ollama keeps its bounded context and stream/cache behavior behind the same
 * candidate interface as language-server providers. One adapter per request;
 * the cache belongs to the editor. */
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
    /** Sent to `complete_text`: an automatic request may be cut at a time
     * budget once it holds a complete line. Unset means manual. */
    trigger?: "auto" | "manual";
    /** The edited file's project-relative path, for the backend's reference
     * layout. */
    fileName?: string;
    /** References gathered for this request's scope, before the model's
     * budget is applied. Starts together with the model lookup. */
    context: (signal: AbortSignal) => Promise<CompletionReference[]>;
    /** Whether a stats event already said this model drops references. */
    referencesDropped?: (model: string) => boolean;
    /** The request's `text-completion-stats-<id>` payload, when one arrives. */
    onStats?: (stats: CompletionStats, model: string) => void;
  }, cache?: CompletionCache) {
    if (cache) this.cache = cache;
  }

  async complete(document: CompletionDocument, signal: AbortSignal,
    publish: (candidates: CompletionCandidate[]) => void): Promise<CompletionCandidate[]> {
    // The AI switch (`lib/aiSwitch.ts`): no suggestion while AI is off.
    if (aiIsOff()) return [];
    let requestId: string | undefined;
    let finished = false;
    const unlisteners: (() => void)[] = [];
    const cancel = () => {
      if (requestId) void invoke("cancel_text_completion", { requestId }).catch(() => {});
      for (const unlisten of unlisteners.splice(0)) unlisten();
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      const explicit = this.options.trigger !== "auto";
      // Model lookup, reference gathering and the reservation run together.
      const lookup = completionModels(this.options.endpoint, () => invoke<CompletionModel[]>("list_ollama_models_detailed"));
      const gathering = this.options.context(signal);
      const reserving = invoke<string>("prepare_text_completion").then((id) => {
        // Arrived after Escape, an error or a cache hit: never leave it reserved.
        if (finished || signal.aborted) void invoke("cancel_text_completion", { requestId: id }).catch(() => {});
        else requestId = id;
      });
      const [detailed, gathered] = await Promise.all([lookup, gathering, reserving]);
      signal.throwIfAborted();
      const loaded = detailed.filter((m) => m.running && (!m.capabilities?.length || m.capabilities.includes("completion")));
      const model = pickCompletionModel(loaded, completionModelOrder(document.language, this.options.preferred, this.options.preferredProse));
      if (!model) throw new Error("not_running");
      const insert = model.capabilities?.includes("insert") === true;
      const context = this.options.referencesDropped?.(model.name)
        ? [] : trimReferences(gathered, referenceBudget(explicit, model.context_length));
      const { prefix, suffix } = completionWindow(document.text, document.caret);
      const { mode, candidate } = this.options;
      const key = JSON.stringify([this.id, document.path, this.options.scope, this.options.endpoint,
        prefix, suffix, model.name, insert, document.language, mode, referenceSetId(context), candidate]);
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
      unlisteners.push(await listen<string>(`text-completion-${requestId}`, (event) => {
        if (!signal.aborted) publish(candidates(event.payload));
      }));
      signal.throwIfAborted();
      const onStats = this.options.onStats;
      if (onStats) {
        unlisteners.push(await listen<CompletionStats>(`text-completion-stats-${requestId}`, (event) => {
          if (event.payload && typeof event.payload === "object") onStats(event.payload, model.name);
        }));
        signal.throwIfAborted();
      }
      const text = await invoke<string>("complete_text", {
        prefix, suffix, model: model.name, language: document.language === "plain" ? "" : document.language,
        mode, candidate, insert,
        trigger: this.options.trigger ?? "manual",
        ...(this.options.fileName ? { fileName: this.options.fileName } : {}),
        requestId, context: context.length ? context : undefined,
        projectId: document.projectId ?? this.options.scope,
      });
      signal.throwIfAborted();
      this.cache.set(key, text);
      const result = candidates(text);
      publish(result);
      return result;
    } finally {
      finished = true;
      cancel();
      signal.removeEventListener("abort", cancel);
    }
  }
}
