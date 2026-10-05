import { useEffect, useId, useState } from "react";
import { DialogShell } from "../common/PromptDialogs";
import { ErrorNote } from "../common/ErrorNote";
import { UntestedTag } from "../common/UntestedTag";
import { useT } from "../../lib/i18n";
import {
  STEERING_PROMPT_EVENT,
  ledDraft,
  sendSteeringPrompt,
  type SteeringPromptDetail,
} from "../../lib/shortcuts/steeringAgent";
import { agentTabLabel, agentTabModelTag, useAgentModelsStore } from "../../stores/agents/agentModels";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";

type Open = Omit<SteeringPromptDetail, "handled">;

/** Unsent text per agent tab (`scope:key`), for the window's lifetime. */
const drafts = new Map<string, string>();

/**
 * Steering's prompt box (the Prompt key, I by default): a text box in the
 * middle of the window for the active agent tab, so a prompt goes in without
 * leaving the keyboard mode for the terminal. Enter submits it
 * (`sendSteeringPrompt`), Shift+Enter breaks the line; Enter or Escape hands
 * the keyboard back to steering on the level the key was pressed on, as the
 * project jump does. A send that fails keeps the box and the text, with why.
 * Text left unsent (Escape, Cancel) waits in the box for that tab's next open.
 * Plan / Goal open it led with `/plan ` / `/goal ` (`ledDraft`).
 *
 * Mounted once in `AppShell`; opened by `STEERING_PROMPT_EVENT`. A modal
 * (`DialogShell`), so steering's key handler stands aside while it is up.
 */
export function SteeringPromptOverlay() {
  const [open, setOpen] = useState<Open | null>(null);

  useEffect(() => {
    const onRequest = (e: Event) => {
      const detail = (e as CustomEvent<SteeringPromptDetail>).detail;
      detail.handled = true;
      setOpen({ scope: detail.scope, tab: detail.tab, level: detail.level, lead: detail.lead });
    };
    window.addEventListener(STEERING_PROMPT_EVENT, onRequest);
    return () => window.removeEventListener(STEERING_PROMPT_EVENT, onRequest);
  }, []);

  if (!open) return null;
  const close = () => {
    setOpen(null);
    const steering = useKeyboardSteeringStore.getState();
    steering.enter();
    if (open.level !== "tabs") steering.setLevel(open.level);
  };
  // Keyed by the tab, so a box reopened for another tab takes that tab's draft.
  const id = `${open.scope}:${open.tab.key}`;
  return <PromptBox key={id} draftKey={id} target={open} onClose={close} />;
}

function PromptBox({ draftKey, target, onClose }: { draftKey: string; target: Open; onClose: () => void }) {
  const t = useT();
  const modelsByTab = useAgentModelsStore((state) => state.byTab);
  const screenModels = useAgentModelsStore((state) => state.screenByTab);
  // Which agent the prompt goes to, in the words its own status line uses.
  const agent = agentTabLabel(target.tab);
  const model = agentTabModelTag(target.scope, target.tab, modelsByTab, screenModels);
  const [value, setValue] = useState(() => ledDraft(drafts.get(draftKey) ?? "", target.lead));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const submittable = !busy && value.trim().length > 0;

  async function submit() {
    if (!submittable) return;
    setBusy(true);
    setError(null);
    try {
      await sendSteeringPrompt(target.tab, value);
      drafts.delete(draftKey);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <DialogShell className="steering-prompt-dialog" onDismiss={() => !busy && onClose()}>
      <h2 className="steering-prompt-head">
        <span className="steering-prompt-title">{t("steering.prompt.title", { tab: target.tab.label })}</span>
        {(agent !== target.tab.label || model) && (
          <span className="steering-prompt-agent">{[agent !== target.tab.label ? agent : "", model].filter(Boolean).join(" · ")}</span>
        )}
        <UntestedTag id="steering.agentPrompt" />
      </h2>
      <textarea
        className="file-paste-name steering-prompt-input"
        autoFocus
        rows={4}
        aria-label={t("steering.prompt.placeholder")}
        placeholder={t("steering.prompt.placeholder")}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        value={value}
        disabled={busy}
        // A kept draft: the caret goes after it, not before.
        onFocus={(e) => {
          const end = e.currentTarget.value.length;
          e.currentTarget.setSelectionRange(end, end);
        }}
        onChange={(e) => {
          setValue(e.target.value);
          if (e.target.value) drafts.set(draftKey, e.target.value);
          else drafts.delete(draftKey);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
          e.preventDefault();
          void submit();
        }}
      />
      {error && <ErrorNote id={errorId} role="alert" className="file-delete-path file-delete-error" error={error} />}
      <div className="file-delete-actions">
        <span className="steering-prompt-hint">
          <span><kbd>{t("steering.prompt.keyEnter")}</kbd> {t("steering.prompt.hintSend")}</span>
          <span><kbd>{t("steering.prompt.keyShiftEnter")}</kbd> {t("steering.prompt.hintNewLine")}</span>
          <span><kbd>{t("steering.prompt.keyEsc")}</kbd> {t("steering.prompt.hintBack")}</span>
        </span>
        <button type="button" onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </button>
        <button type="button" className="btn-primary" onClick={() => void submit()} disabled={!submittable}>
          {t("steering.prompt.send")}
        </button>
      </div>
    </DialogShell>
  );
}
