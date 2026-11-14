/**
 * One phone app, several desktops (`docs/phone_multi_desktop_plan.md`,
 * Phase 3, minimal). The home — the desktop this app was installed from —
 * renders natively; another linked desktop is exactly one `DesktopFrame`: its
 * own phone page from its own origin, so it runs the UI built for its own API
 * and the home's code cannot read it (same-origin policy).
 *
 * The shell wraps `App` and owns the picker sheet. `App` keeps the gate: its
 * own lock comes first (it covers the shell and unmounts the frame), then the
 * selected desktop (`DesktopStage`), and only then the home's connect step —
 * so the home's "unavailable" screen shows only while the home is selected,
 * and a cached list frames another desktop with the home down.
 *
 * Inside a frame this page is the other side: no picker, no list; its switch
 * button asks the shell to open the picker (`frameBridge.ts`).
 */
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { App } from "../App";
import { OptionSheet } from "../components/OptionSheet";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { firstLabel, linkedSnapshot, selectDesktop, subscribeLinked } from "./linkedDesktops";
import { shellOrigin } from "./frameBridge";
import { ShellContext, type DesktopShellApi } from "./shellContext";

/** The page's root: the shell at the top, the plain app inside a frame. */
export function DesktopShell() {
  // Read once: whether a page is framed does not change while it lives.
  const [framed] = useState(() => shellOrigin() !== null);
  return framed ? <App /> : <TopShell />;
}

function TopShell() {
  const linked = useSyncExternalStore(subscribeLinked, linkedSnapshot);
  const [picker, setPicker] = useState(false);
  const [unlocked, setUnlockedState] = useState(false);
  const setUnlocked = useCallback((on: boolean) => {
    setUnlockedState(on);
    // A lock takes the picker away with everything else.
    if (!on) setPicker(false);
  }, []);
  const api = useMemo<DesktopShellApi>(() => ({
    selected: linked.selected,
    canSwitch: linked.desktops.length > 0,
    openPicker: () => setPicker(true),
    setUnlocked,
  }), [linked.selected, linked.desktops.length, setUnlocked]);
  return <ShellContext.Provider value={api}>
    <App />
    {picker && unlocked && <DesktopPicker onClose={() => setPicker(false)} />}
  </ShellContext.Provider>;
}

const HOME_KEY = "";

/** The picker: the home, then each linked desktop; a tap switches. */
function DesktopPicker({ onClose }: { onClose: () => void }) {
  const t = useT();
  const linked = useSyncExternalStore(subscribeLinked, linkedSnapshot);
  const home = window.location.origin;
  const options = [
    {
      key: HOME_KEY,
      label: linked.homeName ?? firstLabel(home),
      description: t("mobile.shell.homeNote", { origin: home }),
      current: linked.selected === null,
    },
    ...linked.desktops.map((row) => ({
      key: row.origin,
      label: row.name ?? firstLabel(row.origin),
      description: row.origin,
      current: linked.selected === row.origin,
    })),
  ];
  return <OptionSheet
    title={t("mobile.shell.pickerTitle")}
    options={options}
    waiting=""
    busy={false}
    onPick={(key) => {
      selectDesktop(key === HOME_KEY ? null : key);
      onClose();
    }}
    onClose={onClose}
  >{isUntested("mobile.shell.switcher") && <p className="sheet-note"><span className="untested">{t("mobile.newTab.untested")}</span></p>}</OptionSheet>;
}

