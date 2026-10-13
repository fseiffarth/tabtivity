import { useModalFocus } from "../../hooks/useModalFocus";
import { useEffect } from "react";
import { useHpcGuardStore, type HpcGuardKind } from "../../stores/remote/hpc/hpcGuardPrompt";
import { useT, type TranslationKey } from "../../lib/i18n";
import { UntestedTag } from "./UntestedTag";

/**
 * The HPC tag's confirmation, mounted once at the shell like the host-key prompt.
 *
 * It exists for the two gated things that can't just be switched off — a
 * disk-usage scan of the cluster tree, and running something in a login-node
 * shell — where the honest answer is "you may, but not by accident". It states
 * what the act costs the machine and what the compliant route is, and then gets
 * out of the way: proceeding is the user's call, and this never remembers the
 * answer.
 */

/** What each refusal is about, in the terms the site's rules put it. The copy
 *  itself lives in `lib/i18n` like every other user-facing string; this table is
 *  only the kind → key mapping. */
const COPY: Record<HpcGuardKind, { title: TranslationKey; body: TranslationKey; go: TranslationKey }> = {
  "du-scan": {
    title: "hpcGuard.duScan.title",
    body: "hpcGuard.duScan.body",
    go: "hpcGuard.duScan.go",
  },
  census: {
    title: "hpcGuard.census.title",
    body: "hpcGuard.census.body",
    go: "hpcGuard.census.go",
  },
  connect: {
    title: "hpcGuard.connect.title",
    body: "hpcGuard.connect.body",
    go: "hpcGuard.connect.go",
  },
  "login-node-run": {
    title: "hpcGuard.loginNodeRun.title",
    body: "hpcGuard.loginNodeRun.body",
    go: "hpcGuard.loginNodeRun.go",
  },
};

export function HpcGuardDialog() {
  const t = useT();
  const pending = useHpcGuardStore((s) => s.pending);
  const proceed = useHpcGuardStore((s) => s.proceed);
  const cancel = useHpcGuardStore((s) => s.cancel);
  const registerHost = useHpcGuardStore((s) => s.registerHost);
  // Tell the store a dialog is here to answer with — mounted once per window
  // (AppShell and DetachedApp), so a request made in a popout has a host too.
  useEffect(() => registerHost(), [registerHost]);

  const modalRef = useModalFocus(cancel, !!pending);
  if (!pending) return null;
  const copy = COPY[pending.kind] ?? COPY["login-node-run"];

  return (
    // Backdrop-dismissable, unlike the host-key prompt: nothing here is a
    // security decision, and "I didn't mean to" is a legitimate answer that
    // should cost one click.
    <div className="modal-backdrop" onClick={cancel}>
      <div ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" className="project-dialog hpc-guard-dialog" onClick={(e) => e.stopPropagation()}>
        <h2 className="hpc-guard-title">
          {t(copy.title)} <UntestedTag id="hpcGuardDialog.1" />
        </h2>
        <div className="hpc-guard-target">
          <span className="hpc-guard-badge">HPC</span>
          <code>{pending.target}</code>
        </div>
        <p className="hpc-guard-body">{t(copy.body)}</p>
        <p className="hpc-guard-note">{t("hpcGuard.note")}</p>
        <div className="project-dialog-actions">
          <button type="button" onClick={cancel}>
            {t("common.cancel")}
          </button>
          <button type="button" onClick={proceed}>
            {t(copy.go)}
          </button>
        </div>
      </div>
    </div>
  );
}
