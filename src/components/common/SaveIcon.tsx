interface SaveIconProps {
  className?: string;
}

/**
 * Tabtivity's save mark. Its rounded current-color outline deliberately matches
 * {@link PrinterIcon}, so the two file actions read as one toolbar family.
 */
export function SaveIcon({ className }: SaveIconProps) {
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
        <path d="M5 3.75h11l3 3v13.5H5z" />
        <path d="M8 3.75v6h8v-6" />
        <path d="M8 20.25v-6.5h8v6.5" />
      </g>
      <circle cx="14" cy="6.75" r="0.85" fill="currentColor" />
    </svg>
  );
}
