# Keyboard steering on the phone

Why it is built the way it is. Plan and decisions: `docs/mobile_steering_plan.md`
(the numbered decisions and "Engine rules"); what each implementer left:
`docs/mobile_steering_handoff.md`. Code: `mobile-web/src/steering/`.

## The cursor is real DOM focus

A class set by hand is wiped whenever React re-renders `className` (the lists
re-poll every 5 s). Focus survives that, agrees with `useModalFocus` and with
screen readers, and needs no cursor state. So a list row is a
`[data-steer-row]` button and moving the cursor is `focus({ preventScroll })`
plus `scrollIntoView({ block: "nearest" })`. The outline is on `:focus`, not
`:focus-visible`: iOS sets the latter unreliably after a key moves focus by script.
When a remount drops focus (Back to a list that loads late, a reordered card)
a `MutationObserver`, on only while the mode is, puts it back on the row the
level was left from.

## Levels are derived, never stored

`App()` knows the base level (Home, a project, a terminal, a section); a
`aria-modal` sheet on top makes it `region`. Nothing stores "where steering is",
so it cannot disagree with the screen. The phone has no panes or subwindows, so
the desktop's panes + tabs collapse into `tabs` and scroll becomes `inside`.

## Why Alt+Space, and why Shift+Space is not enough

Some Android keyboards (Samsung) use Shift+Space to switch language; iOS may not
deliver it with nothing focused. Alt+Space enters from anywhere, text fields
included, and types no ordinary text. macOS-layout keyboards type a no-break
space under Alt, so the chords match by `code` or `key`, never `key` alone.
Both chords ignore `repeat`.

## Typing is never eaten

With the mode off the engine acts only on the two chords. With it on, it
prevents only the keydowns the table resolves, and the keyup of each (so the
Space that left the mode cannot click the focused button); it never calls
`stopPropagation`, so the idle-lock listener and React see every key. While a
text field has the caret, every key passes except Esc and the chords. The
handoff is read from focus, not from what steering did, so a field that took
focus by itself (a sheet's `autoFocus`, Home's search, the free-text answer)
is covered. The composer is not wrapped: after an Enter that left it empty the
engine blurs it.

## Why Ctrl, Meta and most Alt combos are ignored

Ctrl+Space and Cmd combos belong to the OS (input-source switching, iOS
shortcuts); Alt+arrow is the browser's history and Alt+letter types special
characters on iOS and macOS layouts. IME steps (`isComposing`, 229,
`Unidentified`/`Process`/`Dead`) belong to the keyboard layer. A key the table
does not resolve is untouched, which keeps Tab, F-keys and browser shortcuts.

## Why some views pause steering

The files library, the viewers and Mark up already own arrows, `/` and Esc.
Rather than edit those files (several are dirty on develop), the engine lists
their root classes (`OWN_KEYS_SELECTOR`) and passes every key through while one
is on top; `MobileKeydownGuards` fails if a class goes missing. A sheet opened
over one is the top surface and is walked as `region`.

## The legend and its room

`SteeringBar` is a solid fixed bar (no `backdrop-filter`, no animation, nothing
blurred). `html[data-steer-bar]` sets `--steer-bar-h` and moves the tab bar,
the FABs, the screens' bottom padding and the sheet backdrop clear of it; the
terminal screen gets `padding-bottom` because its inline `height` (from
`viewportHeight`) beats any stylesheet height. The height is a constant (a head
line, two key lines, the safe area): nothing is measured. All of it lives in
`steering.css`, so `style.css` is untouched.

## The one-time tip

The first hardware keydown on a device (a key soft keyboards never send, or one
outside a text field) shows the tip once and sets `hintSteering`. A device that
pressed the chord first never sees it. Turn off tips silences it without using
it up; Reset tips brings it back.
