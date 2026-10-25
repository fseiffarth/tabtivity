import { useOllamaActivityStore } from "../../stores/agents/ollamaActivity";
import { useOllamaUpgradeStore } from "../../stores/agents/ollamaUpgrade";
import { runInstallInTab, type InstallShellKind } from "../installCommand";
import type { TranslationKey } from "../i18n";
import { checkOllamaUpdates, ollamaVersionStatus, type OllamaVersionStatus } from "./localDrivers";

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

/**
 * Ask the registry which installed models have a newer published version, and
 * the Ollama server whether it has one — the one "Check for updates" click of
 * both the header dropdown and the Models overlay. Explicit only (a button), and
 * it survives a partial answer: a model the registry couldn't be reached for
 * comes back carrying its own `error`, which its row shows as "couldn't check"
 * rather than "up to date". The two questions are settled independently
 * (`allSettled`): a registry that is down must not suppress the Ollama-version
 * answer, and vice versa, since the two reach entirely different hosts.
 */
export function runOllamaUpdateCheck(t: Translate): void {
  const store = useOllamaActivityStore.getState();
  store.setCheckingUpdates(true);
  store.setCheckResult(null);
  void Promise.allSettled([checkOllamaUpdates(), ollamaVersionStatus(true)]).then(
    ([modelsRes, server]) => {
      const s = useOllamaActivityStore.getState();
      const serverOk = server.status === "fulfilled";
      if (serverOk) s.setVersion(server.value);

      if (modelsRes.status === "fulfilled") {
        s.setUpdates(Object.fromEntries(modelsRes.value.map((u) => [u.model, u])));
        s.setCheckResult({
          ok: true,
          updates:
            modelsRes.value.filter((u) => u.update_available).length +
            (serverOk && server.value.update_available ? 1 : 0),
        });
      } else {
        // Both invokes failing together says something a network error can't:
        // the commands aren't in the running backend. That is a *restart*,
        // not a connectivity problem, and reporting it as one would send the
        // user to look at their firewall.
        s.setCheckResult({
          ok: false,
          reason: serverOk ? t("localModel.updateCheckFailed") : t("localModel.updateCheckNoBackend"),
        });
      }
      s.setCheckingUpdates(false);
    },
  );
}

/**
 * Upgrade Ollama itself, in a visible terminal tab. Never a "copy this and run
 * it yourself": both installers need an interactive sudo/UAC answer, and the tab
 * is where the user gives it. Same one-click path as the first-time install and
 * every agent CLI (`runInstallInTab`).
 *
 * Snapshots what is in memory *before* handing the installer the terminal: the
 * upgrade restarts the server, which evicts every resident model, and this list
 * is the only record that they were ever there. `stores/ollamaUpgrade` watches
 * for the new server and warms exactly these back up; a snapshot of nothing
 * starts no watcher.
 */
export function upgradeOllamaInTab(t: Translate, version: OllamaVersionStatus, residentModels: string[]): void {
  if (!version.install_cmd) return;
  useOllamaUpgradeStore.getState().begin(version.current, residentModels);
  runInstallInTab(
    t("localModel.ollamaUpgradeTabLabel"),
    version.install_cmd,
    (version.shell_kind || "default") as InstallShellKind,
  );
}
