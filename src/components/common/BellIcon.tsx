interface BellIconProps {
  className?: string;
  /** Struck through — "alerts off" for a control whose two states must differ. */
  off?: boolean;
}

/**
 * Tabtivity's bell: the header's alerts switch (`header/AlertsToggle`) and every
 * smaller "alerts" control that should read as the same thing. Drawn rather than
 * a bell emoji — monochrome, schematic, `currentColor` — so it follows the theme instead of
 * dropping a colour emoji into line art.
 */
export function BellIcon({ className, off }: BellIconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <g stroke="currentColor" strokeWidth="1.1" strokeLinecap="round">
        {/* dome: straight sides closed by a half-round top */}
        <path d="M4.9 10.6V7.3a3.1 3.1 0 0 1 6.2 0v3.3" />
        {/* rim */}
        <line x1="3.5" y1="10.7" x2="12.5" y2="10.7" />
        {/* clapper */}
        <path d="M6.8 12.2a1.3 1.3 0 0 0 2.4 0" />
        {off ? <line x1="3" y1="3" x2="13" y2="13.4" /> : null}
      </g>
    </svg>
  );
}
