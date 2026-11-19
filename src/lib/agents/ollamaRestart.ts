import { invoke } from "@tauri-apps/api/core";
import type { TranslationKey } from "../i18n";
import { useOllamaActivityStore } from "../../stores/agents/ollamaActivity";

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;
type Confirm = (spec: { title: string; body: string; confirmLabel: string; danger?: boolean }) => Promise<boolean>;

/*
 * The one Restart Ollama click, shared by the Local models page and the Ollama
 * panel: ask (it stops everything Ollama is doing, other programs' requests
 * too), then restart and re-read the model list.
 */

export function askRestartOllama(t: Translate, confirmAction: Confirm): Promise<boolean> {
  return confirmAction({
    title: t("localModel.restartConfirmTitle"),
    body: t("localModel.restartConfirmBody"),
    confirmLabel: t("localModel.restartOllama"),
    danger: true,
  });
}

/** `null` once the server is back, else the error text to show. */
export async function restartOllamaServer(t: Translate): Promise<string | null> {
  try {
    await invoke("restart_ollama_server");
    await useOllamaActivityStore.getState().fetchModels();
    return null;
  } catch (e) {
    return e === "ollama_remote" ? t("localModel.restartRemote") : t("localModel.restartFailed");
  }
}
