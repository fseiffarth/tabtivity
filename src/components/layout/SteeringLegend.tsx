import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useKeyboardSteeringStore, type SteeringHandoff } from "../../stores/keyboardSteering";
import { allGroups, useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useExperimental } from "../../lib/experimental";
import { voiceInputOffered } from "../../lib/voice/desktopVoice";
import { STEERING_GROUPS, modifierLabel, steeringKeysFor, type SteeringGroup } from "../../lib/shortcuts/shortcuts";
import { steeringKeyLabel, steeringKeys, steeringSlotKey, type SteeringKeyMap } from "../../lib/shortcuts/steeringBindings";
import { newTabSlotLabels } from "../../lib/shortcuts/newTabChord";
import { activeTabCard, steeringAppEnabled } from "../../lib/shortcuts/steeringRegion";
import { statusTabs } from "../../lib/shortcuts/statusJump";
import { steeringAgentOffer } from "../../lib/shortcuts/steeringAgent";
import { steeringConfirmButton } from "../../lib/shortcuts/steeringConfirm";
import { anchorOf, barModel, ladder, type BarItem, type CapAnchor, type Rung } from "../../lib/shortcuts/steeringBar";
import { measureCaps, samePlacements, type CapPlacements } from "../../lib/shortcuts/steeringCaps";
import { useActivityStore } from "../../stores/activity";
import { useT, type TranslationKey } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { terminalFor } from "../../lib/terminal/terminalRegistry";
import { documentScroller } from "../../lib/shortcuts/documentScroll";
import { ChevronRightIcon, KeyboardIcon, MicIcon } from "../common/icons/Icon";

/** What the box steering lent the keyboard to answers — its own keys, fixed,
 *  so not steering bindings — and Esc, which brings steering back. */
const HANDOFF: Record<SteeringHandoff, { where: TranslationKey; keys: [string, TranslationKey][] }> = {
  jump: {
    where: "steering.jumpProject.label",
    keys: [
      ["↑ ↓", "steering.handoff.choose"],
      ["Enter", "steering.handoff.open"],
    ],
  },
  prompt: {
    where: "steering.agentPrompt.label",
    keys: [
      ["Enter", "steering.handoff.send"],
      ["Shift+Enter", "steering.handoff.newLine"],
    ],
  },
  search: { where: "steering.search.label", keys: [] },
};
const HANDOFF_BACK_KEY = "Esc";

const NO_KEYS: ReturnType<typeof steeringKeysFor> = [];
const TOK_BY_GROUP = new Map(STEERING_GROUPS.map((g) => [g.id, g.tok]));
const tokFor = (g: SteeringGroup) => TOK_BY_GROUP.get(g) ?? "tok-comment";

/**
 * The bar shown while keyboard steering mode is active — the visible half of
 * the mode's contract (every key is swallowed, so the user must be able to see
 * what the keys do and how to get out). Two parts, both read from the one
 * table the cheat sheet uses (`steeringKeysFor` over `STEERING_KEYS`) in the
 * user's own bindings (`steeringRowKeys`, `steeringSlotKey`), so it can never
 * list a key the handler doesn't act on:
 *
 *  - a 28 px bar docked under the panes: the badge (a click folds it), the
 *    ladder Projects › Subwindows › Tabs › Inside with the lit rung being where
 *    the arrows act, the level's move keys, the status jumps with their counts,
 *    and at the right end the keys that leave the mode. It takes its height out
 *    of the window (`html[data-steer-bar]`), so it never covers the prompt line.
 *  - every other key as a small cap in its group's `.tok-*` colour, pinned to
 *    the control it fires (N O 1–N + above the + button, W on the steered tab,
 *    I L G K on the prompt strip, M C T , on the header, B P on the rail …;
 *    `steeringBar.anchorOf`, `steeringCaps`). A key whose control is not on
 *    screen stays in the bar.
 *
 * Folded (steering's H, remembered per machine) the bar keeps the badge, the
 * ladder and the way out. While steering has lent the keyboard to a box — the
 * project jump, the prompt box, a surface's search field (`handedTo`) — the mode
 * is off but the bar stays with a hollow badge, the box as its lit rung, that
 * box's keys and Esc back, folded or not: the way back is the one thing it must
 * not hide. With hands-free on, the badge wears a mic: steering takes the Chat's
 * composer and its Hands-free chip off screen while the loop goes on listening.
 *
 * Mounted once in `AppShell` (the FocusFrameOverlay/host pattern), portalled to
 * `document.body` so no pane clips it. Nothing here animates or blurs.
 */
export function SteeringLegend() {
  const t = useT();
  const active = useKeyboardSteeringStore((s) => s.active);
  const level = useKeyboardSteeringStore((s) => s.level);
  const region = useKeyboardSteeringStore((s) => s.region);
  const regionReturn = useKeyboardSteeringStore((s) => s.regionReturn);
  const legendHidden = useKeyboardSteeringStore((s) => s.legendHidden);
  const toggleLegend = useKeyboardSteeringStore((s) => s.toggleLegend);
  const handedTo = useKeyboardSteeringStore((s) => s.handedTo);
  const handoffReturn = useKeyboardSteeringStore((s) => s.handoffReturn);
  const multiPane = useTabsStore((s) => allGroups(s.layout).length >= 2);
  const popouts = useTabsStore((s) => (s.detachedGroupsByScope[s.scope]?.length ?? 0) > 0);
  const focusedGroupId = useTabsStore((s) => s.focusedGroupId);
  const mail = useSettingsStore((s) => steeringAppEnabled("mail", s.settings));
  const calendar = useSettingsStore((s) => steeringAppEnabled("calendar", s.settings));
  const todo = useSettingsStore((s) => steeringAppEnabled("todo", s.settings));
  const busyByTab = useActivityStore((s) => s.busyByTab);
  const attentionByTab = useActivityStore((s) => s.attentionByTab);
  const tabsByScope = useTabsStore((s) => s.tabsByScope);
  const tabScope = useTabsStore((s) => s.scope);
  const activeTab = useTabsStore((s) => (s.activeKey ? s.tabs.find((tab) => tab.key === s.activeKey) : undefined));
  const steerKeys = useSettingsStore((s) => s.settings?.steering_keys) as SteeringKeyMap | undefined;
  const handsFreeFlag = useExperimental("voice_hands_free");
  const handsFreeChip = useSettingsStore((s) => s.settings?.voice_hands_free_on ?? false);
  const handsFree = handsFreeFlag && handsFreeChip && voiceInputOffered();
  const micLabel = t("terminal.reader.voice.handsFree");
  const mic = handsFree && (
    <span className="steering-bar-mic" role="img" aria-label={micLabel} title={micLabel}>
      <MicIcon size={11} />
    </span>
  );

  const inPane = active && (level === "panes" || level === "tabs");
  const agents = useMemo(
    () => (inPane ? newTabSlotLabels() : []),
    // The focused pane decides which agents 1–9 open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inPane, focusedGroupId],
  );

  // Publish where steering points on <html> (`data-steer`, plus
  // `data-steer-region` in a region) so the stylesheet can light up the one
  // object the arrows act on — the top frame and current pill, the focused
  // subwindow, its active tab, the side panel or overlay — without every one
  // of those components subscribing to this store.
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.dataset.steer = level;
    if (region) root.dataset.steerRegion = region;
    return () => {
      delete root.dataset.steer;
      delete root.dataset.steerRegion;
    };
  }, [active, level, region]);

  // The bar takes its height out of the window while it is up
  // (`html[data-steer-bar] .app-shell`), lent to a box or not.
  const barUp = active || !!handedTo;
  useEffect(() => {
    if (!barUp) return;
    const root = document.documentElement;
    root.dataset.steerBar = "";
    return () => {
      delete root.dataset.steerBar;
    };
  }, [barUp]);

  // Steering is a keyboard mode, so the mouse pointer hides while it is on
  // (`data-steer-pointer` on <html>). Moving the mouse brings it back; the
  // next steering key hides it again. Only real movement counts: the engine
  // fires mousemove under a still pointer when a tab switch changes what lies
  // beneath it, and that must not unhide.
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    let last: { x: number; y: number } | null = null;
    const hide = () => {
      root.dataset.steerPointer = "hidden";
    };
    const onMove = (e: MouseEvent) => {
      const moved = last !== null && Math.hypot(e.screenX - last.x, e.screenY - last.y) > 3;
      last = { x: e.screenX, y: e.screenY };
      if (moved) delete root.dataset.steerPointer;
    };
    hide();
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("keydown", hide, true);
    return () => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("keydown", hide, true);
      delete root.dataset.steerPointer;
    };
  }, [active]);

  const terminal = !!activeTab && !!terminalFor(`${tabScope}:${activeTab.key}`);
  const folded = active && legendHidden;
  const statusCount = (kind: "decision" | "working" | "done") => statusTabs(kind, busyByTab, attentionByTab, tabsByScope).length;
  // Read live at render: the bar redraws on every steering key.
  const keys =
    active && !folded
      ? steeringKeysFor({
          level,
          sideRegion: region === "side",
          settingsRegion: region === "settings",
          headerRegion: region === "header",
          overlayRegion: region === "overlay",
          steeringConfirm: region === "overlay" && !!steeringConfirmButton(document),
          tabCard: inPane && !!activeTabCard(),
          multiPane,
          apps: { mail, calendar, todo },
          agent: steeringAgentOffer(activeTab),
          terminal,
          // Only where ↓ could step into it.
          document: !terminal && !!activeTab && (inPane || level === "scroll") && !!documentScroller(tabScope, activeTab.key),
          popouts,
          statusCounts: {
            decision: statusCount("decision"),
            working: statusCount("working"),
            done: statusCount("done"),
          },
        })
      : NO_KEYS;
  const wanted = [...new Set(keys.map(anchorOf).filter((a): a is CapAnchor => a !== null))];
  const placed = useCapPlacements(wanted, `${level}|${region}|${tabScope}|${activeTab?.key}|${focusedGroupId}`);

  if (!barUp) return null;

  const legendKey = steeringKeys("legend", steerKeys)[0];
  const legendCap = legendKey ? steeringKeyLabel(legendKey) : "—";
  const exitKey = steeringKeys("exit", steerKeys)[0];
  const exitCap = exitKey ? steeringKeyLabel(exitKey) : "—";

  const cap = (key: string, tok: string, i: number, count?: true) => (
    <span className={`steering-cap ${tok}${count ? " count" : ""}`} key={`${key}-${i}`}>
      <span className="steering-cap-k">{key}</span>
    </span>
  );
  const item = (it: BarItem) => (
    <span
      className="steering-bar-item"
      key={it.id}
      title={it.title ?? (it.descKey ? t(it.descKey, { modifier: modifierLabel() }) : undefined)}
    >
      <span className="steering-bar-caps">{it.caps.map((c, i) => cap(c, tokFor(it.group), i))}</span>
      <span className="steering-bar-label">{t(it.labelKey)}</span>
      {it.status && cap(String(statusCount(it.status)), tokFor(it.group), 0, true)}
    </span>
  );
  const rungs = (list: Rung[]) =>
    list.map((r, i) => (
      <span className="steering-bar-rung-wrap" key={r.id}>
        {i > 0 && (
          <span className="steering-bar-sep" aria-hidden="true">
            <ChevronRightIcon size={12} />
          </span>
        )}
        <span className={`steering-rung${r.lit ? " lit" : ""}${r.lent ? " lent" : ""}`} aria-current={r.lit ? "step" : undefined}>
          {t(r.labelKey)}
        </span>
      </span>
    ));

  let badge: ReactNode;
  let ladderEl: ReactNode;
  let keyItems: ReactNode[] = [];
  let tailItems: ReactNode[] = [];
  let caps: ReactNode = null;

  if (!active && handedTo) {
    // Steering is off while lent, so the badge is a plain, hollow mark — not
    // the fold toggle.
    const box = HANDOFF[handedTo];
    badge = (
      <span className="steering-bar-badge hollow">
        <KeyboardIcon size={16} />
        {mic}
      </span>
    );
    ladderEl = (
      <div className="steering-bar-ladder">
        {rungs(
          ladder({
            level: handoffReturn.level,
            region: handoffReturn.region,
            regionReturn: handoffReturn.regionReturn,
            document: !terminal,
            lent: box.where,
          }),
        )}
      </div>
    );
    const split = (k: string) => k.split(/[+ ]/);
    keyItems = box.keys.map(([k, label]) => (
      <span className="steering-bar-item" key={label}>
        <span className="steering-bar-caps">{split(k).map((c, i) => cap(c, "tok-type", i))}</span>
        <span className="steering-bar-label">{t(label)}</span>
      </span>
    ));
    tailItems = [
      <span className="steering-bar-item" key="back">
        <span className="steering-bar-caps">{cap(HANDOFF_BACK_KEY, "tok-comment", 0)}</span>
        <span className="steering-bar-label">{t("steering.handoff.back")}</span>
      </span>,
    ];
  } else {
    badge = (
      <button
        type="button"
        className="steering-bar-badge"
        // The focus stays where steering left it (a terminal, usually).
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggleLegend}
        title={t(folded ? "steering.fab.title" : "steering.hub.title", { key: legendCap })}
      >
        <KeyboardIcon size={16} />
        {mic}
      </button>
    );
    ladderEl = (
      <div className="steering-bar-ladder">
        {rungs(ladder({ level, region, regionReturn, document: !terminal }))}
      </div>
    );
    if (folded) {
      tailItems = [
        <span className="steering-bar-item" key="show">
          <span className="steering-bar-caps">{cap(legendCap, "tok-comment", 0)}</span>
          <span className="steering-bar-label">{t("steering.bar.show")}</span>
        </span>,
        <span className="steering-bar-item" key="exit">
          <span className="steering-bar-caps">{cap(exitCap, "tok-comment", 0)}</span>
          <span className="steering-bar-label">{t("steering.exit.label")}</span>
        </span>,
      ];
    } else {
      const agentSlots = agents.flatMap((label, i) => {
        // An unbound slot has no key to press, so it is not counted.
        const key = label ? steeringSlotKey(i + 1, steerKeys) : null;
        return key && label ? [{ key, label }] : [];
      });
      const placedSet = new Set(Object.keys(placed) as CapAnchor[]);
      const model = barModel(keys, level, placedSet, steerKeys, agentSlots, tokFor);
      // The leave keys read at the right end; the rest follow the ladder.
      const grouped = (it: BarItem) => it.group === "mode" || it.leave;
      keyItems = model.items.filter((it) => !grouped(it)).map(item);
      const tail = model.items.filter(grouped);
      tailItems = tail.flatMap((it, i) => [
        ...(it.leave && !tail[i - 1]?.leave ? [<span className="steering-bar-vr" key={`vr-${it.id}`} aria-hidden="true" />] : []),
        item(it),
      ]);
      const rowsAt = [...model.caps.entries()].flatMap(([anchor, list]) => {
        const at = placed[anchor];
        if (!at) return [];
        return [
          <span className={`steering-cap-row ${at.align}`} style={{ left: at.x, top: at.y }} key={anchor} data-anchor={anchor}>
            {list.flatMap((r) => r.caps.map((c, i) => cap(c.key, c.tok, i)))}
          </span>,
        ];
      });
      caps = rowsAt.length > 0 ? <div className="steering-caps" aria-hidden="true">{rowsAt}</div> : null;
    }
  }

  return createPortal(
    <>
      <div className={`steering-bar${folded ? " folded" : ""}`} role="status" aria-label={t("steering.legendTitle")}>
        {badge}
        {ladderEl}
        <UntestedTag id="steering.bar" />
        <div className="steering-bar-keys">{keyItems}</div>
        <div className="steering-bar-tail">{tailItems}</div>
      </div>
      {caps}
    </>,
    document.body,
  );
}

/**
 * Where the controls the caps are pinned to are right now. Measured after every
 * commit (the bar redraws on each steering key and level change), when the
 * window resizes or anything scrolls (a tab strip, the panel), and once more
 * shortly after a change so a panel that is still sliding open is caught where
 * it comes to rest. Only a changed placement sets state, so it settles; no
 * timer loops.
 */
function useCapPlacements(wanted: CapAnchor[], settleKey: string): CapPlacements {
  const [placed, setPlaced] = useState<CapPlacements>({});
  const ids = useRef(wanted);
  ids.current = wanted;
  const measure = useCallback(() => {
    const next = measureCaps(ids.current);
    setPlaced((prev) => (samePlacements(prev, next) ? prev : next));
  }, []);
  useLayoutEffect(() => {
    measure();
  });
  const wantedKey = wanted.join(",");
  useEffect(() => {
    if (!wantedKey) return;
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    window.addEventListener("resize", later);
    window.addEventListener("scroll", later, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", later);
      window.removeEventListener("scroll", later, true);
    };
  }, [wantedKey, measure]);
  useEffect(() => {
    if (!wantedKey) return;
    const timer = window.setTimeout(measure, 260);
    return () => window.clearTimeout(timer);
  }, [wantedKey, settleKey, measure]);
  return placed;
}
