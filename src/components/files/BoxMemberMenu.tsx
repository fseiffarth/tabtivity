import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { UntestedTag } from "../common/UntestedTag";
import { CheckIcon } from "../common/icons/Icon";
import { useT } from "../../lib/i18n";
import type { BoxMemberView } from "../../stores/boxAccordion";
import type { FileSourceSide } from "../../stores/remote/fileSourcePref";

/**
 * The `⋯` menu on a member's header in the box side panel: everything a header
 * used to hide behind its expanded toolbar. The shared context-menu scheme (one
 * `ContextMenuPortal`, `.context-menu-check` radio rows), no popup of its own.
 *
 * Files / Git picks the member's view (expanding it); open in file manager and
 * project settings act on this member; Remote / Local is the same project-wide
 * side the body's switch shows (remote SSH members only, never a host-pinned
 * one, which has no Local side); "Open as tab" is the member's Files (Project)
 * tab, the one that carries the git bar and its commit row.
 */
export function BoxMemberMenu({
  x,
  y,
  onClose,
  view,
  onView,
  onOpenFolder,
  onSettings,
  source,
  onSource,
  onOpenTab,
}: {
  x: number;
  y: number;
  onClose: () => void;
  view: BoxMemberView;
  onView: (view: BoxMemberView) => void;
  /** Absent for a host-pinned member: its folder is not on this machine. */
  onOpenFolder?: () => void;
  /** Absent where there is no project.json to edit. */
  onSettings?: () => void;
  /** Present for a remote SSH member that has a Local side. */
  source?: FileSourceSide;
  onSource?: (side: FileSourceSide) => void;
  onOpenTab: () => void;
}) {
  const t = useT();
  const pick = (action: () => void) => () => {
    action();
    onClose();
  };
  const radio = (checked: boolean, label: string, action: () => void, title?: string) => (
    <button
      type="button"
      className="context-menu-check"
      role="menuitemradio"
      aria-checked={checked}
      title={title}
      onClick={pick(action)}
    >
      <span className="context-menu-checkmark" aria-hidden>
        {checked ? <CheckIcon /> : null}
      </span>
      {label}
    </button>
  );
  return (
    <ContextMenuPortal x={x} y={y} onClose={onClose}>
      <div role="menu" aria-label={t("fileRoot.moreAria")}>
        {radio(view === "files", t("projectFilesView.tabFiles"), () => onView("files"))}
        {radio(view === "git", t("projectFilesView.tabGit"), () => onView("git"))}
        {source && onSource && (
          <>
            <hr />
            {radio(source === "local", t("fileSourceSwitch.local"), () => onSource("local"), t("fileSourceSwitch.localTitle"))}
            {radio(source === "remote", t("fileSourceSwitch.remote"), () => onSource("remote"), t("fileSourceSwitch.remoteTitle"))}
          </>
        )}
        <hr />
        {onOpenFolder && (
          <button type="button" role="menuitem" onClick={pick(onOpenFolder)}>
            {t("projectFilesView.openInFileManagerTitle")}
          </button>
        )}
        {onSettings && (
          <button type="button" role="menuitem" onClick={pick(onSettings)}>
            {t("projectFilesView.projectSettingsTitle")}
            <UntestedTag id="projectFilesPane.1" />
          </button>
        )}
        <button type="button" role="menuitem" onClick={pick(onOpenTab)} title={t("fileRoot.openAsTabTitle")}>
          {t("fileRoot.openAsTab")}
          <UntestedTag id="projectFilesPane.memberMenu" />
        </button>
      </div>
    </ContextMenuPortal>
  );
}
