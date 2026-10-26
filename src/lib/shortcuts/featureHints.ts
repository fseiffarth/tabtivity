import type { TranslationKey } from "../i18n";

/**
 * The feature-hint catalogue: one short tip per important control, shown only
 * while that control is on screen (`HintHost`, tier "feature"). The same idea
 * as the phone's tips (`mobile-web/.../HintMessage.tsx`), on the desktop's
 * anchored bubble.
 *
 * Each row is data only — the id, the selector of the control the bubble points
 * at, and the side it prefers. The text lives in `i18n/en.ts` under
 * `hint.f.<id>.title` / `hint.f.<id>.body` (other languages fall back to
 * English until translated). Order is rank: earlier rows win when several
 * targets are visible at once.
 *
 * The id is persisted in `settings.hints_seen`, so renaming one replays it for
 * everyone. Selectors are classes of live chrome and rot when it is renamed;
 * `FeatureHints.test.ts` fails on a class that no component or stylesheet
 * mentions any more.
 *
 * Do not point a hint at something that only exists inside a dialog: hints sit
 * below `.modal-backdrop` and are held back while one is open.
 */
export interface FeatureHintSpec {
  id: string;
  /** `document.querySelector` selector of the control to point at. */
  anchor: string;
  /** Preferred side; flips when the window has no room there. */
  placement?: "top" | "bottom";
  /** Always-on chrome (header, project bar, tab bar): visible in every session,
   *  so it ranks below the hints for what the user has opened right now. */
  ambient?: boolean;
}

export const FEATURE_HINTS = [
  // --- Header ----------------------------------------------------------------
  { id: "header-mail", anchor: ".mail-indicator-btn", ambient: true },
  { id: "header-calendar", anchor: ".calendar-indicator-btn", ambient: true },
  { id: "header-todo", anchor: ".todo-indicator-btn", ambient: true },
  { id: "header-models", anchor: ".local-model-btn", ambient: true },
  { id: "header-models-pick", anchor: ".local-model-btn", ambient: true },
  { id: "header-models-roles", anchor: ".local-model-btn", ambient: true },
  { id: "header-models-manage", anchor: ".local-model-btn", ambient: true },
  { id: "header-models-agents", anchor: ".local-model-btn", ambient: true },
  { id: "header-vpn", anchor: ".vpn-indicator-btn", ambient: true },
  { id: "header-vpn-config", anchor: ".vpn-indicator-btn", ambient: true },
  { id: "header-vpn-launch", anchor: ".vpn-indicator-btn", ambient: true },
  { id: "header-machines", anchor: ".machines-indicator-btn", ambient: true },
  { id: "header-phone", anchor: ".mobile-indicator-btn", ambient: true },
  { id: "header-phone-lockdown", anchor: ".mobile-indicator-btn", ambient: true },
  { id: "header-clock", anchor: ".clock-menu-btn", ambient: true },
  { id: "header-clock-recap", anchor: ".clock-menu-btn", ambient: true },
  { id: "header-settings", anchor: "[data-hint-anchor=\"settings\"]", ambient: true },
  { id: "header-settings-search", anchor: "[data-hint-anchor=\"settings\"]", ambient: true },
  { id: "header-help", anchor: "[data-hint-anchor=\"help-agent\"]", ambient: true },
  // --- Project bar -----------------------------------------------------------
  { id: "pills-strip", anchor: ".project-pills-region", ambient: true },
  { id: "pill-menu", anchor: ".project-pill", ambient: true },
  { id: "pill-container", anchor: ".project-pill", ambient: true },
  { id: "pill-publish", anchor: ".project-pill", ambient: true },
  { id: "pill-machines", anchor: ".project-pill", ambient: true },
  { id: "pill-box-drag", anchor: ".project-pill", ambient: true },
  { id: "root-console", anchor: ".box-chip-main", ambient: true },
  { id: "box-list", anchor: ".box-chip-caret-btn", ambient: true },
  { id: "add-menu", anchor: "[data-hint-anchor=\"add-project\"]", ambient: true },
  { id: "add-hpc", anchor: "[data-hint-anchor=\"add-project\"]", ambient: true },
  // --- Tabs ------------------------------------------------------------------
  { id: "tab-add-menu", anchor: "[data-hint-anchor=\"tab-add\"]", ambient: true },
  { id: "tab-agents-install", anchor: "[data-hint-anchor=\"tab-add\"]", ambient: true },
  { id: "tab-menu", anchor: ".tab-strip .tab", ambient: true },
  { id: "tab-arrange", anchor: ".tab-strip", ambient: true },
  { id: "tab-cross-window", anchor: ".tab-strip", ambient: true },
  { id: "tab-restore", anchor: ".tab-strip", ambient: true },
  { id: "tab-chat", anchor: ".reader-view-tabs", ambient: true },
  { id: "prompt-strip", anchor: ".prompt-strip", ambient: true },
  { id: "steering-enter", anchor: ".tab-strip", ambient: true },
  { id: "steering-jumps", anchor: ".tab-strip", ambient: true },
  { id: "steering-stations", anchor: ".project-pills-region", ambient: true },
  { id: "steering-panels", anchor: ".tab-strip", ambient: true },
  { id: "hidden-subwindows", anchor: ".hidden-subwindows", ambient: true },
  // --- File tree and side panel ----------------------------------------------
  { id: "tree-search", anchor: ".file-tree-search" },
  { id: "tree-search-mode", anchor: ".file-tree-search-modes" },
  { id: "tree-search-scope", anchor: ".file-tree-search" },
  { id: "tree-open", anchor: ".file-entry" },
  { id: "tree-drag-layout", anchor: ".file-entry" },
  { id: "tree-viewers", anchor: ".file-name" },
  { id: "tree-presentation", anchor: ".file-entry" },
  { id: "tree-pin", anchor: ".side-panel-pin" },
  { id: "tree-downloads", anchor: ".downloads-section" },
  // --- Git -------------------------------------------------------------------
  { id: "git-sync", anchor: ".git-lockstep-bar" },
  { id: "git-view", anchor: ".git-history-toolbar" },
  { id: "git-branches", anchor: ".git-branch-list" },
  // --- Viewers ---------------------------------------------------------------
  { id: "yaml-safe", anchor: ".yaml-tree" },
  { id: "yaml-copy", anchor: ".yaml-actions" },
  { id: "pdf-contents", anchor: ".file-viewer-pdf-host .file-viewer-pdf-toolbar" },
  { id: "pdf-rail", anchor: ".file-viewer-pdf-rail" },
  { id: "pdf-remarks", anchor: ".file-viewer-pdf-pages" },
  { id: "pdf-redact", anchor: ".file-viewer-pdf-redact-bar" },
  { id: "pdf-synctex", anchor: ".file-viewer-pdf-sync-pills" },
  { id: "tex-structure", anchor: ".tex-structure-sidebar" },
  { id: "tex-compile", anchor: ".tex-workspace-center" },
  { id: "tex-pdf-tab", anchor: ".tex-workspace-center" },
  { id: "tex-errors", anchor: ".tex-workspace-center" },
  { id: "deck-rail", anchor: ".deck-rail" },
  { id: "deck-layers", anchor: ".deck-toolbar-title" },
  { id: "deck-export", anchor: ".deck-toolbar-title" },
  { id: "editor-autocomplete", anchor: ".file-viewer-code-area" },
  // --- Browser and printing --------------------------------------------------
  { id: "browser-reader", anchor: ".browser-content" },
  { id: "browser-address", anchor: ".browser-address" },
  { id: "browser-live", anchor: ".browser-toolbar" },
  { id: "browser-downloads", anchor: ".browser-toolbar" },
  { id: "browser-resume", anchor: ".browser-start" },
  { id: "print-queue", anchor: ".print-card" },
  { id: "print-scope", anchor: ".print-toolbar" },
  // --- Calendar and to-do ----------------------------------------------------
  { id: "cal-views", anchor: ".cal-toolbar-views" },
  { id: "cal-drag", anchor: ".cal-timegrid" },
  { id: "cal-event", anchor: ".cal-block" },
  { id: "cal-caldav", anchor: ".cal-sidebar" },
  { id: "cal-ics", anchor: ".cal-toolbar-actions" },
  { id: "cal-alarm", anchor: ".cal-alarm-popup" },
  { id: "todo-columns", anchor: ".todo-board" },
  { id: "todo-card", anchor: ".todo-card-head" },
  { id: "todo-filters", anchor: ".todo-toolbar" },
  { id: "todo-rails", anchor: ".todo-rails" },
  // --- Mail ------------------------------------------------------------------
  { id: "mail-folders", anchor: ".mail-rail" },
  { id: "mail-sort", anchor: ".mail-list-sort" },
  { id: "mail-html", anchor: ".mail-body-frame" },
  { id: "mail-filters", anchor: ".mail-toolbar" },
  { id: "mail-ai", anchor: ".mail-ai-toolbar" },
  { id: "header-mail-encryption", anchor: ".mail-indicator-btn" },
  { id: "header-mail-pgp", anchor: ".mail-indicator-btn" },
  // --- Skills ----------------------------------------------------------------
  { id: "skills-sources", anchor: ".skills-sources" },
  { id: "skills-filter", anchor: ".skills-toolbar" },
  { id: "skills-scope", anchor: ".skills-install-scope" },
  { id: "skills-scripts", anchor: ".skills-preview-files" },
] as const satisfies readonly FeatureHintSpec[];

export type FeatureHintId = (typeof FEATURE_HINTS)[number]["id"];

export function featureTitleKey(id: string): TranslationKey {
  return `hint.f.${id}.title` as TranslationKey;
}

export function featureBodyKey(id: string): TranslationKey {
  return `hint.f.${id}.body` as TranslationKey;
}
