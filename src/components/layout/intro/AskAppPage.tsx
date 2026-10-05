import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT, type TranslationKey } from "../../../lib/i18n";
import { useSettingsStore } from "../../../stores/settings";
import { Toggle } from "../../common/Toggle";
import { UntestedTag } from "../../common/UntestedTag";
import { IntroActions, IntroStatus } from "./introUi";

/** `root_mcp_status().help` — the Tabtivity help MCP's state. Absent on a backend
 *  that predates it. Read in either key case. */
interface HelpMcpStatus {
  enabled?: boolean;
  wiredClis?: string[];
  wired_clis?: string[];
}

/** One `help_search` hit. */
interface HelpHit {
  id: string;
  title: string;
  section?: string | null;
  sectionTitle?: string | null;
  snippet: string;
}

const EXAMPLE_KEYS: TranslationKey[] = [
  "intro.ask.example1",
  "intro.ask.example2",
  "intro.ask.example3",
  "intro.ask.example4",
];

/**
 * Intro page 5 — "Ask Tabtivity": every local agent tab can look things up in
 * Tabtivity's own help (the `tabtivity-help` MCP server, read-only). Shows whether
 * the server is up (`root_mcp_status`), the one on/off switch
 * (`settings.help_mcp`, absent = on), and a small search box over the same
 * corpus (`help_search`) so the user sees what an agent would get back. An
 * older backend without these answers with a plain sentence, never an error.
 */
export function AskAppPage() {
  const t = useT();
  const enabledSetting = useSettingsStore((s) => s.settings?.help_mcp !== false);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  // undefined = probing; null = this backend has no help MCP yet.
  const [status, setStatus] = useState<HelpMcpStatus | null | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<HelpHit[] | null>(null);
  const [searchFailed, setSearchFailed] = useState(false);
  const [searching, setSearching] = useState(false);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    void invoke<{ help?: HelpMcpStatus }>("root_mcp_status")
      .then((s) => {
        if (live.current) setStatus(s?.help ?? null);
      })
      .catch(() => {
        if (live.current) setStatus(null);
      });
    return () => {
      live.current = false;
    };
  }, [enabledSetting]);

  const search = (q: string) => {
    const text = q.trim();
    if (!text) return;
    setSearching(true);
    setSearchFailed(false);
    void invoke<HelpHit[]>("help_search", { query: text, limit: 3 })
      .then((rows) => {
        if (live.current) setHits(rows);
      })
      .catch(() => {
        if (!live.current) return;
        setHits(null);
        setSearchFailed(true);
      })
      .finally(() => {
        if (live.current) setSearching(false);
      });
  };

  const clis = status?.wiredClis ?? status?.wired_clis ?? [];
  const up = status ? status.enabled === true : status === null ? false : null;

  return (
    <>
      <p className="settings-help">{t("intro.ask.lead")}</p>
      <div className="intro-choice-row">
        <IntroStatus ok={up}>
          {status === undefined
            ? t("intro.checking")
            : status === null
              ? t("intro.ask.statusOldBackend")
              : status.enabled
                ? clis.length > 0
                  ? t("intro.ask.statusOnFor", { list: clis.join(", ") })
                  : t("intro.ask.statusOn")
                : t("intro.ask.statusOff")}
        </IntroStatus>
        <UntestedTag id="desktop.intro.askApp" />
      </div>

      <label className="intro-toggle-row">
        <Toggle
          checked={enabledSetting}
          onChange={(e) => void updateSettings({ help_mcp: e.target.checked })}
          size="sm"
          aria-label={t("intro.ask.toggle")}
        />
        {t("intro.ask.toggle")}
      </label>
      <p className="settings-help">{t("intro.ask.reach")}</p>

      <div className="how-to-start-step-title">{t("intro.ask.examplesTitle")}</div>
      <ul className="intro-examples">
        {EXAMPLE_KEYS.map((key) => (
          <li key={key}>
            <button
              type="button"
              className="settings-btn sm"
              title={t("intro.ask.tryThis")}
              onClick={() => {
                setQuery(t(key));
                search(t(key));
              }}
            >
              {t(key)}
            </button>
          </li>
        ))}
      </ul>

      <div className="how-to-start-step-title">{t("intro.ask.tryTitle")}</div>
      <form
        className="intro-ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          search(query);
        }}
      >
        <input
          type="text"
          className="ollama-pull-input"
          value={query}
          placeholder={t("intro.ask.placeholder")}
          aria-label={t("intro.ask.placeholder")}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        <IntroActions>
          <button type="submit" className="settings-btn sm" disabled={searching || !query.trim()}>
            {t("intro.ask.search")}
          </button>
        </IntroActions>
      </form>
      {searchFailed && <p className="settings-help">{t("intro.ask.searchUnavailable")}</p>}
      {hits && hits.length === 0 && <p className="settings-help">{t("intro.ask.noHits")}</p>}
      {hits && hits.length > 0 && (
        <ul className="intro-hits">
          {hits.map((h) => (
            <li key={`${h.id}#${h.section ?? ""}`} className="settings-card">
              <div className="how-to-start-step-title">
                {h.title}
                {h.sectionTitle ? ` › ${h.sectionTitle}` : ""}
              </div>
              <div className="settings-help">{h.snippet}</div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
