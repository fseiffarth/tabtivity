import { useState } from "react";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { readFlag, writeFlag, type MobileFlag } from "../prefs";

const HINTS = {
  agentHold: { flag: "hintAgentHold", text: "mobile.hints.agentHold" },
  agentDefault: { flag: "hintAgentDefault", text: "mobile.hints.agentDefault" },
  projectFiles: { flag: "hintProjectFiles", text: "mobile.hints.projectFiles" },
} as const satisfies Record<string, { flag: MobileFlag; text: TranslationKey }>;

/** Closing lasts for this visit; only the checkbox remembers it on this phone.
 * No timer: the reader gets time to read and dismiss the message. */
export function HintMessage({ hint, floating = false }: { hint: keyof typeof HINTS; floating?: boolean }) {
  const t = useT();
  const { flag, text } = HINTS[hint];
  const [hidden, setHidden] = useState(() => readFlag(flag));
  const [neverAgain, setNeverAgain] = useState(false);
  if (hidden) return null;
  return <aside className={`hint-message${floating ? " hint-message-floating" : ""}`} aria-label={t("mobile.hints.title")}>
    <div className="hint-message-head">
      <strong>{t("mobile.hints.title")}{isUntested("mobile.hints") && <span className="untested">{t("mobile.newTab.untested")}</span>}</strong>
      <button onClick={() => setHidden(true)} aria-label={t("mobile.hints.close")}>×</button>
    </div>
    <p role={floating ? "status" : undefined}>{t(text)}</p>
    <label><input type="checkbox" checked={neverAgain} onChange={(event) => {
      setNeverAgain(event.target.checked);
      writeFlag(flag, event.target.checked);
    }} />{t("mobile.hints.neverAgain")}</label>
  </aside>;
}
