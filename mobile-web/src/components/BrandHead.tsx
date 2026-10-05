import type { ReactNode } from "react";
import { AppMark } from "../AppMark";
import { BRAND } from "../../../src/lib/brand";

/**
 * The header of the screens met before the app opens — pairing and the local
 * lock: the launch splash's mark and wordmark, with the screen's own title
 * beneath. The splash's rings are held still here: a turning ring there means
 * "working", and these screens are waiting on the reader.
 */
export function BrandHead({ children }: { children: ReactNode }) {
  return <div className="brand-head">
    <div className="splash-mark brand-head-mark" aria-hidden="true">
      <span className="splash-orbit splash-orbit-one" />
      <span className="splash-orbit splash-orbit-two" />
      <AppMark />
    </div>
    <div className="splash-name" aria-hidden="true">{BRAND.display.toUpperCase()}</div>
    <h1>{children}</h1>
  </div>;
}
