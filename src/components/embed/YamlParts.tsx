import { useEffect, useRef, useState } from "react";
import { isFlow, scalarType, type YamlDoc, type YamlNode } from "../../lib/viewers/yaml";
import { useT } from "../../lib/i18n";

/**
 * The pieces the YAML/JSON **tree** and **cards** both render (#yaml, #yaml-grid):
 * the commit-on-blur value editors, the flow-style tag, the child-count badge and
 * the "can't read this file" notice. One copy, so the two views cannot drift in
 * how a value is edited or what a collection is called.
 */

type T = ReturnType<typeof useT>;

/**
 * A field's draft buffer: what the user has typed, held apart from the file until
 * it is committed. The views commit on Enter/blur rather than per keystroke
 * because a commit re-encodes the value into the file (quoting it when it must),
 * and doing that on each keypress would rewrite the text — and move the caret —
 * under the typist.
 *
 * The buffer follows `initial` (a re-parse, an undo) only while the user is not
 * mid-edit: `type` marks it dirty, `settle` (a commit) and `revert` (Escape)
 * hand it back.
 */
export function useDraft(initial: string) {
  const [buf, setBuf] = useState(initial);
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setBuf(initial);
  }, [initial]);
  return {
    buf,
    type: (next: string) => {
      dirty.current = true;
      setBuf(next);
    },
    settle: () => {
      dirty.current = false;
    },
    revert: () => {
      dirty.current = false;
      setBuf(initial);
    },
  };
}

/** A single-line input that commits on Enter/blur and reverts on Escape. An
 *  unchanged buffer commits nothing and reports `onCancel` instead, which is what
 *  closes a transient editor (a rename, a new key). */
export function CommitInput({
  initial,
  className,
  ariaLabel,
  placeholder,
  autoFocus,
  onCommit,
  onCancel,
}: {
  initial: string;
  className: string;
  ariaLabel: string;
  placeholder?: string;
  autoFocus?: boolean;
  onCommit: (next: string) => void;
  onCancel?: () => void;
}) {
  const draft = useDraft(initial);
  const finish = () => {
    draft.settle();
    if (draft.buf !== initial) onCommit(draft.buf);
    else onCancel?.();
  };

  return (
    <input
      className={className}
      value={draft.buf}
      placeholder={placeholder}
      aria-label={ariaLabel}
      autoFocus={autoFocus}
      onChange={(e) => draft.type(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish();
        } else if (e.key === "Escape") {
          e.preventDefault();
          draft.revert();
          onCancel?.();
        }
      }}
    />
  );
}

/** A multi-line block scalar (`|`/`>`): committed on blur or Ctrl+Enter, since
 *  plain Enter has to keep inserting newlines. */
function BlockCell({
  initial,
  tag,
  ariaLabel,
  onCommit,
}: {
  initial: string;
  /** The block header as written (`|`, `>-`, …), shown so the style is visible. */
  tag: string;
  ariaLabel: string;
  onCommit: (next: string) => void;
}) {
  const draft = useDraft(initial);

  return (
    <span className="yaml-block">
      <span className="yaml-block-tag">{tag}</span>
      <textarea
        className="yaml-block-input"
        value={draft.buf}
        rows={Math.min(12, Math.max(2, draft.buf.split("\n").length))}
        aria-label={ariaLabel}
        onChange={(e) => draft.type(e.target.value)}
        onBlur={() => {
          draft.settle();
          if (draft.buf !== initial) onCommit(draft.buf);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            draft.revert();
          }
        }}
      />
    </span>
  );
}

/** A scalar's value: an input (a textarea for a block scalar, whose line breaks a
 *  single-line input would silently drop) that commits on Enter/blur, or plain
 *  text when the node is one the views won't rewrite (`source only`). */
export function ValueCell({
  node,
  label,
  onCommit,
}: {
  node: YamlNode;
  label: string;
  onCommit: (next: string) => void;
}) {
  const t = useT();
  if (!node.editable) {
    return (
      <span
        className="yaml-value yaml-value-locked"
        title={node.raw || t("yamlGrid.sourceOnlyTitle")}
      >
        {node.raw || node.value}
      </span>
    );
  }
  const ariaLabel = t("yamlGrid.valueOfLabel", { label });
  if (node.style === "block") {
    return (
      <BlockCell
        key={node.id}
        initial={node.value}
        tag={node.raw}
        ariaLabel={ariaLabel}
        onCommit={onCommit}
      />
    );
  }
  return (
    <CommitInput
      initial={node.value}
      className={`yaml-value-input yaml-val-${scalarType(node)}`}
      ariaLabel={ariaLabel}
      placeholder={node.style === "empty" ? t("yamlGrid.nullPlaceholder") : undefined}
      onCommit={onCommit}
    />
  );
}

/** The `[ ]` / `{ }` mark on a flow (JSON-style) collection. Flow style is
 *  visible because it is what an edit will keep: adding there splices into the
 *  brackets, not new lines. Renders nothing for a block collection. */
export function FlowTag({ node }: { node: YamlNode }) {
  const t = useT();
  if (!isFlow(node)) return null;
  return (
    <span className="yaml-flow-tag" title={t("yamlGrid.flowStyleTitle")}>
      {node.kind === "seq" ? "[ ]" : "{ }"}
    </span>
  );
}

/** A collection's size, in its own unit: `3 items` for a list, `2 keys` for a
 *  mapping. */
export function countBadge(t: T, node: YamlNode): string {
  const n = node.children.length;
  return node.kind === "seq"
    ? t(n === 1 ? "yamlGrid.itemsBadgeOne" : "yamlGrid.itemsBadgeMany", { n })
    : t(n === 1 ? "yamlGrid.keysBadgeOne" : "yamlGrid.keysBadgeMany", { n });
}

/** What a view shows instead of itself for a file the parser could not classify:
 *  why, where, and that Source still can. */
export function ParseNotice({
  error,
  cantReadKey,
}: {
  error: NonNullable<YamlDoc["error"]>;
  cantReadKey: "yamlTree.cantRead" | "yamlGrid.cantRead";
}) {
  const t = useT();
  return (
    <div className="yaml-tree-notice">
      <p>{t(cantReadKey, { msg: t(error.messageKey, error.messageVars), line: error.line })}</p>
      <p className="yaml-tree-notice-hint">
        {t("yamlGrid.switchToSourcePre")}<strong>{t("yamlGrid.sourceWord")}</strong>{t("yamlGrid.switchToSourcePost")}
      </p>
    </div>
  );
}
