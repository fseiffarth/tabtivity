import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSettingsStore } from "../../stores/settings";
import { useHeaderSlotsStore } from "../../stores/headerSlots";
import { isHeaderPinned, toggleHeaderPin, type HeaderItemId } from "../../lib/headerPins";
import { useT } from "../../lib/i18n";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { UntestedTag } from "../common/UntestedTag";

/** A right-click inside one of the item's own popovers or fields is theirs. */
const OWN_CONTEXT = ".tab-new-menu, .project-switcher-add-menu, .context-menu, input, textarea, [role='menu'], [role='dialog']";

/**
 * One top-bar item and its place: pinned in the bar, or folded behind the ‹
 * chevron of `StatusCluster`. Right-clicking the item chooses (the setting is
 * `header_pins`, defaults in `lib/headerPins`).
 *
 * Folding is `display: none`, never unmounting, for the reason the cluster
 * gives: a folded readout keeps polling and a folded mail button keeps its
 * badge state, so unfolding is instant and the summary lamp stays honest.
 * Every slot renders in a fixed DOM order whether folded or not.
 */
export function HeaderSlot({ id, children }: { id: HeaderItemId; children: ReactNode }) {
  const t = useT();
  const pins = useSettingsStore((s) => s.settings?.header_pins);
  const expanded = useSettingsStore((s) => s.settings?.header_status_expanded ?? false);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const setPresent = useHeaderSlotsStore((s) => s.setPresent);
  const ref = useRef<HTMLSpanElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const pinned = isHeaderPinned(pins, id);

  // Whether the item drew anything: the wrapper is empty when its feature is off.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => setPresent(id, el.childElementCount > 0);
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(el, { childList: true });
    return () => {
      observer.disconnect();
      setPresent(id, false);
    };
  }, [id, setPresent]);

  return (
    <>
      <span
        ref={ref}
        className="header-slot"
        data-folded={!pinned && !expanded}
        onContextMenu={(e) => {
          if (e.defaultPrevented || (e.target as HTMLElement).closest(OWN_CONTEXT)) return;
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {children}
      </span>
      {menu && (
        <ContextMenuPortal x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <div className="context-menu-group">
            <div className="context-menu-group-label">{t(`headerPins.item.${id}` as "headerPins.item.mail")}</div>
            <button
              className="untested"
              onClick={() => {
                setMenu(null);
                void updateSettings({ header_pins: toggleHeaderPin(pins, id) });
              }}
            >
              {pinned ? t("headerPins.fold") : t("headerPins.pin")}
              <UntestedTag id="headerPins.menu" />
            </button>
          </div>
        </ContextMenuPortal>
      )}
    </>
  );
}
