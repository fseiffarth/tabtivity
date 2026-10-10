import type { ComponentType } from "react";
import { CalendarIcon, CheckboxIcon, FolderIcon, MailIcon, type IconProps } from "../../src/components/common/icons/Icon";

/**
 * The section icons the tab bar and the Home alert list share.
 *
 * They were Unicode symbols (🗂 ☑ 🗓 ✉) with U+FE0F asking for colour-emoji
 * presentation, because phones drew ☑ and ✉ from a text font and 🗂 and 🗓 from
 * the emoji font, and the row came out half grey, half colour. Drawn line icons
 * in `currentColor` settle that without depending on any font, follow the
 * active tab's colour, and match the desktop header's mail / calendar / to-do.
 */
export const SECTION_ICON: Record<"projects" | "todo" | "calendar" | "mail", ComponentType<IconProps>> = {
  projects: FolderIcon,
  todo: CheckboxIcon,
  calendar: CalendarIcon,
  mail: MailIcon,
};
