/**
 * The guided **HPC pipeline wizard** (`docs/quirky-knitting-umbrella` plan
 * Phases B + C).
 *
 * A newcomer to a SLURM cluster has to log in, get a piece of the parallel
 * filesystem to work in, create a project there, get their data across, write a
 * batch script, submit it, and tail the log — a lot of steps, each easy to get
 * subtly wrong. This stepper walks the whole path **by composing the existing
 * flows** rather than reimplementing them:
 *
 *  1. **Login** — `RemoteProjectSection` + `useRemoteSession` (SSH connect + optional
 *     OpenVPN + the live remote folder browser).
 *  2. **Project** — a name + local-mirror location.
 *  3. **Workspace** (Phase C, skipped on a host without the tooling) — allocate or
 *     pick an `hpc-workspace` (`lib/remote/hpc/hpcWorkspace`), **then** create the project.
 *     This step exists because `$HOME` on a cluster is a small, quota'd, code-only
 *     filesystem: bulk data belongs in a time-limited workspace on the parallel
 *     filesystem. It has to come *before* the project is created and before a
 *     single byte is uploaded, because the whole integration is that the chosen
 *     workspace becomes the project's **remote root** — every existing transport
 *     (SFTP upload, byte-sync, git lockstep, run tabs) then lands there instead of
 *     `$HOME` with no change of its own.
 *  4. **Load data** (skippable) — pick local files → stream them to the host over
 *     the pooled SFTP (`remote_upload_file`) — i.e. into the workspace.
 *  5. **Run job** — edit a starter `.slurm`'s `#SBATCH` directives (the Phase-A
 *     splice helpers), write it to the host, and **Submit** it (Phase-A
 *     `submitSlurmJob`, which opens a log tab).
 *  6. **Watch** — the log tab is already tailing; point at the Jobs view (⚙) and
 *     finish.
 *
 * Everything new is `untested` until QA'd on a real cluster.
 */

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { RemoteProjectSection } from "./RemoteProjectSection";
import { useRemoteSession } from "./useRemoteSession";
import { useHpcPipelineStore } from "../../stores/remote/hpc/hpcPipeline";
import { useProjectsStore, stashRemotePassword, stashRemoteViaLogin } from "../../stores/projects";
import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import { resolveProjectDirectory, resolveLocalMirror, type ProjectEntry } from "../../types";
import { basename } from "../../lib/paths";
import { writeFileText } from "../embed/fileAccess";
import { UntestedTag } from "../common/UntestedTag";
import {
  parseSbatchDirectives,
  directiveValue,
  spliceDirective,
  submitSlurmJob,
  COMMON_SBATCH_KEYS,
} from "../../lib/remote/hpc/slurm";
import {
  wsAvailable,
  wsList,
  wsAllocate,
  wsLink,
  wsAnchor,
  setProjectHpc,
  wsTargetForHost,
  defaultFilesystem,
  defaultAnchorRel,
  logOutputPattern,
  scratchCandidates,
  freeSpaceLabel,
  remainingLabel,
  expiryTone,
  linkedWorkspaceCaveat,
  type HpcWorkspace,
  type HpcWsInfo,
  type HpcAnchor,
  type ScratchCandidate,
} from "../../lib/remote/hpc/hpcWorkspace";
import { useT, type TranslationKey } from "../../lib/i18n";
import { GearIcon, UploadIcon } from "../common/icons/Icon";
import { ErrorNote } from "../common/ErrorNote";

type Step = "login" | "project" | "workspace" | "data" | "run" | "watch";

/** Where the project's tree lives on the host once a workspace is chosen.
 *  `in-workspace` (the default) makes the workspace the project's remote root, so
 *  everything Tabtivity already syncs lands on the parallel filesystem; `link` keeps
 *  the project in the browsed folder (usually `$HOME`) and symlinks the workspace
 *  in for the host's own tools — see `linkedWorkspaceCaveat`. */
type WsLayout = "in-workspace" | "link";

/** Human labels for the `#SBATCH` keys the run step surfaces, keyed to translation keys. */
const SBATCH_LABEL_KEYS: Record<string, TranslationKey> = {
  "job-name": "hpcWizard.sbatchJobName",
  partition: "hpcWizard.sbatchPartition",
  time: "hpcWizard.sbatchTime",
  nodes: "hpcWizard.sbatchNodes",
  ntasks: "hpcWizard.sbatchTasks",
  "cpus-per-task": "hpcWizard.sbatchCpusPerTask",
  mem: "hpcWizard.sbatchMemory",
  gres: "hpcWizard.sbatchGres",
  output: "hpcWizard.sbatchOutput",
};

/** A sensible starter batch script. Edit the `#SBATCH` directives to match your
 *  cluster's partitions/limits and your job's needs. */
const STARTER_SLURM = `#!/bin/bash
#SBATCH --job-name=myjob
#SBATCH --account=<account>
#SBATCH --partition=<partition>
#SBATCH --time=01:00:00
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=8G
#SBATCH --output=slurm-%j.out

# Runs on a compute node via SLURM — never the login node.
# Set --account to your working group's allocation: many clusters reject a job
# with no account. Match --partition and the module name below to
# your cluster; check its usage policy (e.g. any acknowledgement it asks for).

module load Python
python --version
echo "Replace this with your job."
`;

const STARTER_NAME = "job.slurm";

/** Mounted once in AppShell; renders the wizard when the store says it's open. */
export function HpcPipelineWizardHost() {
  const open = useHpcPipelineStore((s) => s.open);
  const close = useHpcPipelineStore((s) => s.close);
  if (!open) return null;
  return <HpcPipelineWizard onClose={close} />;
}

function HpcPipelineWizard({ onClose }: { onClose: () => void }) {
  const t = useT();
  const addProject = useProjectsStore((s) => s.addProject);
  const registerGlobalMachine = useGlobalMachinesStore((s) => s.register);
  const remote = useRemoteSession({ kind: "new" });
  const {
    isRemoteProject,
    isRemote,
    remoteConn,
    toggleRemoteProject,
    remoteBrowsePath,
    remoteChosenPath,
    setRemoteChosenPath,
    rememberChosenPath,
    remotePassword,
    buildRemoteSpec,
  } = remote;

  // Once the cluster login goes live, surface that host in the header's global
  // machines list too — it's now a project-free, already-authenticated
  // connection the user can reuse across projects (or drag onto one as a
  // compute host). Registration is idempotent by target and best-effort, so it
  // never blocks the wizard.
  useEffect(() => {
    if (!isRemote || !remoteConn) return;
    void registerGlobalMachine({
      user: remoteConn.user ?? undefined,
      host: remoteConn.host,
      port: remoteConn.port ?? undefined,
    });
  }, [isRemote, remoteConn, registerGlobalMachine]);

  const [step, setStep] = useState<Step>("login");
  const [projectsRoot, setProjectsRoot] = useState("");
  const [mirrorParent, setMirrorParent] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<ProjectEntry | null>(null);

  // ── Workspace step (Phase C) ───────────────────────────────────────────────
  // The folder the login step browsed to — kept so the "keep the project in
  // $HOME and link the workspace in" layout can put it back as the remote root
  // after the workspace layout has pointed it elsewhere.
  const [browsedPath, setBrowsedPath] = useState("");
  const [wsInfo, setWsInfo] = useState<HpcWsInfo | null>(null);
  const [workspace, setWorkspace] = useState<HpcWorkspace | null>(null);
  const [layout, setLayout] = useState<WsLayout>("in-workspace");
  const [linkName, setLinkName] = useState("data");
  const [linkedAt, setLinkedAt] = useState("");
  // The home anchor: the small folder in the cluster `$HOME` that outlives the
  // workspace (logs + a `cd`-able link + the record naming it).
  const [anchorOn, setAnchorOn] = useState(true);
  const [anchorRel, setAnchorRel] = useState("");
  const [anchor, setAnchor] = useState<HpcAnchor | null>(null);
  // A cluster with no workspace tooling still has a big filesystem; this is the
  // one the host nominated and the user picked (null = the browsed folder).
  const [scratchRoot, setScratchRoot] = useState<ScratchCandidate | null>(null);

  // Force remote on for the whole wizard — an HPC project is remote by definition.
  useEffect(() => {
    if (!isRemoteProject) toggleRemoteProject(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seed the local roots from the backend defaults (mirror of ProjectDialog).
  useEffect(() => {
    invoke<string>("projects_root_dir").then(setProjectsRoot).catch(() => {});
    invoke<string>("remote_mirror_root_dir")
      .then((dir) => setMirrorParent((cur) => cur || dir.replace(/\/+$/, "")))
      .catch(() => {});
  }, []);

  const safeName = useMemo(
    () => name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, ""),
    [name],
  );

  // Commit the browsed remote folder and advance — mirrors ProjectDialog's
  // `useThisRemoteFolder`.
  const useThisFolder = () => {
    const chosen = remoteBrowsePath || "/";
    setRemoteChosenPath(chosen);
    setBrowsedPath(chosen);
    rememberChosenPath(chosen);
    setStep("project");
  };

  // The workspace layout decides the project's REMOTE ROOT — that single
  // assignment is the whole integration, because `buildRemoteSpec` derives the
  // host path from `remoteChosenPath` and every transport follows it from there.
  useEffect(() => {
    if (created) return; // the spec is already fixed once the project exists
    const root =
      layout === "in-workspace" && workspace
        ? workspace.path.replace(/\/+$/, "")
        : (scratchRoot?.path.replace(/\/+$/, "") ?? browsedPath);
    if (root) setRemoteChosenPath(root);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, workspace, scratchRoot, browsedPath, created]);

  // Probe the host for workspace tooling as soon as the login is live: the
  // Workspace step needs to know whether it has anything to offer *before* the
  // user gets there, and a cluster-less host skips it entirely.
  useEffect(() => {
    if (!isRemote || !remoteConn) return;
    let cancelled = false;
    void wsAvailable(wsTargetForHost(remoteConn, remotePassword))
      .then((info) => {
        if (!cancelled) setWsInfo(info);
      })
      .catch(() => {
        if (!cancelled) setWsInfo({ available: false, filesystems: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [isRemote, remoteConn, remotePassword]);

  const chooseMirror = async () => {
    const picked = await open({ directory: true, multiple: false, defaultPath: mirrorParent || undefined });
    if (typeof picked === "string") setMirrorParent(picked.replace(/\/+$/, ""));
  };

  const canCreate = Boolean(name.trim() && safeName && remoteChosenPath && mirrorParent.trim());

  const createProject = async () => {
    setError("");
    setBusy(true);
    try {
      const remoteSpec = buildRemoteSpec(safeName);
      const targetDir = projectsRoot ? `${projectsRoot}/${safeName}` : "";
      const project = await invoke<ProjectEntry>("create_project", {
        req: {
          name,
          directory: targetDir,
          description: "",
          gitType: "local",
          skipScaffold: false,
          remote: remoteSpec,
          mirrorParent,
        },
      });
      // Hand the just-authenticated credential to the project's first pooled
      // connect (single-use, never persisted — see stashRemotePassword).
      if (remotePassword) stashRemotePassword(project.id, remotePassword);
      // A login typed into the embedded terminal leaves no credential to stash, and
      // headless mode alone doesn't say so — mark it, or the credential-less first
      // connect is recorded as key auth on a password host.
      if (remote.sshTerm) stashRemoteViaLogin(project.id);
      rememberChosenPath();
      await addProject(project); // adds + activates (which connects)
      setCreated(project);
      // The "keep it in $HOME" layout still wants the workspace reachable from
      // the project — a symlink the host's own tools (job scripts, `cd`) follow.
      // Best-effort: a failed link must not undo a created project, so it only
      // reports.
      if (layout === "link" && workspace) {
        try {
          const at = await wsLink(resolveProjectDirectory(project), workspace.path, linkName);
          setLinkedAt(at);
        } catch (err) {
          setError(`Project created, but linking the workspace failed: ${String(err)}`);
        }
      }

      // The home anchor + the project's own record of its workspace. Both are
      // best-effort — neither can undo a created project — but the *record* is
      // what makes an expiry survivable at all (`ws_restore` is keyed by the
      // workspace name), so it is written even when the anchor is off.
      let made: HpcAnchor | null = null;
      const rel = anchorRel || defaultAnchorRel(safeName);
      if (anchorOn && remoteConn) {
        try {
          made = await wsAnchor(wsTargetForHost(remoteConn, remotePassword), {
            anchorRel: rel,
            // At a site with no workspace tooling the link points at the big
            // filesystem the host nominated instead — same purpose: a short,
            // memorable way back to where the data actually is.
            workspacePath: workspace?.path ?? scratchRoot?.path,
            workspaceId: workspace?.id,
            projectName: name.trim(),
            // The record names the machine+folder holding the durable copy, so
            // ask the created project rather than re-deriving the mirror path.
            mirrorPath: resolveLocalMirror(project) ?? undefined,
            makeLogs: true,
          });
          setAnchor(made);
        } catch (err) {
          setError(`Project created, but the home folder could not be set up: ${String(err)}`);
        }
      }
      if (workspace || scratchRoot || made) {
        const hpc = {
          // A site filesystem has no workspace *id* — recording one would send
          // Extend/expiry looking for an allocation that does not exist.
          workspace_id: workspace?.id,
          workspace_path: workspace?.path ?? scratchRoot?.path,
          filesystem: workspace?.filesystem,
          anchor_dir: made?.dir,
          anchor_rel: made ? rel : undefined,
          logs_dir: made?.logs_dir,
        };
        await setProjectHpc(project.id, hpc).catch(() => {});
        // Mirror it into the live entry too: the store was populated by
        // `addProject` before this record existed, and without this the expiry
        // banner and the log-dir fallback would only start working after a
        // relaunch re-read projects.json.
        useProjectsStore.setState((s) => ({
          projects: s.projects.map((p) => (p.id === project.id ? { ...p, hpc } : p)),
        }));
      }
      setStep("data");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="project-dialog dialog-framed hpc-wizard" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>
            {t("hpcWizard.title")} <UntestedTag id="hpcWizard.title" />
          </h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="dialog-scroll">
        <StepTrail step={step} />
        {error && <ErrorNote className="project-dialog-error" error={error} />}

        {step === "login" && (
          <>
            <p className="ssh-optional-hint">
              {t("hpcWizard.loginHint")}
            </p>
            <RemoteProjectSection
              kind="new"
              safeName={safeName}
              onClose={onClose}
              onUseThisFolder={useThisFolder}
              remote={remote}
            />
          </>
        )}

        {step === "project" && (
          <>
            <label>
              {t("hpcWizard.projectNameLabel")}
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-experiment"
              />
            </label>
            <label>
              {t("hpcWizard.mirrorLabel")}
              <div className="folder-picker-row">
                <span title={mirrorParent}>{mirrorParent || t("hpcWizard.noFolderSelected")}</span>
                <button type="button" onClick={chooseMirror}>{t("hpcWizard.browseBtn")}</button>
              </div>
              <span className="ssh-optional-hint">
                {t("hpcWizard.hostPathHintPre")} {browsedPath}/{safeName || "<name>"} {t("hpcWizard.hostPathHintPost")}
              </span>
            </label>
            <div className="project-dialog-actions">
              <button type="button" onClick={() => setStep("login")}>{t("common.back")}</button>
              <button
                type="button"
                disabled={!name.trim() || !safeName || !mirrorParent.trim()}
                onClick={() => setStep("workspace")}
              >
                {t("common.next")}
              </button>
            </div>
          </>
        )}

        {step === "workspace" && (
          <WorkspaceStep
            info={wsInfo}
            conn={remoteConn}
            password={remotePassword}
            safeName={safeName}
            browsedPath={browsedPath}
            workspace={workspace}
            setWorkspace={setWorkspace}
            layout={layout}
            setLayout={setLayout}
            linkName={linkName}
            setLinkName={setLinkName}
            anchorOn={anchorOn}
            setAnchorOn={setAnchorOn}
            anchorRel={anchorRel}
            setAnchorRel={setAnchorRel}
            scratchRoot={scratchRoot}
            setScratchRoot={setScratchRoot}
            busy={busy}
            canCreate={canCreate}
            onBack={() => setStep("project")}
            onCreate={() => void createProject()}
          />
        )}

        {step === "data" && created && (
          <DataStep
            project={created}
            workspace={workspace}
            layout={layout}
            linkName={linkName}
            linkedAt={linkedAt}
            onBack={() => setStep("workspace")}
            onNext={() => setStep("run")}
          />
        )}

        {step === "run" && created && (
          <RunStep
            project={created}
            logsDir={anchor?.logs_dir ?? ""}
            dataHint={
              workspace
                ? layout === "in-workspace"
                  ? `# This project lives in workspace '${workspace.id}' (${workspace.path}) —\n# its data is on the cluster's parallel filesystem, not in your home quota.`
                  : `# Bulk data: ./${linkName} → workspace '${workspace.id}' (${workspace.path}).`
                : ""
            }
            onBack={() => setStep("data")}
            onSubmitted={() => setStep("watch")}
          />
        )}

        {step === "watch" && (
          <>
            <p>
              {t("hpcWizard.watchPre")} <GearIcon /> {t("hpcWizard.watchMid")}{" "}
              <em>{t("hpcWizard.watchWatchWord")}</em> {t("hpcWizard.watchAnd")}{" "}
              <em>{t("hpcWizard.watchCancelWord")}</em>.
            </p>
            <div className="project-dialog-actions">
              <button type="button" onClick={onClose}>{t("hpcWizard.done")}</button>
            </div>
          </>
        )}
        </div>
      </div>
    </div>
  );
}

/** The step breadcrumb across the top of the wizard. */
function StepTrail({ step }: { step: Step }) {
  const t = useT();
  const steps: { id: Step; label: string }[] = [
    { id: "login", label: t("hpcWizard.stepLogin") },
    { id: "project", label: t("hpcWizard.stepProject") },
    { id: "workspace", label: t("hpcWizard.stepWorkspace") },
    { id: "data", label: t("hpcWizard.stepData") },
    { id: "run", label: t("hpcWizard.stepRun") },
    { id: "watch", label: t("hpcWizard.stepWatch") },
  ];
  const idx = steps.findIndex((s) => s.id === step);
  return (
    <div className="hpc-wizard-trail">
      {steps.map((s, i) => (
        <span
          key={s.id}
          className={`hpc-wizard-trail-step${i === idx ? " active" : ""}${i < idx ? " done" : ""}`}
        >
          {i + 1}. {s.label}
        </span>
      ))}
    </div>
  );
}

/**
 * Step 3 (Phase C): get a **workspace** before anything is created or uploaded.
 *
 * `$HOME` on a cluster is a small, quota'd, backed-up filesystem for code; the
 * data of a computation belongs on the parallel filesystem, which is handed out as
 * a time-limited workspace (`ws_allocate <name> <days>`). This step allocates one
 * (or adopts an existing one) and then decides where the project's tree goes:
 *
 *  - **in the workspace** (default) — the workspace path becomes the project's
 *    remote root, so uploads, byte-sync, git lockstep and every run tab already
 *    land on the parallel filesystem. Nothing else in Tabtivity changes.
 *  - **linked** — the project stays in the browsed folder and the workspace is
 *    symlinked in as `./<name>` for the host's own tools, with the caveat that
 *    Tabtivity's sync does not follow a symlink.
 *
 * The project is created *here*, at the end, because its remote root is what this
 * step decides. A host without the tooling shows a one-line note and the same
 * Create button, so there is exactly one creation path.
 */
function WorkspaceStep({
  info,
  conn,
  password,
  safeName,
  browsedPath,
  workspace,
  setWorkspace,
  layout,
  setLayout,
  linkName,
  setLinkName,
  anchorOn,
  setAnchorOn,
  anchorRel,
  setAnchorRel,
  scratchRoot,
  setScratchRoot,
  busy,
  canCreate,
  onBack,
  onCreate,
}: {
  info: HpcWsInfo | null;
  conn: { user?: string | null; host: string; port?: number | null } | null;
  password: string;
  safeName: string;
  browsedPath: string;
  workspace: HpcWorkspace | null;
  setWorkspace: (ws: HpcWorkspace | null) => void;
  layout: WsLayout;
  setLayout: (l: WsLayout) => void;
  linkName: string;
  setLinkName: (n: string) => void;
  anchorOn: boolean;
  setAnchorOn: (on: boolean) => void;
  anchorRel: string;
  setAnchorRel: (rel: string) => void;
  scratchRoot: ScratchCandidate | null;
  setScratchRoot: (c: ScratchCandidate | null) => void;
  busy: boolean;
  canCreate: boolean;
  onBack: () => void;
  onCreate: () => void;
}) {
  const t = useT();
  const [existing, setExisting] = useState<HpcWorkspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [wsError, setWsError] = useState("");
  const [allocating, setAllocating] = useState(false);
  const [wsName, setWsName] = useState(safeName);
  const [days, setDays] = useState("30");
  const [filesystem, setFilesystem] = useState("");
  const [mail, setMail] = useState("");
  const [reminder, setReminder] = useState("7");
  const [scratch, setScratch] = useState<ScratchCandidate[]>([]);

  const target = useMemo(
    () => (conn ? wsTargetForHost(conn, password) : null),
    [conn, password],
  );

  // A cluster with no workspace tooling still has a big filesystem — ask it where
  // (only then: at a workspace site the workspace *is* the answer).
  useEffect(() => {
    if (!target || info?.available !== false) return;
    let cancelled = false;
    void scratchCandidates(target)
      .then((list) => {
        if (!cancelled) setScratch(list);
      })
      .catch(() => {
        if (!cancelled) setScratch([]);
      });
    return () => {
      cancelled = true;
    };
  }, [target, info?.available]);

  // Where the project's tree will end up, in every branch below: the workspace
  // (when one is chosen and hosts the project), a site filesystem the host
  // nominated, or the browsed folder.
  const rootPath = workspace && layout === "in-workspace" ? workspace.path : scratchRoot?.path ?? browsedPath;
  const projectPath = `${rootPath.replace(/\/+$/, "")}/${safeName || "<name>"}`;

  // Default the workspace name to the project name, and the filesystem to
  // whichever one the site itself marked default (so the field states what
  // leaving `-F` out would do, rather than pretending there is no choice).
  useEffect(() => {
    setWsName((n) => n || safeName);
  }, [safeName]);
  useEffect(() => {
    setFilesystem((f) => f || defaultFilesystem(info) || "");
  }, [info]);

  // The user's existing workspaces — one may already be the right home for this
  // project (allocating a second one for the same data is the common mistake).
  useEffect(() => {
    if (!info?.available || !target) return;
    let cancelled = false;
    setLoading(true);
    void wsList(target)
      .then((list) => {
        if (!cancelled) setExisting(list);
      })
      .catch((err) => {
        if (!cancelled) setWsError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [info, target]);

  const allocate = async () => {
    if (!target) return;
    setWsError("");
    setAllocating(true);
    try {
      const ws = await wsAllocate(target, {
        id: wsName.trim(),
        days: Number(days) || 0,
        filesystem: filesystem.trim() || undefined,
        mail: mail.trim() || undefined,
        reminderDays: Number(reminder) || undefined,
      });
      setWorkspace(ws);
      setExisting((list) => [ws, ...list.filter((w) => w.id !== ws.id)]);
    } catch (err) {
      setWsError(String(err));
    } finally {
      setAllocating(false);
    }
  };

  // No workspace tooling on this host — which is the ordinary answer at any host
  // that isn't a cluster, AND at a cluster that simply uses a different
  // convention. The step still has to be answered in the second case: dropping
  // the project into the browsed folder means `$HOME`, the exact thing this step
  // exists to prevent. So ask the site where its big filesystem is
  // (`$SCRATCH`/`$WORK`/… as its own profile exports them) and offer those.
  if (info && !info.available) {
    return (
      <>
        <p className="ssh-optional-hint">
          {t("hpcWizard.noToolingPre")}<code>ws_allocate</code>{t("hpcWizard.noToolingPost")}
          {scratch.length > 0 ? (
            <>
              {" "}
              {t("hpcWizard.noToolingScratchHint")}
            </>
          ) : (
            <>
              {" "}
              {t("hpcWizard.noToolingNoScratchPre")}{" "}
              <code>
                {browsedPath}/{safeName || "<name>"}
              </code>
              .
            </>
          )}
        </p>
        {scratch.length > 0 && (
          <div className="hpc-ws-list">
            <label className="hpc-ws-row">
              <input
                type="radio"
                name="hpc-scratch"
                checked={!scratchRoot}
                onChange={() => setScratchRoot(null)}
              />
              <span className="hpc-ws-id">{t("hpcWizard.homeRadioLabel")}</span>
              <span className="hpc-ws-path" title={browsedPath}>{browsedPath}</span>
            </label>
            {scratch.map((c) => (
              <label key={c.path} className="hpc-ws-row">
                <input
                  type="radio"
                  name="hpc-scratch"
                  disabled={!c.writable}
                  checked={scratchRoot?.path === c.path}
                  onChange={() => setScratchRoot(c)}
                />
                <span className="hpc-ws-id">{c.label}</span>
                <span className="hpc-ws-path" title={c.path}>{c.path}</span>
                <span className="hpc-ws-remaining tone-ok">
                  {[c.writable ? "" : t("hpcWizard.readOnly"), freeSpaceLabel(c.free_kb)]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </label>
            ))}
          </div>
        )}
        <span className="ssh-optional-hint">
          {t("hpcWizard.projectOnHostLabel")} <code>{projectPath}</code>
        </span>
        <div className="project-dialog-actions">
          <button type="button" onClick={onBack}>{t("common.back")}</button>
          <button type="button" disabled={!canCreate || busy} onClick={onCreate}>
            {busy ? t("hpcWizard.creating") : t("hpcWizard.createProject")}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <p className="ssh-optional-hint">
        {t("hpcWizard.introPre")} <strong>{t("hpcWizard.introStrongWorkspace")}</strong>{" "}
        {t("hpcWizard.introMid")}{" "}
        <strong>{t("hpcWizard.introStrongDeleted")}</strong>
        {t("hpcWizard.introPost")}
      </p>
      {!info && <p className="ssh-optional-hint">{t("hpcWizard.checkingTooling")}</p>}
      {wsError && <ErrorNote className="project-dialog-error" error={wsError} />}

      {info?.available && (
        <>
          <div className="hpc-ws-form">
            <label className="slurm-directive-field">
              <span className="slurm-directive-key">{t("hpcWizard.workspaceNameLabel")}</span>
              <input
                className="file-viewer-run-args-input"
                value={wsName}
                spellCheck={false}
                onChange={(e) => setWsName(e.target.value)}
              />
            </label>
            <label className="slurm-directive-field">
              <span className="slurm-directive-key">{t("hpcWizard.daysLabel")}</span>
              <input
                className="file-viewer-run-args-input"
                value={days}
                inputMode="numeric"
                onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, ""))}
              />
            </label>
            <label className="slurm-directive-field">
              <span className="slurm-directive-key">{t("hpcWizard.filesystemLabel")}</span>
              {info.filesystems.length > 0 ? (
                <select value={filesystem} onChange={(e) => setFilesystem(e.target.value)}>
                  <option value="">{t("hpcWizard.siteDefault")}</option>
                  {info.filesystems.map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.name}
                      {f.default ? t("hpcWizard.defaultSuffix") : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="file-viewer-run-args-input"
                  value={filesystem}
                  spellCheck={false}
                  placeholder={t("hpcWizard.siteDefault")}
                  onChange={(e) => setFilesystem(e.target.value)}
                />
              )}
            </label>
            <label className="slurm-directive-field">
              <span className="slurm-directive-key">{t("hpcWizard.reminderEmailLabel")}</span>
              <input
                className="file-viewer-run-args-input"
                value={mail}
                spellCheck={false}
                placeholder={t("hpcWizard.optionalPlaceholder")}
                onChange={(e) => setMail(e.target.value)}
              />
            </label>
            <label className="slurm-directive-field">
              <span className="slurm-directive-key">{t("hpcWizard.remindDaysLabel")}</span>
              <input
                className="file-viewer-run-args-input"
                value={reminder}
                inputMode="numeric"
                onChange={(e) => setReminder(e.target.value.replace(/[^0-9]/g, ""))}
              />
            </label>
          </div>
          <span className="ssh-optional-hint">
            {t("hpcWizard.reminderHint")}
          </span>
          <div className="folder-picker-row">
            <button
              type="button"
              disabled={allocating || !wsName.trim() || !days}
              onClick={() => void allocate()}
            >
              {allocating ? t("hpcWizard.allocating") : t("hpcWizard.allocateWorkspace")}
            </button>
          </div>

          {loading && <p className="ssh-optional-hint">{t("hpcWizard.readingWorkspaces")}</p>}
          {existing.length > 0 && (
            <div className="hpc-ws-list">
              <div className="slurm-directive-key">{t("hpcWizard.yourWorkspaces")}</div>
              {existing.map((ws) => {
                const tone = expiryTone(ws);
                return (
                  <label key={`${ws.filesystem ?? ""}/${ws.id}`} className="hpc-ws-row">
                    <input
                      type="radio"
                      name="hpc-ws-pick"
                      checked={workspace?.id === ws.id && workspace?.path === ws.path}
                      onChange={() => setWorkspace(ws)}
                    />
                    <span className="hpc-ws-id">{ws.id}</span>
                    <span className="hpc-ws-path" title={ws.path}>{ws.path}</span>
                    {remainingLabel(ws) && (
                      <span className={`hpc-ws-remaining tone-${tone}`}>{remainingLabel(ws)}</span>
                    )}
                  </label>
                );
              })}
            </div>
          )}

          {workspace && (
            <div className="hpc-ws-layout">
              <div className="slurm-directive-key">{t("hpcWizard.whereProjectGoes")}</div>
              <label className="hpc-ws-row">
                <input
                  type="radio"
                  name="hpc-ws-layout"
                  checked={layout === "in-workspace"}
                  onChange={() => setLayout("in-workspace")}
                />
                <span>
                  <strong>{t("hpcWizard.inWorkspaceStrong")}</strong> {t("hpcWizard.inWorkspaceDesc")}
                </span>
              </label>
              <label className="hpc-ws-row">
                <input
                  type="radio"
                  name="hpc-ws-layout"
                  checked={layout === "link"}
                  onChange={() => setLayout("link")}
                />
                <span>
                  <strong>{t("hpcWizard.inBrowsedStrong")}</strong>{t("hpcWizard.inBrowsedDesc")}{" "}
                  <code>./{linkName || "data"}</code>. {t(linkedWorkspaceCaveat)}
                </span>
              </label>
              {layout === "link" && (
                <label className="slurm-directive-field">
                  <span className="slurm-directive-key">{t("hpcWizard.linkNameLabel")}</span>
                  <input
                    className="file-viewer-run-args-input"
                    value={linkName}
                    spellCheck={false}
                    onChange={(e) => setLinkName(e.target.value.replace(/[^A-Za-z0-9._-]/g, ""))}
                  />
                </label>
              )}
            </div>
          )}
        </>
      )}

      {/* The home anchor. Offered whether or not a workspace was chosen, because
          the *record* it appends is what makes an expiry recoverable — the
          tooling's restore path is keyed by the workspace name, and by then the
          directory that carried it is gone. */}
      <div className="hpc-ws-layout">
        <label className="hpc-ws-row">
          <input
            type="checkbox"
            checked={anchorOn}
            onChange={(e) => setAnchorOn(e.target.checked)}
          />
          <span>
            {t("hpcWizard.anchorPre")}{" "}
            <code>logs/</code>{t("hpcWizard.anchorMid")} <code>workspace</code>{" "}
            {t("hpcWizard.anchorPost")}
          </span>
        </label>
        {anchorOn && (
          <label className="slurm-directive-field">
            <span className="slurm-directive-key">{t("hpcWizard.anchorFolderLabel")}</span>
            <input
              className="file-viewer-run-args-input"
              value={anchorRel || defaultAnchorRel(safeName)}
              spellCheck={false}
              onChange={(e) => setAnchorRel(e.target.value.replace(/[^A-Za-z0-9._/-]/g, ""))}
            />
          </label>
        )}
      </div>

      <span className="ssh-optional-hint">
        {t("hpcWizard.projectOnHostLabel")} <code>{projectPath}</code>
      </span>
      <div className="project-dialog-actions">
        <button type="button" onClick={onBack}>{t("common.back")}</button>
        <button type="button" disabled={!canCreate || busy} onClick={onCreate}>
          {busy ? t("hpcWizard.creating") : workspace ? t("hpcWizard.createProject") : t("hpcWizard.createWithoutWorkspace")}
        </button>
      </div>
    </>
  );
}

/** Step 4: upload local files to the host over the pooled SFTP. Skippable.
 *  Uploads land in the project's remote root — which, after the Workspace step,
 *  is the workspace itself — or through the workspace symlink in the linked
 *  layout, so a "Load data" click never fills the user's home quota. */
function DataStep({
  project,
  workspace,
  layout,
  linkName,
  linkedAt,
  onBack,
  onNext,
}: {
  project: ProjectEntry;
  workspace: HpcWorkspace | null;
  layout: WsLayout;
  linkName: string;
  linkedAt: string;
  onBack: () => void;
  onNext: () => void;
}) {
  const t = useT();
  const [uploaded, setUploaded] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Where an uploaded file lands. In the linked layout the workspace is reachable
  // only *through* the symlink, so the destination is prefixed with it — SFTP
  // follows the link on the host, which is the whole point of having made it.
  const destPrefix = workspace && layout === "link" && linkedAt ? `${linkName}/` : "";
  const destLabel = workspace
    ? layout === "in-workspace"
      ? workspace.path
      : linkedAt || `${linkName}${t("hpcWizard.linkNotCreatedSuffix")}`
    : (project.remote?.remote_path ?? t("hpcWizard.theProjectFolder"));

  const addFiles = async () => {
    setError("");
    const picked = await open({ multiple: true, directory: false });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length === 0) return;
    setBusy(true);
    try {
      for (const p of paths) {
        const name = basename(p);
        await invoke("remote_upload_file", {
          projectId: project.id,
          localPath: p,
          destRel: `${destPrefix}${name}`,
        });
        setUploaded((u) => [...u, `${destPrefix}${name}`]);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="ssh-optional-hint">
        {t("hpcWizard.dataHintPre")} <code>{destLabel}</code>
        {workspace ? ` ${t("hpcWizard.dataHintWorkspaceSuffix")}` : t("hpcWizard.dataHintPlainSuffix")}{" "}
        {t("hpcWizard.dataHintPost")}
      </p>
      {error && <ErrorNote className="project-dialog-error" error={error} />}
      <div className="folder-picker-row">
        <button type="button" disabled={busy} onClick={() => void addFiles()}>
          {busy ? t("hpcWizard.uploading") : t("hpcWizard.addFiles")}
        </button>
      </div>
      {uploaded.length > 0 && (
        <ul className="hpc-wizard-uploaded">
          {uploaded.map((f) => (
            <li key={f}>✓ {f}</li>
          ))}
        </ul>
      )}
      <div className="project-dialog-actions">
        <button type="button" onClick={onBack}>{t("common.back")}</button>
        <button type="button" onClick={onNext}>
          {uploaded.length ? t("common.next") : t("hpcWizard.skip")}
        </button>
      </div>
    </>
  );
}

/** Step 5: edit a starter `.slurm`'s directives, write it to the host, submit.
 *  `dataHint` is a comment naming the workspace the data lives in — the job
 *  script is where the user will look for it next. */
function RunStep({
  project,
  logsDir,
  dataHint,
  onBack,
  onSubmitted,
}: {
  project: ProjectEntry;
  logsDir: string;
  dataHint: string;
  onBack: () => void;
  onSubmitted: () => void;
}) {
  const t = useT();
  // Two edits to the starter, both made once at mount: the workspace comment, and
  // — when a home anchor exists — `--output` routed into it, so the log outlives
  // the workspace the job ran in. The `--output` edit goes through
  // `spliceDirective` for the same reason every other directive edit does: it
  // rewrites that one line and leaves the rest of the script byte-identical.
  const [script, setScript] = useState(() => {
    let s = dataHint
      ? STARTER_SLURM.replace("\n# Runs on a compute node", `\n${dataHint}\n# Runs on a compute node`)
      : STARTER_SLURM;
    if (logsDir) s = spliceDirective(s, "output", logOutputPattern(logsDir));
    return s;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fields = useMemo(() => parseSbatchDirectives(script), [script]);
  const [edits, setEdits] = useState<Record<string, string>>({});

  const remoteRoot = project.remote?.remote_path ?? "";
  const scriptPath = `${remoteRoot.replace(/\/+$/, "")}/${STARTER_NAME}`;
  const projectDir = resolveProjectDirectory(project);

  const valueFor = (key: string) => edits[key] ?? directiveValue(fields, key);
  const commit = (key: string) => {
    const v = edits[key];
    if (v === undefined) return;
    setScript((s) => spliceDirective(s, key, v));
  };

  const submit = async () => {
    setError("");
    setBusy(true);
    try {
      // Write the (possibly edited) script to the host, then submit it.
      await writeFileText(scriptPath, script, project.id);
      await submitSlurmJob({
        file: scriptPath,
        projectDir,
        cwd: projectDir,
        projectId: project.id,
        scope: project.id,
        isRemote: true,
      });
      onSubmitted();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="ssh-optional-hint">
        {t("hpcWizard.scriptHintPre")}<code>{STARTER_NAME}</code>{t("hpcWizard.scriptHintPost")}
      </p>
      {error && <ErrorNote className="project-dialog-error" error={error} />}
      <div className="slurm-directive-grid">
        {COMMON_SBATCH_KEYS.map((key) => (
          <label key={key} className="slurm-directive-field">
            <span className="slurm-directive-key">{SBATCH_LABEL_KEYS[key] ? t(SBATCH_LABEL_KEYS[key]) : key}</span>
            <input
              className="file-viewer-run-args-input"
              value={valueFor(key)}
              spellCheck={false}
              onChange={(e) => setEdits((m) => ({ ...m, [key]: e.target.value }))}
              onBlur={() => commit(key)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit(key);
                }
              }}
            />
          </label>
        ))}
      </div>
      <div className="project-dialog-actions">
        <button type="button" onClick={onBack}>{t("common.back")}</button>
        <button type="button" disabled={busy} onClick={() => void submit()}>
          {busy ? t("hpcWizard.submitting") : <><UploadIcon /> {t("hpcWizard.submitJob")}</>}
        </button>
      </div>
    </>
  );
}
