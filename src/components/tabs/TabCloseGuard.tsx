import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useDialogs } from "../common/PromptDialogs";
import { useT } from "../../lib/i18n";
import {
  PaneUnsavedContext,
  registerTabCloseGuard,
  type PaneUnsavedWork,
} from "../../lib/tabs/tabCloseGuard";

/**
 * A tab pane's close guard (`lib/tabs/tabCloseGuard`): collects what the pane's
 * viewers would lose on close and, when a close would lose any, asks Save /
 * Discard / Cancel. Save writes it first and closes only once nothing is left
 * unsaved — a failed save keeps the tab, its error shown in the viewer.
 */
export function TabCloseGuard({ scope, tabKey, children }: { scope: string; tabKey: string; children: ReactNode }) {
  const t = useT();
  const { chooseOption, dialogs } = useDialogs();
  const sources = useRef(new Set<PaneUnsavedWork>());
  const asking = useRef<Promise<boolean> | null>(null);

  const register = useCallback((work: PaneUnsavedWork) => {
    sources.current.add(work);
    return () => {
      sources.current.delete(work);
    };
  }, []);

  const losing = () => [...sources.current].filter((work) => work.lostOnClose());

  const ask = async (): Promise<boolean> => {
    const work = losing();
    if (work.length === 0) return true;
    const pick = await chooseOption({
      title: t("fileViewer.closeUnsavedTitle", { name: work.map((w) => w.label()).join(", ") }),
      body: t("fileViewer.closeUnsavedBody"),
      options: [
        { id: "save", label: t("fileViewer.closeUnsavedSave"), current: true },
        { id: "discard", label: t("fileViewer.closeUnsavedDiscard") },
      ],
      untested: "desktop.tabCloseUnsaved",
    });
    if (pick === "discard") return true;
    if (pick !== "save") return false;
    await Promise.all(work.map((w) => w.save().catch(() => {})));
    return losing().length === 0;
  };
  const askRef = useRef(ask);
  askRef.current = ask;

  useEffect(
    () =>
      registerTabCloseGuard(scope, tabKey, {
        wouldLose: () => [...sources.current].some((work) => work.lostOnClose()),
        // A second close while the question is up (a double click on ×)
        // waits for the same answer instead of stacking a second dialog.
        confirm: () => {
          asking.current ??= askRef.current().finally(() => {
            asking.current = null;
          });
          return asking.current;
        },
      }),
    [scope, tabKey],
  );

  return (
    <PaneUnsavedContext.Provider value={register}>
      {children}
      {dialogs}
    </PaneUnsavedContext.Provider>
  );
}
