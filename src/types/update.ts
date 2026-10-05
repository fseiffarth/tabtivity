/**
 * The wire contract for "check for a new Tabtivity" (`commands::app_update`).
 *
 * Nothing here is persisted — every field is re-read from GitHub on each check.
 * Note what is *absent*: the frontend never sends a URL or a path back. It
 * asks to download, and asks to install what was downloaded; the backend keeps
 * both, so a compromised renderer cannot nominate a file to fetch or run.
 */

/** How the *running* build can apply an update — not which artifact exists. */
export type InstallKind =
  /** Linux AppImage: the running file is swapped, then the user restarts. */
  | "appimage"
  /** Windows: the NSIS installer runs and offers to close Tabtivity first. */
  | "nsis"
  /** macOS: the disk image opens for a drag into Applications. */
  | "dmg"
  /** Downloadable, but the last step is the user's (`.deb`, package manager). */
  | "manual";

export interface UpdateAsset {
  name: string;
  url: string;
  size: number;
}

export interface UpdateCheck {
  /** The running version. */
  current: string;
  /** The latest published version, tag normalized (`v0.1.53` → `0.1.53`). */
  latest: string | null;
  tag: string | null;
  /** The release's title, when it has one beyond the tag. */
  name: string | null;
  /** The release body as markdown, rendered here as plain text. */
  notes: string | null;
  publishedAt: string | null;
  /** Always a `github.com` release page — never a URL taken from the JSON. */
  htmlUrl: string;
  updateAvailable: boolean;
  /** Only set when something newer exists *and* this platform got an artifact. */
  asset: UpdateAsset | null;
  installKind: InstallKind;
}

/** What a finished download left staged, by name — never by path. */
export interface StagedUpdate {
  name: string;
  version: string;
  installKind: InstallKind;
  bytes: number;
}

export interface InstallOutcome {
  /** The user must restart Tabtivity for the update to take effect. */
  restartRequired: boolean;
  /** An external installer was launched and now owns the rest. */
  installerLaunched: boolean;
  /** Where the artifact sits, for the manual case's "downloaded to …" line. */
  path: string;
}

/** Payload of the `app-update-progress` event. */
export interface UpdateProgress {
  received: number;
  total: number | null;
}
