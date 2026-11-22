import { Fragment } from "react";

import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { CheckboxIcon, SquareIcon } from "../common/icons/Icon";

/** One entry of an `EntryMenu`. */
export interface MenuEntry {
  key: string;
  label: string;
  run: () => void;
  /** A switch: the row shows ☑/☐ and is a `menuitemcheckbox`. */
  checked?: boolean;
  disabled?: boolean;
  /** Destructive (Remove, Disconnect): the danger colour. */
  danger?: boolean;
  /** A rule above this entry, to set a group apart. */
  separatorBefore?: boolean;
  title?: string;
}

/** The shared popover (`ContextMenuPortal` + `.tab-new-menu`) with a few
 *  actions: a project row's ⋯, a not-open project's right-click, the machine
 *  list's Connect when several projects could use it, and a machine row's ⋯. A
 *  pick closes it first. */
export function EntryMenu({
  x,
  y,
  entries,
  onClose,
}: {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
}) {
  // Dropped from a button in the lower half of the window (the last rows of a
  // long list), a menu kept below its anchor got only the strip down to the
  // window edge, and its last entries (Edit, Remove) fell off the screen. There
  // it is shifted up to fit instead; higher up it stays under its button.
  const keepBelow = y < window.innerHeight / 2;
  return (
    <ContextMenuPortal x={x} y={y} keepBelow={keepBelow} className="tab-new-menu cockpit-view-menu" onClose={onClose}>
      <div className="menu-scroll-region">
        {entries.map((entry) => (
          <Fragment key={entry.key}>
            {entry.separatorBefore && <div className="entry-menu-sep" role="separator" />}
            <button
              type="button"
              role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={entry.checked}
              className={`tab-new-menu-item${entry.checked === undefined ? "" : " context-menu-check"}${entry.danger ? " is-danger" : ""}`}
              disabled={entry.disabled}
              title={entry.title}
              onClick={() => {
                onClose();
                entry.run();
              }}
            >
              {entry.checked !== undefined && (
                <span className="context-menu-checkmark" aria-hidden>
                  {entry.checked ? <CheckboxIcon /> : <SquareIcon />}
                </span>
              )}
              {entry.label}
            </button>
          </Fragment>
        ))}
      </div>
    </ContextMenuPortal>
  );
}
