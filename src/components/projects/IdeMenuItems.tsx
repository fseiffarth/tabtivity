import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useT } from "../../lib/i18n";
import { useProjectsStore } from "../../stores/projects";
import { useWindowsStore } from "../../stores/windows";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { UntestedTag } from "../common/UntestedTag";

/** One row of `detect_project_ides` (`commands::ide::IdeCandidate`). */
export interface IdeCandidate {
  id: string;
  family: string;
  label: string;
  markerPath: string;
  target: string;
  exec: string | null;
  displayName: string | null;
  source: string | null;
  overridden: boolean;
}

interface Props {
  projectId: string;
  /** Close the hosting menu (a launch is a terminal action for it). */
  onClose: () => void;
}

/**
 * The IDEs `projectId`'s tree carries markers for, refetched whenever a pick
 * changes a launcher, plus the three actions the rows and the side panel's
 * header button share. `launch` reports a failure through the switch toast.
 */
export function useProjectIdes(projectId: string) {
  const t = useT();
  const [ides, setIdes] = useState<IdeCandidate[]>([]);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    invoke<IdeCandidate[]>("detect_project_ides", { projectId })
      .then((list) => {
        if (!cancelled) setIdes(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setIdes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, nonce]);

  const launch = async (ide: IdeCandidate) => {
    try {
      await invoke("open_project_in_ide", { projectId, ideId: ide.id });
      await useWindowsStore.getState().refresh(projectId);
    } catch (e) {
      console.error("open_project_in_ide", e);
      useProjectsStore.setState({
        switchToast: t("pill.openInIdeFailed", { ide: ide.displayName ?? ide.label, error: String(e) }),
      });
    }
  };

  /** Pick the program for `ide`; true when one was chosen and stored. */
  const choose = async (ide: IdeCandidate): Promise<boolean> => {
    const picked = await open({ directory: false, multiple: false });
    if (typeof picked !== "string") return false;
    try {
      await invoke("set_ide_launcher", { ideId: ide.id, exec: picked });
    } catch (e) {
      console.error("set_ide_launcher", e);
      return false;
    }
    setNonce((n) => n + 1);
    return true;
  };

  const reset = async (ide: IdeCandidate) => {
    try {
      await invoke("set_ide_launcher", { ideId: ide.id, exec: null });
    } catch (e) {
      console.error("set_ide_launcher", e);
    }
    setNonce((n) => n + 1);
  };

  return { ides, launch, choose, reset };
}

/**
 * "Open in <IDE>" rows for a project menu: one per IDE the project's tree
 * carries markers for (`.idea/`, `.vs/` + `*.sln`, `.vscode/`, `.zed/`,
 * `*.Rproj`, … — `services::ide_detect`), listed by the backend on every open. Renders nothing for a project without markers, so the
 * hosting menu (the pill's View group, the file tree's root menu) gains no
 * empty group.
 *
 * A row whose IDE was not found still shows, suffixed "(not found)": clicking
 * it asks for the executable, stores it as the user's launcher for that IDE
 * and launches. Right-click on any row picks the program the same way without
 * launching; an overridden row gets a second row to go back to detection.
 * The program launched is always resolved backend-side — the list here is a
 * display, never the thing executed.
 */
export function IdeMenuItems({ projectId, onClose }: Props) {
  const t = useT();
  const { ides, launch: launchIde, choose, reset } = useProjectIdes(projectId);

  if (ides.length === 0) return null;

  const launch = async (ide: IdeCandidate) => {
    onClose();
    await launchIde(ide);
  };

  return (
    <>
      {ides.map((ide) => {
        const name = ide.displayName ?? ide.label;
        const missing = !ide.exec;
        return (
          <span key={ide.id} style={{ display: "contents" }}>
            <button
              className="untested"
              title={
                missing
                  ? t("pill.openInIdeMissingTitle", { ide: name, marker: ide.markerPath })
                  : t("pill.openInIdeTitle", { ide: name, marker: ide.markerPath, exec: ide.exec ?? "" })
              }
              onClick={() => {
                if (missing) {
                  void choose(ide).then((chosen) => {
                    if (chosen) void launch(ide);
                  });
                } else {
                  void launch(ide);
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void choose(ide);
              }}
            >
              {t("pill.openInIde", { ide: name })}
              {missing && ` (${t("globalApps.notFoundPlaceholder")})`}
              <UntestedTag id="projectPill.openInIde" />
            </button>
            {ide.overridden && (
              <button className="untested" onClick={() => void reset(ide)}>
                {t("pill.ideUseDetected", { ide: ide.label })}
                <UntestedTag id="projectPill.openInIde" />
              </button>
            )}
          </span>
        );
      })}
    </>
  );
}

/** Code-brackets glyph for the side panel's IDE button; `currentColor`. */
function IdeIcon() {
  return (
    <svg
      className="side-panel-mobile-btn-icon"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M5.4 4.2L1.8 8l3.6 3.8M10.6 4.2L14.2 8l-3.6 3.8M9.1 2.6L6.9 13.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The side panel header's "Open in IDE" button: absent for a project without
 * IDE markers. With one detected IDE whose program was found, a click opens
 * the project in it; otherwise (several IDEs, or a program to pick) the click
 * opens the same rows the pill menu shows. Right-click always opens the rows,
 * which is where the program is chosen or reset.
 */
export function IdeHeaderButton({ projectId, projectName }: { projectId: string; projectName: string }) {
  const t = useT();
  const { ides, launch } = useProjectIdes(projectId);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  if (ides.length === 0) return null;

  const only = ides.length === 1 && ides[0].exec ? ides[0] : null;
  const openMenu = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 2 });
  };

  return (
    <>
      <button
        type="button"
        className="side-panel-mobile-btn side-panel-ide-btn"
        aria-haspopup={only ? undefined : "menu"}
        aria-label={t("projectFilesView.openInIdeAria", { name: projectName })}
        title={
          only
            ? t("pill.openInIdeTitle", {
              ide: only.displayName ?? only.label,
              marker: only.markerPath,
              exec: only.exec ?? "",
            })
            : t("projectFilesView.openInIdeMenuTitle", {
              ides: ides.map((ide) => ide.displayName ?? ide.label).join(", "),
            })
        }
        onClick={(e) => {
          if (only) void launch(only);
          else openMenu(e.currentTarget);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openMenu(e.currentTarget);
        }}
      >
        <IdeIcon />
      </button>
      <UntestedTag id="projectFilesView.openInIde" />
      {menu && (
        <ContextMenuPortal x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <div className="context-menu-group">
            <div className="context-menu-group-label">{t("projectFilesView.openInIdeGroup")}</div>
            <IdeMenuItems projectId={projectId} onClose={() => setMenu(null)} />
          </div>
        </ContextMenuPortal>
      )}
    </>
  );
}
