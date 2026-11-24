import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import { AgentsStatus } from "./agentsUi";

/** `claude_api_check` (`services::claude_doctor`): `claude doctor`'s "API
 *  connectivity" section, parsed. */
export interface ClaudeApiCheckResult {
  verdict: "ok" | "unexpected" | "unreachable" | "notTested" | "missing";
  reachable: boolean | null;
  status: number | null;
  elapsedMs: number | null;
  error: string | null;
  host: string;
  via: string | null;
  /** Why `claude doctor` sent no request, in its own words. */
  notTested: string | null;
  /** The section as `claude doctor` printed it. */
  lines: string[];
}

/** First Claude release whose `claude doctor` prints the section
 *  (`claude_doctor::SINCE`). */
export const CLAUDE_API_CHECK_SINCE = "2.1.331";

/** Whether `version` (`2.1.331`, `2.2.0-beta.1`) is at or past `since`; an
 *  unknown version is not. Numeric parts only, like `agent_versions::version_cmp`. */
export function versionAtLeast(version: string | null | undefined, since: string): boolean {
  if (!version) return false;
  const parts = (v: string) => v.split(/[.\-+]/).map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
  const [a, b] = [parts(version), parts(since)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const [x, y] = [a[i] ?? 0, b[i] ?? 0];
    if (x !== y) return x > y;
  }
  return true;
}

/** Claude's "Check API connection": runs `claude doctor` in the probe home and
 *  says whether the API answers from this machine — the HTTP status or the
 *  error, or why `doctor` sent nothing. Shown only for a Claude that has the
 *  section; the parent hides it for an older one. */
export function ClaudeApiCheck() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ClaudeApiCheckResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const run = () => {
    setBusy(true);
    setFailure(null);
    invoke<ClaudeApiCheckResult>("claude_api_check")
      .then((r) => setResult(r))
      .catch((e: unknown) => {
        setResult(null);
        setFailure(String(e));
      })
      .finally(() => setBusy(false));
  };

  const status = (r: ClaudeApiCheckResult) => {
    const args = {
      status: String(r.status ?? ""),
      ms: String(r.elapsedMs ?? ""),
      error: r.error ?? "",
      reason: r.notTested ?? "",
    };
    switch (r.verdict) {
      case "ok":
        return { tone: "ok" as const, text: t("agents.apiCheckOk", args) };
      case "unexpected":
        return { tone: "warn" as const, text: t("agents.apiCheckUnexpected", args) };
      case "unreachable":
        return { tone: "warn" as const, text: t("agents.apiCheckUnreachable", args) };
      case "notTested":
        return { tone: "off" as const, text: t("agents.apiCheckNotTested", args) };
      default:
        return { tone: "off" as const, text: t("agents.apiCheckMissing", { since: CLAUDE_API_CHECK_SINCE }) };
    }
  };
  const shown = result ? status(result) : null;

  return (
    <div className="agents-block">
      <div className="agents-row">
        <div className="agents-row-main">
          {busy ? (
            <AgentsStatus tone="off">{t("agents.apiCheckRunning")}</AgentsStatus>
          ) : shown ? (
            <AgentsStatus tone={shown.tone}>{shown.text}</AgentsStatus>
          ) : (
            <AgentsStatus tone="off">{t("agents.apiCheckIdle")}</AgentsStatus>
          )}
        </div>
        <div className="agents-actions">
          <button type="button" className="settings-btn sm" disabled={busy} onClick={run}>
            {t("agents.apiCheckRun")}
          </button>
        </div>
      </div>
      {failure && <div className="project-dialog-error">{t("agents.apiCheckFailed", { error: failure })}</div>}
      {result && result.verdict !== "missing" && result.lines.map((line, i) => (
        <p key={i} className="settings-help">{line.trim().replace(/^- /, "")}</p>
      ))}
      <p className="settings-help">{t("agents.apiCheckHelp")}</p>
    </div>
  );
}
