import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SettingsHeader, SettingsList } from "../layout/settingsUi";
import { parseSshAddress } from "../../lib/projects/scaffold";
import { useProjectsStore } from "../../stores/projects";
import { useT } from "../../lib/i18n";
import { ErrorNote } from "../common/ErrorNote";
import type { SubPanelProps } from "./subPanelProps";

/**
 * "Remote Connections" settings panel: a standard/default remote path per SSH
 * host, set once here instead of re-browsing it every time. Consulted by
 * `useRemoteSession`'s `resolveStartDir` whenever a connect/browse flow would
 * otherwise fall back to the SSH-reported home directory — so a host with a
 * preferred working directory (e.g. a projects folder that isn't `$HOME`)
 * opens there every time, for both new remote projects and reconnects.
 *
 * Distinct from the auto-remembered "recently used paths" dropdown in the New
 * Project dialog (`remote_paths.json`): that list grows on its own from every
 * folder you browse to, while this is one explicit choice per host, edited
 * only here.
 */
export function RemoteHostsSettings({ onBack, onClose }: SubPanelProps) {
  const t = useT();
  const [defaults, setDefaults] = useState<Record<string, string> | null>(null);
  const [draftHost, setDraftHost] = useState("");
  const [draftPath, setDraftPath] = useState("");
  const [error, setError] = useState("");

  const refresh = () => {
    invoke<Record<string, string>>("remote_list_default_paths")
      .then(setDefaults)
      .catch((e) => setError(String(e)));
  };
  useEffect(refresh, []);

  // Hosts seen before (recent SSH addresses + any active remote project),
  // offered as suggestions when adding a new entry — typing the exact host is
  // still required (paths are host-specific and a typo would silently do
  // nothing), this just saves re-typing one you've already connected to.
  const knownHosts = useProjectsStore((s) => s.projects);
  const [hostSuggestions, setHostSuggestions] = useState<string[]>([]);
  useEffect(() => {
    invoke<string[]>("ssh_list_addresses")
      .then((addrs) => {
        const fromAddrs = addrs.map((a) => parseSshAddress(a)?.host).filter((h): h is string => !!h);
        const fromProjects = knownHosts.map((p) => p.remote?.host).filter((h): h is string => !!h);
        const seen = new Set<string>();
        const out: string[] = [];
        for (const h of [...fromAddrs, ...fromProjects]) {
          const key = h.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(h);
        }
        setHostSuggestions(out);
      })
      .catch(() => setHostSuggestions([]));
  }, [knownHosts]);

  const savePath = (host: string, path: string) => {
    setError("");
    invoke<void>("remote_set_default_path", { host, path })
      .then(refresh)
      .catch((e) => setError(String(e)));
  };

  const removeHost = (host: string) => savePath(host, "");

  const addEntry = () => {
    const host = draftHost.trim();
    const path = draftPath.trim();
    if (!host || !path) return;
    savePath(host, path);
    setDraftHost("");
    setDraftPath("");
  };

  const entries = defaults ? Object.entries(defaults).sort(([a], [b]) => a.localeCompare(b)) : [];

  return (
    <>
      <SettingsHeader title={t("nav.remoteHosts.title")} onBack={onBack} onClose={onClose} />
      <div className="dialog-scroll">
      <p className="settings-help">{t("remoteHosts.help")}</p>
      {error && <ErrorNote className="project-dialog-error" error={error} />}
      {/* One framed list holds the saved hosts, the empty state AND the add
          row — the same shape the File Type Apps panel uses. Before, the add
          row sat outside the frame and read as a stray strip below it. */}
      {defaults === null ? (
        <p className="settings-help">{t("common.loading")}</p>
      ) : (
        <SettingsList boxed>
          {entries.length === 0 && (
            <div className="settings-empty">{t("remoteHosts.empty")}</div>
          )}
          {entries.map(([host, path]) => (
            <div className="remote-host-settings-row" key={host}>
              <span className="settings-list-label" title={host}>{host}</span>
              <input
                value={path}
                onChange={(e) => setDefaults((d) => (d ? { ...d, [host]: e.target.value } : d))}
                onBlur={(e) => savePath(host, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") savePath(host, e.currentTarget.value);
                }}
              />
              <button
                type="button"
                className="settings-btn sm icon danger"
                onClick={() => removeHost(host)}
                title={t("common.remove")}
              >
                ×
              </button>
            </div>
          ))}
          <div className="remote-host-settings-row remote-host-settings-add">
            <input
              list="remote-host-suggestions"
              value={draftHost}
              placeholder={t("remoteHosts.hostPlaceholder")}
              onChange={(e) => setDraftHost(e.target.value)}
            />
            <datalist id="remote-host-suggestions">
              {hostSuggestions.map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
            <input
              value={draftPath}
              placeholder={t("remoteHosts.pathPlaceholder")}
              onChange={(e) => setDraftPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addEntry();
              }}
            />
            <button type="button" className="settings-btn sm primary" onClick={addEntry}>
              {t("common.add")}
            </button>
          </div>
        </SettingsList>
      )}
      </div>
    </>
  );
}
