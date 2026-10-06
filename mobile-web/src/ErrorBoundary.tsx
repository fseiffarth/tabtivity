import React from "react";
import { forgetLastPlace } from "./lastPlace";
import { useT } from "../../src/lib/i18n";

/**
 * A render error anywhere used to leave a permanently blank PWA that only a
 * force-quit could clear — there was no boundary at all, and the app root is
 * the one place a phone user cannot work around.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    // Both ways out of here remount the app from scratch, and the app resumes
    // at the saved place — which is the screen that just threw. With the place
    // kept, "Try again" and "Reload" were a loop back into the same crash; the
    // project list is the one landing that cannot be it.
    forgetLastPlace();
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <CrashScreen retry={() => this.setState({ failed: false })} />;
  }
}

/** The boundary's own screen: a function component, since a class cannot use
 * the translator hook. */
function CrashScreen({ retry }: { retry: () => void }) {
  const t = useT();
  return (
    <main className="screen splash">
      <p>{t("mobile.app.crashed")}</p>
      <button className="primary" onClick={retry}>
        {t("mobile.app.tryAgain")}
      </button>
      <button onClick={() => location.reload()}>{t("common.reload")}</button>
    </main>
  );
}
