import { useEffect, useRef, useState, type ReactNode } from "react";
import { useT, type TranslationKey } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { COMMIT_CHOICES, type CommitChoice } from "../../../mobile-web/src/terminal/commitPrompts";

const COMMIT_LABELS: Record<CommitChoice, TranslationKey> = { own: "mobile.commit.own", state: "mobile.commit.state", split: "mobile.commit.split" };
const COMMIT_HINTS: Record<CommitChoice, TranslationKey> = { own: "mobile.commit.ownHint", state: "mobile.commit.stateHint", split: "mobile.commit.splitHint" };

/**
 * The Reader composer's chip row — the phone composer bar's Plan / Goal /
 * Clear / Commit, on the desktop. Plan and Goal lead the draft with their
 * command (or take it off again) and send nothing; Clear starts a new
 * conversation at once, the draft kept; Commit opens a menu of the three
 * commit prompts, each sent as a prompt of its own, the draft kept too.
 * `prefixes` are the commands this CLI takes as a lead (`draftPrefixes`).
 */
export function ReaderComposerChips({ prefixes, active, disabled, onPrefix, onClear, onCommit, extra }: {
  prefixes: readonly string[];
  /** The command the draft leads with, if it is one of `prefixes`. */
  active: string | null;
  disabled: boolean;
  onPrefix: (command: string) => void;
  onClear: () => void;
  onCommit: (choice: CommitChoice) => void;
  /** Chips of the composer's own after these (read-aloud, hands-free). */
  extra?: ReactNode;
}) {
  const t = useT();
  const [commitOpen, setCommitOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Esc or a click elsewhere closes the commit menu.
  useEffect(() => {
    if (!commitOpen) return;
    const away = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setCommitOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCommitOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [commitOpen]);

  // The composer keeps the focus: a click on a chip must not blur the field.
  const keepFocus = (event: React.MouseEvent) => event.preventDefault();

  return (
    <div className="terminal-reader-chips" ref={wrap}>
      {prefixes.map((command) => {
        const plan = command === "/plan";
        return (
          <button
            key={command}
            type="button"
            className={`terminal-reader-chip${active === command ? " active" : ""}`}
            disabled={disabled}
            aria-pressed={active === command}
            onMouseDown={keepFocus}
            onClick={() => onPrefix(command)}
            title={t(plan ? "mobile.composer.planHint" : "mobile.composer.goalHint")}
          >
            {t(plan ? "mobile.composer.plan" : "mobile.composer.goal")}
          </button>
        );
      })}
      <button
        type="button"
        className="terminal-reader-chip"
        disabled={disabled}
        onMouseDown={keepFocus}
        onClick={onClear}
        title={t("mobile.composer.clearChat")}
      >
        {t("mobile.composer.clearChip")}
      </button>
      <button
        type="button"
        className={`terminal-reader-chip${commitOpen ? " active" : ""}`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={commitOpen}
        onMouseDown={keepFocus}
        onClick={() => setCommitOpen((open) => !open)}
        title={t("mobile.commit.open")}
      >
        {t("mobile.commit.open")} <UntestedTag id="terminal.reader.chips" />
      </button>
      {commitOpen && (
        <div className="terminal-reader-commit-menu" role="menu" aria-label={t("mobile.commit.title")}>
          {COMMIT_CHOICES.map((choice) => (
            <button
              key={choice}
              type="button"
              role="menuitem"
              className="terminal-reader-commit-row"
              onMouseDown={keepFocus}
              onClick={() => { setCommitOpen(false); onCommit(choice); }}
            >
              <strong>{t(COMMIT_LABELS[choice])}</strong>
              <small>{t(COMMIT_HINTS[choice])}</small>
            </button>
          ))}
        </div>
      )}
      {extra}
    </div>
  );
}
