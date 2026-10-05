import { BRAND } from "../../src/lib/brand";
/**
 * The Tabtivity mark — the same circuit "tree of life" the desktop app draws in
 * its launch splash (`src/components/layout/LogoIcon.tsx`, geometry from
 * `src/assets/logo.svg`).
 *
 * Inlined rather than an `<img src="/icons/icon.svg">` for the desktop's
 * reason: the ring/branch strokes take `currentColor`, so the mark stays
 * legible wherever it is placed, while the hexagon nodes and the gold star keep
 * their brand colours. The mirrored branches are written out instead of
 * `<use href="#…">` — an id inside a component that may be mounted more than
 * once on a page is a collision waiting to happen, and `public/icons/icon.svg`
 * already spells them out the same way.
 *
 * The mobile bundle is built from its own Vite root (`vite.mobile.config.ts`),
 * so it cannot import the desktop component; this is the copy, and the two are
 * the same paths.
 */
export function AppMark({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      fill="none"
      role="img"
      aria-label={BRAND.display}
      className={className}
    >
      <title>{BRAND.display}</title>
      <g
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        {/* Ring + both outer legs as one stroke: each leg bends through an
            r=20 fillet that meets the ring tangentially. The ring stays open
            at the bottom, where the trunk passes through. */}
        <path
          d="M 165 190 L 165 238 L 233 306 L 233 470.74 A 20 20 0 0 1 209.07 490.35 A 239 239 0 1 1 302.93 490.35 A 20 20 0 0 1 279 470.74 L 279 306 L 347 238 L 347 190"
          strokeWidth="13"
        />

        {/* Central trunk stem, running out through the ring's opening. */}
        <path d="M 256 161 L 256 499" strokeWidth="13" />

        {/* The inner branches: vertical, then one straight 45° trace through
            the middle node into the leg. */}
        <path d="M 98 249 L 98 289 L 135.2 326.2 M 174.8 365.8 L 233 424" strokeWidth="13" />
        <path d="M 414 249 L 414 289 L 376.8 326.2 M 337.2 365.8 L 279 424" strokeWidth="13" />

        {/* Hexagon nodes, warm on the left and cool on the right. */}
        <path d="M 195 162 L 180 187.98 L 150 187.98 L 135 162 L 150 136.02 L 180 136.02 Z" fill="#E7B369" strokeWidth="10" />
        <path d="M 128 221 L 113 246.98 L 83 246.98 L 68 221 L 83 195.02 L 113 195.02 Z" fill="#ED946C" strokeWidth="10" />
        <path d="M 183.98 353.76 L 162.76 374.98 L 133.79 367.21 L 126.02 338.24 L 147.24 317.02 L 176.21 324.79 Z" fill="#EB8182" strokeWidth="10" />
        <path d="M 377 162 L 362 187.98 L 332 187.98 L 317 162 L 332 136.02 L 362 136.02 Z" fill="#72D0D0" strokeWidth="10" />
        <path d="M 444 221 L 429 246.98 L 399 246.98 L 384 221 L 399 195.02 L 429 195.02 Z" fill="#5ABBE6" strokeWidth="10" />
        <path d="M 385.98 338.24 L 378.21 367.21 L 349.24 374.98 L 328.02 353.76 L 335.79 324.79 L 364.76 317.02 Z" fill="#80A3F0" strokeWidth="10" />
      </g>

      {/* Gold eight-point compass star above the trunk. */}
      <path
        d="M 256 52 L 265 87 L 284 73 L 270 92 L 305 101 L 270 110 L 284 129 L 265 115
           L 256 150 L 247 115 L 228 129 L 242 110 L 207 101 L 242 92 L 228 73 L 247 87 Z"
        fill="#C79A45"
      />
    </svg>
  );
}
