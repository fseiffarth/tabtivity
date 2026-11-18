import type { ReactNode } from "react";
import { useT } from "../../../lib/i18n";
import { UntestedTag } from "../../common/UntestedTag";
import type { DiffSourceStatus } from "./useDiffSource";

const NOTE: React.CSSProperties = { padding: "1rem", color: "var(--text-secondary, #8b949e)" };

/**
 * The body of the diff viewer while there is no diff to draw: loading, a
 * failed request (with Retry), a file that is not under git, a remote project
 * that is not connected, or a diff with nothing in it.
 */
export function DiffStateNote({
  status,
  error,
  empty,
  onRetry,
}: {
  status: DiffSourceStatus;
  error: string | null;
  empty: boolean;
  onRetry: () => void;
}) {
  const t = useT();
  if (status === "error") {
    return (
      <div className="diff-error" role="alert" style={{ padding: "1rem" }}>
        <div style={{ color: "var(--danger, #f85149)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{error}</div>
        <button
          type="button"
          className="file-viewer-format-btn"
          style={{ marginTop: "0.75rem" }}
          onClick={onRetry}
        >
          {t("diffView.retry")}
        </button>
        <UntestedTag id="diffView.states" />
      </div>
    );
  }
  if (status === "notRepo") {
    return (
      <div className="diff-empty" style={NOTE}>
        {t("diffView.notRepo")} <UntestedTag id="diffView.states" />
      </div>
    );
  }
  if (status === "blocked") {
    return (
      <div className="diff-empty" style={NOTE}>
        {t("diffView.notConnected")} <UntestedTag id="diffView.states" />
      </div>
    );
  }
  if (status === "loading") {
    return (
      <div className="diff-loading" style={NOTE}>
        {t("diffView.loading")}
      </div>
    );
  }
  if (empty) {
    return (
      <div className="diff-empty" style={NOTE}>
        {t("diffView.noChanges")}
      </div>
    );
  }
  return null;
}

/** A slim row between the drawn lines and the rest of a large diff. */
export function DiffMoreRow({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div
      className="diff-more"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "0.5em",
        padding: "0.5em 0.75em",
        background: "var(--bg-elevated, rgba(255,255,255,0.04))",
        borderTop: "1px solid var(--border-color)",
        borderBottom: "1px solid var(--border-color)",
        color: "var(--text-secondary, #8b949e)",
        fontFamily: "inherit",
      }}
    >
      {hint ? <span>{hint}</span> : null}
      {children}
    </div>
  );
}
