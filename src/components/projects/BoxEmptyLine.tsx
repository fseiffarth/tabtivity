import { useBoxEditorStore } from "../../stores/boxEditor";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { isDetachedWindow } from "../../stores/detachedContext";

/**
 * "No projects yet — Add projects…": the line an empty box shows, in the slice
 * strip and in the box's side panel. The button opens the box sheet, whose
 * member list takes closed projects too. (Inside the slice no pill of another
 * project is on the row, so the copy offers the button only, not a drag.) The
 * sheet's host is mounted in `AppShell` only, so a popout shows the line without
 * the button (it would do nothing there).
 */
export function BoxEmptyLine({ boxId, className }: { boxId: string; className?: string }) {
  const t = useT();
  const popout = isDetachedWindow();
  return (
    <span className={`box-empty-line${className ? ` ${className}` : ""}`} role="status">
      <span className="box-empty-text">{t("boxEmpty.text")}</span>
      {!popout && (
        <button
          type="button"
          className="box-empty-add"
          title={t("boxEmpty.addTitle")}
          onClick={() => useBoxEditorStore.getState().openEditor(boxId)}
        >
          {t("boxEmpty.add")}
        </button>
      )}
      <UntestedTag id="boxEmpty.line" />
    </span>
  );
}
