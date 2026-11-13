import { ContextMenuPortal } from "../common/ContextMenuPortal";

/** One entry of an `EntryMenu`. */
export interface MenuEntry {
  key: string;
  label: string;
  run: () => void;
}

/** The shared popover (`ContextMenuPortal` + `.tab-new-menu`) with a few
 *  actions: a project row's ⋯, a not-open project's right-click, and the machine
 *  list's Connect when several projects could use it. A pick closes it first. */
export function EntryMenu({ x, y, entries, onClose }: { x: number; y: number; entries: MenuEntry[]; onClose: () => void }) {
  return (
    <ContextMenuPortal x={x} y={y} keepBelow className="tab-new-menu cockpit-view-menu" onClose={onClose}>
      {entries.map((entry) => (
        <button
          key={entry.key}
          type="button"
          role="menuitem"
          className="tab-new-menu-item"
          onClick={() => {
            onClose();
            entry.run();
          }}
        >
          {entry.label}
        </button>
      ))}
    </ContextMenuPortal>
  );
}
