import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { hasTokenFor, useGitHosts } from "../../lib/gitHosts";
import { useT } from "../../lib/i18n";
import { PROVIDER_CLI_INSTALL, providerAuthLoginCmd, runInstallInTab } from "../../lib/installCommand";
import { IS_HOST_WINDOWS } from "../../lib/platform";
import { isHostPinned } from "../../lib/projectTabHost";
import { resolveLocalMirror, resolveProjectDirectory, type GitProvider, type ProjectEntry, type PublishFrom } from "../../types";
import { Dropdown } from "../common/Dropdown";
import { ErrorNote } from "../common/ErrorNote";
import { DialogShell } from "../common/PromptDialogs";
import { UntestedTag } from "../common/UntestedTag";
import { gitTypeLabel, providerName } from "./projectTypeTags";

/** Best-effort guess at the provider for a not-yet-published project: an
 *  explicit prior provider wins, else sniff the profile URL host, else GitHub. */
export function guessProvider(project: ProjectEntry): GitProvider {
  if (project.git_provider === "github" || project.git_provider === "gitlab") {
    return project.git_provider;
  }
  if (project.git_profile_url?.toLowerCase().includes("gitlab")) return "gitlab";
  return "github";
}

export function PublishWindow({
  project,
  onPublish,
  onClose,
  showSource = false,
}: {
  project: ProjectEntry;
  onPublish: (
    provider: GitProvider,
    visibility: "public" | "private",
    publishFrom: PublishFrom,
  ) => Promise<string>;
  onClose: () => void;
  showSource?: boolean;
}) {
  const t = useT();
  const [provider, setProvider] = useState<GitProvider>(() => guessProvider(project));
  const [visibility, setVisibility] = useState<"public" | "private">(
    project.git_type === "remote-public" ? "public" : "private",
  );
  // Which side runs the CLI. Defaults to this machine (for a remote project, its
  // lockstep mirror): the provider login lives here, not on the work remote. A
  // project pinned to its host has no local copy, so only the host can publish
  // (the backend refuses "local" for it).
  const hostPinned = isHostPinned(project);
  const [publishFrom, setPublishFrom] = useState<PublishFrom>(hostPinned ? "remote" : "local");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const isRemoteWork = Boolean(project.remote);
  // True when the CLI will run on this machine — always for a local project, and
  // for a remote one unless the host was explicitly chosen.
  const runsLocally = !isRemoteWork || publishFrom === "local";
  // The CLI the chosen provider drives, surfaced in the command preview/help.
  const cli = provider === "gitlab" ? "glab" : "gh";
  const createPreview =
    provider === "gitlab"
      ? `glab repo create ${project.name} --${visibility} --remoteName origin && git push`
      : `gh repo create ${project.name} --${visibility} --source=. --push`;
  const cliInstall = PROVIDER_CLI_INSTALL[provider];
  // Whether `cli` is on PATH here. Meaningful whenever the publish runs on this
  // machine — which now includes a work-remote project publishing from its
  // mirror. Only the explicit "work-remote host" choice runs somewhere this
  // probe (a local `<cli> --version`) can't see. `null` while probing/unknown,
  // so a pending answer never claims the CLI is missing.
  const [cliAvailable, setCliAvailable] = useState<boolean | null>(null);
  // A host token for this provider (⚙ Settings → Git hosting) — a
  // project-specific override is possible too (`GitHostingWindow`) but rare
  // enough that this approximation (skip the sign-in nudge when the provider
  // has a host token) is fine.
  const gitConnected = hasTokenFor(useGitHosts(), provider);

  useEffect(() => {
    if (!runsLocally) {
      setCliAvailable(null);
      return;
    }
    let cancelled = false;
    setCliAvailable(null);
    invoke<boolean>("provider_cli_available", { provider })
      .then((ok) => !cancelled && setCliAvailable(ok))
      .catch(() => !cancelled && setCliAvailable(false));
    return () => {
      cancelled = true;
    };
  }, [runsLocally, provider]);

  const publish = async () => {
    setBusy(true);
    setError("");
    try {
      const output = await onPublish(provider, visibility, publishFrom);
      setResult(output || t("pill.published"));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogShell
      frame="project-dialog"
      title={t("pill.publishTitle", { name: project.name, provider: providerName(provider) })}
      onDismiss={onClose}
    >
    <div className="project-dialog-path">
      {t("pill.currentPrefix")} {gitTypeLabel(project.git_type, project.git_provider, t)}
      {isRemoteWork && !runsLocally && ` ${t("pill.runsOnWorkRemote")}`}
    </div>
    {showSource && (
      <div className="project-dialog-path">
        {t("projectFilesView.publishCheckout", {
          checkout: isRemoteWork
            ? runsLocally ? resolveLocalMirror(project) ?? project.name : project.remote?.remote_path ?? project.name
            : resolveProjectDirectory(project) || project.name,
        })}
      </div>
    )}
    <label>
      {t("pill.hostingProvider")}
      <Dropdown
        className="dropdown-block"
        value={provider}
        disabled={busy || Boolean(result)}
        onChange={(v) => setProvider(v as GitProvider)}
        options={[
          { value: "github", label: "GitHub" },
          { value: "gitlab", label: "GitLab" },
        ]}
      />
    </label>
    {/* A work-remote project has the same history on both sides, so which one
        creates the repo is a real choice — and only this machine holds the
        provider login, which is why it is the default. */}
    {isRemoteWork && !hostPinned && (
      <label>
        {t("pill.publishFrom")} <UntestedTag id="pill.publishFrom" />
        <Dropdown
          className="dropdown-block"
          value={publishFrom}
          disabled={busy || Boolean(result)}
          onChange={(v) => setPublishFrom(v as PublishFrom)}
          options={[
            { value: "local", label: t("pill.publishFromLocal") },
            { value: "remote", label: t("pill.publishFromRemote") },
          ]}
        />
      </label>
    )}
    <label>
      {t("pill.repoVisibility")}
      <Dropdown
        className="dropdown-block"
        value={visibility}
        disabled={busy || Boolean(result)}
        onChange={(v) => setVisibility(v as "public" | "private")}
        options={[
          { value: "private", label: t("pill.visPrivate") },
          { value: "public", label: t("pill.visPublic") },
        ]}
      />
    </label>
    <div className="project-dialog-path">
      {t("pill.publishRunsPre")} <code>{createPreview}</code>. {t("pill.publishRunsMid")} <code>{cli}</code>{" "}
      {t("pill.publishRunsPost")}
    </div>

    {isRemoteWork && (
      <div className="project-dialog-path">
        {runsLocally
          ? t("pill.publishFromLocalHint", { cli })
          : t("pill.publishRemoteCliHint", { cli })}
      </div>
    )}

    {!runsLocally ? null : cliAvailable === false ? (
      <div className="tex-install-banner" role="status">
        <span className="tex-install-banner-text">
          {t("pill.publishCliMissingPre")} <code>{cliInstall.bin}</code>{" "}
          {t("pill.publishCliMissingMid")} <code>{cliInstall.bin} auth login</code>
          {t("pill.publishCliMissingPost")}
        </span>
        <code className="ollama-install-cmd">{cliInstall.cmd}</code>
        <button
          type="button"
          className="ollama-action-btn primary"
          title={t("projectDialog.runInTerminalTitle")}
          onClick={() =>
            runInstallInTab(
              t("projectDialog.installBinLabel", { bin: cliInstall.bin }),
              cliInstall.cmd,
              IS_HOST_WINDOWS ? "default" : "bash",
            )
          }
        >
          {t("projectDialog.runInTerminalBtn")}
        </button>
      </div>
    ) : cliAvailable === true && !gitConnected ? (
      <div className="tex-install-banner" role="status">
        <span className="tex-install-banner-text">{t("pill.publishSignInHint", { cli })}</span>
        <button
          type="button"
          className="ollama-action-btn primary"
          title={t("pill.publishSignInTitle", { cmd: providerAuthLoginCmd(provider) })}
          onClick={() =>
            runInstallInTab(
              t("pill.publishSignInBtn", { cli }),
              providerAuthLoginCmd(provider),
              IS_HOST_WINDOWS ? "default" : "bash",
            )
          }
        >
          {t("pill.publishSignInBtn", { cli })}
        </button>
      </div>
    ) : null}

    {error && <ErrorNote className="project-dialog-error" error={error} />}
    {result && <div className="scaffold-empty">{result}</div>}
    <div className="project-dialog-actions">
      <button type="button" onClick={onClose}>{result ? t("common.close") : t("common.cancel")}</button>
      {!result && (
        <button type="button" disabled={busy} onClick={() => void publish()}>
          {busy ? t("pill.publishing") : t("pill.publish")}
        </button>
      )}
    </div>
    </DialogShell>
  );
}
