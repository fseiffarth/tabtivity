import { HOW_TO_START_STEPS, focusModeTip } from "../../lib/shortcuts/hints";
import { useModalFocus } from "../../hooks/useModalFocus";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  useSettingsStore,
  clampZoom,
  MIN_UI_ZOOM,
  MAX_UI_ZOOM,
  ZOOM_STEPS,
} from "../../stores/settings";
import { RootMcpSecurity } from "./RootMcpSecurity";
import { CopilotCompletionCard } from "./CopilotCompletionCard";
import { UntestedTag } from "../common/UntestedTag";
import { experimentalEnabled } from "../../lib/experimental";
import { usePowerStore, useEnergySaver } from "../../stores/power";
import { useProjectsStore } from "../../stores/projects";
import { DEFAULT_MIN_SUBWINDOW_PX } from "../../stores/tabs";
import { DEFAULT_MAIL_CHECK_MIN } from "../../lib/mail";
import { ThemeCustomizerDialog } from "./ThemeCustomizer";
import type {
  ArchivedProject,
  CalendarViewKind,
  GitProvider,
  KeyboardChord,
  ProjectEntry,
  Theme,
  UnsyncedReport,
  VmDoctorReport,
} from "../../types";
import { THEMES } from "../../types";
import type { LinkOpenTarget } from "../../types/browser";
import { summarizeScaffoldRepair, type ProjectScaffoldRepair } from "../projects/scaffold";
import { providerName } from "../projects/projectTypeTags";
import { GitTokenScopes, tokenPageUrl } from "../common/GitTokenScopes";
import { OPEN_STATS_EVENT } from "../stats/StatsRecapHost";
import {
  LONE_SUPER,
  SHORTCUT_DEFS,
  SHORTCUT_GROUPS,
  UNBOUND,
  chordFromEvent,
  chordLabel,
  findConflicts,
  isUnbound,
  resolveChord,
  type ShortcutAction,
  type ShortcutDef,
  type ShortcutMap,
} from "../../lib/shortcuts/shortcuts";
import {
  STEERING_BINDINGS,
  STEERING_BINDING_SECTIONS,
  STEERING_KEYS_PER_ACTION,
  findSteeringConflicts,
  steeringKeyFromEvent,
  steeringKeyLabel,
  steeringKeys,
  type SteeringAction,
  type SteeringBindingDef,
  type SteeringKeyMap,
} from "../../lib/shortcuts/steeringBindings";
import { livePanelToggleLabel } from "../../lib/shortcuts/shortcutHint";
import {
  AgentsPanel,
  FileTypeSettings,
  GlobalAppsSettings,
  OllamaPanel,
  RemoteHostsSettings,
} from "./SettingsSubPanels";
import { Dropdown } from "../common/Dropdown";
import { PasswordInput } from "../common/PasswordInput";
import { useT, LANGUAGES, type Language, type TranslationKey } from "../../lib/i18n";
import { useUse24h } from "../../lib/timeFormat";
import { IS_MAC, IS_WINDOWS, PLATFORM } from "../../lib/platform";
import { runInstallInTab } from "../../lib/installCommand";
import { useHintsStore } from "../../stores/hints";
import { canConnectVpnSilently } from "../../lib/remote/vpn/vpnConnect";
import { setVpnAutoConnect, vpnUsernameFor } from "../../lib/remote/vpn/vpnAutoConnect";
import type { StoredVpnConfig } from "../../types";
import { MobileSettings } from "../mobile/MobileSettings";
import { UpdatesPanel } from "./UpdatesPanel";
import { DEFAULT_PDF_MARKUP_APPLY, DEFAULT_PDF_MARKUP_INSTRUCTION, MAX_PDF_MARKUP_PROMPT } from "../../lib/viewers/pdfMarkup";
import { BugIcon, PlayIcon, WarningIcon } from "../common/icons/Icon";
import {
  SETTINGS_ANCHORS,
  SettingRow,
  SettingsCard,
  SettingsAdvanced,
  SettingsHeader,
  SettingsList,
  SettingsSection,
  SettingsNavigation,
  ToggleCard,
  ToggleRow,
} from "./settingsUi";
import { ErrorNote } from "../common/ErrorNote";

// The workspace-layout help text. The key is the one that works here, from
// `livePanelToggleLabel` (unless rebound): a lone Super on a Linux desktop that leaves it to the
// window, F9 where the shell claims Super (GNOME, KDE) and on Windows (the lone
// Win key is OS-reserved — Start opens on release, see useKeyboard). On macOS
// the Meta key is reserved for Cmd shortcuts, so the lone-key toggle is
// disabled — there the panels stay reachable via the cursor-to-edge reveal.
function workspaceLayoutIntro(t: ReturnType<typeof useT>): string {
  return IS_MAC
    ? t("help.workspaceLayout.introMac")
    : t("help.workspaceLayout.introOther", { key: livePanelToggleLabel() });
}

/** What `workspace_capabilities` answers (backend `commands::workspace`). */
interface WorkspaceCapabilities {
  backend: string;
  can_park: boolean;
}

/**
 * One sentence in Layout, Linux only: this desktop cannot hide other apps'
 * windows on a project switch. Project switching promises to swap the apps
 * with the project, and on GNOME, XFCE or KDE Wayland (the `null` and
 * `kde-wayland` backends) it silently leaves every window where it was — the
 * user should read that here rather than conclude the feature is broken.
 * Renders nothing until the backend answers, when it can park, and when the
 * command is missing (a backend older than this frontend). Not on Windows or
 * macOS, whose backends always park.
 */
/** One Mark up prompt of the desktop PDF viewer (Settings → PDF markup): a
 *  free-text field that starts from the default, kept as typed; Use the
 *  default clears it (`undefined` = the default). */
function PdfMarkupPromptCard({ id, label, help, value, fallback, onChange }: {
  id: string;
  label: string;
  help: string;
  value: string | undefined;
  fallback: string;
  onChange: (value: string | undefined) => void;
}) {
  const t = useT();
  const custom = value?.trim() ? value : undefined;
  return (
    <SettingsCard>
      <label className="settings-card-label" htmlFor={id}>{label}</label>
      <textarea
        id={id}
        className="settings-prompt-text"
        rows={4}
        maxLength={MAX_PDF_MARKUP_PROMPT}
        value={custom ?? fallback}
        onChange={(e) => {
          const next = e.target.value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
          onChange(next.trim() && next.trim() !== fallback ? next : undefined);
        }}
      />
      <p className="settings-help">{help}</p>
      <div className="settings-link-row">
        <button type="button" className="settings-btn sm" disabled={custom === undefined} onClick={() => onChange(undefined)}>
          {t("settings.pdfMarkupReset")}
        </button>
      </div>
    </SettingsCard>
  );
}

export function WorkspaceParkingNote() {
  const t = useT();
  const [caps, setCaps] = useState<WorkspaceCapabilities | null>(null);
  useEffect(() => {
    if (PLATFORM !== "linux") return;
    let live = true;
    invoke<WorkspaceCapabilities>("workspace_capabilities")
      .then((c) => {
        if (live && c && typeof c.can_park === "boolean") setCaps(c);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (!caps || caps.can_park) return null;
  return (
    <SettingsCard>
      <p className="settings-help">
        {t("settings.workspaceNoParking")} <UntestedTag id="settings.workspaceNoParking" />
      </p>
    </SettingsCard>
  );
}

/** Machine-wide VM prerequisites, using the same doctor and root-tab install
 *  command as the project creation dialog. */
function VmInstallSettings() {
  const t = useT();
  const [doctor, setDoctor] = useState<VmDoctorReport | null>(null);
  const [error, setError] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    let live = true;
    const check = () => {
      void invoke<VmDoctorReport>("vm_doctor")
        .then((report) => {
          if (!live) return;
          setDoctor(report);
          setError(false);
          if (!report.install_command) setInstalling(false);
        })
        .catch(() => { if (live) setError(true); });
    };
    check();
    if (installing) {
      const timer = window.setInterval(check, 3000);
      return () => { live = false; window.clearInterval(timer); };
    }
    return () => { live = false; };
  }, [installing]);

  return (
    <SettingRow
      label={<>{t("settings.vmPrerequisites")} <UntestedTag id="settings.vmPrerequisites" /></>}
      control={doctor?.install_command ? (
        <button
          type="button"
          className="settings-btn"
          onClick={() => {
            setInstalling(true);
            runInstallInTab(t("projectDialog.vmInstallLabel"), doctor.install_command!, IS_WINDOWS ? "default" : "bash");
          }}
        >
          {t("projectDialog.vmInstallBtn")}
        </button>
      ) : null}
      help={error
        ? t("settings.vmCheckFailed")
        : doctor === null
          ? t("settings.vmChecking")
          : doctor.ok
            ? t("settings.vmReady")
            : doctor.reasons.join(" ")}
    />
  );
}

/** Every sub-panel takes the same two: `onBack` returns to the main panel,
 *  `onClose` dismisses the whole dialog. Optional because the panels are also
 *  rendered standalone in tests. */
interface SubPanelProps {
  onBack: () => void;
  onClose?: () => void;
}

interface HelpItem {
  termKey: TranslationKey;
  descKey: TranslationKey;
}

interface HelpSection {
  titleKey: TranslationKey;
  hasIntro?: boolean;
  items: HelpItem[];
}

/**
 * The Feature Guide's contents, in reading order: the window itself, then
 * projects, then what runs in a tab, then the surfaces that are their own
 * applications, then everything that leaves this machine, then the rest.
 * Terms and descriptions are i18n keys (`help.<section>.item<N>.term|desc`) —
 * add a row here and its two keys in every language block.
 */
const HELP_SECTIONS: HelpSection[] = [
  {
    titleKey: "help.workspaceLayout.title",
    hasIntro: true,
    items: [
      { termKey: "help.workspaceLayout.item1.term", descKey: "help.workspaceLayout.item1.desc" },
      { termKey: "help.workspaceLayout.item2.term", descKey: "help.workspaceLayout.item2.desc" },
      { termKey: "help.workspaceLayout.item3.term", descKey: "help.workspaceLayout.item3.desc" },
      { termKey: "help.workspaceLayout.item4.term", descKey: "help.workspaceLayout.item4.desc" },
    ],
  },
  {
    titleKey: "help.projects.title",
    items: [
      { termKey: "help.projects.item1.term", descKey: "help.projects.item1.desc" },
      { termKey: "help.projects.item2.term", descKey: "help.projects.item2.desc" },
      { termKey: "help.projects.item3.term", descKey: "help.projects.item3.desc" },
      { termKey: "help.projects.item4.term", descKey: "help.projects.item4.desc" },
      { termKey: "help.projects.item5.term", descKey: "help.projects.item5.desc" },
    ],
  },
  {
    titleKey: "help.aiTerminals.title",
    items: [
      { termKey: "help.aiTerminals.item1.term", descKey: "help.aiTerminals.item1.desc" },
      { termKey: "help.aiTerminals.item2.term", descKey: "help.aiTerminals.item2.desc" },
      { termKey: "help.aiTerminals.item3.term", descKey: "help.aiTerminals.item3.desc" },
      { termKey: "help.aiTerminals.item4.term", descKey: "help.aiTerminals.item4.desc" },
    ],
  },
  {
    titleKey: "help.filesViewers.title",
    items: [
      { termKey: "help.filesViewers.item1.term", descKey: "help.filesViewers.item1.desc" },
      { termKey: "help.filesViewers.item2.term", descKey: "help.filesViewers.item2.desc" },
      { termKey: "help.filesViewers.item3.term", descKey: "help.filesViewers.item3.desc" },
      { termKey: "help.filesViewers.item4.term", descKey: "help.filesViewers.item4.desc" },
      { termKey: "help.filesViewers.item5.term", descKey: "help.filesViewers.item5.desc" },
    ],
  },
  {
    titleKey: "help.mailCalendar.title",
    items: [
      { termKey: "help.mailCalendar.item1.term", descKey: "help.mailCalendar.item1.desc" },
      { termKey: "help.mailCalendar.item2.term", descKey: "help.mailCalendar.item2.desc" },
      { termKey: "help.mailCalendar.item3.term", descKey: "help.mailCalendar.item3.desc" },
      { termKey: "help.mailCalendar.item4.term", descKey: "help.mailCalendar.item4.desc" },
    ],
  },
  {
    titleKey: "help.remoteMachines.title",
    items: [
      { termKey: "help.remoteMachines.item1.term", descKey: "help.remoteMachines.item1.desc" },
      { termKey: "help.remoteMachines.item2.term", descKey: "help.remoteMachines.item2.desc" },
      { termKey: "help.remoteMachines.item3.term", descKey: "help.remoteMachines.item3.desc" },
      { termKey: "help.remoteMachines.item4.term", descKey: "help.remoteMachines.item4.desc" },
      { termKey: "help.remoteMachines.item5.term", descKey: "help.remoteMachines.item5.desc" },
    ],
  },
  {
    titleKey: "help.settingsExtras.title",
    items: [
      { termKey: "help.settingsExtras.item1.term", descKey: "help.settingsExtras.item1.desc" },
      { termKey: "help.settingsExtras.item2.term", descKey: "help.settingsExtras.item2.desc" },
      { termKey: "help.settingsExtras.item3.term", descKey: "help.settingsExtras.item3.desc" },
      { termKey: "help.settingsExtras.item4.term", descKey: "help.settingsExtras.item4.desc" },
    ],
  },
];

/** What the shortcuts panel is capturing: a chord, or one of a steering
 *  action's key slots. */
type ShortcutCapture =
  | { kind: "chord"; action: ShortcutAction }
  | { kind: "steer"; action: SteeringAction; slot: number };

/**
 * Group L / #62 — let the user rebind every key: the app's chords, one boxed
 * list per `SHORTCUT_GROUPS` section (the cheat sheet's grouping, driven
 * entirely by each def's `group`), then the keys inside steering mode, one
 * list per level (`STEERING_BINDING_SECTIONS`). Click a key button to enter
 * capture mode; the next non-modifier keydown is stored as the override
 * (`settings.keyboard_shortcuts` / `settings.steering_keys`). × turns a chord
 * off or drops one steering key; "Reset" brings a row's defaults back; "Reset
 * all" clears both maps. A colliding capture is still stored — the user may
 * mean to fix the other action next — and both rows wear the warning until one
 * moves (`findConflicts` / `findSteeringConflicts`).
 */
function ShortcutsSettings({ onBack, onClose }: SubPanelProps) {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const overrides = (settings?.keyboard_shortcuts ?? {}) as ShortcutMap;
  const steerOverrides = (settings?.steering_keys ?? {}) as SteeringKeyMap;
  const [capturing, setCapturing] = useState<ShortcutCapture | null>(null);

  const saveMap = (next: ShortcutMap) => {
    void updateSettings({ keyboard_shortcuts: next as Record<string, KeyboardChord> });
  };
  const saveSteerMap = (next: SteeringKeyMap) => {
    void updateSettings({ steering_keys: next as Record<string, string[]> });
  };

  const rebind = (action: ShortcutAction, chord: KeyboardChord) => {
    saveMap({ ...overrides, [action]: chord });
  };

  const reset = (action: ShortcutAction) => {
    const next = { ...overrides };
    delete next[action];
    saveMap(next);
  };

  /** Put `key` in slot `slot` of the action's list (null drops the slot). */
  const setSteerKey = (action: SteeringAction, slot: number, key: string | null) => {
    const keys = [...steeringKeys(action, steerOverrides)];
    if (key === null) keys.splice(slot, 1);
    else keys[Math.min(slot, keys.length)] = key;
    saveSteerMap({ ...steerOverrides, [action]: keys.filter((k, i) => keys.indexOf(k) === i) });
  };

  const resetSteer = (action: SteeringAction) => {
    const next = { ...steerOverrides };
    delete next[action];
    saveSteerMap(next);
  };

  const hasOverrides = Object.keys(overrides).length > 0 || Object.keys(steerOverrides).length > 0;
  const conflicts = findConflicts(overrides);
  const steerConflicts = findSteeringConflicts(steerOverrides);
  const labelOf = (action: ShortcutAction) => {
    const def = SHORTCUT_DEFS.find((d) => d.action === action);
    return def ? t(def.labelKey) : action;
  };
  const steerLabelOf = (action: SteeringAction) => {
    const def = STEERING_BINDINGS.find((d) => d.action === action);
    return def ? t(def.labelKey) : action;
  };

  // While capturing, the next real key sets the binding. Capture at the window
  // level (capture phase, ahead of steering's document listener) so the
  // keystroke is grabbed even though our button, not a terminal, has focus;
  // ignore lone modifiers so the user can hold them. Escape cancels a chord
  // capture but is stored as a steering key — it is one of the mode's own. A
  // lone Super tap (press and release, nothing between) is a chord of its own
  // for the actions that allow it (`loneSuper`), on Linux only.
  useEffect(() => {
    if (!capturing) return;
    const loneSuperOk =
      PLATFORM === "linux" &&
      capturing.kind === "chord" &&
      !!SHORTCUT_DEFS.find((d) => d.action === capturing.action)?.loneSuper;
    let superAlone = false;
    const isSuper = (k: string) => k === "Meta" || k === "Super" || k === "OS";
    const onKey = (e: KeyboardEvent) => {
      if (capturing.kind === "steer") {
        const key = steeringKeyFromEvent(e);
        if (!key) return; // lone modifier — keep waiting
        e.preventDefault();
        e.stopPropagation();
        setSteerKey(capturing.action, capturing.slot, key);
        setCapturing(null);
        return;
      }
      if (e.key === "Escape") {
        // Only the capture ends — not steering's settings region, whose
        // Escape would close the dialog.
        e.preventDefault();
        e.stopPropagation();
        setCapturing(null);
        return;
      }
      superAlone = isSuper(e.key) && !e.repeat ? true : isSuper(e.key) && superAlone;
      const chord = chordFromEvent(e);
      if (!chord) return; // lone modifier — keep waiting
      e.preventDefault();
      e.stopPropagation();
      rebind(capturing.action, chord);
      setCapturing(null);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!loneSuperOk || capturing.kind !== "chord" || !isSuper(e.key) || !superAlone) return;
      e.preventDefault();
      e.stopPropagation();
      rebind(capturing.action, LONE_SUPER);
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing, overrides, steerOverrides]);

  const isCapturing = (c: ShortcutCapture) =>
    !!capturing &&
    capturing.kind === c.kind &&
    capturing.action === c.action &&
    (c.kind === "chord" || (capturing.kind === "steer" && capturing.slot === c.slot));
  const toggleCapture = (c: ShortcutCapture) => setCapturing(isCapturing(c) ? null : c);

  // One boxed-list entry: the capture/off/reset row, plus the conflict
  // warning line when its effective chord collides with another.
  const renderRow = (def: ShortcutDef) => {
    const active = isCapturing({ kind: "chord", action: def.action });
    const effective = resolveChord(def.action, overrides);
    const isCustom = !!overrides[def.action];
    const clash = conflicts.get(def.action);
    return (
      <div className="shortcut-entry" key={def.action}>
        <div className="settings-row shortcut-row">
          <span className="settings-role-label">
            {t(def.labelKey)}
            {def.untested && <> <UntestedTag id={def.untested} /></>}
          </span>
          <button
            type="button"
            className={`shortcut-capture-btn${active ? " capturing" : ""}`}
            onClick={() => toggleCapture({ kind: "chord", action: def.action })}
            title={t("shortcuts.captureTitle")}
          >
            {active ? t("shortcuts.pressKeys") : chordLabel(effective)}
          </button>
          <button
            type="button"
            className="settings-btn sm icon"
            disabled={isUnbound(effective)}
            onClick={() => rebind(def.action, UNBOUND)}
            title={t("shortcuts.unbind")}
            aria-label={t("shortcuts.unbind")}
          >
            ×
          </button>
          <button
            type="button"
            className="settings-btn sm"
            disabled={!isCustom}
            onClick={() => reset(def.action)}
            title={t("shortcuts.resetTitle")}
          >
            {t("common.reset")}
          </button>
        </div>
        {clash && (
          <div className="shortcut-conflict">
            <WarningIcon /> {t("shortcuts.conflict", { actions: clash.map(labelOf).join(", ") })}
          </div>
        )}
      </div>
    );
  };

  // A steering action: one capture button per key slot (an empty slot adds a
  // key), × on each bound key, Reset back to the defaults.
  const renderSteerRow = (def: SteeringBindingDef) => {
    const keys = steeringKeys(def.action, steerOverrides);
    const isCustom = !!steerOverrides[def.action];
    const clash = steerConflicts.get(def.action);
    const slots = Array.from({ length: Math.min(keys.length + 1, STEERING_KEYS_PER_ACTION) }, (_, i) => i);
    return (
      <div className="shortcut-entry" key={def.action}>
        <div className="settings-row shortcut-row">
          <span className="settings-role-label">{t(def.labelKey)}</span>
          {slots.map((slot) => {
            const c: ShortcutCapture = { kind: "steer", action: def.action, slot };
            const active = isCapturing(c);
            const key = keys[slot];
            return (
              <span className="shortcut-steer-key" key={slot}>
                <button
                  type="button"
                  className={`shortcut-capture-btn narrow${active ? " capturing" : ""}`}
                  onClick={() => toggleCapture(c)}
                  title={key ? t("shortcuts.captureTitle") : t("shortcuts.addKey")}
                >
                  {active ? t("shortcuts.pressKey") : key ? steeringKeyLabel(key) : "+"}
                </button>
                {key && (
                  <button
                    type="button"
                    className="settings-btn sm icon"
                    onClick={() => setSteerKey(def.action, slot, null)}
                    title={t("shortcuts.unbind")}
                    aria-label={t("shortcuts.unbind")}
                  >
                    ×
                  </button>
                )}
              </span>
            );
          })}
          <button
            type="button"
            className="settings-btn sm"
            disabled={!isCustom}
            onClick={() => resetSteer(def.action)}
            title={t("shortcuts.resetTitle")}
          >
            {t("common.reset")}
          </button>
        </div>
        {clash && (
          <div className="shortcut-conflict">
            <WarningIcon /> {t("shortcuts.conflict", { actions: clash.map(steerLabelOf).join(", ") })}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <SettingsHeader title={t("nav.shortcuts.title")} onBack={onBack} onClose={onClose} />
      <div className="dialog-scroll">
      <p className="settings-help">
        {t("shortcuts.help")} <UntestedTag id="shortcuts.rebindAll" />
      </p>
      <div className="settings-link-row">
        <button
          type="button"
          className="settings-btn sm"
          disabled={!hasOverrides}
          onClick={() => void updateSettings({ keyboard_shortcuts: {}, steering_keys: {} })}
          title={t("shortcuts.resetAllTitle")}
        >
          {t("shortcuts.resetAll")}
        </button>
      </div>
      {SHORTCUT_GROUPS.map((g) => (
        <SettingsSection title={t(g.labelKey)} key={g.id}>
          <SettingsList boxed>
            {SHORTCUT_DEFS.filter((d) => d.group === g.id).map(renderRow)}
          </SettingsList>
        </SettingsSection>
      ))}
      {/* The steering keys, one list per level; the first carries the
          explanation (the sections' own heading/help pair, no extra chrome). */}
      {STEERING_BINDING_SECTIONS.map((sec, i) => (
        <SettingsSection
          title={`${t("shortcuts.steeringTitle")} · ${t(sec.labelKey)}`}
          help={
            i === 0
              ? t("shortcuts.steeringHelp", { chord: chordLabel(resolveChord("steeringMode", overrides)) })
              : undefined
          }
          key={sec.scope}
        >
          <SettingsList boxed>
            {STEERING_BINDINGS.filter((d) => d.scopes[0] === sec.scope).map(renderSteerRow)}
          </SettingsList>
        </SettingsSection>
      ))}
      </div>
    </>
  );
}

/**
 * Git hosting profile + access token, broken out of the main settings panel
 * into its own sub-menu. Manages its own draft state (mirroring the saved
 * settings) and persists on blur / Enter, same as it did inline.
 */
function GitHostingSettings({ onBack, onClose }: SubPanelProps) {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const [gitProfileUrl, setGitProfileUrl] = useState(settings?.git_profile_url ?? "");
  const [gitToken, setGitToken] = useState(settings?.git_token ?? "");

  useEffect(() => {
    setGitProfileUrl(settings?.git_profile_url ?? "");
    setGitToken(settings?.git_token ?? "");
  }, [settings?.git_profile_url, settings?.git_token]);

  const saveGitProfileUrl = () => {
    void updateSettings({ git_profile_url: gitProfileUrl.trim() });
  };

  const saveGitToken = () => {
    void updateSettings({ git_token: gitToken.trim() });
  };

  // Which provider the token hint and permission guide describe. Derived live
  // from the profile URL being typed (the only provider signal a global,
  // project-less setting has), defaulting to GitHub as everywhere else.
  const provider: GitProvider = gitProfileUrl.toLowerCase().includes("gitlab")
    ? "gitlab"
    : "github";

  return (
    <>
      <SettingsHeader title={t("nav.git.title")} onBack={onBack} onClose={onClose} />
      <div className="dialog-scroll">
      <p className="settings-help">{t("git.help")}</p>
      <SettingsCard>
      <label className="settings-field">
        {t("git.profileUrl")}
        <input
          value={gitProfileUrl}
          placeholder={t("git.profileUrlPlaceholder")}
          onChange={(e) => setGitProfileUrl(e.target.value)}
          onBlur={saveGitProfileUrl}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveGitProfileUrl();
          }}
        />
      </label>
      <label className="settings-field">
        {t("git.accessToken")}
        <PasswordInput
          value={gitToken}
          placeholder={t("git.tokenPlaceholder")}
          onChange={(e) => setGitToken(e.target.value)}
          onBlur={saveGitToken}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveGitToken();
          }}
        />
      </label>
      <span className="ssh-optional-hint">
        {t("pill.getTokenHint")}{" "}
        <button
          type="button"
          className="inline-link-btn"
          onClick={() =>
            void invoke("open_external_url", { url: tokenPageUrl(provider, gitProfileUrl) })
          }
        >
          {t("pill.getTokenCta", { provider: providerName(provider) })}
        </button>
      </span>
      </SettingsCard>
      <GitTokenScopes provider={provider} />
      </div>
    </>
  );
}

/**
 * Same setting the header's VPN menu arms per config (`settings.vpn_auto_connect`,
 * see `lib/remote/vpn/vpnAutoConnect.ts`) — surfaced here too since the header menu only shows
 * up once a tunnel exists, which makes this opt-in easy to miss.
 */
function VpnAutoConnectSettings({ onBack, onClose }: SubPanelProps) {
  const t = useT();
  const { settings } = useSettingsStore();
  const armed = settings?.vpn_auto_connect ?? null;
  const headless = settings?.connections_headless ?? true;
  const [configs, setConfigs] = useState<StoredVpnConfig[] | null>(null);
  const [silent, setSilent] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    void invoke<StoredVpnConfig[]>("openvpn_list_configs")
      .then(async (list) => {
        const stored = Array.isArray(list) ? list : [];
        if (cancelled) return;
        setConfigs(stored);
        const checks = await Promise.all(
          stored.map(async (c) => [c.path, await canConnectVpnSilently(c.path, vpnUsernameFor(c.path))] as const),
        );
        if (!cancelled) setSilent(Object.fromEntries(checks));
      })
      .catch(() => {
        if (!cancelled) setConfigs([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <SettingsHeader title={t("nav.vpn.title")} onBack={onBack} onClose={onClose} />
      <div className="dialog-scroll">
      <p className="settings-help">{t("vpn.autoConnectHelp")}</p>
      {configs === null ? (
        <p className="settings-help">{t("common.loading")}</p>
      ) : configs.length === 0 ? (
        <div className="settings-empty">{t("vpn.noConfig")}</div>
      ) : (
        <SettingsList>
          {configs.map((c) => {
            const on = armed === c.path;
            const eligible = !headless || silent[c.path] === true;
            return (
              <SettingsCard key={c.path}>
                <ToggleRow
                  label={<span title={c.path}>{c.name}</span>}
                  checked={on}
                  disabled={!eligible && !on}
                  onChange={(e) => void setVpnAutoConnect(c.path, e.target.checked)}
                />
                {!eligible && !on && (
                  <p className="settings-help">
                    {t("vpn.needsSavedPre")} <b>{t("vpn.needsSavedBold")}</b>{" "}
                    {t("vpn.needsSavedPost")}
                  </p>
                )}
                {on && (
                  <p className="settings-help">
                    {t("vpn.startsWithApp")}
                    {headless ? "" : ` ${t("vpn.waitsInRootTerminal")}`}.
                  </p>
                )}
              </SettingsCard>
            );
          })}
        </SettingsList>
      )}
      </div>
    </>
  );
}

function ArchivedProjectsPanel({ onBack, onClose }: SubPanelProps) {
  const t = useT();
  const [items, setItems] = useState<ArchivedProject[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  // id of the row armed for permanent deletion + the name typed to confirm it.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // Mirrors confirmId for stale-guarding the async unsynced check below.
  const confirmIdRef = useRef<string | null>(null);
  const [typed, setTyped] = useState("");
  // Unsynced-mirror check for the armed row (remote projects only): null while
  // loading/not-yet-fetched, else the offline report on local-only commits.
  const [unsynced, setUnsynced] = useState<UnsyncedReport | null>(null);
  // Typed guard for the "Clear archive" bulk action.
  const [clearing, setClearing] = useState(false);
  const [clearTyped, setClearTyped] = useState("");

  const refresh = () => {
    invoke<ArchivedProject[]>("list_archived_projects")
      .then(setItems)
      .catch((e) => {
        setError(String(e));
        setItems([]);
      });
  };

  useEffect(refresh, []);

  const resetConfirm = () => {
    setConfirmId(null);
    confirmIdRef.current = null;
    setTyped("");
    setUnsynced(null);
  };

  // Arm a row for permanent deletion; for remote projects, run the offline
  // unsynced-mirror check so the confirm step can warn about local-only commits.
  const armDelete = (a: ArchivedProject) => {
    setConfirmId(a.id);
    confirmIdRef.current = a.id;
    setTyped("");
    setUnsynced(null);
    if (a.remote) {
      invoke<UnsyncedReport>("archived_mirror_unsynced", { projectId: a.id })
        // Drop a late result if the user moved to a different row; ignore failures
        // (the type-to-confirm guard still stands without the hint).
        .then((r) => confirmIdRef.current === a.id && setUnsynced(r))
        .catch(() => {});
    }
  };

  const restore = async (a: ArchivedProject) => {
    setBusyId(a.id);
    setError("");
    try {
      const restored = await invoke<ProjectEntry>("restore_archived_project", { projectId: a.id });
      // Splice the restored (inactive) entry back into the live list without a
      // full reload, so box grouping / active project are left undisturbed.
      useProjectsStore.setState((s) => ({
        projects: [...s.projects.filter((p) => p.id !== restored.id), restored],
      }));
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  };

  const deleteForever = async (a: ArchivedProject) => {
    setBusyId(a.id);
    setError("");
    try {
      await invoke("delete_archived_project", { projectId: a.id });
      resetConfirm();
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  };

  const clearAll = async () => {
    setBusyId("__all__");
    setError("");
    try {
      await invoke("clear_archive");
      setClearing(false);
      setClearTyped("");
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <SettingsHeader title={t("nav.archive.title")} onBack={onBack} onClose={onClose} />
      <div className="dialog-scroll">
      <p className="settings-help">{t("archive.help")}</p>
      {error && <ErrorNote className="project-dialog-error" error={error} />}
      {items === null ? (
        <p className="settings-help">{t("common.loading")}</p>
      ) : items.length === 0 ? (
        <p className="settings-help">{t("archive.empty")}</p>
      ) : (
        <ul className="archived-projects-list">
          {items.map((a) => {
            const armed = confirmId === a.id;
            const rowBusy = busyId === a.id;
            return (
              <li key={a.id} className="archived-project-row">
                <div className="archived-project-info">
                  <span className="archived-project-name">{a.name}</span>
                  {a.remote && <span className="archived-project-tag">{t("archive.remoteTag")}</span>}
                  <span className="archived-project-date">{a.archived_at.slice(0, 10)}</span>
                </div>
                {armed ? (
                  <div className="archived-project-confirm-group">
                    {unsynced && unsynced.total > 0 && (
                      <p className="archived-project-warn">
                        <WarningIcon /> {unsynced.verified
                          ? t(unsynced.total === 1 ? "archive.unsyncedVerifiedOne" : "archive.unsyncedVerifiedMany", {
                              count: unsynced.total,
                              branches: unsynced.branches.map((b) => b.name).join(", "),
                            })
                          : t(unsynced.total === 1 ? "archive.unsyncedUnverifiedOne" : "archive.unsyncedUnverifiedMany", {
                              count: unsynced.total,
                            })}
                      </p>
                    )}
                  <div className="archived-project-confirm">
                    <input
                      type="text"
                      autoFocus
                      placeholder={t("archive.typeToDelete", { name: a.name })}
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); resetConfirm(); }
                      }}
                    />
                    <button type="button" className="settings-btn sm" onClick={resetConfirm} disabled={rowBusy}>{t("common.cancel")}</button>
                    <button
                      type="button"
                      className="settings-btn sm danger"
                      disabled={rowBusy || typed.trim() !== a.name.trim()}
                      onClick={() => void deleteForever(a)}
                    >
                      {rowBusy ? t("archive.deleting") : t("archive.deleteForever")}
                    </button>
                  </div>
                  </div>
                ) : (
                  <div className="archived-project-actions">
                    <button type="button" className="settings-btn sm" disabled={rowBusy} onClick={() => void restore(a)}>
                      {rowBusy ? t("archive.restoring") : t("archive.restore")}
                    </button>
                    <button
                      type="button"
                      className="settings-btn sm danger"
                      disabled={rowBusy}
                      onClick={() => armDelete(a)}
                    >
                      {t("archive.deletePermanently")}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {items && items.length > 0 && (
        clearing ? (
          <div className="archived-project-confirm">
            <input
              type="text"
              autoFocus
              placeholder={t("archive.typeDeleteAll")}
              value={clearTyped}
              onChange={(e) => setClearTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setClearing(false); setClearTyped(""); }
              }}
            />
            <button type="button" className="settings-btn sm" onClick={() => { setClearing(false); setClearTyped(""); }}>{t("common.cancel")}</button>
            <button
              type="button"
              className="settings-btn sm danger"
              disabled={busyId === "__all__" || clearTyped.trim().toLowerCase() !== "delete"}
              onClick={() => void clearAll()}
            >
              {busyId === "__all__" ? t("archive.clearing") : t("archive.clearArchive")}
            </button>
          </div>
        ) : (
          <div className="settings-link-row">
            <button type="button" className="danger" onClick={() => setClearing(true)}>
              {t("archive.clearArchiveEllipsis")}
            </button>
          </div>
        )
      )}
      </div>
    </>
  );
}

function ScaffoldRepairPanel({ onBack, onClose }: SubPanelProps) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<ProjectScaffoldRepair[] | null>(null);

  const run = async () => {
    setBusy(true);
    setError("");
    try {
      const repaired = await invoke<ProjectScaffoldRepair[]>("repair_all_project_scaffolds");
      setResults(repaired);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* The repair now *rewrites* untouched legacy agent stubs, not just fills
          gaps — new behavior, never run in a live window. */}
      <SettingsHeader
        title={<>{t("nav.scaffoldRepair.title")} <UntestedTag id="nav.scaffoldRepair.title" /></>}
        onBack={onBack}
        onClose={onClose}
      />
      <div className="dialog-scroll">
      <p className="settings-help">{t("scaffoldRepair.help")}</p>
      {error && <ErrorNote className="project-dialog-error" error={error} />}
      <div className="settings-link-row">
        <button type="button" className="settings-btn primary" disabled={busy} onClick={() => void run()}>
          {busy ? t("scaffoldRepair.running") : t("scaffoldRepair.runNow")}
        </button>
      </div>
      {results !== null && (
        results.length === 0 ? (
          <p className="settings-help">{t("scaffoldRepair.upToDate")}</p>
        ) : (
          <ul className="archived-projects-list">
            {results.map((r) => (
              <li key={r.projectId} className="archived-project-row">
                <div className="archived-project-info">
                  <span className="archived-project-name">{r.name}</span>
                  <span className="archived-project-date">{summarizeScaffoldRepair(r.report)}</span>
                </div>
              </li>
            ))}
          </ul>
        )
      )}
      </div>
    </>
  );
}

function HelpPanel({ onBack, onClose }: SubPanelProps) {
  const t = useT();
  return (
    <>
      <SettingsHeader title={t("help.title")} onBack={onBack} onClose={onClose} />
      <div className="dialog-scroll">

      <p className="settings-help">{t("help.intro")}</p>
      <SettingsSection title={t("settings.howToStart")} />
      <SettingsCard>
        <dl className="help-list">
          {HOW_TO_START_STEPS.map((step) => <div className="help-row" key={step.titleKey}>
            <dt>{t(step.titleKey)}</dt><dd>{t(step.bodyKey, { tip: focusModeTip(t) })}</dd>
          </div>)}
        </dl>
      </SettingsCard>

      {HELP_SECTIONS.map((section) => (
        <div key={section.titleKey} className="help-section">
          <SettingsSection
            title={t(section.titleKey)}
            help={section.hasIntro ? workspaceLayoutIntro(t) : undefined}
          />
          <dl className="help-list">
            {section.items.map((item) => (
              <div key={item.termKey} className="help-row">
                <dt>{t(item.termKey)}</dt>
                <dd>{t(item.descKey)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      </div>
    </>
  );
}

export type SettingsPanelKind = "main" | "global" | "filetypes" | "ollama" | "agents" | "shortcuts" | "git" | "vpn" | "remoteHosts" | "archive" | "scaffoldRepair" | "updates" | "help";

type SubPanel = Exclude<SettingsPanelKind, "main">;

/** The pages of the main panel, one per left-hand entry. Each page's header
 *  carries `settings-anchor-<key>` as its id (`SETTINGS_ANCHORS`), which is
 *  what a deep link names. */
const MAIN_SECTIONS = [
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
  "remoteFeatures",
  "vm",
  "mobile",
  "performance",
  "resourceMonitor",
  "experimental",
] as const;
type MainSection = (typeof MAIN_SECTIONS)[number];
type NavEntry = MainSection | SubPanel;

const anchorOf = (section: MainSection) => `settings-anchor-${section}`;
const isMainSection = (entry: NavEntry): entry is MainSection =>
  (MAIN_SECTIONS as readonly string[]).includes(entry);
function sectionOfAnchor(anchor: string | undefined): MainSection {
  const key = anchor?.replace(/^settings-anchor-/, "") ?? "";
  return isMainSection(key as NavEntry) ? (key as MainSection) : "general";
}

/** The left-hand navigation: five topic groups, every entry one page on the
 *  right — a main-panel page (`MainSection`) or a sub-panel. Group labels are
 *  `settings.group.<key>`; entry labels `settings.<section>` / `nav.<panel>.title`. */
const SETTINGS_GROUPS: { key: "general" | "workspace" | "agents" | "remote" | "system"; entries: NavEntry[] }[] = [
  { key: "general", entries: ["general", "layout", "clock", "hintsOnboarding", "shortcuts", "updates", "help"] },
  { key: "workspace", entries: ["global", "filetypes", "downloads", "browser", "calendar", "usageStats", "archive", "scaffoldRepair"] },
  { key: "agents", entries: ["agents", "ollama", "pdfMarkup", "rootConsole"] },
  { key: "remote", entries: ["remoteFeatures", "git", "remoteHosts", "vpn", "vm", "mobile"] },
  { key: "system", entries: ["performance", "resourceMonitor", "experimental"] },
];

/** What the search box matches beyond an entry's own label: the labels of the
 *  settings on that page (a sub-panel contributes its blurb). Kept as i18n keys
 *  so the search works in the UI language; a new control on a page adds its
 *  label key here, or the search will not find it. */
const SEARCH_KEYS: Record<NavEntry, TranslationKey[]> = {
  general: ["settings.theme", "settings.themeVars", "settings.language", "settings.showUntestedTags", "settings.runScriptsBg", "settings.persistLocal"],
  layout: ["settings.windowZoom", "settings.minSubWidth", "settings.minSubHeight"],
  clock: ["settings.showClockSeconds", "settings.clock24"],
  hintsOnboarding: ["settings.showHints", "settings.howToStart", "settings.lessons", "lessons.tour.title", "lessons.tourRemote.title", "settings.resetHints"],
  downloads: ["settings.addDownloadFolder"],
  browser: ["settings.browserHome", "settings.browserSearch", "settings.browserLinkTarget", "settings.browserRestoreNavigate", "settings.browserLivePages"],
  calendar: ["settings.calendarGlobalApp", "settings.todoBoard", "settings.weekStartsOn", "settings.defaultView", "settings.dayGridStart", "settings.defaultReminder"],
  usageStats: ["settings.dailyRecap", "settings.openUsageStats"],
  pdfMarkup: ["settings.pdfMarkupInstruction", "settings.pdfMarkupApply"],
  rootConsole: ["settings.rootMcp", "settings.rootMcpLocalOnly", "settings.rootMcpMail", "settings.rootMcpMailLocalOnly", "settings.rootMcpMailLocalRead", "rootReview.setting", "mcpSecurity.title"],
  remoteFeatures: ["settings.vpnEnabled", "settings.machinesEnabled", "settings.headlessRemote"],
  vm: ["settings.vmPrerequisites", "projectDialog.vmInstallBtn"],
  mobile: ["settings.mobileIndicator", "mobile.phones.only", "mobile.device.sections", "mobile.device.projects"],
  performance: ["settings.energySaver", "settings.fastMode"],
  resourceMonitor: ["settings.showCpu", "settings.showRam", "settings.showGpu", "statusCluster.settingLabel"],
  experimental: ["settings.debug", "settings.terminalWebgl", "settings.mdGraph", "settings.projectRemarks", "settings.copilotCompletion", "settings.mailClient", "settings.webBrowser", "settings.pythonRunDebug"],
  git: ["nav.git.blurb"],
  vpn: ["nav.vpn.blurb"],
  remoteHosts: ["nav.remoteHosts.blurb"],
  global: ["nav.global.blurb"],
  filetypes: ["nav.filetypes.blurb"],
  agents: ["nav.agents.blurb"],
  ollama: ["ollama.modelsTitle"],
  shortcuts: ["nav.shortcuts.blurb"],
  archive: ["nav.archive.blurb"],
  scaffoldRepair: ["nav.scaffoldRepair.blurb"],
  updates: ["nav.updates.blurb"],
  help: ["nav.help.blurb"],
};

export function SettingsDialog({
  onClose,
  initialPanel = "main",
  initialAnchor,
}: {
  onClose: () => void;
  initialPanel?: SettingsPanelKind;
  /** A `SETTINGS_ANCHORS` id naming the main-panel page to open, for a deep
   *  link from another surface (the Mobile setup guide's "Open Mobile
   *  settings"). */
  initialAnchor?: string;
}) {
  const { settings, setTheme, setLanguage, updateSettings } = useSettingsStore();
  const [panel, changePanel] = useState<SettingsPanelKind>(initialPanel);
  const [section, changeSection] = useState<MainSection>(sectionOfAnchor(initialAnchor));
  const [query, setQuery] = useState("");
  // Scroll position per page, so ‹ Back from a sub-panel — or a round trip
  // through another page — lands where the user left that page.
  const scrollBySection = useRef<Partial<Record<MainSection, number>>>({});
  const lastInitialAnchor = useRef(initialAnchor);
  const saveScroll = () => {
    if (panel !== "main") return;
    scrollBySection.current[section] = modalRef.current?.querySelector(".dialog-scroll")?.scrollTop ?? 0;
  };
  const setPanel = (next: SettingsPanelKind) => {
    saveScroll();
    changePanel(next);
  };
  const setSection = (next: MainSection) => {
    saveScroll();
    changeSection(next);
    changePanel("main");
  };
  // The theme customizer is a window of its own, not a sub-panel: it is opened
  // INSTEAD of this dialog (‹ Back returns here), so the palette it edits is
  // not judged through the settings scroll sitting on top of it.
  const [showCustomizer, setShowCustomizer] = useState(false);
  const modalRef = useModalFocus(onClose, !showCustomizer);
  const t = useT();

  const currentTheme = (settings?.color_scheme ?? "light_lavender") as Theme;
  const currentLang = (settings?.language ?? "en") as Language;
  // Through the hook, never off `settings`: unset means "not chosen", and only
  // `resolveUse24h` knows that it then follows the OS. Reading the raw key with a
  // `?? false` would show the switch off for a user whose desktop clock is in
  // fact 24-hour — a control lying about the state it is controlling.
  const use24h = useUse24h();

  // Live power state for the Energy Saver help line.
  const energyMode = settings?.energy_saver ?? "battery";
  const energyActive = useEnergySaver();
  const powerReady = usePowerStore((s) => s.ready);
  const powerSupported = usePowerStore((s) => s.supported);
  const energyStatus = (() => {
    if (energyMode === "battery" && powerReady && !powerSupported) {
      return t("settings.energyUnavailable");
    }
    if (energyActive) {
      return energyMode === "always"
        ? t("settings.energyActiveAlways")
        : t("settings.energyActiveBattery");
    }
    return energyMode === "off" ? t("settings.energyOff") : t("settings.energyInactive");
  })();

  // A deep link that arrives while the dialog is already open (the event
  // re-fires with a new anchor) opens that page too.
  useEffect(() => {
    if (lastInitialAnchor.current === initialAnchor) return;
    lastInitialAnchor.current = initialAnchor;
    if (initialAnchor) {
      changeSection(sectionOfAnchor(initialAnchor));
      changePanel("main");
    }
  }, [initialAnchor]);

  useEffect(() => {
    if (showCustomizer || panel !== "main") return;
    const scroll = modalRef.current?.querySelector(".dialog-scroll");
    if (scroll) scroll.scrollTop = scrollBySection.current[section] ?? 0;
  }, [panel, section, showCustomizer, modalRef]);

  const navigate = (value: string) => {
    if (value.startsWith("settings-anchor-")) setSection(sectionOfAnchor(value));
    else setPanel(value as SettingsPanelKind);
  };

  // The search box narrows the left-hand list to the entries whose label, or
  // the label of a setting on their page, contains every word typed.
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const navGroups = SETTINGS_GROUPS.map((group) => ({
    label: t(`settings.group.${group.key}` as TranslationKey),
    entries: group.entries.flatMap((entry) => {
      const label = isMainSection(entry)
        ? t(`settings.${entry}` as TranslationKey)
        : t(`nav.${entry}.title` as TranslationKey);
      const value = isMainSection(entry) ? anchorOf(entry) : entry;
      if (terms.length === 0) return [{ value, label }];
      const keywords = SEARCH_KEYS[entry].map((key) => t(key));
      const haystack = [label, ...keywords].join("\n").toLowerCase();
      if (!terms.every((term) => haystack.includes(term))) return [];
      const hits = keywords
        .filter((keyword) => terms.some((term) => keyword.toLowerCase().includes(term)))
        .slice(0, 3);
      return [{ value, label, hits }];
    }),
  })).filter((group) => group.entries.length > 0);

  if (showCustomizer) {
    return (
      <ThemeCustomizerDialog
        onClose={onClose}
        onBack={() => setShowCustomizer(false)}
      />
    );
  }

  return (
    <div className="modal-backdrop how-to-start-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("settings.title")} className="settings-dialog settings-with-navigation" onMouseDown={(e) => e.stopPropagation()}>
        <SettingsNavigation
          value={panel === "main" ? anchorOf(section) : panel}
          groups={navGroups}
          onChange={navigate}
          query={query}
          onQuery={setQuery}
        />
        <div className="settings-panel-content">
        {panel === "main" && (
          <>
            <SettingsHeader title={<>{t("settings.title")} <UntestedTag id="desktop.settingsNavigation" /></>} onClose={onClose} />
            <div className="dialog-scroll">
            {section === "general" && (<>
            <SettingsSection title={t("settings.general")} anchor="settings-anchor-general" />

            <SettingRow
              label={t("settings.theme")}
              control={
                <Dropdown
                  value={currentTheme}
                  onChange={(v) => void setTheme(v as Theme)}
                  options={THEMES.map((theme) => ({ value: theme.value, label: t(theme.labelKey) }))}
                />
              }
            />

            <SettingRow
              label={<>{t("settings.themeVars")} <UntestedTag id="settings.themeVars" /></>}
              help={t("settings.themeVars.help")}
              control={
                <button
                  type="button"
                  className="settings-btn"
                  onClick={() => {
                    saveScroll();
                    setShowCustomizer(true);
                  }}
                >
                  {t("settings.themeVars.open")}
                </button>
              }
            />

            <SettingRow
              label={<>{t("settings.language")} <UntestedTag id="settings.language" /></>}
              help={t("settings.language.help")}
              control={
                <Dropdown
                  value={currentLang}
                  onChange={(v) => void setLanguage(v as Language)}
                  options={LANGUAGES.map((l) => ({ value: l.value, label: l.label }))}
                />
              }
            />

            <ToggleCard
              label={<>{t("settings.showUntestedTags")} <UntestedTag id="settings.showUntestedTags" /></>}
              help={t("settings.showUntestedTags.help")}
              checked={settings?.show_untested_tags ?? false}
              onChange={(e) => void updateSettings({ show_untested_tags: e.target.checked })}
            />

            <ToggleCard
              label={t("settings.runScriptsBg")}
              checked={settings?.run_scripts_in_background ?? true}
              onChange={(e) => void updateSettings({ run_scripts_in_background: e.target.checked })}
            />

            {!IS_WINDOWS && (
              <ToggleCard
                label={t("settings.persistLocal")}
                checked={settings?.persist_local_sessions ?? true}
                onChange={(e) => void updateSettings({ persist_local_sessions: e.target.checked })}
                help={
                  <>
                    {t("settings.persistLocalHelp1")} <code>tmux</code>
                    {t("settings.persistLocalHelp2")}
                  </>
                }
              />
            )}
            </>)}

            {section === "layout" && (<>
            <SettingsSection
              anchor="settings-anchor-layout" title={<>{t("settings.layout")} <UntestedTag id="settings.layout" /></>}
              help={
                <>
                  {t("settings.zoomHelp1")} <strong>{t("settings.zoomHelpBold")}</strong>
                  {t("settings.zoomHelp2")}
                </>
              }
            />
            <WorkspaceParkingNote />
            <SettingRow
              label={t("settings.windowZoom")}
              control={
                <Dropdown
                  value={String(clampZoom(settings?.ui_zoom))}
                  onChange={(v) => {
                    const z = parseFloat(v);
                    void updateSettings({
                      ui_zoom: z === 1 ? undefined : clampZoom(z),
                    });
                  }}
                  options={ZOOM_STEPS.filter(
                    (z) => z >= MIN_UI_ZOOM && z <= MAX_UI_ZOOM,
                  ).map((z) => ({
                    value: String(z),
                    label: `${Math.round(z * 100)}%${z === 1 ? ` (${t("common.default")})` : ""}`,
                  }))}
                />
              }
            />
            {/* Both minimums answer one question, so one card holds them and
                the help line that explains the pair sits at its foot. */}
            <SettingsCard>
              <div className="settings-card-row">
                <label className="settings-card-label" htmlFor="min-subwindow-width">
                  {t("settings.minSubWidth")}
                </label>
                <input
                  id="min-subwindow-width"
                  type="number"
                  min={20}
                  step={10}
                  placeholder={String(DEFAULT_MIN_SUBWINDOW_PX)}
                  value={settings?.min_subwindow_width ?? ""}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    void updateSettings({
                      min_subwindow_width: Number.isFinite(v) && v >= 20 ? v : undefined,
                    });
                  }}
                />
              </div>
              <div className="settings-card-row">
                <label className="settings-card-label" htmlFor="min-subwindow-height">
                  {t("settings.minSubHeight")}
                </label>
                <input
                  id="min-subwindow-height"
                  type="number"
                  min={20}
                  step={10}
                  placeholder={String(DEFAULT_MIN_SUBWINDOW_PX)}
                  value={settings?.min_subwindow_height ?? ""}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    void updateSettings({
                      min_subwindow_height: Number.isFinite(v) && v >= 20 ? v : undefined,
                    });
                  }}
                />
              </div>
              <p className="settings-help">
                {t("settings.minSubwindowHelp", { px: DEFAULT_MIN_SUBWINDOW_PX })}
              </p>
            </SettingsCard>
            </>)}

            {section === "clock" && (<>
            {/* The clock lives in its own section, not under Resource monitor:
                seconds and the 12/24-hour face are time, not CPU/RAM/GPU. */}
            <SettingsSection anchor="settings-anchor-clock" title={t("settings.clock")} />
            <SettingsCard>
              <ToggleRow
                label={t("settings.showClockSeconds")}
                checked={settings?.show_clock_seconds ?? false}
                onChange={(e) => void updateSettings({ show_clock_seconds: e.target.checked })}
              />
              {/* App-wide, and here rather than under Calendar (where it used to
                  live as a calendar-only switch): a clock is not a property of
                  one feature, and reading 17:00 in the calendar beside 5:00 PM
                  on a to-do card is one app disagreeing with itself. Unset
                  follows the OS clock, which is why the help line says what
                  the default is rather than leaving the off position to imply
                  it — see `lib/timeFormat.ts`. */}
              <ToggleRow
                label={t("settings.clock24")}
                checked={use24h}
                onChange={(e) => void updateSettings({ time_format_24h: e.target.checked })}
              />
              <p className="settings-help">{t("settings.clock24Help")}</p>
            </SettingsCard>
            </>)}

            {section === "hintsOnboarding" && (<>
            <SettingsSection anchor="settings-anchor-hintsOnboarding" title={t("settings.hintsOnboarding")} />
            <ToggleCard
              label={t("settings.showHints")}
              checked={settings?.hints_enabled ?? true}
              onChange={(e) => void updateSettings({ hints_enabled: e.target.checked })}
            />
            <div className="settings-link-row">
              <button
                type="button"
                className="settings-btn"
                onClick={() => {
                  onClose();
                  window.dispatchEvent(new Event("app:open-how-to-start"));
                }}
              >
                {t("settings.howToStart")}
              </button>
              <button
                type="button"
                className="settings-btn"
                onClick={() => {
                  onClose();
                  window.dispatchEvent(new Event("app:open-lessons"));
                }}
              >
                {t("settings.lessons")}
              </button>
              <button
                type="button"
                className="settings-btn"
                onClick={() => useHintsStore.getState().reset()}
              >
                {t("settings.resetHints")}
              </button>
            </div>
            </>)}

            {section === "downloads" && (<>
            <SettingsSection
              anchor="settings-anchor-downloads" title={t("settings.downloads")}
              help={t("settings.downloadsHelp")}
            />
            <SettingsList boxed>
              {(settings?.download_sources ?? []).length === 0 ? (
                <div className="settings-empty">
                  {t("settings.noDownloadFolders")}
                </div>
              ) : (
                (settings?.download_sources ?? []).map((dir) => (
                  <div key={dir} className="settings-row">
                    <span className="settings-list-label" title={dir}>
                      {dir}
                    </span>
                    <button
                      type="button"
                      className="settings-btn sm"
                      onClick={() =>
                        void updateSettings({
                          download_sources: (settings?.download_sources ?? []).filter(
                            (d) => d !== dir,
                          ),
                        })
                      }
                      title={t("settings.removeFolderTitle")}
                    >
                      {t("common.remove")}
                    </button>
                  </div>
                ))
              )}
            </SettingsList>
            <div className="settings-link-row">
              <button
                type="button"
                className="settings-btn"
                onClick={() => {
                  void (async () => {
                    const picked = await openDialog({
                      directory: true,
                      multiple: false,
                    }).catch(() => null);
                    if (!picked || Array.isArray(picked)) return;
                    const current = settings?.download_sources ?? [];
                    if (current.includes(picked)) return;
                    void updateSettings({ download_sources: [...current, picked] });
                  })();
                }}
              >
                {t("settings.addDownloadFolder")}
              </button>
            </div>
            </>)}

            {section === "browser" && (<>
            {/* The in-app browser (#61). Everything here is a *preference*; the
                navigation policy, the permission defaults and the download rule
                are the backend's and are not configurable — a "trusted sites"
                list or an "ignore certificate errors" switch is exactly the kind
                of relaxation that outlives the reason for it, so none exists. */}
            <SettingsSection anchor="settings-anchor-browser" title={<>{t("settings.browser")} <UntestedTag id="settings.browser" /></>} />
            <SettingRow
              htmlFor="browser-home-url"
              label={t("settings.browserHome")}
              help={t("settings.browserHomeHelp")}
              control={
                <input
                  id="browser-home-url"
                  type="text"
                  value={settings?.browser_home_url ?? ""}
                  placeholder={t("settings.browserHomePlaceholder")}
                  onChange={(e) => void updateSettings({ browser_home_url: e.target.value })}
                />
              }
            />
            <SettingRow
              htmlFor="browser-search-template"
              label={t("settings.browserSearch")}
              help={t("settings.browserSearchHelp")}
              control={
                <input
                  id="browser-search-template"
                  type="text"
                  value={settings?.browser_search_template ?? ""}
                  placeholder="https://duckduckgo.com/?q=%s"
                  onChange={(e) => void updateSettings({ browser_search_template: e.target.value })}
                />
              }
            />
            <SettingRow
              label={t("settings.browserLinkTarget")}
              help={t("settings.browserLinkTargetHelp")}
              control={
                <Dropdown
                  value={settings?.browser_link_target ?? "external"}
                  onChange={(v) =>
                    void updateSettings({ browser_link_target: v as LinkOpenTarget })
                  }
                  options={[
                    { value: "external", label: t("settings.browserLinkTargetExternal") },
                    { value: "in_app", label: t("settings.browserLinkTargetInApp") },
                    { value: "ask", label: t("settings.browserLinkTargetAsk") },
                  ]}
                />
              }
            />
            <ToggleCard
              label={t("settings.browserRestoreNavigate")}
              checked={settings?.browser_restore_navigate ?? false}
              onChange={(e) =>
                void updateSettings({ browser_restore_navigate: e.target.checked })
              }
              help={t("settings.browserRestoreNavigateHelp")}
            />
            {/* Deliberately `?? false` and NOT `useExperimental` — this is the one
                browser switch that must stay off in a debug build too. */}
            <ToggleCard
              label={t("settings.browserLivePages")}
              checked={settings?.browser_live_pages ?? false}
              onChange={(e) => void updateSettings({ browser_live_pages: e.target.checked })}
              help={t("settings.browserLivePagesHelp")}
            />
            </>)}

            {section === "calendar" && (<>
            <SettingsSection anchor="settings-anchor-calendar" title={t("settings.calendar")} />

            {/* The calendar's twin of "Mail in the header". Not nested under
                anything: the calendar is shipped, not experimental. */}
            <ToggleCard
              label={<>{t("settings.calendarGlobalApp")} <UntestedTag id="settings.calendarGlobalApp" /></>}
              checked={settings?.calendar_global_app ?? false}
              onChange={(e) => void updateSettings({ calendar_global_app: e.target.checked })}
              help={t("settings.calendarGlobalAppHelp")}
            />

            {/* The to-do board sits under Calendar because that is literally
                where its cards live: they ARE this calendar's tasks, so the
                board is a second view of the store above, not a second store. */}
            <ToggleCard
              label={<>{t("settings.todoBoard")} <UntestedTag id="settings.todoBoard" /></>}
              checked={settings?.todo_board ?? false}
              onChange={(e) => void updateSettings({ todo_board: e.target.checked })}
              help={t("settings.todoBoardHelp")}
            />

            {/* The four calendar defaults are one question ("how should the
                calendar open?"), so they share a card and read as a group. */}
            <SettingsCard>
              <div className="settings-card-row">
                <span>{t("settings.weekStartsOn")}</span>
                <Dropdown
                  value={String(settings?.calendar_week_start ?? 1)}
                  onChange={(v) =>
                    void updateSettings({ calendar_week_start: Number(v) === 0 ? 0 : 1 })
                  }
                  options={[
                    { value: "0", label: t("day.sunday") },
                    { value: "1", label: t("day.monday") },
                  ]}
                />
              </div>
              <div className="settings-card-row">
                <span>{t("settings.defaultView")}</span>
                <Dropdown
                  value={settings?.calendar_default_view ?? "month"}
                  onChange={(v) =>
                    void updateSettings({ calendar_default_view: v as CalendarViewKind })
                  }
                  options={[
                    { value: "day", label: t("view.day") },
                    { value: "week", label: t("view.week") },
                    { value: "multiweek", label: t("view.multiweek") },
                    { value: "month", label: t("view.month") },
                    { value: "agenda", label: t("view.agenda") },
                    { value: "tasks", label: t("view.tasks") },
                  ]}
                />
              </div>
              <div className="settings-card-row">
                <span>{t("settings.dayGridStart")}</span>
                <Dropdown
                  value={String(settings?.calendar_day_start_hour ?? 8)}
                  onChange={(v) => void updateSettings({ calendar_day_start_hour: Number(v) })}
                  options={Array.from({ length: 24 }, (_, h) => ({
                    value: String(h),
                    label: `${String(h).padStart(2, "0")}:00`,
                  }))}
                />
              </div>
              <div className="settings-card-row">
                <span>{t("settings.defaultReminder")}</span>
                <Dropdown
                  value={String(settings?.calendar_default_reminder_minutes ?? 0)}
                  onChange={(v) =>
                    void updateSettings({ calendar_default_reminder_minutes: Number(v) })
                  }
                  options={[
                    { value: "0", label: t("reminder.none") },
                    { value: "5", label: t("reminder.5") },
                    { value: "15", label: t("reminder.15") },
                    { value: "30", label: t("reminder.30") },
                    { value: "60", label: t("reminder.60") },
                    { value: "1440", label: t("reminder.1440") },
                  ]}
                />
              </div>
              <p className="settings-help">{t("settings.reminderHelp")}</p>
            </SettingsCard>
            </>)}

            {section === "usageStats" && (<>
            <SettingsSection anchor="settings-anchor-usageStats" title={t("settings.usageStats")} />
            <ToggleCard
              label={t("settings.dailyRecap")}
              checked={settings?.daily_stats_recap ?? true}
              onChange={(e) => void updateSettings({ daily_stats_recap: e.target.checked })}
              help={t("settings.dailyRecapHelp")}
            />
            <div className="settings-link-row">
              <button
                type="button"
                className="settings-btn primary"
                onClick={() => {
                  onClose();
                  window.dispatchEvent(new CustomEvent(OPEN_STATS_EVENT));
                }}
              >
                {t("settings.openUsageStats")}
              </button>
            </div>
            </>)}

            {section === "pdfMarkup" && (<>
            {/* The desktop PDF viewer's Mark up prompts — the desktop's own, as
                the phone keeps its own (Home → This phone → Mark up prompt).
                Blank = the default, shown as the starting text. */}
            <SettingsSection anchor="settings-anchor-pdfMarkup" title={<>{t("settings.pdfMarkup")} <UntestedTag id="desktop.markup.apply" /></>} help={t("settings.pdfMarkupHelp")} />
            <PdfMarkupPromptCard
              id="pdf-markup-instruction"
              label={t("settings.pdfMarkupInstruction")}
              help={t("settings.pdfMarkupInstructionHelp")}
              value={settings?.pdf_markup_instruction}
              fallback={DEFAULT_PDF_MARKUP_INSTRUCTION}
              onChange={(value) => void updateSettings({ pdf_markup_instruction: value })}
            />
            <PdfMarkupPromptCard
              id="pdf-markup-apply"
              label={t("settings.pdfMarkupApply")}
              help={t("settings.pdfMarkupApplyHelp")}
              value={settings?.pdf_markup_apply}
              fallback={DEFAULT_PDF_MARKUP_APPLY}
              onChange={(value) => void updateSettings({ pdf_markup_apply: value })}
            />
            </>)}

            {section === "rootConsole" && (<>
            {/* Root console: the MCP endpoint every agent session may reach.
                Its own page under Agents rather than a tail of General — it
                is the app's most consequential switch group. */}
            <SettingsSection anchor="settings-anchor-rootConsole" title={t("settings.rootConsole")} />
            {/* Absent means on. The backend reads the key per spawn and per
                request, so the switch needs no restart in either direction. */}
            <ToggleCard
              label={<>{t("settings.rootMcp")} <UntestedTag id="settings.rootMcp" /></>}
              checked={settings?.root_mcp ?? true}
              onChange={(e) => void updateSettings({ root_mcp: e.target.checked })}
              help={t("settings.rootMcpHelp")}
            />
            {/* Subordinate to the switch above. Read per spawn and per request
                too: on, the endpoint refuses the cloud agents already running. */}
            <ToggleCard
              label={<>{t("settings.rootMcpLocalOnly")} <UntestedTag id="settings.rootMcpLocalOnly" /></>}
              checked={settings?.root_mcp_local_only ?? false}
              disabled={!(settings?.root_mcp ?? true)}
              onChange={(e) => void updateSettings({ root_mcp_local_only: e.target.checked })}
              help={t("settings.rootMcpLocalOnlyHelp")}
            />
            {/* Its own switch, absent means off: the tools above never bring
                mail with them. Read per request, like the two above. */}
            <ToggleCard
              label={<>{t("settings.rootMcpMail")} <UntestedTag id="settings.rootMcpMail" /></>}
              checked={settings?.root_mcp_mail ?? false}
              disabled={!(settings?.root_mcp ?? true)}
              onChange={(e) => void updateSettings({ root_mcp_mail: e.target.checked })}
              help={t("settings.rootMcpMailHelp")}
            />
            {/* Subordinate to the mail switch: narrows mail alone, where the
                local-only switch above narrows every tool. Absent means off;
                read per request, so running cloud agents lose mail at once. */}
            <ToggleCard
              label={<>{t("settings.rootMcpMailLocalOnly")} <UntestedTag id="settings.rootMcpMailLocalOnly" /></>}
              checked={settings?.root_mcp_mail_local_only ?? false}
              disabled={!(settings?.root_mcp ?? true) || !(settings?.root_mcp_mail ?? false)}
              onChange={(e) => void updateSettings({ root_mcp_mail_local_only: e.target.checked })}
              help={t("settings.rootMcpMailLocalOnlyHelp")}
            />
            {/* The one way a root tab reads mail: a local model, marked mails
                only, loopback Ollama only (`Policy::reads_mail`). Absent means
                off; read per request. */}
            <ToggleCard
              label={<>{t("settings.rootMcpMailLocalRead")} <UntestedTag id="settings.rootMcpMailLocalRead" /></>}
              checked={settings?.root_mcp_mail_local_read ?? false}
              disabled={!(settings?.root_mcp ?? true) || !(settings?.root_mcp_mail ?? false)}
              onChange={(e) => void updateSettings({ root_mcp_mail_local_read: e.target.checked })}
              help={t("settings.rootMcpMailLocalReadHelp")}
            />

            <SettingRow
              label={<>{t("rootReview.setting")} <UntestedTag id="rootReview.setting" /></>}
              control={<Dropdown
                value={settings?.root_mcp_review ?? "all"}
                disabled={!(settings?.root_mcp ?? true)}
                options={[
                  { value: "all", label: t("rootReview.levelAll") },
                  { value: "destructive", label: t("rootReview.levelDestructive") },
                  { value: "off", label: t("rootReview.levelOff") },
                ]}
                onChange={(value) => void updateSettings({ root_mcp_review: value as "all" | "destructive" | "off" })}
              />}
              help={t("rootReview.settingHelp")}
            />

            <SettingsAdvanced title={t("mcpSecurity.title")}>
              <RootMcpSecurity />
            </SettingsAdvanced>
            </>)}

            {section === "remoteFeatures" && (<>
            <SettingsSection anchor="settings-anchor-remoteFeatures" title={t("settings.remoteFeatures")} />
            <SettingsCard>
              <ToggleRow
                label={t("settings.vpnEnabled")}
                checked={settings?.vpn_enabled ?? false}
                onChange={(e) => void updateSettings({ vpn_enabled: e.target.checked })}
              />
              <ToggleRow
                label={t("settings.machinesEnabled")}
                checked={settings?.machines_enabled ?? false}
                onChange={(e) => void updateSettings({ machines_enabled: e.target.checked })}
              />
              <p className="settings-help">{t("settings.remoteFeaturesHelp")}</p>
            </SettingsCard>

            <ToggleCard
              label={t("settings.headlessRemote")}
              checked={settings?.connections_headless ?? true}
              onChange={(e) => void updateSettings({ connections_headless: e.target.checked })}
              help={t("settings.headlessRemoteHelp")}
            />
            </>)}

            {section === "vm" && (<>
            <SettingsSection anchor="settings-anchor-vm" title={t("settings.vm")} />
            <VmInstallSettings />
            </>)}

            {section === "mobile" && (<>
            {/* Tabtivity Mobile runs its host sidecar on every desktop (systemd
                user unit, launchd agent, or the Windows Run key), so the
                section is not platform-gated. */}
            <SettingsSection title={t("settings.mobile")} anchor={SETTINGS_ANCHORS.mobile} />
            <MobileSettings />
            <ToggleCard
              label={t("settings.mobileIndicator")}
              checked={settings?.mobile_indicator ?? true}
              onChange={(e) => void updateSettings({ mobile_indicator: e.target.checked })}
              help={t("settings.mobileIndicatorHelp")}
            />
            </>)}

            {section === "performance" && (<>
            <SettingsSection anchor="settings-anchor-performance" title={t("settings.performance")} />
            <SettingRow
              label={t("settings.energySaver")}
              help={<>{t("settings.energyHelp")} {energyStatus}</>}
              control={
                <Dropdown
                  value={energyMode}
                  onChange={(v) => void updateSettings({ energy_saver: v as "off" | "battery" | "always" })}
                  options={[
                    { value: "off", label: t("energy.off") },
                    { value: "battery", label: t("energy.battery") },
                    { value: "always", label: t("energy.always") },
                  ]}
                />
              }
            />

            {/* Beside Energy Saver rather than folded into it: that one widens
                timers off a live battery reading, this removes features off a
                standing preference, and "plugged in, still want it lean" is the
                case a merged control could not express. `lib/agents/fastMode` holds the
                list of what goes — the help string above mirrors it. */}
            <ToggleCard
              label={
                <>
                  {t("settings.fastMode")} <UntestedTag id="settings.fastMode" />
                </>
              }
              checked={settings?.fast_mode === true}
              onChange={(e) => void updateSettings({ fast_mode: e.target.checked })}
              help={t("settings.fastModeHelp")}
            />
            </>)}

            {section === "resourceMonitor" && (<>
            <SettingsSection anchor="settings-anchor-resourceMonitor" title={t("settings.resourceMonitor")} />
            <SettingsCard>
              <ToggleRow
                label={t("settings.showCpu")}
                checked={settings?.show_cpu_usage ?? true}
                onChange={(e) => void updateSettings({ show_cpu_usage: e.target.checked })}
              />
              <ToggleRow
                label={t("settings.showRam")}
                checked={settings?.show_ram_usage ?? true}
                onChange={(e) => void updateSettings({ show_ram_usage: e.target.checked })}
              />
              <ToggleRow
                label={t("settings.showGpu")}
                checked={settings?.show_gpu_usage ?? true}
                onChange={(e) => void updateSettings({ show_gpu_usage: e.target.checked })}
              />
              <p className="settings-help">{t("settings.resourceMonitorHelp")}</p>
              {/* The fold is normally driven by the ‹/› in the header itself;
                  this row is here so it is findable, and so the default can be
                  turned off by someone who wants every lamp out permanently. */}
              <ToggleRow
                label={
                  <>
                    {t("statusCluster.settingLabel")} <UntestedTag id="statusCluster.settingLabel" />
                  </>
                }
                title={t("statusCluster.settingHelp")}
                checked={!(settings?.header_status_expanded ?? false)}
                onChange={(e) =>
                  void updateSettings({ header_status_expanded: !e.target.checked })
                }
              />
              <p className="settings-help">{t("statusCluster.settingHelp")}</p>
            </SettingsCard>
            </>)}

            {section === "experimental" && (<>
            <SettingsSection
              anchor="settings-anchor-experimental" title={t("settings.experimental")}
              help={
                <>
                  {t("settings.experimentalHelp1")}{" "}
                  <b>{t("settings.experimentalHelpBold")}</b> {t("settings.experimentalHelp2")}{" "}
                  {t("settings.experimentalHelp3")}
                </>
              }
            />

            {/* Debug mode sits with the experiments because it is their fallback
                gate: an unset experiment flag follows it (`lib/experimental`). */}
            <ToggleCard
              label={t("settings.debug")}
              checked={settings?.debug ?? false}
              onChange={(e) => void updateSettings({ debug: e.target.checked })}
            />


            {/* An experiment rather than the default because WebGL rides the
                GPU/driver path the DMABUF re-test failed on (flicker, missing
                content, renderer crash — docs/typing_latency_plan.md Step 4):
                canvas is the safe renderer, and a terminal whose WebGL fails
                demotes itself back to it (TerminalView's renderer ladder). */}
            <ToggleCard
              label={<>{t("settings.terminalWebgl")} <UntestedTag id="settings.terminalWebgl" /></>}
              checked={experimentalEnabled(settings, "terminal_webgl")}
              onChange={(e) => void updateSettings({ terminal_webgl: e.target.checked })}
              help={t("settings.terminalWebglHelp")}
            />

            <ToggleCard
              label={<>{t("settings.mdGraph")} <UntestedTag id="settings.mdGraph" /></>}
              checked={experimentalEnabled(settings, "md_graph")}
              onChange={(e) => void updateSettings({ md_graph: e.target.checked })}
              help={t("settings.mdGraphHelp")}
            />

            <ToggleCard
              label={<>{t("settings.projectRemarks")} <UntestedTag id="settings.projectRemarks" /></>}
              checked={experimentalEnabled(settings, "project_remarks")}
              onChange={(e) => void updateSettings({ project_remarks: e.target.checked })}
              help={t("settings.projectRemarksHelp")}
            />

            <ToggleCard
              label={<>{t("settings.copilotCompletion")} <UntestedTag id="settings.copilotCompletion" /></>}
              checked={experimentalEnabled(settings, "copilot_completion")}
              onChange={(e) => void updateSettings({ copilot_completion: e.target.checked })}
              help={t("settings.copilotCompletionHelp")}
            />
            {experimentalEnabled(settings, "copilot_completion") && <CopilotCompletionCard />}

            {/* Mail is ONE switch. It used to be two — this gate plus a
                `mail_global_app` sub-toggle deciding whether the header button
                appeared *as well as* the mail tab — but the tab is retired, so
                the overlay is the only surface and a second switch could only
                ever mean "mail on, and unreachable". The interval check stays
                nested because it is genuinely a different question (how often to
                dial out), and it is the one part of the feature that reaches the
                network without a click. The browser below still owns a whole TAB,
                so switching *it* off closes what it opened — see
                lib/experimentalSweep. */}
            <SettingsCard>
              <ToggleRow
                label={<>{t("settings.mailClient")} <UntestedTag id="settings.mailClient" /></>}
                checked={experimentalEnabled(settings, "mail_client")}
                onChange={(e) => void updateSettings({ mail_client: e.target.checked })}
              />
              <p className="settings-help">{t("settings.mailClientHelp")}</p>
              {experimentalEnabled(settings, "mail_client") && (
                <>
                  <div className="settings-card-row">
                    <span>{t("settings.mailCheckInterval")}</span>
                    <Dropdown
                      value={String(
                        settings?.mail_check_interval_min ?? DEFAULT_MAIL_CHECK_MIN,
                      )}
                      onChange={(v) =>
                        void updateSettings({ mail_check_interval_min: Number(v) })
                      }
                      options={[
                        { value: "0", label: t("settings.mailCheckNever") },
                        { value: "5", label: t("settings.mailCheckMinutes", { count: 5 }) },
                        { value: "10", label: t("settings.mailCheckMinutes", { count: 10 }) },
                        { value: "15", label: t("settings.mailCheckMinutes", { count: 15 }) },
                        { value: "30", label: t("settings.mailCheckMinutes", { count: 30 }) },
                        { value: "60", label: t("settings.mailCheckMinutes", { count: 60 }) },
                      ]}
                    />
                  </div>
                  <p className="settings-help">{t("settings.mailCheckIntervalHelp")}</p>
                </>
              )}
            </SettingsCard>

            <ToggleCard
              label={t("settings.webBrowser")}
              checked={experimentalEnabled(settings, "web_browser")}
              onChange={(e) => void updateSettings({ web_browser: e.target.checked })}
              help={
                <>
                  {t("settings.webBrowserHelp1")} <b>{t("browser.readerMode")}</b>{" "}
                  {t("settings.webBrowserHelp2")}
                </>
              }
            />

            <ToggleCard
              label={t("settings.pythonRunDebug")}
              checked={experimentalEnabled(settings, "python_run_debug")}
              onChange={(e) => void updateSettings({ python_run_debug: e.target.checked })}
              help={
                <>
                  {t("settings.pythonRunHelp1")} <code>.py</code> {t("settings.pythonRunHelp2")}{" "}
                  <b><PlayIcon /> {t("fileViewer.runLabel")}</b> {t("settings.pythonRunHelp3")} <b><BugIcon /> {t("fileViewer.debugLabel")}</b>{" "}
                  {t("settings.pythonRunHelp4")} <code>pdb</code>
                  {t("settings.pythonRunHelp5")}
                </>
              }
            />

            {/* Mail AI (local) — Group Q #203 — is configured **per account**
                now, from the mail toolbar (a bordered group with the global
                master switch and per-account quick-toggle tags), not here. There
                are deliberately no global per-feature toggles in this panel. */}
            </>)}
            </div>
          </>
        )}
        {panel === "global" && <GlobalAppsSettings onBack={() => setPanel("main")} onClose={onClose} />}
        {panel === "filetypes" && <FileTypeSettings onBack={() => setPanel("main")} onClose={onClose} />}
        {panel === "ollama" && <OllamaPanel onBack={() => setPanel("main")} onClose={onClose} />}
        {panel === "agents" && <AgentsPanel onBack={() => setPanel("main")} onClose={onClose} />}
        {panel === "shortcuts" && <ShortcutsSettings onBack={() => setPanel("main")} onClose={onClose} />}
        {panel === "git" && <GitHostingSettings onBack={() => setPanel("main")} onClose={onClose} />}
        {panel === "vpn" && <VpnAutoConnectSettings onBack={() => setPanel("main")} onClose={onClose} />}
        {panel === "remoteHosts" && <RemoteHostsSettings onBack={() => setPanel("main")} onClose={onClose} />}
        {panel === "archive" && <ArchivedProjectsPanel onBack={() => setPanel("main")} onClose={onClose} />}
        {panel === "scaffoldRepair" && <ScaffoldRepairPanel onBack={() => setPanel("main")} onClose={onClose} />}
        {panel === "updates" && <UpdatesPanel onBack={() => setPanel("main")} onClose={onClose} />}
        {panel === "help" && <HelpPanel onBack={() => setPanel("main")} onClose={onClose} />}
        </div>
      </div>
    </div>
  );
}
