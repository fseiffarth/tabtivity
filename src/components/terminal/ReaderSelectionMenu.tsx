import { useEffect, useState, type RefObject } from "react";
import { useT } from "../../lib/i18n";
import { copyText } from "../../lib/terminal/copyText";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { UntestedTag } from "../common/UntestedTag";

/** Snapshot the selection before a menu click moves focus or clears it. */
export function ReaderSelectionMenu({ root, enabled, onInsert }: {
  root: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  onInsert?: (text: string) => void;
}) {
  const t = useT();
  const [target, setTarget] = useState<{ x: number; y: number; text: string } | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const element = root.current;
    if (!element) return;
    const open = (event: MouseEvent) => {
      // Editable fields keep their native editing menu.
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable]")) return;
      const selection = window.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return;
      const text = selection.toString();
      if (!text.trim()) return;
      event.preventDefault();
      event.stopPropagation();
      setCopyFailed(false);
      setTarget({ x: event.clientX, y: event.clientY, text });
    };
    element.addEventListener("contextmenu", open);
    return () => {
      element.removeEventListener("contextmenu", open);
      setTarget(null);
    };
  }, [enabled, root]);

  if (!enabled || !target) return null;
  const insert = (quote: boolean) => {
    const text = quote ? `\n\n${target.text.split(/\r?\n/).map((line) => `> ${line}`).join("\n")}\n\n` : target.text;
    setTarget(null);
    onInsert?.(text);
  };
  return <ContextMenuPortal x={target.x} y={target.y} onClose={() => setTarget(null)}>
    <button type="button" className="untested" onClick={async () => {
      try {
        await copyText(target.text);
        setTarget(null);
      } catch {
        setCopyFailed(true);
      }
    }}>
      {t("common.copy")}<UntestedTag id="terminal.reader.selection" />
    </button>
    {onInsert && <>
      <button type="button" className="untested" onClick={() => insert(false)}>
        {t("terminal.reader.selectionDraft")}<UntestedTag id="terminal.reader.selection" />
      </button>
      <button type="button" className="untested" onClick={() => insert(true)}>
        {t("terminal.reader.selectionQuote")}<UntestedTag id="terminal.reader.selection" />
      </button>
    </>}
    {copyFailed && <div role="alert">{t("terminal.copyFailed")}</div>}
  </ContextMenuPortal>;
}
