// The tip cards' switch, from the start page's "This device" sheet (the
// header's gear): where a tip's Turn off tips button is undone, and where
// Reset tips brings back every tip the Read button made rarer.

import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { readFlag, writeFlag } from "../prefs";
import { resetTips } from "./HintMessage";
import { OptionSheet, type SheetOption } from "./OptionSheet";

export function tipsOff(): boolean {
  return readFlag("hintsOff");
}

export function TipsRow({ off, open, expanded }: { off: boolean; open: () => void; expanded: boolean }) {
  const t = useT();
  return <li><button aria-haspopup="dialog" aria-expanded={expanded} onClick={open}>
    <span><strong>{t("mobile.tips.title")}{isUntested("mobile.hints.read") && <span className="untested">{t("mobile.newTab.untested")}</span>}</strong><small>{t(off ? "mobile.tips.off" : "mobile.tips.on")}</small></span>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
  </button></li>;
}

export function TipsSheet({ off, onChange, onClose }: { off: boolean; onChange: (off: boolean) => void; onClose: () => void }) {
  const t = useT();
  const options: SheetOption[] = [
    { key: "on", label: t("mobile.tips.on"), current: !off },
    { key: "off", label: t("mobile.tips.off"), current: off },
    { key: "reset", label: t("mobile.tips.reset"), description: t("mobile.tips.resetHelp"), current: false },
  ];
  return <OptionSheet
    title={t("mobile.tips.title")}
    note={{ text: t("mobile.tips.hint") }}
    options={options}
    waiting=""
    busy={false}
    onPick={(key) => {
      if (key === "reset") resetTips();
      else writeFlag("hintsOff", key === "off");
      onChange(key === "off");
      onClose();
    }}
    onClose={onClose}
  />;
}
