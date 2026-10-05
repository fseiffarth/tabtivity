import { formatRemoteTarget, type ProjectEntry } from "../../types";
import type { TranslationKey } from "../../lib/i18n";

/** The `useT()` translator, passed in rather than read from the store: these are
 *  pure functions called during render, and taking `t` as an argument is what
 *  makes the caller re-render when the language changes. */
type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** Display name for a hosting provider. Never translated — it is the product's
 *  own name. */
export function providerName(provider: unknown): string {
  return provider === "gitlab" ? "GitLab" : "GitHub";
}

export function gitTypeLabel(gitType: unknown, provider: unknown, t: Translate): string {
  switch (gitType) {
    case "remote-public":
      return t("projectType.gitTypePublic", { provider: providerName(provider) });
    case "remote-private":
      return t("projectType.gitTypePrivate", { provider: providerName(provider) });
    case "none":
      return t("projectType.gitTypeNone");
    default:
      return t("projectType.gitTypeLocal");
  }
}

/** One colored tag in the pill hover overlay marking a facet of the project's
 *  type. Facets are independent axes, so a project can carry several at once
 *  (e.g. an SSH host published to GitHub → both "GitHub" and "SSH"). */
export interface ProjectTypeTag {
  key: string;
  label: string;
  /** 6-digit hex; text + border use it solid, background gets an alpha tint. */
  color: string;
  title: string;
}

/** Derive the colored type tags for a project. The git axis contributes a base
 *  git tag plus a provider/visibility tag when known; the SSH-remote and
 *  missing-scaffold axes each contribute an independent tag on top. */
export function projectTypeTags(
  project: ProjectEntry,
  scaffoldMissing: boolean,
  t: Translate,
): ProjectTypeTag[] {
  const tags: ProjectTypeTag[] = [];
  const gitType = typeof project.git_type === "string" ? project.git_type : "local";
  if (gitType === "none") {
    tags.push({
      key: "git",
      label: t("projectType.tagNoGit"),
      color: "#8b949e",
      title: t("projectType.titleNoGit"),
    });
  } else {
    // The provider badge normally rides on a Tabtivity-published `remote-*`
    // git_type, but a repo pushed to a host *outside* Tabtivity carries only a
    // detected provider (sniffed from `origin`; git_type stays "local"). Either
    // one lights up the badge; the ·public/·private suffix stays exclusive to
    // Tabtivity-published repos, since visibility can't be sniffed from the URL.
    const published = gitType.startsWith("remote");
    const provider = project.git_provider ?? project.detected_provider;
    // A repo always carries the base "git" tag; when it's published, the hosting
    // provider rides alongside it as a parallel tag (git + GitHub / git + GitLab).
    tags.push({
      key: "git",
      label: t("projectType.tagGit"),
      color: "#3fb950",
      title: published
        ? gitTypeLabel(gitType, project.git_provider, t)
        : provider
          ? t("projectType.titleLocalOriginOn", { provider: providerName(provider) })
          : t("projectType.titleLocalNotPushed"),
    });
    if (published || provider) {
      const providerLabel = provider === "gitlab" ? "GitLab" : "GitHub";
      // Visibility is trustworthy only when Tabtivity recorded it during publish;
      // an origin URL alone cannot reveal whether its repository is private.
      const label = published
        ? gitType === "remote-private"
          ? t("projectType.providerPrivate", { provider: providerLabel })
          : t("projectType.providerPublic", { provider: providerLabel })
        : providerLabel;
      const color = provider === "gitlab" ? "#fc6d26" : "#a371f7";
      const summary = published
        ? gitTypeLabel(gitType, provider, t)
        : t("projectType.titleOriginDetected", { provider: providerName(provider) });
      // The sniffed `origin` address rides on a second line, so hovering the
      // badge says *where* the repo lives, not just which provider hosts it.
      const origin = project.git_origin_url?.trim();
      const title = origin ? `${summary}\n${origin}` : summary;
      tags.push({ key: "provider", label, color, title });
    }
  }
  if (project.remote) {
    tags.push({
      key: "ssh",
      // The protocol's own name — the same in every language.
      label: "SSH",
      color: "#58a6ff",
      title: t("projectType.titleRemoteHost", { target: formatRemoteTarget(project.remote) }),
    });
  }
  if (scaffoldMissing) {
    tags.push({
      key: "scaffold",
      label: t("projectType.tagNoScaffold"),
      color: "#d29922",
      title: t("projectType.titleMissingScaffold"),
    });
  }
  return tags;
}
