/**
 * What the Settings search finds, as data: the pages, their settings, and the
 * ranked search over them. The dialog's own search box and the command palette
 * both read it, so a setting added to the index is found from either.
 */
import { translate, type TranslationKey, type useT } from "../../lib/i18n";
import type { SettingsSearchResult } from "./settingsUi";
import { scoreSearch, searchTerms, type SearchField } from "./settingsSearch";

export type SettingsPanelKind = "main" | "global" | "filetypes" | "ollama" | "agents" | "shortcuts" | "git" | "vpn" | "remoteHosts" | "archive" | "scaffoldRepair" | "updates" | "help";

export type SubPanel = Exclude<SettingsPanelKind, "main">;

/** The pages of the main panel, one per left-hand entry. Each page's header
 *  carries `settings-anchor-<key>` as its id (`SETTINGS_ANCHORS`), which is
 *  what a deep link names. */
export const MAIN_SECTIONS = [
  "general",
  "layout",
  "clock",
  "hintsOnboarding",
  "downloads",
  "browser",
  "calendar",
  "usageStats",
  "pdfMarkup",
  "rootConsole",
  "assistant",
  "voice",
  "remoteFeatures",
  "vm",
  "mobile",
  "performance",
  "resourceMonitor",
  "experimental",
] as const;
export type MainSection = (typeof MAIN_SECTIONS)[number];
export type NavEntry = MainSection | SubPanel;

export const anchorOf = (section: MainSection) => `settings-anchor-${section}`;
export const isMainSection = (entry: NavEntry): entry is MainSection =>
  (MAIN_SECTIONS as readonly string[]).includes(entry);
export function sectionOfAnchor(anchor: string | undefined): MainSection {
  const key = anchor?.replace(/^settings-anchor-/, "") ?? "";
  return isMainSection(key as NavEntry) ? (key as MainSection) : "general";
}

/** The left-hand navigation: five topic groups, every entry one page on the
 *  right — a main-panel page (`MainSection`) or a sub-panel. Group labels are
 *  `settings.group.<key>`; entry labels `settings.<section>` / `nav.<panel>.title`. */
export const SETTINGS_GROUPS: { key: "general" | "workspace" | "agents" | "remote" | "system"; entries: NavEntry[] }[] = [
  { key: "general", entries: ["general", "layout", "clock", "hintsOnboarding", "shortcuts", "updates", "help"] },
  { key: "workspace", entries: ["global", "filetypes", "downloads", "browser", "calendar", "usageStats", "archive", "scaffoldRepair"] },
  { key: "agents", entries: ["agents", "ollama", "pdfMarkup", "rootConsole", "assistant", "voice"] },
  { key: "remote", entries: ["remoteFeatures", "git", "remoteHosts", "vpn", "vm", "mobile"] },
  { key: "system", entries: ["performance", "resourceMonitor", "experimental"] },
];

/** One searchable setting on a page, found by its label key and by what the
 *  label alone does not say. */
interface SearchItem {
  key: TranslationKey;
  /** Substituted into `key`'s text. */
  params?: Record<string, string>;
  /** The text that marks the setting on its page, when that is not its label
   *  (a provider row is marked by the provider's name). */
  target?: string;
  /** The folds it sits in, outermost first, by their toggle's label. */
  within?: TranslationKey[];
  /** Other words that should find it (`settings.searchAlias.*`). */
  aliases?: TranslationKey;
  /** The setting is itself a fold: picking it opens it. */
  open?: boolean;
}

interface SearchPage {
  /** Text that should find the page beyond its label (a sub-panel's blurb). */
  keywords?: TranslationKey[];
  /** Other words for the page, also matched (weakly) by its settings. */
  aliases?: TranslationKey;
  /** Settings found by their label alone. */
  labels?: TranslationKey[];
  items?: SearchItem[];
}

const ACCOUNTS: TranslationKey[] = ["agents.groupAccounts"];
const apiKeyItem = (provider: string, aliases: TranslationKey): SearchItem => ({
  key: "settings.searchProviderKey",
  params: { provider },
  target: provider,
  within: ACCOUNTS,
  aliases,
});

/** What the search box finds: per page, its settings — each found by its
 *  label (in the UI language and in English), its synonyms and its page, and
 *  picked to open the page at that setting. A label is looked for on the page
 *  by its text, so a new control adds its label key here and nothing else; a
 *  control in a fold names the fold in `within`. */
const SEARCH_INDEX: Record<NavEntry, SearchPage> = {
  general: {
    items: [
      { key: "settings.theme", aliases: "settings.searchAlias.theme" },
      { key: "settings.themeVars" },
      { key: "settings.language", aliases: "settings.searchAlias.language" },
      { key: "settings.showUntestedTags" },
      { key: "settings.runScriptsBg" },
      { key: "settings.persistLocal", aliases: "settings.searchAlias.persistLocal" },
    ],
  },
  layout: {
    items: [
      { key: "settings.windowZoom", aliases: "settings.searchAlias.zoom" },
      { key: "settings.closeSubwindowOnLastTab" },
      { key: "settings.minSubWidth" },
      { key: "settings.minSubHeight" },
    ],
  },
  clock: { aliases: "settings.searchAlias.clock", labels: ["settings.showClockSeconds", "settings.clock24"] },
  hintsOnboarding: {
    labels: ["settings.showHints", "settings.howToStart", "settings.lessons", "lessons.tour.title", "lessons.tourRemote.title", "settings.resetHints"],
  },
  downloads: { labels: ["settings.addDownloadFolder"] },
  browser: {
    labels: ["settings.browserHome", "settings.browserSearch", "settings.browserLinkTarget", "settings.browserRestoreNavigate", "settings.browserLivePages"],
  },
  calendar: {
    labels: ["settings.calendarGlobalApp", "settings.todoBoard", "settings.weekStartsOn", "settings.defaultView", "settings.dayGridStart", "settings.defaultReminder"],
  },
  usageStats: { labels: ["settings.dailyRecap", "settings.openUsageStats"] },
  pdfMarkup: { labels: ["settings.pdfMarkupDirect", "settings.pdfMarkupInstruction", "markup.ask.label", "settings.pdfMarkupApply"] },
  rootConsole: {
    labels: ["settings.rootMcp", "settings.rootMcpLocalOnly", "settings.rootMcpMail", "settings.rootMcpMailLocalOnly", "settings.rootMcpMailLocalRead", "rootReview.setting", "mcpSecurity.title"],
  },
  assistant: { labels: ["assistant.settings.defaultCli", "assistant.settings.defaultModel", "assistant.settings.search", "assistant.search.kind"] },
  voice: { aliases: "settings.searchAlias.voice", labels: ["settings.voice.model", "settings.voice.lang", "settings.voice.gpu"] },
  remoteFeatures: { labels: ["settings.vpnEnabled", "settings.machinesEnabled", "settings.headlessRemote"] },
  vm: { aliases: "settings.searchAlias.vm", labels: ["settings.vmPrerequisites", "projectDialog.vmInstallBtn"] },
  mobile: { aliases: "settings.searchAlias.mobile", labels: ["settings.mobileIndicator", "mobile.phones.only", "mobile.device.sections", "mobile.device.projects"] },
  performance: {
    items: [
      { key: "settings.energySaver", aliases: "settings.searchAlias.energySaver" },
      { key: "settings.fastMode" },
      { key: "settings.sleepTabs" },
      { key: "settings.shellScrollback" },
      { key: "settings.tabCosts" },
    ],
  },
  resourceMonitor: { labels: ["settings.showCpu", "settings.showRam", "settings.showGpu", "statusCluster.settingLabel"] },
  experimental: {
    labels: ["settings.debug", "settings.terminalWebgl", "settings.gpuCompositing", "settings.mdGraph", "settings.projectRemarks", "settings.copilotCompletion", "settings.mailClient", "settings.webBrowser", "settings.pythonRunDebug", "settings.deckPresenter"],
  },
  git: { keywords: ["nav.git.blurb"], aliases: "settings.searchAlias.git" },
  vpn: { keywords: ["nav.vpn.blurb"], aliases: "settings.searchAlias.vpn" },
  remoteHosts: { keywords: ["nav.remoteHosts.blurb"], aliases: "settings.searchAlias.remoteHosts" },
  global: { keywords: ["nav.global.blurb"] },
  filetypes: { keywords: ["nav.filetypes.blurb"], aliases: "settings.searchAlias.filetypes" },
  agents: {
    keywords: ["nav.agents.blurb"],
    aliases: "settings.searchAlias.agents",
    items: [
      { key: "agents.installedGroup", aliases: "settings.searchAlias.agentsInstalled" },
      { key: "agents.availableGroup", aliases: "settings.searchAlias.agentsAvailable" },
      { key: "agents.groupAccounts", open: true },
      { key: "settings.agentLogins", within: ACCOUNTS, aliases: "settings.searchAlias.agentLogins" },
      { key: "settings.agentApiKeys", within: ACCOUNTS, aliases: "settings.searchAlias.apiKeys" },
      apiKeyItem("Anthropic", "settings.searchAlias.anthropicKey"),
      apiKeyItem("OpenAI", "settings.searchAlias.openaiKey"),
      apiKeyItem("Google Gemini", "settings.searchAlias.geminiKey"),
      { key: "settings.agentGlobal", within: ACCOUNTS, aliases: "settings.searchAlias.agentGlobal" },
      { key: "settings.copilotFenceAuth", within: ACCOUNTS },
      { key: "settings.agentFenceTitle", open: true, aliases: "settings.searchAlias.agentFence" },
      { key: "settings.agentFencePaths", within: ["settings.agentFenceTitle"] },
      { key: "agentCron.title", open: true, aliases: "settings.searchAlias.agentCron" },
      { key: "agents.groupTools", open: true, aliases: "settings.searchAlias.agentTools" },
      { key: "scheduleMcp.title", within: ["agents.groupTools"] },
      { key: "gitPushMcp.title", within: ["agents.groupTools"] },
      { key: "markupMcp.title", within: ["agents.groupTools"] },
      { key: "agents.composerHeading", open: true },
      { key: "agents.composerCommands", within: ["agents.composerHeading"] },
      { key: "agents.composerModels", within: ["agents.composerHeading"] },
    ],
  },
  ollama: {
    keywords: ["ollama.modelsTitle"],
    aliases: "settings.searchAlias.ollama",
    items: [
      { key: "ollama.autostartTitle" },
      { key: "ollama.vibeTitle" },
      { key: "ollama.storageTitle", open: true },
      { key: "ollama.modelLocationTitle", within: ["ollama.storageTitle"] },
    ],
  },
  shortcuts: { keywords: ["nav.shortcuts.blurb"], aliases: "settings.searchAlias.shortcuts" },
  archive: { keywords: ["nav.archive.blurb"] },
  scaffoldRepair: { keywords: ["nav.scaffoldRepair.blurb"] },
  updates: { keywords: ["nav.updates.blurb"], aliases: "settings.searchAlias.updates" },
  help: { keywords: ["nav.help.blurb"] },
};


/** A search result: the page to open and, for a setting, the path to it. */
export interface SearchResult extends SettingsSearchResult {
  page: string;
  path?: string[];
  open?: boolean;
  score: number;
}

export const pageLabelKey = (entry: NavEntry) =>
  (isMainSection(entry) ? `settings.${entry}` : `nav.${entry}.title`) as TranslationKey;
export const pageValue = (entry: NavEntry) => (isMainSection(entry) ? anchorOf(entry) : entry);

/** The search: the pages and the settings that match every word typed, best
 *  first. Text is matched in the UI language and in English, so an English
 *  setting name finds its page in any language. `shown` drops a page that
 *  does not exist for this user. */
export function searchSettings(
  query: string,
  t: ReturnType<typeof useT>,
  shown: (entry: NavEntry) => boolean,
): SearchResult[] {
  const terms = searchTerms(query);
  const results: SearchResult[] = [];
  if (terms.length > 0) {
    const texts = (key: TranslationKey, params?: Record<string, string>) => {
      const ui = t(key, params);
      const base = translate("en", key, params);
      return ui === base ? [ui] : [ui, base];
    };
    const fields = (keys: (TranslationKey | undefined)[], weight: number): SearchField[] =>
      keys.flatMap((key) => (key ? texts(key).map((text) => ({ text, weight })) : []));
    for (const group of SETTINGS_GROUPS) {
      const groupKey = `settings.group.${group.key}` as TranslationKey;
      for (const entry of group.entries.filter(shown)) {
        const index = SEARCH_INDEX[entry];
        const page = pageValue(entry);
        const pageLabel = t(pageLabelKey(entry));
        const pageScore = scoreSearch(terms, [
          ...fields([pageLabelKey(entry)], 4),
          ...fields([index.aliases], 2),
          ...fields([...(index.keywords ?? []), groupKey], 1),
        ]);
        if (pageScore !== null) {
          results.push({ value: `search:${results.length}`, label: pageLabel, trail: t(groupKey), page, score: pageScore });
        }
        const items: SearchItem[] = [...(index.labels ?? []).map((key) => ({ key })), ...(index.items ?? [])];
        for (const item of items) {
          const within = item.within ?? [];
          const label = t(item.key, item.params);
          const score = scoreSearch(terms, [
            ...texts(item.key, item.params).map((text) => ({ text, weight: 4 })),
            ...fields([item.aliases], 2),
            ...fields([pageLabelKey(entry), ...within, index.aliases], 1),
          ]);
          if (score === null) continue;
          results.push({
            value: `search:${results.length}`,
            label,
            trail: [pageLabel, ...within.map((key) => t(key))].join(" › "),
            page,
            path: [...within.map((key) => t(key)), item.target ?? label],
            open: item.open,
            score,
          });
        }
      }
    }
    // Stable: equal scores keep the rail's order.
    results.sort((a, b) => b.score - a.score);
  }
  return results;
}
