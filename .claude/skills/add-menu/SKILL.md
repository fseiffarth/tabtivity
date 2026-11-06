---
name: add-menu
description: Build or restyle a floating surface in the desktop UI — a dialog, confirm, menu, context menu, popover, dropdown, header menu, hover card or toast. Use when adding one, changing how one looks or behaves, or moving an old hand-rolled one onto the shared frame.
argument-hint: "<what the surface is for>"
---

A **floating surface** is anything that sits above the window: dialogs, menus,
popovers, hover cards, toasts. They all share one look and one set of
behaviours, and every one built by hand has broken one of them somewhere: a
black title on a dark theme, a click leaking through the backdrop, a square
corner, a glass theme with no tint. So nothing new gets built from scratch.
Pick the shared **frame**, copy a **sibling** that already uses it, and take
every style value from a token.

The style itself is not repeated here. It lives in
`docs/context/desktop_ui_system.md` (type, spacing, colour, buttons, floating
surfaces, focus) and in the recipe comment at the top of the floating recipe
in `src/styles/apps.css`. Read the section you need there. A value written
anywhere else goes stale at the next redesign.

## Steps

1. **Pick the frame.** Done when you have named the frame and one existing
   component that uses it, which becomes your sibling.

   | The surface | Frame |
   | --- | --- |
   | A yes/no, a name prompt, a message, a choice | `useDialogs()` (`promptText`, `confirmAction`, `showMessage`, `chooseOption`) from `common/PromptDialogs.tsx`. Never plugin-dialog `confirm`/`ask`/`message`. |
   | A modal dialog with its own content (a form, a window) | `DialogShell` from the same file. Pick `frame`; `title` gives the title row with a close button; `scroll` when the body can overflow. Sibling: `projects/CategoryEditor.tsx`. |
   | A right-click menu, or a popover opened from a button | `common/ContextMenuPortal.tsx`. It clamps to the viewport, layers itself, and closes on a click away or Escape. Use `keepBelow` for a menu dropped from a button. |
   | A header action menu | `useHeaderMenu(id)` + `.tab-new-menu` (the rich variant adds `.vpn-indicator-menu`). Siblings: `header/SettingsMenu.tsx`, `layout/LocalModelMenu.tsx`. |
   | A select | `common/Dropdown.tsx`. |
   | A movable overlay window (mail, calendar, board) | `common/useFloatingFrame.tsx`. |
   | A tooltip, hint or tour step | `TooltipHost`, `HintBubble`, `TourCoachmark` in `common/`. |

2. **Copy the sibling's markup.** Take its class names for rows, labels,
   actions and fields. Dialog fields get their styling from the frame. Fields
   inside a popover need `menu-form` on their container. Rows that overflow a
   menu go in a `.menu-scroll-region` child. For buttons, use `.btn-primary`
   for the one main action, `.settings-btn` by default, `.btn-quiet` for
   link-weight actions (`.is-danger` for a destructive row), `.btn-danger`
   for a destructive main action, and `.seg` for a segmented choice. Done when
   the new surface has no CSS rule of its own beyond size and layout.

3. **Add CSS only for what is truly new.** Size and inner layout only, using
   the type tokens (`--text-*`), the spacing grid (`--space-*`) and the
   colour tokens. The accent marks only the active item, focus, a selection
   and the one main action: never a title, a frame or a label. If no family's
   surface class fits and you need a new one, follow the recipe comment in
   `apps.css` to the letter (every list it names, the rail, a radius token, a
   stacking context) and add the class to `MEMBERS` in
   `src/__tests__/theme/FloatingRecipe.test.ts`. Corners come from a radius
   token, never `clip-path`. Never animate a blurred `box-shadow`. A new
   entry or loop animation gets a `[data-software-paint]` rule.

4. **Use the behaviour that comes with the frame.** Focus, Escape, the
   backdrop and layering are already handled. Add no key handler, z-index
   or outside-click listener of your own. Icons come from `common/icons/Icon.tsx`.
   An icon-only button needs an `aria-label`. Every string goes through
   `useT()`, with the key in `src/lib/i18n/en.ts`; translate it in the other
   dictionaries when the surrounding keys are translated there. A surface in
   a hidden pane waits for `PaneVisibleContext`.

5. **Leave old surfaces better than you found them.** If you touch a dialog
   that still builds `.modal-backdrop` itself, move it onto `DialogShell` and
   remove its line from `STILL_HAND_ROLLED` in
   `src/__tests__/theme/DialogShellRatchet.test.ts`. That test fails for any
   new hand-rolled backdrop.

6. **Tag it and check it.** A new surface gets an `UntestedTag` and a row in
   `src/lib/untested.ts`. Run `scripts/gates.sh`. `FloatingRecipe`,
   `TypeScale`, `ChromeGlyphs` and `DialogShellRatchet` are the tests that
   catch a broken look. Tell the user exactly what to click to see the surface
   in each theme they use. You can't open the window yourself.
