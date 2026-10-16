import { useExperimental } from "../../lib/experimental";
import { useT } from "../../lib/i18n";
import { useAssistantOverlayStore } from "../../stores/assistantOverlay";
import { AssistantGlyph } from "./HeaderGlyphs";

/**
 * The header's chat bubble — opens the Tabby overlay
 * (`assistant/AssistantOverlay`, mounted at the shell). Shown only while the
 * experimental `assistant` switch is on (the backend refuses its commands
 * otherwise, so a button with the switch off could only open a dead window).
 *
 * The header-button twin of the ✉ 🗓 ☑ family: a `.global-apps-menu` wrapper
 * around a `.global-apps-menu-btn`, the same click behaviour (open, or close
 * when already open), pressed while its overlay is up. It opens no hover menu
 * and carries no badge, so it holds no hover-menu id.
 */
export function AssistantButton() {
  const t = useT();
  const enabled = useExperimental("assistant");
  const open = useAssistantOverlayStore((s) => s.open);
  if (!enabled) return null;
  const label = t("assistant.button");
  return (
    <div className="global-apps-menu assistant-indicator no-drag">
      <button
        type="button"
        className="global-apps-menu-btn assistant-indicator-btn"
        title={label}
        aria-label={label}
        aria-pressed={open}
        onClick={() => {
          const store = useAssistantOverlayStore.getState();
          if (store.open) store.close();
          else store.openOverlay();
        }}
      >
        <AssistantGlyph className="assistant-indicator-icon" />
      </button>
    </div>
  );
}
