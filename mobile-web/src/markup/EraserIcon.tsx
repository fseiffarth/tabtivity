/**
 * The eraser tool's icon, shared by the phone's palette and the desktop's
 * markup strip — a block eraser on a stroke, drawn in the button's own colour
 * so it follows the selected state. No font has an eraser glyph; `⌫` read as
 * backspace.
 */
export function EraserIcon() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8.5 20.5 3.6 15.6a2 2 0 0 1 0-2.8l9.2-9.2a2 2 0 0 1 2.8 0l4.8 4.8a2 2 0 0 1 0 2.8L12 19.6" />
      <path d="m8.4 8 7.6 7.6" />
      <path d="M8.5 20.5H21" />
    </svg>
  );
}
