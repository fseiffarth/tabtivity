interface StarIconProps {
  className?: string;
}

/**
 * The gold eight-point compass star from the Tabtivity logo, on its own — the
 * root project's mark. Same path as `LogoIcon`'s crown, just cropped to its
 * own viewBox instead of sitting above the ring/branches.
 *
 * Decorative on purpose: every host of this mark already carries the label
 * that belongs on it (the chip's root row says "Root project", the detached
 * title bar hides it). An `aria-label` + `<title>` here would win the native
 * tooltip over its host button's, so hovering the glyph said "Tabtivity" while
 * hovering the padding beside it said the host's label.
 */
export function StarIcon({ className }: StarIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="203 48 106 106"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M 256 52 L 265 87 L 284 73 L 270 92 L 305 101 L 270 110 L 284 129 L 265 115
           L 256 150 L 247 115 L 228 129 L 242 110 L 207 101 L 242 92 L 228 73 L 247 87 Z"
        fill="#C79A45"
      />
    </svg>
  );
}
