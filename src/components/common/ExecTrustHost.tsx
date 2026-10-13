import { DialogShell } from "./PromptDialogs";
import { UntestedTag } from "./UntestedTag";
import { useT, type TranslationKey } from "../../lib/i18n";
import type { TrustKind } from "../../lib/execTrust";
import { useExecTrustStore } from "../../stores/execTrust";

const TITLES: Record<TrustKind, TranslationKey> = {
  git_hooks: "execTrust.title.gitHooks",
  latexmkrc: "execTrust.title.latexmkrc",
  prettier: "execTrust.title.prettier",
};

/**
 * The ask-once prompt for project-supplied code a click would run on this
 * machine (`services::exec_trust`): lists exactly what would run, each entry
 * expandable to its content. Mounted once per window (AppShell, DetachedApp) —
 * a popout's Build/Format button raises its question in its own store.
 *
 * "Don't run" is the default button: approving is the deliberate act.
 */
export function ExecTrustHost() {
  const pending = useExecTrustStore((s) => s.pending);
  const answer = useExecTrustStore((s) => s.answer);
  const t = useT();
  if (!pending) return null;
  const { request } = pending;
  // Keyed per question: a queued one gets a fresh dialog, focus on its
  // default button, not on the button that answered the previous one.
  return (
    <DialogShell key={pending.id} onDismiss={() => answer(false)}>
      <h2>
        {t(TITLES[request.kind] ?? "execTrust.title.gitHooks")} <UntestedTag id="execTrustHost.1" />
      </h2>
      <p className="file-delete-body">
        {t(request.changed ? "execTrust.bodyChanged" : "execTrust.body")}
      </p>
      <div className="file-delete-path">{request.dir}</div>
      <div className="exec-trust-items">
        {request.items.map((item) => (
          <details key={item.label} className="exec-trust-item" open={request.items.length <= 2}>
            <summary>{item.label}</summary>
            {item.preview && (
              <pre className="exec-trust-preview">
                {item.preview}
                {item.truncated ? "\n…" : ""}
              </pre>
            )}
          </details>
        ))}
      </div>
      <p className="file-delete-body">{t("execTrust.note")}</p>
      <div className="file-delete-actions">
        <button type="button" autoFocus onClick={() => answer(false)}>
          {t("execTrust.dontRun")}
        </button>
        <button type="button" className="danger" onClick={() => answer(true)}>
          {t("execTrust.run")}
        </button>
      </div>
    </DialogShell>
  );
}
