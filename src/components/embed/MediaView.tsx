import { useEffect, useMemo, useRef, useState } from "react";
import { ViewerHeader } from "./fileViewer/ViewerHeader";
import { useFileScope, readFileBytes } from "../../lib/files/fileAccess";
import { basename } from "../../lib/paths";
import { useT } from "../../lib/i18n";
import { usePaneSleepHold } from "../../lib/sleepWhenHidden";

/**
 * Audio/video player viewer (Dev D). Plays `.mp3`/`.mp4`/`.webm`/… in-tab via
 * the webview's native <audio>/<video>, sourcing the bytes through a Blob URL
 * (reuse `read_file_bytes`, picking the MIME from the extension). Read-only.
 *
 * Controls are enabled; nothing autoplays. `preload="metadata"` fetches just
 * enough of the blob to populate duration/dimensions without buffering the whole
 * file up front. Mirrors the image viewer's blob-URL lifecycle: a new object URL
 * is minted per path and the previous one revoked when the path changes / on
 * unmount, so the blobs don't leak.
 */

/** Lowercased extension → MIME type. Anything not listed is treated as audio
 *  with an empty type (let the webview sniff). The keys here are also the set of
 *  extensions FileViewerPane routes to the "media" viewer. */
const MIME_BY_EXT: Record<string, string> = {
  // audio
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  // video
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  ogv: "video/ogg",
};

/** Extensions that should render in a <video> element; everything else routed
 *  here plays as <audio>. */
const VIDEO_EXTS = new Set(["mp4", "m4v", "webm", "mov", "mkv", "ogv"]);

/** Lowercased extension (no dot) of a path, or "" when it has none. */
function extOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Load `path`'s bytes once and expose them as a typed Blob object URL, revoking
 * the previous URL when the path changes and on unmount. `type` picks the Blob
 * MIME so the webview decodes the right codec. A read failure (missing file, or
 * the backend's large-file rejection) surfaces as `error`.
 */
function useMediaBlobUrl(path: string, type: string) {
  const scope = useFileScope();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setError(null);
    readFileBytes(path, scope)
      .then((bytes) => {
        if (cancelled) return;
        const blob = new Blob([new Uint8Array(bytes)], type ? { type } : undefined);
        const objectUrl = URL.createObjectURL(blob);
        const prev = urlRef.current;
        urlRef.current = objectUrl;
        setUrl(objectUrl);
        if (prev) URL.revokeObjectURL(prev);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path, type, scope]);

  // Revoke the last live URL on unmount.
  useEffect(
    () => () => {
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    },
    [],
  );

  return { url, error };
}

export function MediaView({
  path,
  onOpenExternally,
  tabKey: _tabKey,
}: {
  path: string;
  onOpenExternally: () => void;
  tabKey?: string;
}) {
  const t = useT();
  const ext = useMemo(() => extOf(path), [path]);
  const mime = MIME_BY_EXT[ext] ?? "";
  const isVideo = VIDEO_EXTS.has(ext);
  const { url, error } = useMediaBlobUrl(path, mime);

  // A media element that fails to decode (unsupported codec/container in the
  // webview) surfaces an onError; show it instead of a frozen player.
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  useEffect(() => {
    setPlaybackError(null);
  }, [url]);
  // Playing media keeps the pane awake: a sleeping pane is unmounted, which
  // would stop a track left playing in a background tab (performance plan §5.3).
  const [playing, setPlaying] = useState(false);
  usePaneSleepHold(playing);
  const playback = {
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
  };

  return (
    <div className="file-viewer">
      <ViewerHeader onOpenExternally={onOpenExternally} />
      <div
        className="file-viewer-body"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          padding: 12,
        }}
      >
        {error != null ? (
          <div className="file-viewer-error">{error}</div>
        ) : playbackError != null ? (
          <div className="file-viewer-error">{playbackError}</div>
        ) : url == null ? (
          <div className="file-viewer-loading">{t("common.loading")}</div>
        ) : isVideo ? (
          <video
            key={url}
            src={url}
            controls
            preload="metadata"
            {...playback}
            onError={() => setPlaybackError(t("mediaView.playbackFailed"))}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
            }}
          />
        ) : (
          <audio
            key={url}
            src={url}
            controls
            preload="metadata"
            {...playback}
            onError={() => setPlaybackError(t("mediaView.playbackFailed"))}
            style={{ width: "100%", maxWidth: 640 }}
          />
        )}
      </div>
    </div>
  );
}
