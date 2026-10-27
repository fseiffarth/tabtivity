// The phone terminal's sign-in page walk: a CLI that scrolls its sign-in page
// in its own window is paged until the whole link has been on screen.
// Their effects read setters and refs the screen passes in. Those are stable,
// so where `exhaustive-deps` cannot tell, the rule is disabled at the site
// rather than handed a dependency the screen's own effect never had.
import { useEffect, useRef } from "react";
import { signInPageKeys, type SignInPage } from "../../terminal/signIn";

/** Pages a sign-in page the CLI scrolls in its own window until all of it has been on screen. */
export function useSignInPageWalk({
  signInPage, deliver,
}: {
  signInPage: SignInPage | null;
  deliver: (writes: string[], prompt?: number) => boolean;
}) {
  /** Walks a paged sign-in page with Shift+↓/↑ until every line of it has
   * been on screen. Only scroll keys; keys sent from one window position are
   * not sent again from it, so a walk that never shows stops there. */
  const pageWalkFrom = useRef("");
  useEffect(() => {
    if (!signInPage) {
      pageWalkFrom.current = "";
      return;
    }
    const at = `${signInPage.first}-${signInPage.last}`;
    const keys = signInPageKeys(signInPage);
    if (pageWalkFrom.current === at || keys.length === 0) return;
    if (deliver(keys)) pageWalkFrom.current = at;
    // `deliver` is a fresh closure every render; the walk runs on the frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signInPage]);
}
