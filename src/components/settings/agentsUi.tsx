import { useId, useState, type ReactNode } from "react";

/** A small "?" that carries a long explanation as a tooltip, so the page keeps
 *  a short line and the detail is one hover (or focus) away. Not a button: it
 *  has no border or fill and does nothing when clicked. */
export function AgentsHelp({ text }: { text: string }) {
  return (
    <span className="agents-help" role="img" tabIndex={0} aria-label={text} title={text}>
      ?
    </span>
  );
}

/** A coloured dot and a word: a status, never a control (no border, no fill). */
export function AgentsStatus({
  tone,
  children,
  title,
}: {
  tone: "ok" | "warn" | "off";
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`agents-status is-${tone}`} title={title}>
      <span className="agents-dot" aria-hidden="true" />
      <span className="agents-status-text">{children}</span>
    </span>
  );
}

/** An inline fold for detail most people never need: closed on every open,
 *  unmounted while closed. The lighter sibling of `AgentsGroup`, used inside a
 *  card or a group for one block of secondary content. */
export function AgentsFold({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div className={`agents-fold${open ? " open" : ""}${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        className="agents-fold-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="agents-fold-chevron" aria-hidden="true">
          ›
        </span>
        {label}
      </button>
      {open && (
        <div id={bodyId} className="agents-fold-body">
          {children}
        </div>
      )}
    </div>
  );
}

/** One collapsible settings group of the Agents section: a title, a one-line
 *  summary of what is inside, and the controls themselves once opened. Closed
 *  on every open, body unmounted while closed. */
export function AgentsGroup({
  title,
  summary,
  children,
}: {
  title: ReactNode;
  summary: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div className={`agents-group${open ? " open" : ""}`}>
      <button
        type="button"
        className="agents-group-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="agents-group-chevron" aria-hidden="true">
          ›
        </span>
        <span className="agents-group-title">{title}</span>
        <span className="agents-group-summary">{summary}</span>
      </button>
      {open && (
        <div id={bodyId} className="agents-group-body">
          {children}
        </div>
      )}
    </div>
  );
}
