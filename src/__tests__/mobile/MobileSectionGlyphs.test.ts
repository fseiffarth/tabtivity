/**
 * The phone's tab bar showed Projects and Calendar in colour but To-do and
 * Mail in grey: ☑ and ✉ exist as text symbols, so the phone drew them from a
 * text font, while 🗂 and 🗓 fell back to the colour-emoji font. The sections
 * now wear the shared drawn line icons, the same ones the desktop header uses,
 * so no font decides how they look.
 */
import { describe, expect, it } from "vitest";
import { SECTION_ICON } from "../../../mobile-web/src/glyphs";
import { CalendarIcon, CheckboxIcon, FolderIcon, MailIcon } from "../../components/common/icons/Icon";

describe("mobile section icons", () => {
  it("draws every section with a shared line icon", () => {
    expect(SECTION_ICON).toEqual({
      projects: FolderIcon,
      todo: CheckboxIcon,
      calendar: CalendarIcon,
      mail: MailIcon,
    });
  });
});
