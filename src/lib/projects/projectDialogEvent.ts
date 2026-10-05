/** Which of the header + menu's project dialogs to open. */
export type ProjectDialogKind = "new" | "import" | "clone";

/** Window event `ProjectSwitcher` answers by opening that dialog — the same one
 *  its + menu opens. The dialogs are that bar's local state, so a surface
 *  elsewhere (the intro wizard) asks through this instead of keeping a copy. */
export const OPEN_PROJECT_DIALOG_EVENT = "app:open-project-dialog";

export function openProjectDialog(kind: ProjectDialogKind): void {
  window.dispatchEvent(new CustomEvent(OPEN_PROJECT_DIALOG_EVENT, { detail: kind }));
}
