/**
 * Tabtivity's shared line-icon set — the replacement for colour emoji in the
 * chrome. Same rounded `currentColor` outline as {@link SaveIcon} /
 * {@link PrinterIcon} / the edge-rail icons (24-grid, 1.4 stroke), so every
 * icon follows the theme, dims with its row, and reads as one family.
 *
 * Sized in `em` by default, so an icon drops into the spot a glyph held and
 * scales with that spot's `font-size` the way the glyph did. Each is
 * `aria-hidden`: the control around it carries the accessible name.
 */
import type { ReactNode, SVGProps } from "react";

export interface IconProps {
  className?: string;
  /** Width and height; any CSS length. Defaults to a glyph-sized 1.2em. */
  size?: number | string;
}

function Frame({ className, size = "1.2em", children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      className={className ? `app-icon ${className}` : "app-icon"}
      style={{ verticalAlign: "-0.2em", flexShrink: 0 }}
      aria-hidden="true"
      focusable="false"
    >
      <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </g>
    </svg>
  );
}

/** A page with a folded corner — the base every file icon draws on. */
const PAGE = (
  <>
    <path d="M6 3.5h8l4.5 4.5v12.5H6z" />
    <path d="M14 3.5V8h4.5" />
  </>
);

export function FolderIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M3.5 6.5a1.5 1.5 0 011.5-1.5h4l2 2h8a1.5 1.5 0 011.5 1.5v9.5a1.5 1.5 0 01-1.5 1.5H5a1.5 1.5 0 01-1.5-1.5z" />
    </Frame>
  );
}

export function PageIcon(p: IconProps) {
  return <Frame {...p}>{PAGE}</Frame>;
}

/** Source code: a page with angle brackets. */
export function FileCodeIcon(p: IconProps) {
  return (
    <Frame {...p}>
      {PAGE}
      <path d="M10 12.5l-2 2 2 2" />
      <path d="M14 12.5l2 2-2 2" />
    </Frame>
  );
}

/** Prose / markup: a page with text lines. */
export function FileTextIcon(p: IconProps) {
  return (
    <Frame {...p}>
      {PAGE}
      <path d="M9 12h6" />
      <path d="M9 15h6" />
      <path d="M9 18h3.5" />
    </Frame>
  );
}

/** Structured data (JSON): a page with braces. */
export function FileDataIcon(p: IconProps) {
  return (
    <Frame {...p}>
      {PAGE}
      <path d="M10.5 11.5c-.9 0-1.4 .5-1.4 1.3v.9c0 .5-.4 .9-.9 .9 .5 0 .9 .4 .9 .9v.9c0 .8 .5 1.3 1.4 1.3" />
      <path d="M13.5 11.5c.9 0 1.4 .5 1.4 1.3v.9c0 .5 .4 .9 .9 .9-.5 0-.9 .4-.9 .9v.9c0 .8-.5 1.3-1.4 1.3" />
    </Frame>
  );
}

/** Image: a page with a sun and a hill. */
export function FileImageIcon(p: IconProps) {
  return (
    <Frame {...p}>
      {PAGE}
      <circle cx="10" cy="12" r="1.2" />
      <path d="M8 18.5l3-3 2 2 1.5-1.5 2 2" />
    </Frame>
  );
}

/** Shell script: a page with a prompt. */
export function FileTerminalIcon(p: IconProps) {
  return (
    <Frame {...p}>
      {PAGE}
      <path d="M8.5 13l2.5 2-2.5 2" />
      <path d="M12.5 17.5h3" />
    </Frame>
  );
}

/** Bibliography / references: a closed book. */
export function BookIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M5 5.5a2 2 0 012-2h12v14H7a2 2 0 00-2 2z" />
      <path d="M5 19.5a2 2 0 002 2h12v-4" />
      <path d="M9 7.5h6" />
    </Frame>
  );
}

export function SearchIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5" />
    </Frame>
  );
}

/** A speech bubble — comments, notes, chat. */
export function CommentIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M4.5 6A1.5 1.5 0 016 4.5h12A1.5 1.5 0 0119.5 6v9a1.5 1.5 0 01-1.5 1.5h-8l-4 3.5v-3.5A1.5 1.5 0 014.5 15z" />
    </Frame>
  );
}

/** A push pin — keep docked / pinned. */
export function PinIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M9 3.5h6" />
      <path d="M10 3.5V9l-3 3.5h10L14 9V3.5" />
      <path d="M12 12.5v8" />
    </Frame>
  );
}

export function TrashIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M4.5 6.5h15" />
      <path d="M9.5 6.5v-2h5v2" />
      <path d="M6.5 6.5l1 13.5h9l1-13.5" />
      <path d="M10 10v6.5" />
      <path d="M14 10v6.5" />
    </Frame>
  );
}

export function LockIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <rect x="5.5" y="10.5" width="13" height="10" rx="1.5" />
      <path d="M8.5 10.5v-3a3.5 3.5 0 017 0v3" />
    </Frame>
  );
}

/** The lock with its shackle swung out past the body's left edge. A shackle
 *  that only lifts or shortens reads as closed at the 12px pill size. */
export function UnlockIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <rect x="5.5" y="10.5" width="13" height="10" rx="1.5" />
      <path d="M8.5 10.5V7a3.5 3.5 0 00-7 0v1.5" />
    </Frame>
  );
}

export function KeyIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <circle cx="8" cy="15.5" r="3.5" />
      <path d="M10.5 13L19 4.5" />
      <path d="M16.5 7L19 9.5" />
      <path d="M14 9.5l2 2" />
    </Frame>
  );
}

export function CalendarIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <rect x="4" y="5.5" width="16" height="14.5" rx="1.5" />
      <path d="M4 10h16" />
      <path d="M8.5 3.5v4" />
      <path d="M15.5 3.5v4" />
    </Frame>
  );
}

/** A camera — video calls / "join" affordances. */
export function VideoIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <rect x="3.5" y="7" width="12" height="10" rx="1.5" />
      <path d="M15.5 10.5l5-3v9l-5-3" />
    </Frame>
  );
}

/** An arrow into a tray — downloads, incoming files. */
export function InboxIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M12 4v9" />
      <path d="M8 9.5l4 4 4-4" />
      <path d="M4.5 14.5v4A1.5 1.5 0 006 20h12a1.5 1.5 0 001.5-1.5v-4" />
    </Frame>
  );
}

/** An arrow out of a tray's rim — submit, send up. */
export function UploadIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M5 4h14" />
      <path d="M12 20V8" />
      <path d="M7 12.5l5-5 5 5" />
    </Frame>
  );
}

export function PaperclipIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M18 11.5l-6.2 6.2a4 4 0 01-5.7-5.7l6.7-6.7a2.7 2.7 0 013.8 3.8l-6.6 6.6a1.3 1.3 0 01-1.9-1.9l6-6" />
    </Frame>
  );
}

export function GlobeIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.3 2.3 3.5 5.2 3.5 8.5s-1.2 6.2-3.5 8.5c-2.3-2.3-3.5-5.2-3.5-8.5s1.2-6.2 3.5-8.5z" />
    </Frame>
  );
}

export function LinkIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />
    </Frame>
  );
}

export function PlayIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M8 5.5v13l10-6.5z" />
    </Frame>
  );
}

export function PauseIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M8.5 5.5v13" />
      <path d="M15.5 5.5v13" />
    </Frame>
  );
}

export function SkipBackIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M6.5 5.5v13" />
      <path d="M18 5.5v13L9 12z" />
    </Frame>
  );
}

export function SkipForwardIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M17.5 5.5v13" />
      <path d="M6 5.5v13l9-6.5z" />
    </Frame>
  );
}

/** Two arrows chasing each other — repeat / loop. */
export function LoopIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M4.5 11V9.5A2.5 2.5 0 017 7h12" />
      <path d="M16.5 4l3 3-3 3" />
      <path d="M19.5 13v1.5A2.5 2.5 0 0117 17H5" />
      <path d="M7.5 20l-3-3 3-3" />
    </Frame>
  );
}

/** A stopwatch — timers, due times. */
export function TimerIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <circle cx="12" cy="13" r="7.5" />
      <path d="M12 9.5V13l2.5 2" />
      <path d="M10 2.5h4" />
    </Frame>
  );
}

export function BugIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M8 10a4 4 0 018 0v4.5a4 4 0 01-8 0z" />
      <path d="M9.5 6.8a2.5 2.5 0 015 0" />
      <path d="M12 10v8.5" />
      <path d="M8 12H4.5" />
      <path d="M19.5 12H16" />
      <path d="M8 16.5L5 18" />
      <path d="M16 16.5l3 1.5" />
      <path d="M8.3 8.5L5.5 7" />
      <path d="M15.7 8.5L18.5 7" />
    </Frame>
  );
}

/** A lightning bolt — interactive / quick runs. */
export function BoltIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M13 3.5l-7.5 10h6l-1 7 7.5-10h-6z" />
    </Frame>
  );
}

export function EyeIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.5" />
    </Frame>
  );
}

export function TagIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M3.5 12.3V4.5a1 1 0 011-1h7.8l8.2 8.2a1.2 1.2 0 010 1.7l-7.1 7.1a1.2 1.2 0 01-1.7 0z" />
      <circle cx="8" cy="8" r="1.3" />
    </Frame>
  );
}

export function MailIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
      <path d="M4.5 7l7.5 6 7.5-6" />
    </Frame>
  );
}

/** A ticked box — to-dos, tasks. */
export function CheckboxIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
      <path d="M8.5 12.2l2.5 2.5 4.5-5" />
    </Frame>
  );
}

/** A four-point sparkle — AI / assistant features. */
export function SparkleIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M11 4c.6 3.8 2.2 5.4 6 6-3.8.6-5.4 2.2-6 6-.6-3.8-2.2-5.4-6-6 3.8-.6 5.4-2.2 6-6z" />
      <path d="M18 15.5v4" />
      <path d="M16 17.5h4" />
    </Frame>
  );
}

/** A feather — the light, low-overhead mode. */
export function FeatherIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M19.5 4.5c-6.5 0-11.5 4-11.5 10.5v4.5h4.5c6.5 0 10.5-5 10.5-11.5" />
      <path d="M4.5 20.5l11-11" />
      <path d="M8 15h6" />
    </Frame>
  );
}

/** A microscope — the detailed, close-look mode. */
export function MicroscopeIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M9.5 3.5l3 1.5-3 6-3-1.5z" />
      <path d="M11 8.2a5.5 5.5 0 013.8 9.8" />
      <path d="M5 20.5h14" />
      <path d="M8 17.5h7" />
      <path d="M8 11.2v6.3" />
    </Frame>
  );
}

/** A clock face — due times, deadlines. */
export function ClockIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </Frame>
  );
}

/** An app window — an opened external program. */
export function WindowIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <path d="M3.5 8.5h17" />
      <path d="M6.5 6.5h.01" />
      <path d="M9 6.5h.01" />
    </Frame>
  );
}

// ── Glyphs that used to be typed ─────────────────────────────────────────────
// Every icon below replaces a Unicode symbol with the Emoji property (↗ ⬆ ⬇ ⬅
// ➡ ↔ ↩ ⚠ ⚙ ✉ ☑ ▶ ☁ ✔ ✏ ⏱): a font fallback could hand any of those to the
// colour-emoji font, where they ignore `currentColor` and the row's weight.

/** North-east arrow — open externally, jump to, pop out. */
export function ArrowUpRightIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M7 17L17 7" />
      <path d="M9 7h8v8" />
    </Frame>
  );
}

export function ArrowUpIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M12 19V5" />
      <path d="M6 11l6-6 6 6" />
    </Frame>
  );
}

export function ArrowDownIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M12 5v14" />
      <path d="M6 13l6 6 6-6" />
    </Frame>
  );
}

export function ArrowLeftIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M19 12H5" />
      <path d="M11 6l-6 6 6 6" />
    </Frame>
  );
}

export function ArrowRightIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </Frame>
  );
}

/** A two-headed horizontal arrow — centred / both ways. */
export function ArrowsHorizontalIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M4 12h16" />
      <path d="M8 8l-4 4 4 4" />
      <path d="M16 8l4 4-4 4" />
    </Frame>
  );
}

/** A hooked arrow back — undo, restore, reply. */
export function UndoIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 010 11H11" />
    </Frame>
  );
}

/** A triangle with a bang — warnings. */
export function WarningIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M12 4L2.5 20h19z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.4h.01" />
    </Frame>
  );
}

/** The header's eight-tooth cog, on this set's grid. */
export function GearIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M10.37 5.45L10.74 3.09h2.52l.37 2.36a6.75 6.75 0 011.85.76l1.93-1.4 1.77 1.77-1.39 1.94a6.75 6.75 0 01.76 1.85l2.36.37v2.52l-2.36.37a6.75 6.75 0 01-.76 1.85l1.39 1.93-1.77 1.77-1.93-1.39a6.75 6.75 0 01-1.85.76l-.37 2.36h-2.52l-.37-2.36a6.75 6.75 0 01-1.85-.76l-1.94 1.39-1.77-1.77 1.4-1.93a6.75 6.75 0 01-.76-1.85l-2.36-.37v-2.52l2.36-.37a6.75 6.75 0 01.76-1.85l-1.4-1.94 1.77-1.77 1.94 1.4a6.75 6.75 0 011.85-.76z" />
      <circle cx="12" cy="12" r="2.85" />
    </Frame>
  );
}

export function CloudIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M7 18.5h10a4 4 0 00.5-7.97A6 6 0 006.3 12.1 3.25 3.25 0 007 18.5z" />
    </Frame>
  );
}

/** A house — this machine, the local mirror. */
export function HomeIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z" />
    </Frame>
  );
}

/** A bare tick — done, confirm. */
export function CheckIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </Frame>
  );
}

/** The {@link CheckboxIcon}'s empty twin. */
export function SquareIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
    </Frame>
  );
}

/** A laser dot with rays — the presentation laser pointer. */
export function LaserIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <circle cx="12" cy="12" r="2.5" fill="currentColor" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </Frame>
  );
}

/** A flat-top hexagon — a box of projects, in the shape of the logo's nodes. */
export function HexagonIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M20.5 12l-4.25 7.36h-8.5L3.5 12l4.25-7.36h8.5z" />
    </Frame>
  );
}

/**
 * A box's colour mark: the {@link HexagonIcon} filled with the box's colour
 * (`currentColor`, so CSS can set it too) and rimmed like the logo's nodes.
 * Cropped to the hexagon, so a small swatch is all mark and no margin.
 */
export function BoxSwatch({
  className,
  color,
  ...rest
}: { className?: string; color?: string } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 18"
      className={className ? `box-swatch ${className}` : "box-swatch"}
      style={color ? { color } : undefined}
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path
        d="M18.6 9l-4.3 7.45H5.7L1.4 9l4.3-7.45h8.6z"
        fill="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PencilIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <path d="M4 20l4-1L19.5 7.5a1.6 1.6 0 000-2.3l-.7-.7a1.6 1.6 0 00-2.3 0L5 16z" />
      <path d="M14 6l4 4" />
    </Frame>
  );
}

/** A prompt in a frame — "open a terminal here". */
export function TerminalIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M7.5 9.5l3 2.5-3 2.5" />
      <path d="M12.5 15h4" />
    </Frame>
  );
}

/** A keyboard — keyboard steering is on. */
export function KeyboardIcon(p: IconProps) {
  return (
    <Frame {...p}>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M6.5 13.5h.01M17.5 13.5h.01" />
      <path d="M9.5 14h5" />
    </Frame>
  );
}
