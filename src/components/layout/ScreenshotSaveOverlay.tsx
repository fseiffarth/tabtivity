import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useProjectsStore } from "../../stores/projects";
import { useScreenshotPendingStore } from "../../stores/screenshotPending";
import { resolveProjectDirectory } from "../../types";
import { useT } from "../../lib/i18n";
import { APP_SCREENSHOTS_DIR } from "../../lib/window/screenshot";
import { useGeneratedDirName } from "../../lib/generatedDir";
import { UntestedTag } from "../common/UntestedTag";
import { ErrorNote } from "../common/ErrorNote";

/**
 * "Where should this screenshot go?" — the consent step every capture passes
 * through before a single byte is written into a project.
 *
 * A capture used to be filed automatically into the active project's
 * screenshots folder. That is the wrong default for a tool whose projects
 * routinely have public git remotes: a screen grab holds whatever was on the
 * screen — another project's window, mail, a token in a terminal — and a
 * `git add -A` publishes it. So the shot waits in a staging area outside every
 * project tree until this overlay is answered, and `tabtivity-screenshots/` is in
 * the scaffold's `.gitignore` defaults — and the backend ensures that line
 * before it writes — so even a saved shot is ignored by default.
 *
 * The folder is `tabtivity-`prefixed because the bare name is one a project itself
 * may own: ignoring a repo's own `screenshots/` of documentation images would
 * hide the user's files from git.
 *
 * Discard is a cheap answer on purpose: the capture is on the system clipboard
 * either way, so dropping the file loses nothing that was not already pasteable.
 *
 * Portaled to `<body>`, so the dialog sets an explicit `color` (it rides
 * `.file-delete-dialog`'s chrome, which does): `body` carries none, and an
 * inherited color renders black.
 */
export function ScreenshotSaveOverlay() {
  const t = useT();
  const pending = useScreenshotPendingStore((s) => s.pending);
  const show = useScreenshotPendingStore((s) => s.show);
  const close = useScreenshotPendingStore((s) => s.close);
  const projects = useProjectsStore((s) => s.projects);
  const activeId = useProjectsStore((s) => s.activeId);

  const [projectId, setProjectId] = useState<string>("");
  const [folder, setFolder] = useState(APP_SCREENSHOTS_DIR);
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only projects with a resolvable directory can take a file at all.
  const savable = useMemo(
    () =>
      projects
        .map((p) => ({ id: p.id, name: p.name, dir: resolveProjectDirectory(p) || "" }))
        .filter((p) => p.dir),
    [projects],
  );

  // An OS-tool capture reports itself from the backend once its PNG lands in the
  // staging area; a cancelled capture writes nothing and so reports nothing.
  useEffect(() => {
    const un = listen<{ path: string; name: string }>("screenshot-captured", (ev) => {
      show({ kind: "staged", path: ev.payload.path, name: ev.payload.name });
    });
    return () => {
      void un.then((f) => f());
    };
  }, [show]);

  // Fresh defaults per shot: the capture's own file name, and the project it
  // came from when it knows one (a PDF crop does) — else the active project.
  useEffect(() => {
    if (!pending) return;
    setError(null);
    setBusy(false);
    setFolder(APP_SCREENSHOTS_DIR);
    setName(pending.name);
    const hinted = pending.hintDir
      ? savable.find((p) => p.dir === pending.hintDir)
      : undefined;
    setProjectId(hinted?.id ?? (savable.some((p) => p.id === activeId) ? activeId! : savable[0]?.id) ?? "");
    // `savable`/`activeId` are read as they stand when a shot arrives; a project
    // list that changes underneath must not re-pick the user's chosen target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  // The preview is a nicety, not the product: a read that fails still leaves a
  // dialog that can save or discard.
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    let url: string | null = null;
    void (async () => {
      try {
        const bytes =
          pending.kind === "bytes"
            ? pending.png
            : await invoke<ArrayBuffer | number[]>("read_pending_screenshot", {
                path: pending.path,
              }).then((out) =>
                out instanceof ArrayBuffer ? new Uint8Array(out) : Uint8Array.from(out),
              );
        if (cancelled) return;
        // Re-wrapped like every other viewer's blob: a fresh `Uint8Array` is
        // backed by a plain `ArrayBuffer`, which is what `BlobPart` accepts.
        url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
        setPreview(url);
      } catch {
        /* no preview; the dialog still works */
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      setPreview(null);
    };
  }, [pending]);

  const dir = savable.find((p) => p.id === projectId)?.dir ?? "";

  // The folder defaults to the one the chosen project already has: a project
  // filed into before a rename keeps its old-named folder. A name the user
  // typed is theirs and is left alone.
  const projectFolder = useGeneratedDirName(pending ? dir : "", "screenshots");
  const [typedFolder, setTypedFolder] = useState(false);
  useEffect(() => {
    setTypedFolder(false);
  }, [pending]);
  useEffect(() => {
    if (pending && !typedFolder) setFolder(projectFolder);
  }, [pending, typedFolder, projectFolder]);
  const relPath = [folder.trim().replace(/^\/+|\/+$/g, ""), name.trim()]
    .filter(Boolean)
    .join("/");

  const discard = async () => {
    if (pending?.kind === "staged") {
      // Best-effort: a staged file that outlives its overlay is swept by the
      // backend's TTL sweep anyway, and the user said they don't want it.
      try {
        await invoke("discard_pending_screenshot", { path: pending.path });
      } catch {
        /* nothing to report — the shot is on the clipboard either way */
      }
    }
    close();
  };

  const save = async () => {
    if (!pending || !dir || !name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (pending.kind === "staged") {
        const saved = await invoke<string>("save_pending_screenshot", {
          path: pending.path,
          projectDir: dir,
          relPath,
        });
        useProjectsStore.setState({ switchToast: t("screenshotSave.saved", { path: saved }) });
      } else {
        await invoke("write_project_file_bytes", {
          projectDir: dir,
          relPath,
          content: Array.from(pending.png),
        });
        useProjectsStore.setState({
          switchToast: t("screenshotSave.saved", { path: `${dir}/${relPath}` }),
        });
      }
      close();
    } catch (e) {
      setError(t("screenshotSave.failed", { msg: String(e) }));
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!pending) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) void discard();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, busy]);

  if (!pending) return null;

  return createPortal(
    <div className="modal-backdrop" onMouseDown={() => !busy && void discard()}>
      <div
        className="file-delete-dialog screenshot-save-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>
          {t("screenshotSave.title")} <UntestedTag id="screenshotSave.title" />
        </h2>
        {preview && (
          <img className="screenshot-save-preview" src={preview} alt={t("screenshotSave.preview")} />
        )}
        <p>{t("screenshotSave.clipboardNote")}</p>
        {savable.length === 0 ? (
          <div className="file-delete-path">{t("screenshotSave.noProject")}</div>
        ) : (
          <div className="screenshot-save-fields">
            <label>
              {t("screenshotSave.project")}
              <select
                value={projectId}
                disabled={busy}
                onChange={(e) => setProjectId(e.target.value)}
              >
                {savable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("screenshotSave.folder")}
              <input
                value={folder}
                disabled={busy}
                spellCheck={false}
                onChange={(e) => {
                  setTypedFolder(true);
                  setFolder(e.target.value);
                }}
                onKeyDown={(e) => e.key === "Enter" && void save()}
              />
            </label>
            <label>
              {t("screenshotSave.name")}
              <input
                autoFocus
                value={name}
                disabled={busy}
                spellCheck={false}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void save()}
              />
            </label>
          </div>
        )}
        {relPath && dir && <div className="file-delete-path">{`${dir}/${relPath}`}</div>}
        {error && <ErrorNote className="file-delete-path file-delete-error" error={error} />}
        <div className="file-delete-actions">
          <button type="button" disabled={busy} onClick={() => void discard()}>
            {t("screenshotSave.discard")}
          </button>
          <button type="button" disabled={busy || !dir || !name.trim()} onClick={() => void save()}>
            {t("screenshotSave.save")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
