import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";

/** A hovered path link (`lib/terminal/pathLinks`): the viewport point the hint
 *  sits above, and what a click opens there. */
export interface PathLinkHover {
  left: number;
  top: number;
  name: string;
  line?: number;
  isDir: boolean;
}

/**
 * The hint over a hovered path link, terminal and chat alike: what it names and
 * that a click opens it in a tab. The editor's file-link hint (#49,
 * `.link-open-hint`), portaled to the body above every pane overlay so neither
 * the xterm canvas nor the chat's scroller clips it.
 */
export function PathLinkHint({ hover }: { hover: PathLinkHover | null }) {
  const t = useT();
  if (!hover) return null;
  const action = hover.isDir
    ? t("terminal.pathLink.openFolder")
    : hover.line
      ? t("terminal.pathLink.openLine", { line: hover.line })
      : t("terminal.pathLink.open");
  return createPortal(
    <div
      className="link-open-hint"
      role="tooltip"
      style={{ left: hover.left, top: hover.top, zIndex: "var(--z-tooltip)" }}
    >
      {hover.name} · {action}
      <UntestedTag id="terminal.pathLink.open" />
    </div>,
    document.body,
  );
}
