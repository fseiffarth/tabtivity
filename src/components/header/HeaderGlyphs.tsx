/**
 * The header's button icons, drawn rather than typed. The ✉ 🗓 ☑ ▦ ⚙ they
 * replace came from whichever fallback font had the code point, so each had
 * its own stroke weight (most of them heavy) and its own ink box. These share
 * one hand with the status cluster's phone (`MobileIndicator`): a 16-unit grid,
 * outlines only, rounded corners and caps. Stroke is 0.95 units because they
 * render at 20px, which lands them on the phone's ~1.2px line. Every glyph's
 * outline runs from y=2 to y=14, so they all stand the same height in the bar
 * — keep that when redrawing one.
 */

import type { ReactNode } from "react";

const STROKE = {
  stroke: "currentColor",
  strokeWidth: 0.95,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function Glyph({ className, children }: { className: string; children: ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function MailGlyph({ className }: { className: string }) {
  return (
    <Glyph className={className}>
      <rect x="0.9" y="2" width="14.2" height="12" rx="1.8" {...STROKE} />
      <path d="M1.9 3.4 8 8.4l6.1-5" {...STROKE} />
    </Glyph>
  );
}

export function CalendarGlyph({ className }: { className: string }) {
  return (
    <Glyph className={className}>
      <rect x="2" y="3.2" width="12" height="10.8" rx="1.8" {...STROKE} />
      <path d="M2 6.6h12M5.2 2v2.4M10.8 2v2.4" {...STROKE} />
      <circle cx="5.2" cy="9.3" r="0.7" fill="currentColor" />
      <circle cx="8" cy="9.3" r="0.7" fill="currentColor" />
      <circle cx="10.8" cy="9.3" r="0.7" fill="currentColor" />
      <circle cx="5.2" cy="11.7" r="0.7" fill="currentColor" />
      <circle cx="8" cy="11.7" r="0.7" fill="currentColor" />
    </Glyph>
  );
}

export function TodoGlyph({ className }: { className: string }) {
  return (
    <Glyph className={className}>
      <rect x="2" y="2" width="12" height="12" rx="2.2" {...STROKE} />
      <path d="m5.2 8.2 1.9 1.9 3.8-4" {...STROKE} />
    </Glyph>
  );
}

/** A tray — files the phone sent to this desktop (`InboxIndicator`). */
export function InboxGlyph({ className }: { className: string }) {
  return (
    <Glyph className={className}>
      <path
        d="M1.5 9 3.5 3.3A1.8 1.8 0 0 1 5.2 2h5.6a1.8 1.8 0 0 1 1.7 1.3L14.5 9v3.2a1.8 1.8 0 0 1-1.8 1.8H3.3a1.8 1.8 0 0 1-1.8-1.8Z"
        {...STROKE}
      />
      <path d="M1.5 9h3.4l1 1.8h4.2l1-1.8h3.4" {...STROKE} />
    </Glyph>
  );
}

export function SettingsGlyph({ className }: { className: string }) {
  return (
    <Glyph className={className}>
      {/* eight teeth on a 4.5-unit rim, tips out to 6 */}
      <path
        d="M6.91 3.63L7.16 2.06L8.84 2.06L9.09 3.63A4.5 4.5 0 0 1 10.32 4.14L11.61 3.21L12.79 4.39L11.86 5.68A4.5 4.5 0 0 1 12.37 6.91L13.94 7.16L13.94 8.84L12.37 9.09A4.5 4.5 0 0 1 11.86 10.32L12.79 11.61L11.61 12.79L10.32 11.86A4.5 4.5 0 0 1 9.09 12.37L8.84 13.94L7.16 13.94L6.91 12.37A4.5 4.5 0 0 1 5.68 11.86L4.39 12.79L3.21 11.61L4.14 10.32A4.5 4.5 0 0 1 3.63 9.09L2.06 8.84L2.06 7.16L3.63 6.91A4.5 4.5 0 0 1 4.14 5.68L3.21 4.39L4.39 3.21L5.68 4.14A4.5 4.5 0 0 1 6.91 3.63Z"
        {...STROKE}
      />
      <circle cx="8" cy="8" r="1.9" {...STROKE} />
    </Glyph>
  );
}

/** Two stacked server units — the global machines — for the header Machines
 *  button (`header/MachinesIndicator`) and its overlay's bar
 *  (`header/MachinesOverlay`). On the shared 16-unit grid, y=2..14. */
export function MachinesGlyph({ className }: { className: string }) {
  return (
    <Glyph className={className}>
      <g {...STROKE}>
        <rect x="2" y="2" width="12" height="5" rx="1.2" />
        <rect x="2" y="9" width="12" height="5" rx="1.2" />
        <path d="M4.5 4.5h.01M4.5 11.5h.01M8 4.5h3.5M8 11.5h3.5" />
      </g>
    </Glyph>
  );
}

/** A shield with a keyhole — the machine-wide OpenVPN tunnel — in place of
 *  the "VPN" word on the header button (`header/VpnIndicator`). */
export function VpnGlyph({ className }: { className: string }) {
  return (
    <Glyph className={className}>
      <path d="M8 2 13 3.8v3.8c0 3-2.1 5.3-5 6.4-2.9-1.1-5-3.4-5-6.4V3.8Z" {...STROKE} />
      <circle cx="8" cy="7.1" r="1.2" {...STROKE} />
      <path d="M8 8.3v2.2" {...STROKE} />
    </Glyph>
  );
}

/** A processor chip — on-device compute — for the Models & agents button
 *  (`layout/LocalModelMenu`) and the overlay it opens (`models/ModelsOverlay`).
 *  The one glyph here NOT on the shared 16-unit `Glyph` grid: it keeps the
 *  24-unit drawing and 1.4 stroke it had inline in the button, so the button
 *  (sized to 19px by `svg.local-model-icon`) stays pixel-identical. */
export function ModelsGlyph({ className }: { className: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <rect x="6" y="6" width="12" height="12" rx="2" />
        <rect x="9.5" y="9.5" width="5" height="5" rx="0.8" />
        <path d="M9 2.5V6M12 2.5V6M15 2.5V6M9 18v3.5M12 18v3.5M15 18v3.5M2.5 9H6M2.5 12H6M2.5 15H6M18 9h3.5M18 12h3.5M18 15h3.5" />
      </g>
    </svg>
  );
}
