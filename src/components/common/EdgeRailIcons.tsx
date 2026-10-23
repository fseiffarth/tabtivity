/**
 * The closed side panel's edge-rail glyphs. Same rounded current-color
 * outline as {@link SaveIcon} / {@link PrinterIcon}, so the rail reads as one
 * family with the rest of the chrome. Each is 16px, `aria-hidden`: the button
 * around it carries the accessible name.
 */
import { AssistantIcon } from "./icons/Icon";

interface IconProps {
  className?: string;
}

function Frame({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </g>
    </svg>
  );
}

/** The AI switch (`lib/aiSwitch.ts`): the power symbol. */
export function RailPowerIcon({ className }: IconProps) {
  return (
    <Frame className={className}>
      <path d="M12 4v7" />
      <path d="M7.4 7.2a6.5 6.5 0 109.2 0" />
    </Frame>
  );
}

/** Open the panel: a chevron pointing the way the panel slides in. */
export function RailChevronIcon({ dir, className }: IconProps & { dir: "left" | "right" }) {
  return (
    <Frame className={className}>
      {dir === "left" ? <path d="M14 6l-6 6 6 6" /> : <path d="M10 6l6 6-6 6" />}
    </Frame>
  );
}

/** Files: a folder. */
export function RailFilesIcon({ className }: IconProps) {
  return (
    <Frame className={className}>
      <path d="M3.5 6.5a1.5 1.5 0 011.5-1.5h4l2 2h8a1.5 1.5 0 011.5 1.5v9.5a1.5 1.5 0 01-1.5 1.5H5a1.5 1.5 0 01-1.5-1.5z" />
    </Frame>
  );
}

/** Git: two commits on a branch line joining a third. */
export function RailGitIcon({ className }: IconProps) {
  return (
    <Frame className={className}>
      <circle cx="7" cy="5.5" r="2" />
      <circle cx="7" cy="18.5" r="2" />
      <circle cx="17" cy="8.5" r="2" />
      <path d="M7 7.5v9" />
      <path d="M17 10.5c0 3-3.5 3.5-6 4.5a4 4 0 00-2.4 1.6" />
    </Frame>
  );
}

/** Apps: four windows in a grid. */
export function RailAppsIcon({ className }: IconProps) {
  return (
    <Frame className={className}>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.2" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.2" />
    </Frame>
  );
}

/** Agents: a chat bubble with a cursor prompt inside. */
export function RailAgentsIcon({ className }: IconProps) {
  return (
    <Frame className={className}>
      <path d="M4 5.5h16v11H9.5L5.5 20v-3.5H4z" />
      <path d="M8.5 9l2.5 2-2.5 2" />
      <path d="M12.5 13h3.5" />
    </Frame>
  );
}

/** Tabby, the chat assistant: the shared `AssistantIcon` at the rail's size
 *  (the panel's switcher shows the same one). */
export function RailAssistantIcon({ className }: IconProps) {
  return <AssistantIcon className={className} size={16} />;
}

/**
 * Move the panel to the other edge. A window frame with the panel filled in on
 * the edge it sits on now and an arrow pointing at the edge it will jump to.
 * It replaced a frame with a two-headed arrow inside, which read as
 * "swap"/"sync" — nothing about it said "this panel, other side", and the
 * user could not tell what the button did. Drawn for a panel on the right
 * edge; the left edge is the same picture mirrored, so the arrow always points
 * where the panel is going. Shared by the closed panel's rail and the open
 * panel's header, so the two say the same thing.
 */
export function RailSwitchSideIcon({ side, className }: IconProps & { side: "left" | "right" }) {
  return (
    <Frame className={className}>
      <g transform={side === "left" ? "matrix(-1 0 0 1 24 0)" : undefined}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <rect x="15" y="4" width="6" height="16" rx="2" fill="currentColor" stroke="none" />
        <path d="M12 12H6" />
        <path d="M9 9l-3 3 3 3" />
      </g>
    </Frame>
  );
}

/** Diverged (orange) files: two paths splitting off one trunk. */
export function RailDivergedIcon({ className }: IconProps) {
  return (
    <Frame className={className}>
      <path d="M12 20v-6.5" />
      <path d="M12 13.5L6.5 6" />
      <path d="M12 13.5L17.5 6" />
      <path d="M6.5 10V6h4" />
      <path d="M17.5 10V6h-4" />
    </Frame>
  );
}

/** Persistent host sessions (tmux): a terminal window with a prompt. */
export function RailSessionsIcon({ className }: IconProps) {
  return (
    <Frame className={className}>
      <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
      <path d="M7.5 10l2.5 2-2.5 2" />
      <path d="M12 15h4.5" />
    </Frame>
  );
}

/** SLURM jobs: a queue of three stacked jobs. */
export function RailJobsIcon({ className }: IconProps) {
  return (
    <Frame className={className}>
      <rect x="4" y="4.5" width="16" height="4" rx="1" />
      <rect x="4" y="10" width="16" height="4" rx="1" />
      <rect x="4" y="15.5" width="16" height="4" rx="1" />
      <path d="M7 6.5h.01M7 12h.01M7 17.5h.01" />
    </Frame>
  );
}

/** Remarks: a speech bubble with two lines of text. */
export function RailRemarksIcon({ className }: IconProps) {
  return (
    <Frame className={className}>
      <path d="M5 5h14a1.5 1.5 0 011.5 1.5v8A1.5 1.5 0 0119 16h-8l-4 3.5V16H5a1.5 1.5 0 01-1.5-1.5v-8A1.5 1.5 0 015 5z" />
      <path d="M8 9.5h8M8 12.5h5" />
    </Frame>
  );
}

/** To-do groups: a ticked box beside two list lines. */
export function RailTodoIcon({ className }: IconProps) {
  return (
    <Frame className={className}>
      <rect x="3.5" y="5" width="7" height="7" rx="1.2" />
      <path d="M5.3 8.6l1.5 1.4 2.4-3" />
      <path d="M13.5 7h7M13.5 10.5h5" />
      <rect x="3.5" y="14.5" width="7" height="5" rx="1.2" />
      <path d="M13.5 17h7" />
    </Frame>
  );
}
