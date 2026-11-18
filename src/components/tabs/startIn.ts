import { createElement } from "react";
import type { TabEntry } from "../../stores/tabs";
import { PROJECT_FILES_TAB_CMD } from "../../stores/tabs";
import type { BoxMemberDir } from "../../stores/boxes";
import type { TranslationKey } from "../../lib/i18n";
import { boxColor, memberColor } from "../../lib/theme/boxColor";
import {
  SHELL_ITEMS,
  buildStaticTabSpec,
  type StaticMenuItem,
} from "../../lib/tabs/newTabItems";
import type { AddMenuEntry, AddMenuHeading } from "./AddTabMenuList";
import type { MemberTable } from "./TabMemberChip";

/**
 * The box "+" menu's "Start in…" (box redesign, plan step 11): the Agents, Shell
 * and Files rows each get a ▾ fly-out listing the whole box, then every member,
 * and a plain pick follows the new-tab target (the active tab's member,
 * `newTabTarget`). The three per-member rows of the old "Box members" group are
 * gone; this one module is what both "+" menus (the main `TabBar`, the popout's
 * `NewTabMenu`) build the fly-outs and the pick from.
 */

type Translate = (key: TranslationKey, vars?: Record<string, string>) => string;

/** The rows that can start in a member. */
export type StartInKind = "agent" | "shell" | "files";

/** The plain Files row's item (a member's Files is a `projectfiles` tab instead). */
export const FILES_ITEM = SHELL_ITEMS.find((i) => i.kind === "files")!;

/**
 * The tab a "start in" pick opens: the item rooted at the member's folder, or the
 * box folder for `member === null`. `null` when there is no such folder (a box
 * without one cannot be started in). The label is the plain kind's own ("Claude",
 * "Shell", "Files"): the tab strip's chip names the member, so no " — name"
 * suffix. A member's Files is the `projectfiles` tab (the viewer with the commit
 * bar); the whole box's is the plain `files` tab. Agents and shells get the
 * member's (or box's) name for their session rename, as a project's do.
 */
export function startInSpec(
  kind: StartInKind,
  item: StaticMenuItem | undefined,
  member: BoxMemberDir | null,
  table: MemberTable,
  t: Translate,
): Omit<TabEntry, "key"> | null {
  const dir = member ? member.dir : table.boxFolder;
  if (!dir) return null;
  const name = member ? member.name : table.box.name;
  if (kind === "files") {
    const base = buildStaticTabSpec(FILES_ITEM, dir, name, t);
    return member ? { ...base, cmd: PROJECT_FILES_TAB_CMD, kind: "projectfiles" } : base;
  }
  return item ? buildStaticTabSpec(item, dir, name, t) : null;
}

/**
 * Open `kind` in `member` (`null` = the whole box): the ONE helper behind every
 * "Start in…" entry and a plain Files pick in a box. The host supplies how a tab
 * lands: `viaRow` for an agent or shell that starts in the folder the plain row
 * already targets (so it keeps the row's worktree choice), `add` for any other
 * new tab, `addUnique` for the Files panes, which are one per folder.
 */
export function openInMember(ctx: {
  kind: StartInKind;
  member: BoxMemberDir | null;
  item?: StaticMenuItem;
  table: MemberTable;
  /** The folder a plain row of this menu starts in (`newTabTarget`'s cwd). */
  launchCwd: string;
  t: Translate;
  viaRow: (item: StaticMenuItem) => void;
  add: (spec: Omit<TabEntry, "key">) => void;
  addUnique: (spec: Omit<TabEntry, "key">) => void;
}): void {
  const spec = startInSpec(ctx.kind, ctx.item, ctx.member, ctx.table, ctx.t);
  if (!spec) return;
  if (ctx.kind === "files") ctx.addUnique(spec);
  else if (ctx.item && spec.cwd === ctx.launchCwd) ctx.viaRow(ctx.item);
  else ctx.add(spec);
}

/** The mark of a target: a dot in the member's colour, a rounded square in the box's. */
function targetMark(member: BoxMemberDir | null, table: MemberTable) {
  const color = member ? memberColor(member.id) : boxColor(table.box);
  return {
    color,
    dot: createElement("span", {
      className: `tab-member-mark${member ? "" : " box"}`,
      style: { background: color },
    }),
  };
}

/**
 * The ▾ fly-out of one row: "Claude in <box>" for the whole box (only once the
 * box has a folder), then "Claude in api" for each member. The labels are full
 * (`searchable`), so the search box finds a member by name without opening the
 * list. Empty (no ▾) outside a box or when there is nothing to choose between.
 */
export function startInFlyout(opts: {
  /** What the row starts: "Claude", "Shell", "Files". */
  what: string;
  table: MemberTable | null;
  open: (member: BoxMemberDir | null) => void;
  t: Translate;
}): Pick<AddMenuEntry, "machineTitle" | "machineEntries"> {
  const { table, what, t } = opts;
  if (!table) return {};
  const targets: (BoxMemberDir | null)[] = [...(table.boxFolder ? [null] : []), ...table.members];
  if (targets.length < 2) return {};
  return {
    machineTitle: t("newTabMenu.startInTitle", { what }),
    machineEntries: targets.map((member): AddMenuEntry => {
      const mark = targetMark(member, table);
      return {
        key: `${what}@${member ? member.id : "box"}`,
        label: member
          ? t("newTabMenu.startInMember", { what, name: member.name })
          : t("newTabMenu.startInBox", { what }),
        dot: mark.dot,
        color: mark.color,
        searchable: true,
        untested: "newTabMenu.startInMember",
        onPick: () => opts.open(member),
      };
    }),
  };
}

/** The "+" menu's first line in a box: where a plain pick starts (decision 3). */
export function targetHeading(
  member: BoxMemberDir | null,
  table: MemberTable,
  t: Translate,
): AddMenuHeading {
  const mark = targetMark(member, table);
  return {
    text: member
      ? t("newTabMenu.targetMember", { name: member.name })
      : t("newTabMenu.targetBox", { name: table.box.name }),
    color: mark.color,
    box: !member,
    untested: "newTabMenu.targetMember",
  };
}
