import { type GitProvider } from "../../types";
import { useT, type TranslationKey } from "../../lib/i18n";

/**
 * The provider's own "create a personal access token" page. Reads the host off a
 * configured profile URL so a self-hosted GitLab/GitHub Enterprise instance gets
 * its own token page rather than the public one.
 */
export function tokenPageUrl(provider: GitProvider, profileUrl: string): string {
  let host = provider === "gitlab" ? "gitlab.com" : "github.com";
  try {
    const parsed = new URL(profileUrl);
    if (parsed.host) host = parsed.host;
  } catch {
    // No usable profile URL yet — fall back to the public host.
  }
  return provider === "gitlab"
    ? `https://${host}/-/user_settings/personal_access_tokens`
    : `https://${host}/settings/tokens`;
}

/** One row of the guide: the literal scope/permission name plus what Tabtivity does
 *  with it. The name is never translated — it has to match the provider's own
 *  checkbox label for the reader to find it. */
type Scope = { name: string; descKey: TranslationKey };

const GITHUB_CLASSIC: Scope[] = [
  { name: "repo", descKey: "gitScopes.gh.repo" },
  { name: "workflow", descKey: "gitScopes.gh.workflow" },
  { name: "read:org", descKey: "gitScopes.gh.readOrg" },
];

const GITHUB_FINE: Scope[] = [
  { name: "Contents: Read and write", descKey: "gitScopes.ghf.contents" },
  { name: "Metadata: Read-only", descKey: "gitScopes.ghf.metadata" },
  { name: "Administration: Read and write", descKey: "gitScopes.ghf.administration" },
  { name: "Workflows: Read and write", descKey: "gitScopes.ghf.workflows" },
];

const GITLAB: Scope[] = [
  { name: "api", descKey: "gitScopes.gl.api" },
  { name: "write_repository", descKey: "gitScopes.gl.writeRepository" },
];

/**
 * Collapsed explanation of what the stored hosting token is actually used for and
 * which permissions that needs — shown under the token field in Settings → Git
 * Hosting and in a project's per-project hosting dialog.
 *
 * The four things Tabtivity does with the token (clone/push over https, create the
 * repo on publish, flip its visibility, fork) are what the lists are derived
 * from; nothing here asks for more than those. Deleting a hosted repo is
 * deliberately absent — unpublishing only drops the `origin` remote.
 */
export function GitTokenScopes({ provider }: { provider: GitProvider }) {
  const t = useT();
  const gitlab = provider === "gitlab";
  return (
    <details className="settings-guide git-scopes">
      <summary>{t("gitScopes.summary")}</summary>
      <div className="settings-guide-body">
        <p>{t("gitScopes.intro")}</p>
        {gitlab ? (
          <ScopeList titleKey="gitScopes.gl.title" scopes={GITLAB} />
        ) : (
          <>
            <ScopeList titleKey="gitScopes.gh.title" scopes={GITHUB_CLASSIC} />
            <ScopeList titleKey="gitScopes.ghf.title" scopes={GITHUB_FINE} />
            <p>{t("gitScopes.ghf.note")}</p>
          </>
        )}
        <p>{t("gitScopes.never")}</p>
      </div>
    </details>
  );
}

function ScopeList({ titleKey, scopes }: { titleKey: TranslationKey; scopes: Scope[] }) {
  const t = useT();
  return (
    <div className="git-scopes-group">
      <strong>{t(titleKey)}</strong>
      <ul>
        {scopes.map((s) => (
          <li key={s.name}>
            <code>{s.name}</code> — {t(s.descKey)}
          </li>
        ))}
      </ul>
    </div>
  );
}
