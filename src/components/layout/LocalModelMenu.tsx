import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/settings";
import { useQuiesce, saverInterval } from "../../stores/power";
import { useOllamaAutoloadStore } from "../../stores/agents/ollamaAutoload";
import {
  initLocalModelEvents,
  useOllamaActivityStore,
  type LocalModelInfo,
} from "../../stores/agents/ollamaActivity";
import { useOllamaStatus } from "../../lib/ollamaStatus";
import { UntestedTag } from "../common/UntestedTag";
import { useT } from "../../lib/i18n";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useModelsOverlayStore } from "../../stores/modelsOverlay";
import { ModelsGlyph } from "../header/HeaderGlyphs";
import { LOCAL_MODEL_MENU_ID, useAutoloadNotice, useModelsHub } from "../models/useModelsHub";
import { AgentChips, LocalModelsSection, MachineMeters, MODEL_ROLES } from "../models/ModelsHubSections";

const MENU_ID = LOCAL_MODEL_MENU_ID;

/**
 * Header button (left of the ⚙ settings button) for the local (Ollama) models.
 * Hovering reveals the models currently loaded in memory (the running set from
 * `list_ollama_models_detailed`), each shown with a green "loaded" lamp. Clicking
 * a model's name makes it the default (`settings.ollama_model`); its task tags
 * (Autocomplete / Tabs / Mail → `settings.ollama_roles`) pin individual jobs
 * to specific loaded models, so several can run different tasks in parallel. A
 * task with no tag falls back to the default model. Always shown: when Ollama
 * isn't installed (or no models are present yet) the menu offers an "Install
 * Ollama…" entry that opens the overlay's Ollama tab, where Ollama itself and
 * any model can be installed.
 *
 * A **click** opens the Models & agents overlay (`models/ModelsOverlay`); the
 * hover dropdown stays as it was, and every door in it opens one of the
 * overlay's tabs. The menu's body lives in `models/useModelsHub` and
 * `models/ModelsHubSections`, shared with that overlay; what stays here is the
 * button, the hover frame, the `installed` poll, the progress-event
 * subscription (`stores/agents/ollamaActivity`) and the sole-resident →
 * every-role effect, which has one owner by construction.
 */
export function LocalModelMenu() {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const activeModel = settings?.ollama_model;
  const quiesce = useQuiesce();
  // Session facts shared with the Models & agents overlay
  // (`stores/agents/ollamaActivity`): this menu owns the `installed` poll and
  // the event subscription, everyone else reads.
  const installed = useOllamaActivityStore((s) => s.installed);
  const models = useOllamaActivityStore((s) => s.models);
  // Three-state Ollama health for the status lamp: "stopped" (server down, red),
  // "idle" (server up, no model in memory, yellow), "loaded" (a model is loaded
  // in memory, green).
  // Once Ollama is installed, the server's health is polled so the button shows a
  // live lamp without the user opening the menu. The poll itself is the app-wide
  // shared one (`lib/ollamaStatus`) — it is a machine-wide fact, and the file
  // viewer asks the same question per open tab, so a timer here as well meant the
  // same `/api/ps` round trip several times over.
  const status = useOllamaStatus(installed, saverInterval(5000, quiesce));
  // Shared across every header hover-menu (stores/headerHoverMenu) so switching
  // straight from another one closes it instantly instead of racing its own
  // close-grace timer. `setOpen` mirrors the old local-state setter's boolean
  // signature so the rest of this component reads unchanged.
  const open = useHeaderHoverMenuStore((s) => s.openId === MENU_ID);
  const openMenu = useHeaderHoverMenuStore((s) => s.open);
  const closeMenu = useHeaderHoverMenuStore((s) => s.close);
  const setOpen = (v: boolean) => (v ? openMenu(MENU_ID) : closeMenu(MENU_ID));
  // Everything the menu lists and does, shared with the overlay's Local models
  // tab (`models/useModelsHub`); its polls run while the menu is open.
  const hub = useModelsHub(open);
  const closeTimer = useRef<number | null>(null);
  // The click's surface: the Models & agents overlay (`models/ModelsOverlay`).
  const overlayOpen = useModelsOverlayStore((s) => s.open);
  const btnRef = useRef<HTMLButtonElement>(null);
  // Set for the one focus that returns the button its focus after the overlay
  // closes, so that focus does not pop the dropdown open (`onFocus` reveals).
  const skipRevealRef = useRef(false);
  // Whether the pointer is over the button or its dropdown (`onBlur` below).
  const pointerInRef = useRef(false);

  // The pull / load progress events, into the shared store (ref-counted).
  useEffect(() => initLocalModelEvents(), []);

  // Detect whether Ollama is installed. Poll while it's still missing so that
  // installing Ollama mid-session is picked up without restarting Tabtivity; stop
  // once detected (it won't be uninstalled live, and `ollama_status` polling
  // takes over from here — see below).
  useEffect(() => {
    if (installed) return;
    let cancelled = false;
    const check = () =>
      invoke<boolean>("ollama_is_installed")
        .then((ok) => {
          if (!cancelled) useOllamaActivityStore.getState().setInstalled(ok);
        })
        .catch(() => {});
    void check();
    const id = window.setInterval(check, saverInterval(5000, quiesce));
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [installed, quiesce]);

  const reveal = () => {
    // One consumer at a time: while the overlay is up it is the surface, and
    // keyboard focus can still reach this button under it.
    if (useModelsOverlayStore.getState().open) return;
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
    // Agents, the model list and the installed Ollama version — read on every
    // reveal (`useModelsHub`'s `refresh`).
    hub.refresh();
  };

  // Focus comes back here when the overlay closes — on its open→closed edge,
  // and only if nothing else took focus meanwhile (the overlay's tab held it,
  // and unmounting drops it to <body>). Without `skipRevealRef` that focus would
  // run `reveal` and open the dropdown on every Escape.
  const wasOverlayOpen = useRef(overlayOpen);
  useEffect(() => {
    const was = wasOverlayOpen.current;
    wasOverlayOpen.current = overlayOpen;
    // A door click unmounts the list under the pointer, and the mouse-leave for
    // a removed node may never arrive: at this moment the pointer is on the
    // backdrop, so forget it (a real mouseenter after close sets it again).
    if (overlayOpen) pointerInRef.current = false;
    if (!was || overlayOpen) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    skipRevealRef.current = true;
    btnRef.current?.focus();
    skipRevealRef.current = false;
  }, [overlayOpen]);

  // The dropdown's doors, each into its tab of the Models & agents overlay —
  // never out to Settings. Each closes the hover menu first: the pointer is on
  // its way into the overlay, not back to this list.
  //
  // Local models → the overlay's Ollama tab: installing Ollama itself, where
  // models are stored, and the installable-models catalog.
  const openOllama = () => {
    setOpen(false);
    useModelsOverlayStore.getState().openOverlay("ollama");
  };

  // "Manage CLIs…" → the Agents & CLIs tab, to install AI coding-agent CLIs
  // (Claude, Codex, Gemini, Google Antigravity, Mistral, Aider, OpenCode,
  // Cursor, Copilot, Grok, Qwen) that Tabtivity can then launch as agent tabs.
  const openAgents = () => {
    setOpen(false);
    useModelsOverlayStore.getState().openOverlay("agents");
  };

  // The Skills library (`docs/skills_plan.md`) → the Skills tab. It sits in
  // this menu beside "Manage CLIs…" because a skill is the same kind of object
  // as the agent CLIs above it: installed per machine, then available to every
  // project — and because two thirds of the library (the sources and their
  // cached clones) were always machine state that could only be reached from a
  // project tab. The project-scoped install still lives in that tab, which is
  // the one surface that knows which project is meant.
  const openSkills = () => {
    setOpen(false);
    useModelsOverlayStore.getState().openOverlay("skills");
  };

  // Escape, for the dropdown opened by keyboard focus (`onFocus` → `reveal`)
  // and therefore with no mouse-leave coming to close it — MailIndicator's
  // handler. Capture + `stopPropagation`: while this list is up, closing it is
  // what the key meant, not whatever window-level Escape sits underneath.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeMenu(MENU_ID);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, closeMenu]);

  // A close still pending when the button unmounts must not fire later and
  // shut whichever menu is open by then.
  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  const scheduleClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      closeTimer.current = null;
    }, 250);
  };

  // When exactly one model is resident in memory, make it the model for
  // everything — the default plus every task tag (autocomplete/tabs/mail) —
  // so loading a single model "just works" without wiring each task by hand.
  // Tracked per resident model via a ref so we auto-apply once per newly-loaded
  // sole model: manual reassignments the user makes afterwards (while that model
  // stays the only resident one) are preserved. Dropping to zero or rising to
  // two+ resident models re-arms it, so the next single-model load re-applies.
  //
  // Excludes a model the *launch-time autoload* put there
  // (`useOllamaAutoloadStore`'s armed list): that model became resident from a
  // setting, not a click, so treating it as "the" pick clobbered whatever
  // default the user had actually chosen — every restart, the moment the
  // autoloaded model finished warming up and was briefly the only one loaded.
  const autoAppliedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!settings) return;
    const resident = models.filter((m) => m.running);
    if (resident.length !== 1) {
      autoAppliedFor.current = null;
      return;
    }
    const only = resident[0].name;
    if (autoAppliedFor.current === only) return;
    autoAppliedFor.current = only;
    if (useOllamaAutoloadStore.getState().models.includes(only)) return;
    const current = settings.ollama_roles ?? {};
    const already =
      settings.ollama_model === only && MODEL_ROLES.every((r) => current[r.key] === only);
    if (already) return;
    const allRoles: Record<string, string> = {};
    for (const r of MODEL_ROLES) allRoles[r.key] = only;
    void updateSettings({ ollama_model: only, ollama_roles: allRoles });
  }, [models, settings, updateSettings]);

  // The launch-time autoload's report (`useAutoloadNotice`): the button's `!`
  // and tooltip carry it, so it is readable without opening the menu.
  const autoNotice = useAutoloadNotice();
  const showAutoNote = autoNotice.show;
  const autoPhase = autoNotice.phase;
  const autoPending = autoNotice.pending;
  const autoNoteTitle = autoNotice.sentence;
  const autoNoteResident = useOllamaAutoloadStore((s) => s.noteResident);

  // Keep that notice honest without waiting for a hover. The menu only reads the
  // model list when it opens, but the skip notice (and the button's `!`) live on
  // whether or not anyone opens it — so while one is up, a flip of the shared
  // status poll to "loaded" is the cue that *something* became resident, and it
  // may well be the model the notice claims is missing (loaded from the settings
  // panel, or by a process that isn't Tabtivity). One read, then the notice narrows
  // or disappears. `noteResident` is a no-op when nothing moved, so this cannot
  // loop on its own dependencies.
  useEffect(() => {
    if (!installed || status !== "loaded") return;
    if (autoPhase !== "skipped" || autoPending.length === 0) return;
    let cancelled = false;
    invoke<LocalModelInfo[]>("list_ollama_models_detailed")
      .then((all) => {
        if (!cancelled) autoNoteResident(all.filter((m) => m.running).map((m) => m.name));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [installed, status, autoPhase, autoPending, autoNoteResident]);

  return (
    <div
      className="global-apps-menu no-drag"
      onMouseEnter={() => {
        pointerInRef.current = true;
        reveal();
      }}
      onMouseLeave={() => {
        pointerInRef.current = false;
        scheduleClose();
      }}
      // Focus leaving the button and its list (Tab onward, a click elsewhere)
      // closes a keyboard-opened dropdown, as `useHeaderMenu`'s menus do. Not
      // while the pointer is over it: a click on the list's plain text drops
      // focus to <body> (relatedTarget null), and that is no leaving — the
      // mouse-leave will close it when it really goes.
      onBlur={(e) => {
        if (pointerInRef.current) return;
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        ref={btnRef}
        type="button"
        className="global-apps-menu-btn local-model-btn"
        title={
          !installed
            ? t("localModel.installTitle")
            : `${t(
                status === "loaded"
                  ? "localModel.runningLoaded"
                  : status === "idle"
                    ? "localModel.running"
                    : "localModel.stopped",
              )}${activeModel ? t("localModel.modelSuffix", { name: activeModel }) : t("localModel.noModelSelected")}${
                autoNoteTitle ? `\n${autoNoteTitle}` : ""
              }`
        }
        aria-label={t("modelsOverlay.title")}
        aria-pressed={overlayOpen}
        aria-haspopup="menu"
        aria-expanded={open && !overlayOpen}
        onClick={() => {
          // The button's click opens (or closes) the Models & agents overlay;
          // the hover dropdown goes with the click rather than staying up over
          // the overlay it just raised (MailIndicator's button, the same way).
          setOpen(false);
          if (closeTimer.current !== null) {
            window.clearTimeout(closeTimer.current);
            closeTimer.current = null;
          }
          const store = useModelsOverlayStore.getState();
          if (store.open) store.close();
          else store.openOverlay();
        }}
        // Keyboard reach: tabbing to the button is the one way in that no
        // pointer will ever open — except the focus handed back on close.
        onFocus={() => {
          if (skipRevealRef.current) {
            skipRevealRef.current = false;
            return;
          }
          // A mouse click focuses the button too (WebKitGTK), but the pointer's
          // mouseenter already revealed and refreshed — a second read adds nothing.
          if (pointerInRef.current) return;
          reveal();
        }}
      >
        {/* A processor chip — on-device compute — drawn rather than typed, like
            the 🔔: the 🧠 it replaces was a colour emoji that ignored the theme
            and sat apart from the ✉ 🗓 ☑ beside it. The menu's own copy names
            it by its title, "Models & agents". */}
        <ModelsGlyph className="local-model-icon" />
        {installed && (
          <span
            className={`local-model-status-dot ${status}`}
            aria-hidden="true"
          />
        )}
        {/* The menu only opens on hover, so a notice living inside it would be
            invisible to someone who never opens it — which is precisely the
            person who armed a model at start and expects it to be there. */}
        {showAutoNote && autoPhase !== "loading" && (
          <span className="local-model-autostart-flag" aria-hidden="true">
            !
          </span>
        )}
      </button>
      {open && (
        <div className="tab-new-menu local-model-menu">
          {/* Agents · Local models · Machine, in that order: the two things you
              can *pick* first, then what is left to run them with. The section
              headers carry their own chrome here (`.local-model-menu` in
              themes.css) because this menu is the one that stacks four of them
              over rows that are themselves multi-line — an 9px accent word was
              not enough to break the list into parts. */}
          {/* Pinned title + scrolling region: the unified menu shape (the accent
              rail and the ::before wash live on this element, so it must not be
              the thing that scrolls — see `.menu-scroll-region`). This menu is
              the tallest one in the app: four sections, each row two or three
              lines, so on a short window it ran off the bottom edge.

              What is pinned is the MENU's own title, never the first section's
              label. It used to be the latter, which is wrong the moment anything
              scrolls: "Agents & CLIs" stayed up there over the Local Models and
              Machine rows, naming a section that had left the view — and the
              agents section was then the only one with no header of its own. So
              the shape is the global-machines menu's: a title, a note under it
              saying what the menu is for, then the sections themselves. */}
          <div className="tab-new-menu-group-label local-model-menu-title">
            {t("localModel.menuTitle")}
          </div>
          <div className="menu-scroll-region">
          <div className="vpn-indicator-note">
            <strong>{t("localModel.note.strong")}</strong> {t("localModel.note.rest")}
          </div>
          <div className="tab-new-menu-group-label">{t("localModel.agentsGroup")}</div>
          {/* Each section's verbs lead it rather than trail it: the lists below
              them are long (every installed CLI, every model, each row two or
              three lines), so an action at the foot of a section was reached by
              scrolling past everything it is not about. Directly under the
              header they keep a fixed place — Manage CLIs + Skills library
              here, Manage local models + Check for updates below. */}
          <button className="tab-new-menu-item" onClick={openAgents}>
            <span className="tab-new-menu-dot" style={{ color: "transparent" }}>
              ●
            </span>
            {t("localModel.manageAgents")} <UntestedTag id="localModel.manageAgents" />
          </button>
          <button className="tab-new-menu-item" onClick={openSkills}>
            <span className="tab-new-menu-dot" style={{ color: "transparent" }}>
              ●
            </span>
            {t("localModel.skillsLibrary")} <UntestedTag id="localModel.skillsLibrary" />
          </button>
          {hub.agents.map((a) => (
            <div key={a.id} className="local-model-agent-row" title={t("localModel.agentInstalled", { label: a.label })}>
              {/* Green lamp mirrors a loaded model: this agent CLI is installed. */}
              <span className="local-model-lamp" aria-hidden="true" />
              <span className="local-model-loaded-name">{a.label}</span>
              <AgentChips agent={a} wiredClis={hub.wiredClis} />
            </div>
          ))}
          <LocalModelsSection hub={hub} layout="menu" onManageModels={openOllama} />
          <MachineMeters hub={hub} />
          </div>
        </div>
      )}
    </div>
  );
}
