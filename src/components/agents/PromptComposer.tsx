import { useEffect, useMemo, useRef, useState } from "react";
import { useI18nStore, useT } from "../../lib/i18n";
import { useUse24h } from "../../lib/timeFormat";
import type { UsageResetMark } from "../../lib/agents/agentUsageResets";
import {
  composeIsReset,
  composeOffered,
  composeSubmitKey,
  type ComposeWhen,
} from "../../lib/agents/prompt/compose";
import { formatTimelineInstant } from "../../lib/agents/prompt/timeline";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { Dropdown } from "../common/Dropdown";
import { UntestedTag } from "../common/UntestedTag";
import { CheckIcon, ChevronDownIcon, ClockIcon, PlusIcon } from "../common/icons/Icon";
import type { PromptCardTarget } from "./PromptAgentPick";

/** What a submit asks the chart to write. `resetAt` is set for the two reset
 *  choices: the minute the one-time rule lands on. */
export interface ComposeSubmit {
  message: string;
  /** The tab it is aimed at; empty is "a new agent tab". */
  targetId: string;
  when: ComposeWhen;
  resetAt?: Date;
}

interface Props {
  /** The tabs a draft may be aimed at (the free ones). */
  targets: PromptCardTarget[];
  newTabLabel: string;
  /** The agent a target runs; `""` is the new tab's. */
  agentOf: (targetId: string) => string | undefined;
  /** Every agent's next resets: the two "after the reset" choices exist for
   *  the chosen tab's agent only when it has one ahead. */
  resets: readonly UsageResetMark[];
  now: Date;
  snapMinutes: number;
  /** Write it. Rejects when the write failed (the chart reports why); the
   *  composer then keeps its text. */
  onSubmit: (input: ComposeSubmit) => Promise<void>;
  /** Where a reset choice would land, for the timeline's dashed preview. */
  onPreview: (preview: { at: Date; message: string } | null) => void;
}

/**
 * The row under the command bar: write a prompt, say where it goes and when,
 * press Enter. Every choice in the When menu is a write the chart already
 * had — a draft, a send, the schedule dialog, an `after` link, a one-time rule
 * — so the row adds no state of its own beyond the text and the two picks.
 */
export function PromptComposer({ targets, newTabLabel, agentOf, resets, now, snapMinutes, onSubmit, onPreview }: Props) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const use24h = useUse24h();
  const [text, setText] = useState("");
  const [targetId, setTargetId] = useState("");
  const [when, setWhen] = useState<ComposeWhen>("draft");
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const whenButton = useRef<HTMLButtonElement>(null);

  // A tab that closed (or took a rule) since it was picked is no longer
  // offered: the pick falls back to the new tab rather than aiming at nothing.
  const effectiveTarget = targets.some((target) => target.id === targetId) ? targetId : "";
  const targetLabel = effectiveTarget ? targets.find((target) => target.id === effectiveTarget)?.label ?? "" : newTabLabel;
  const offered = useMemo(
    () => composeOffered(resets, agentOf(effectiveTarget), now, snapMinutes),
    [agentOf, effectiveTarget, now, resets, snapMinutes],
  );
  const choice = offered.find((item) => item.when === when) ?? offered[0];
  const effectiveWhen = choice.when;
  const resetAt = choice.reset?.at;
  const message = text.trim();
  const at = (instant: Date) => formatTimelineInstant(instant, lang, use24h, true);

  const previewAt = resetAt && message ? resetAt.getTime() : 0;
  useEffect(() => {
    onPreview(previewAt ? { at: new Date(previewAt), message } : null);
  }, [message, onPreview, previewAt]);
  useEffect(() => () => onPreview(null), [onPreview]);

  const submit = async () => {
    if (!message || busy) return;
    setBusy(true);
    try {
      await onSubmit({ message, targetId: effectiveTarget, when: effectiveWhen, resetAt });
      setText("");
      setWhen("draft");
    } catch { /* the chart reports it; the text stays */ } finally {
      setBusy(false);
    }
  };

  const whenLabel = (item: ComposeWhen) => t(`promptChart.compose.when.${item}` as "promptChart.compose.when.draft");
  const whenHint = (item: ComposeWhen, reset?: Date) => (reset ? at(reset) : t(`promptChart.compose.whenHint.${item}` as "promptChart.compose.whenHint.draft"));
  const hint = composeIsReset(effectiveWhen) && resetAt
    ? t("promptChart.compose.hint.reset", { tab: targetLabel, time: at(resetAt) })
    : t(`promptChart.compose.hint.${effectiveWhen}` as "promptChart.compose.hint.draft", { tab: targetLabel });

  return (
    <div className="agent-prompt-composer" data-testid="prompt-composer">
      <div className="agent-prompt-composer-row">
        <label className="agent-prompt-composer-field">
          <PlusIcon />
          <textarea
            rows={Math.min(5, Math.max(1, text.split("\n").length))}
            value={text}
            aria-label={t("promptChart.compose.label")}
            placeholder={t("promptChart.compose.placeholder")}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // Enter submits; Shift+Enter is a new line. A key that confirms
              // an input method's composition is the method's, not ours.
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              void submit();
            }}
          />
        </label>
        <Dropdown
          className="agent-prompt-composer-target"
          title={t("promptChart.agent")}
          value={effectiveTarget}
          options={[{ value: "", label: newTabLabel }, ...targets.map((target) => ({ value: target.id, label: target.label }))]}
          onChange={setTargetId}
        />
        <button
          ref={whenButton}
          type="button"
          className={`settings-btn sm agent-prompt-bar-btn agent-prompt-composer-when${effectiveWhen !== "draft" ? " is-active" : ""}`}
          aria-haspopup="menu"
          aria-expanded={!!menu}
          title={t("promptChart.compose.when")}
          data-testid="prompt-composer-when"
          onClick={() => {
            if (menu) { setMenu(null); return; }
            const rect = whenButton.current?.getBoundingClientRect();
            setMenu({ x: rect?.left ?? 0, y: (rect?.bottom ?? 0) + 4 });
          }}
        >
          <ClockIcon />
          {whenLabel(effectiveWhen)}
          <ChevronDownIcon />
        </button>
        <button type="button" className="settings-btn sm primary" disabled={!message || busy} data-testid="prompt-composer-submit" onClick={() => void submit()}>
          {t(composeSubmitKey(effectiveWhen))}
        </button>
        <UntestedTag id="promptChart.composer" />
      </div>
      <small className="agent-prompt-composer-hint" data-testid="prompt-composer-hint">{hint}</small>
      {menu && (
        <ContextMenuPortal x={menu.x} y={menu.y} keepBelow onClose={() => setMenu(null)} className="context-menu agent-prompt-when-menu">
          <div role="menu" aria-label={t("promptChart.compose.when")}>
            {offered.map((item) => (
              <button
                key={item.when}
                type="button"
                role="menuitemradio"
                aria-checked={item.when === effectiveWhen}
                className={`agent-prompt-when-item${item.when === effectiveWhen ? " is-active" : ""}`}
                onClick={() => { setWhen(item.when); setMenu(null); }}
              >
                <span>{whenLabel(item.when)}</span>
                <small>{whenHint(item.when, item.reset?.at)}</small>
                {item.when === effectiveWhen && <CheckIcon />}
              </button>
            ))}
          </div>
        </ContextMenuPortal>
      )}
    </div>
  );
}
