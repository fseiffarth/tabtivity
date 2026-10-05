import { useState } from "react";
import { reasonPhrase } from "../../lib/browser";
import { useT } from "../../lib/i18n";
import type { BlockedNavigation } from "../../types/browser";

/**
 * What the user sees when the navigation policy refused a URL — **or** when it
 * allowed one but wants to be asked first.
 *
 * An **in-app page state, not an interrupt**: a blocked navigation is
 * information about where the tab is, so it replaces the content region rather
 * than raising a dialog over it.
 *
 * Three rules from `docs/browser_plan_b.md` §3.5 are the reason this component
 * exists at all rather than being a toast:
 *
 *  - **The full URL, monospace, `word-break: break-all`, never
 *    ellipsis-truncated.** Truncation is itself the attack:
 *    `https://example.com.evil.tld/…` reads as `https://example.com…`.
 *  - **The reason is a sentence, never the backend's token.** The gate speaks in
 *    stable machine tokens (`app-origin`, `scheme:file`,
 *    `redirect-to-link-local`) precisely so the wording can live in `i18n.ts` in
 *    five languages; rendering `reason` directly would put an identifier in
 *    front of a user at the one moment they most need a sentence.
 *    `reasonPhrase` is the mapping, and it is contract-tested against the Rust
 *    side's canonical token list.
 *  - **A refusal has no override.** Two actions only — Back and Copy link — and
 *    the page says so. Every "proceed anyway" control that has ever existed was
 *    added for a good reason and then used for a bad one.
 *
 * The one exception is `onProceed`, and it is the gate's *third* outcome rather
 * than a way through the second: a loopback / private / link-local address is
 * **reachable** (a developer's own dev server is the obvious case) but is the
 * one place this browser is more dangerous than a normal one, because Tabtivity may
 * be holding a VPN tunnel into a network the user's real browser cannot see. So
 * it is presented as a question with a real button — a user gesture — and never
 * as something the page can answer for itself. When `onProceed` is absent this
 * is a hard block and there is no way past it.
 */
export function BrowserBlockedNotice({
  blocked,
  onBack,
  onProceed,
}: {
  blocked: BlockedNavigation;
  onBack?: () => void;
  /** Present only for the gate's Confirm outcome (see the file comment). */
  onProceed?: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const phrase = reasonPhrase(blocked.reason);
  const confirming = !!onProceed;

  return (
    <div className={`browser-blocked${confirming ? " browser-blocked-confirm" : ""}`}>
      <div className="browser-blocked-title">
        {confirming ? t("browser.confirmTitle") : t("browser.blockedTitle")}
      </div>
      <div className="browser-blocked-reason">{t(phrase.key, phrase.vars)}</div>
      <div className="browser-blocked-label">{t("browser.blockedUrlLabel")}</div>
      {/* Full, monospace, wrapping — never shortened. */}
      <div className="browser-blocked-url">{blocked.display_url}</div>
      <p className="browser-blocked-note">
        {confirming ? t("browser.confirmNote") : t("browser.blockedNoOverride")}
      </p>
      <div className="browser-blocked-actions">
        {onBack && (
          <button type="button" className="browser-btn" autoFocus onClick={onBack}>
            {t("common.back")}
          </button>
        )}
        <button
          type="button"
          className="browser-btn"
          onClick={() => {
            navigator.clipboard?.writeText(blocked.display_url).catch(() => {});
            setCopied(true);
          }}
        >
          {copied ? t("browser.linkCopied") : t("browser.copyLink")}
        </button>
        {onProceed && (
          /* Never the default focus, and never rendered for a hard block. */
          <button type="button" className="browser-btn browser-btn-primary" onClick={onProceed}>
            {t("browser.confirmProceed")}
          </button>
        )}
      </div>
    </div>
  );
}
