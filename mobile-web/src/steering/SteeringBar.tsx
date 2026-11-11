import { useEffect, useMemo, useState } from "react";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { steeringKeyLabel, steeringKeys } from "../../../src/lib/shortcuts/steeringBindings";
import { isUntested } from "../../../src/lib/untested";
import { readFlag, writeFlag } from "../prefs";
import {
  isEntryChord,
  isHardwareKeydown,
  phoneActionKeys,
  phoneBindingsFor,
  phoneRowKeys,
  type PhoneLevel,
  type PhoneSteeringAction,
} from "./phoneSteeringKeys";
import { statusCounts, type StatusKind } from "./phoneStatusJump";
import { getSteering, useSteering } from "./steeringState";

/** The chord the tip names; the keys come from the table. Key names are not translated. */
const CHORD = "Shift+Space";
const TIP_MS = 8000;
/** The ladder, outermost first. A sheet and a section sit off it. */
const LADDER: readonly { level: PhoneLevel; label: TranslationKey }[] = [
  { level: "projects", label: "steering.level.projects" },
  { level: "tabs", label: "steering.level.tabs" },
  { level: "inside", label: "mobile.steering.level.inside" },
];
const STATUS: Partial<Record<PhoneSteeringAction, StatusKind>> = { nextDecision: "ask", nextWorking: "working", nextDone: "done" };
const SECTION_KEYS: readonly PhoneSteeringAction[] = ["mail", "calendar", "todo"];

/** The key text of one action on a level ("E/↑", "1–9"), or "" when unbound. */
function keysText(action: PhoneSteeringAction, level: PhoneLevel): string {
  const rows = phoneBindingsFor(level).filter((def) => def.action === action);
  if (rows.length === 0) return "";
  if (action === "openRow" || action === "answer") return phoneRowKeys(rows[0]);
  return phoneActionKeys(action, level, null).map(steeringKeyLabel).join("/");
}

interface Chip {
  id: string;
  keys: string;
  label: string;
  count?: number;
  pill?: "statusJump" | "answer" | "composer";
}

/** Whether a chip's untested pill shows (literal ids, for the register's call-site scan). */
function pillShown(pill: Chip["pill"]): boolean {
  switch (pill) {
    case "statusJump": return isUntested("mobile.steering.statusJump");
    case "answer": return isUntested("mobile.steering.answer");
    case "composer": return isUntested("mobile.steering.composer");
    default: return false;
  }
}

/** The shown ones of a level's actions, one chip each, in table order (up and down read as one; Mail, Calendar and To-do as one). */
function chipsFor(level: PhoneLevel, t: ReturnType<typeof useT>, counts: Record<StatusKind, number>, question: boolean, queue: boolean, jumpBack: boolean): Chip[] {
  const out: Chip[] = [];
  const seen = new Set<PhoneSteeringAction>();
  for (const def of phoneBindingsFor(level)) {
    const action = def.action;
    if (seen.has(action) || action === "legend") continue;
    seen.add(action);
    const label = t(def.labelKey);
    const status = STATUS[action];
    if (status) {
      if (counts[status] > 0) out.push({ id: action, keys: keysText(action, level), label, count: counts[status], pill: "statusJump" });
    } else if (action === "answer") {
      if (question) out.push({ id: action, keys: keysText(action, level), label, pill: "answer" });
    } else if (action === "queueSend" || action === "queuePull") {
      if (queue) out.push({ id: action, keys: keysText(action, level), label });
    } else if (action === "jumpBack") {
      if (jumpBack) out.push({ id: action, keys: keysText(action, level), label });
    } else if (action === "type") {
      out.push({ id: action, keys: keysText(action, level), label, pill: "composer" });
    } else if (action === "up") {
      out.push({ id: action, keys: `${keysText("up", level)} ${keysText("down", level)}`, label });
    } else if (action === "down") {
      // Folded into the Up chip.
    } else if (SECTION_KEYS.includes(action)) {
      if (action === "mail") {
        out.push({
          id: "sections",
          keys: SECTION_KEYS.map((a) => keysText(a, level)).join(" "),
          label: SECTION_KEYS.map((a) => t(phoneBindingsFor(level).find((d) => d.action === a)?.labelKey ?? def.labelKey)).join(" / "),
        });
      }
    } else {
      const keys = keysText(action, level);
      if (keys) out.push({ id: action, keys, label });
    }
  }
  return out;
}

/**
 * The first hardware keydown on this device shows the tip once: "Keyboard
 * connected — Shift+Space steers with E S D F", for about 8 s or until the next
 * key. Touch-only users never see it. The flag is set at that first key, so a
 * reload never repeats it; Turn off tips silences it without using it up.
 */
function useKeyboardTip(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let up = false;
    const hide = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      up = false;
      setShown(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (up) {
        hide();
        return;
      }
      if (readFlag("hintSteering") || readFlag("hintsOff")) return;
      if (!isHardwareKeydown(e, e.target)) return;
      writeFlag("hintSteering", true);
      // Someone who already presses the chord needs no tip.
      if (getSteering().active || isEntryChord(e, e.target)) return;
      up = true;
      setShown(true);
      timer = setTimeout(hide, TIP_MS);
    };
    window.addEventListener("keydown", onKey, { capture: true, passive: true });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
  return shown;
}

/**
 * The phone's steering legend: a bottom bar while the mode is on (badge, the
 * ladder, the level's keys, a flash line), and the one-time keyboard tip while
 * it is off. A static solid bar, no animation. `html[data-steer-bar]` (set by the
 * store while the legend is unfolded) makes room for it; see `steering.css`.
 * It is the one heavy subscriber of the steering store.
 */
export function SteeringBar() {
  const t = useT();
  const { active, view, flash, legendFolded, activity, question, queue, jumpBack } = useSteering();
  const tip = useKeyboardTip();
  const counts = useMemo(() => statusCounts(activity?.tabs ?? []), [activity]);
  const level = view?.level ?? "projects";
  const chips = useMemo(() => chipsFor(level, t, counts, question, queue, jumpBack !== null), [level, t, counts, question, queue, jumpBack]);
  if (!active) {
    return tip
      ? <div className="steer-tip" role="status">
        {t("mobile.steering.tip", { chord: CHORD, keys: (["up", "left", "down", "right"] as const).map((a) => steeringKeyLabel(steeringKeys(a, null)[0] ?? "")).join(" ") })}
        {isUntested("mobile.steering.tip") && <> <span className="untested">{t("mobile.newTab.untested")}</span></>}
      </div>
      : null;
  }
  // A view with its own keys keeps its bottom bars: the bar steps aside with steering.
  if (view?.paused) return null;
  if (legendFolded) return <div className="steer-bar folded" role="group" aria-label={t("mobile.steering.badge")}>{t("mobile.steering.folded")}</div>;
  const off = level === "region" || level === "section";
  const legendKeys = keysText("legend", level);
  const body = view?.typing === "composer" ? t("mobile.steering.handoff")
    : view?.typing === "field" ? t("mobile.steering.handoffField")
    : null;
  return <div className="steer-bar" role="group" aria-label={t("mobile.steering.badge")}>
    <div className="steer-head">
      <strong className="steer-badge">{t("mobile.steering.badge")}</strong>
      {isUntested("mobile.steering.mode") && <span className="untested">{t("mobile.newTab.untested")}</span>}
      <ol className="steer-ladder">
        {LADDER.map((entry) => <li key={entry.level} className={entry.level === level ? "current" : undefined} aria-current={entry.level === level ? "step" : undefined}>{t(entry.label)}</li>)}
        {off && <li className="current off" aria-current="step">
          {level === "region" ? t("mobile.steering.level.sheet") : view?.sectionLabel ? t(view.sectionLabel) : ""}
          {level === "region" && isUntested("mobile.steering.region") && <> <span className="untested">{t("mobile.newTab.untested")}</span></>}
        </li>}
      </ol>
      {legendKeys && <span className="steer-legend"><kbd>{legendKeys}</kbd> {t("mobile.steering.key.legend")}</span>}
    </div>
    <div className="steer-flash" role="status" aria-live="polite">{flash ? t(flash.key, flash.vars) : ""}</div>
    {!flash && (body
      ? <div className="steer-body">{body}</div>
      : <ul className="steer-keys">
        {chips.map((chip) => <li key={chip.id}>
          <kbd>{chip.keys}</kbd> {chip.label}{chip.count !== undefined && <b> {chip.count}</b>}
          {pillShown(chip.pill) && <> <span className="untested">{t("mobile.newTab.untested")}</span></>}
        </li>)}
      </ul>)}
  </div>;
}
