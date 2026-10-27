import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSettingsStore } from "../../stores/settings";
import { useHeaderSlotsStore, type HeaderSlotsDrag } from "../../stores/headerSlots";
import {
  isHeaderPinned,
  moveHeaderItem,
  placedGroupOf,
  resetHeaderGroup,
  setHeaderPin,
  toggleHeaderPin,
  useHeaderPinDefaults,
  type HeaderGroup,
  type HeaderItemId,
} from "../../lib/headerPins";
import { useT } from "../../lib/i18n";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { UntestedTag } from "../common/UntestedTag";

/** A right-click inside one of the item's own popovers or fields is theirs. */
const OWN_CONTEXT = ".tab-new-menu, .project-switcher-add-menu, .context-menu, input, textarea, [role='menu'], [role='dialog']";

/** Pointer travel before a press on an icon becomes a drag, so a click stays one. */
const DRAG_THRESHOLD = 5;

type Target = Omit<NonNullable<HeaderSlotsDrag>, "id">;

/**
 * Where a drag at `x` would drop `id`, over every visible slot: in front of the
 * first one whose middle is right of the pointer, else at the end. The bar has
 * three stretches — the always-shown run, the cluster's pinned items and (while
 * the chevron is open) its folded ones — and the slot decides which one the drop
 * lands in, so dragging across a boundary moves the icon between the stretches:
 * into the folded one it folds, out of it it pins. Between two stretches the
 * pointer picks the nearer side of the gap. Folded-away slots have no box and
 * are skipped; the gear stays pinned, so it has no folded stretch to drop in.
 */
function dropTarget(id: HeaderItemId, x: number, order: readonly string[] | undefined): Target | null {
  const slots = Array.from(document.querySelectorAll<HTMLElement>("[data-header-slot]"))
    .map((el) => ({ el, id: el.dataset.headerSlot as HeaderItemId, r: el.getBoundingClientRect() }))
    .filter((sl) => sl.id !== id && sl.r.width > 0)
    .sort((p, q) => p.r.left - q.r.left);
  type Slot = (typeof slots)[number];
  const area = (sl: Slot) =>
    !sl.el.closest(".header-status-cluster") ? "bar" : sl.el.dataset.pinned === "true" ? "pinned" : "folded";
  const place = (sl: Slot, before: boolean): Target | null => {
    const a = area(sl);
    if (a === "folded" && id === "settings") return null;
    const group: HeaderGroup =
      a === "bar" ? "apps" : a === "pinned" || !before ? "status" : placedGroupOf(sl.id, order);
    return {
      beforeId: before ? sl.id : null,
      afterId: before ? null : sl.id,
      group,
      pin: a !== "folded",
    };
  };
  for (let i = 0; i < slots.length; i++) {
    const sl = slots[i];
    if (x >= sl.r.left + sl.r.width / 2) continue;
    const prev = slots[i - 1];
    if (prev && area(prev) !== area(sl) && x < (prev.r.right + sl.r.left) / 2) return place(prev, false);
    return place(sl, true);
  }
  return slots.length ? place(slots[slots.length - 1], false) : null;
}

/**
 * A drag over the ‹ chevron folds the icon, at the end of the folded stretch.
 * Collapsed, that stretch has no boxes to drop between, so the chevron is the
 * only way into it — and reaching it opens the stretch for the rest of the drag
 * (`foldPeek`), so the pointer can go on to a spot among the folded icons. The
 * gear never folds, so for it the chevron is just the end of the bar.
 */
function overFoldToggle(id: HeaderItemId, x: number): Target | null {
  if (id === "settings") return null;
  const r = document.querySelector(".status-cluster-toggle")?.getBoundingClientRect();
  if (!r || r.width === 0 || x < r.left || x > r.right) return null;
  const folded = Array.from(document.querySelectorAll<HTMLElement>(".header-status-cluster [data-header-slot]"))
    .filter((el) => el.dataset.headerSlot !== id && el.dataset.pinned !== "true" && el.getBoundingClientRect().width > 0);
  const last = folded[folded.length - 1]?.dataset.headerSlot as HeaderItemId | undefined;
  return { beforeId: null, afterId: last ?? null, group: "status", pin: false };
}

/**
 * One top-bar item and its place: pinned in the bar, or folded behind the ‹
 * chevron of `StatusCluster`. Right-clicking the item chooses (the setting is
 * `header_pins`, defaults in `lib/headerPins`).
 *
 * Dragging an icon sideways reorders it (`header_order`), also across the
 * bar's stretches: into the cluster's folded stretch it folds, out of it it
 * pins (`header_pins`), and between the bar's run and the cluster it changes
 * group. The ‹ chevron is the folded stretch's door: a drag that reaches it
 * opens the folded icons until the drag ends, and a drop on it folds the icon
 * (`overFoldToggle`). It is pointer-based like the tab drag: HTML5 DnD is unreliable on
 * WebKitGTK, and the release is handled by a listener bound at pointerdown, the
 * only kind that reliably sees it there.
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
  const foldPeek = useHeaderSlotsStore((s) => s.foldPeek);
  const setPresent = useHeaderSlotsStore((s) => s.setPresent);
  const ref = useRef<HTMLSpanElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const pinned = isHeaderPinned(pins, id, pinDefaults);
  const group = placedGroupOf(id, order);
  const dragging = dragInfo?.id === id;
  const dropHere = dragInfo != null && dragInfo.id !== id && dragInfo.beforeId === id;
  const dropEnd = dragInfo != null && dragInfo.id !== id && dragInfo.afterId === id;

  const onPointerDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(OWN_CONTEXT)) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let engaged = false;
    const { setDrag, setFoldPeek } = useHeaderSlotsStore.getState();
    const move = (ev: PointerEvent) => {
      if (!engaged && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
      engaged = true;
      const fold = overFoldToggle(id, ev.clientX);
      if (fold) setFoldPeek(true);
      const target = fold ?? dropTarget(id, ev.clientX, order);
      setDrag(target && { id, ...target });
    };
    const end = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      const drop = useHeaderSlotsStore.getState().drag;
      setDrag(null);
      setFoldPeek(false);
      if (!engaged) return;
      // The release after a drag is not a click on the icon under it.
      const swallow = (c: MouseEvent) => c.stopPropagation();
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      if (ev.type === "pointercancel" || !drop) return;
      const nextPins = setHeaderPin(pins, id, drop.pin, pinDefaults);
      void updateSettings({
        header_order: moveHeaderItem(order, id, drop.beforeId, drop.group),
        ...(isHeaderPinned(pins, id, pinDefaults) !== drop.pin && { header_pins: nextPins }),
      });
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
        data-pinned={pinned}
        data-folded={!pinned && !expanded && !foldPeek}
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
            {id !== "settings" && (
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
            )}
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
