interface PrinterIconProps {
  className?: string;
}

/**
 * Tabtivity's printer mark. It uses `currentColor` so the same crisp outline works
 * in compact viewer buttons and in the themed Print Manager heading.
 */
export function PrinterIcon({ className }: PrinterIconProps) {
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
      <g
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M7 8V3.75h10V8" />
        <path d="M7 17H5.5A2.5 2.5 0 0 1 3 14.5v-4A2.5 2.5 0 0 1 5.5 8h13a2.5 2.5 0 0 1 2.5 2.5v4a2.5 2.5 0 0 1-2.5 2.5H17" />
        <path d="M7 13.5h10v6.75H7z" />
        <path d="M9.25 16.75h5.5" />
      </g>
      <circle cx="17.25" cy="11" r="0.85" fill="currentColor" />
    </svg>
  );
}
