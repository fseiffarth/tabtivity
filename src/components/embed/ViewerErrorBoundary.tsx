import React, { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { formatBytes } from "../../lib/formatBytes";
import { UntestedTag } from "../common/UntestedTag";
import { readFileText } from "./fileAccess";

/** How much of the file "Show source" puts on screen. */
export const SOURCE_SHOWN_MAX_CHARS = 2 * 1024 * 1024;

type Props = {
  /** Which file and viewer are on screen. When it changes, a caught error is
   *  dropped and the viewer renders again, so one bad file never sticks to the
   *  tab. A prop rather than a React `key`: a key would remount every healthy
   *  viewer on each Local/Remote flip too. */
  resetKey: string;
  /** The file to show as text on "Show source"; `null` when the viewer's file
   *  is not text (an image, a PDF, a database), so the button is left out. */
  sourcePath: string | null;
  projectId: string | null;
  /** Hand the file to the OS; `null` for views whose header never offered it
   *  (the merge views, whose `path` is not one file to open), so the card
   *  leaves the button out. */
  onOpenExternally: (() => void) | null;
  children: React.ReactNode;
};

type State = { error: Error | null; key: string };

/**
 * The one error boundary around every in-app viewer (`FileViewerPane`). Before
 * it there was none anywhere in the app, so a render error in any viewer — a
 * parser blowing the stack on a hostile file — unmounted the whole window and
 * took unsaved work in every other pane with it (threat model row 28).
 *
 * It catches only what React routes to boundaries: errors thrown while
 * rendering or in lifecycle methods/effects of the viewer subtree. Event
 * handlers and promises (saves, autosave, reloads) report their own errors and
 * never reach it. When it catches, React unmounts the viewer subtree, which
 * runs its cleanups — an autosave-enabled draft flushes on that unmount
 * (`DraftSaver.dispose`), the same as closing the tab.
 */
export class ViewerErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null, key: props.resetKey };
  }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { key: props.resetKey, error: null } : null;
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error("viewer render failed", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <ViewerCrashed
        key={this.state.key}
        message={this.state.error.message}
        sourcePath={this.props.sourcePath}
        projectId={this.props.projectId}
        onRetry={() => this.setState({ error: null })}
        onOpenExternally={this.props.onOpenExternally}
      />
    );
  }
}

/** The boundary's own screen: a function component, since a class cannot use
 *  the translator hook. Shaped like `RemotePaneHold`, the other card a viewer
 *  pane shows instead of its viewer. */
function ViewerCrashed({
  message,
  sourcePath,
  projectId,
  onRetry,
  onOpenExternally,
}: {
  message: string;
  sourcePath: string | null;
  projectId: string | null;
  onRetry: () => void;
  onOpenExternally: (() => void) | null;
}) {
  const t = useT();
  const [showSource, setShowSource] = useState(false);
  if (showSource && sourcePath) {
    return <ViewerSource path={sourcePath} projectId={projectId} onBack={() => setShowSource(false)} />;
  }
  return (
    <div className="center-placeholder" style={{ height: "100%" }}>
      <div className="center-placeholder-card">
        <div className="center-placeholder-title">
          {t("viewerCrash.title")} <UntestedTag id="viewerCrash.title" />
        </div>
        <div className="center-placeholder-hint">{t("viewerCrash.hint")}</div>
        {message && <div className="file-viewer-error">{message}</div>}
        <div className="project-dialog-actions" style={{ justifyContent: "center" }}>
          <button type="button" className="btn-primary" onClick={onRetry}>
            {t("viewerCrash.retry")}
          </button>
          {sourcePath && (
            <button type="button" onClick={() => setShowSource(true)}>
              {t("viewerCrash.showSource")}
            </button>
          )}
          {onOpenExternally && (
            <button type="button" onClick={onOpenExternally}>
              {t("viewerCrash.openExternally")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The file as plain, read-only text: nothing here parses it, so whatever made
 *  the viewer fail cannot make this fail too. */
function ViewerSource({
  path,
  projectId,
  onBack,
}: {
  path: string;
  projectId: string | null;
  onBack: () => void;
}) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    readFileText(path, projectId)
      .then((s) => { if (!cancelled) setText(s); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [path, projectId]);
  const cut = text != null && text.length > SOURCE_SHOWN_MAX_CHARS;
  return (
    <div className="file-viewer">
      <div className="file-viewer-header">
        <button type="button" onClick={onBack}>{t("common.back")}</button>
        <div className="file-viewer-header-spacer" aria-hidden="true" />
      </div>
      <div className="file-viewer-body">
        {error != null ? (
          <div className="file-viewer-error">{t("viewerCrash.sourceFailed", { error })}</div>
        ) : text == null ? (
          <div className="file-viewer-loading">{t("common.loading")}</div>
        ) : (
          <>
            {cut && (
              <div className="file-viewer-loading">
                {t("viewerCrash.sourceTruncated", { size: formatBytes(SOURCE_SHOWN_MAX_CHARS) })}
              </div>
            )}
            <pre className="viewer-crash-source">{cut ? text.slice(0, SOURCE_SHOWN_MAX_CHARS) : text}</pre>
          </>
        )}
      </div>
    </div>
  );
}
