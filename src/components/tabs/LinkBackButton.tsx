import type { MouseEvent as ReactMouseEvent } from "react";
import { useT } from "../../lib/i18n";
import { closeTabInScope } from "../../lib/remote/closeRemoteTab";
import { linkBackKey, useLinkBackStore } from "../../stores/linkBack";
import { useTabsStore } from "../../stores/tabs";
import { UntestedTag } from "../common/UntestedTag";

/**
 * "← Back to <agent>" over a file tab an agent's file link opened
 * (`stores/linkBack`). A click shows the agent tab again and closes this one
 * when the link opened it; Shift+click keeps it open. Drawn only while the
 * agent tab is still open in the same scope.
 */
export function LinkBackButton({ scope, tabKey }: { scope: string; tabKey: string }) {
  const t = useT();
  const back = useLinkBackStore((s) => s.byTab[linkBackKey(scope, tabKey)]);
  const fromLabel = useTabsStore((s) => {
    if (!back) return null;
    const list = scope === s.scope ? s.tabs : (s.tabsByScope[scope] ?? []);
    return list.find((tab) => tab.key === back.from)?.label ?? null;
  });
  if (!back || fromLabel === null) return null;
  const close = back.close;
  const goBack = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    useLinkBackStore.getState().clear(scope, tabKey);
    useTabsStore.getState().setActive(back.from);
    if (close && !event.shiftKey) closeTabInScope(scope, tabKey);
  };
  const title = close ? `${t("linkBack.closeHint")} · ${t("linkBack.keepHint")}` : t("linkBack.leaveHint");
  return (
    <button type="button" className="link-back-btn" onClick={goBack} title={title}>
      <span aria-hidden="true">←</span>
      <span className="link-back-btn-label">{t("linkBack.label", { name: fromLabel })}</span>
      <UntestedTag id="linkBack.button" />
    </button>
  );
}
