import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSettingsStore } from "../../stores/settings";
import { useHeaderSlotsStore } from "../../stores/headerSlots";
import {
  headerGroupOf,
  isHeaderPinned,
  moveHeaderItem,
  orderedHeaderIds,
  resetHeaderGroup,
  toggleHeaderPin,
  useHeaderPinDefaults,
  type HeaderItemId,
} from "../../lib/headerPins";
import { useT } from "../../lib/i18n";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { UntestedTag } from "../common/UntestedTag";

/** A right-click inside one of the item's own popovers or fields is theirs. */
const OWN_CONTEXT = ".tab-new-menu, .project-switcher-add-menu, .context-menu, input, textarea, [role='menu'], [role='dialog']";

/** Pointer travel before a press on an icon becomes a drag, so a click stays one. */
const DRAG_THRESHOLD = 5;

/**
 * Where a drag at `x` would drop `id`: in front of the first visible sibling of
 * its group whose middle is right of the pointer, else at the end. Folded slots
 * have no box and are skipped.
 */
function dropBefore(id: HeaderItemId, x: number, order: readonly string[] | undefined): HeaderItemId | null {
  const group = headerGroupOf(id);
  for (const other of orderedHeaderIds(group, order)) {
    if (other === id) continue;
    const el = document.querySelector<HTMLElement>(`[data-header-slot="${other}"]`);
    const r = el?.getBoundingClientRect();
    if (!r || r.width === 0) continue;
    if (x < r.left + r.width / 2) return other;
  }
  return null;
}

/**
 * One top-bar item and its place: pinned in the bar, or folded behind the ‹
 * chevron of `StatusCluster`. Right-clicking the item chooses (the setting is
 * `header_pins`, defaults in `lib/headerPins`).
 *
 * Dragging an icon sideways reorders it within its group (`header_order`). It
 * is pointer-based like the tab drag: HTML5 DnD is unreliable on WebKitGTK, and
 * the release is handled by a listener bound at pointerdown, the only kind that
 * reliably sees it there.
 *
 * Folding is `display: none`, never unmounting, for the reason the cluster
 * gives: a folded readout keeps polling and a folded mail button keeps its
 * badge state, so unfolding is instant and the summary lamp stays honest.
 * Every slot renders in a fixed DOM order whether folded or not.
 */
export function HeaderSlot({ id, children }: { id: HeaderItemId; children: ReactNode }) {
  const t = useT();
  const pins = useSettingsStore((s) => s.settings?.header_pins);
  const pinDefaults = useHeaderPinDefaults();
  const expanded = useSettingsStore((s) => s.settings?.header_status_expanded ?? false);
  const order = useSettingsStore((s) => s.settings?.header_order);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const dragInfo = useHeaderSlotsStore((s) => s.drag);
  const setPresent = useHeaderSlotsStore((s) => s.setPresent);
  const ref = useRef<HTMLSpanElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const pinned = isHeaderPinned(pins, id, pinDefaults);
  const group = headerGroupOf(id);
  const dragging = dragInfo?.id === id;
  const dropHere = dragInfo != null && dragInfo.id !== id && dragInfo.beforeId === id;
  const dropEnd =
    dragInfo != null && dragInfo.beforeId === null && headerGroupOf(dragInfo.id) === group &&
    dragInfo.id !== id && orderedHeaderIds(group, order).filter((x) => x !== dragInfo.id).pop() === id;

  const onPointerDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(OWN_CONTEXT)) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let engaged = false;
    const { setDrag } = useHeaderSlotsStore.getState();
    const move = (ev: PointerEvent) => {
      if (!engaged && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
      engaged = true;
      setDrag({ id, beforeId: dropBefore(id, ev.clientX, order) });
    };
    const end = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      const drop = useHeaderSlotsStore.getState().drag;
      setDrag(null);
      if (!engaged) return;
      // The release after a drag is not a click on the icon under it.
      const swallow = (c: MouseEvent) => c.stopPropagation();
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      if (ev.type === "pointercancel" || !drop) return;
      void updateSettings({ header_order: moveHeaderItem(order, id, drop.beforeId) });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

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
        data-header-slot={id}
        data-folded={!pinned && !expanded}
        data-dragging={dragging || undefined}
        data-drop={dropHere ? "before" : dropEnd ? "after" : undefined}
        onPointerDown={onPointerDown}
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
                void updateSettings({ header_pins: toggleHeaderPin(pins, id, pinDefaults) });
              }}
            >
              {pinned ? t("headerPins.fold") : t("headerPins.pin")}
              <UntestedTag id="headerPins.menu" />
            </button>
            {resetHeaderGroup(order, group).length !== (order ?? []).length && (
              <button
                className="untested"
                onClick={() => {
                  setMenu(null);
                  void updateSettings({ header_order: resetHeaderGroup(order, group) });
                }}
              >
                {t("headerPins.resetOrder")}
                <UntestedTag id="headerOrder.menu" />
              </button>
            )}
          </div>
        </ContextMenuPortal>
      )}
    </>
  );
}
