/**
 * Shared projects (hosted plan §6.2–§6.6, P4): share one of your git
 * projects with other users of the server as viewer or editor, see who is
 * a member and who has it open, push your branch; and the projects shared
 * with you — add one (a clone of your own), fetch it, push your branch
 * under your name if you are an editor. A share that is revoked or deleted
 * stays a greyed row: your copy is never deleted.
 *
 * Every call is a `share_*` command of your own daemon, which asks the share
 * hub; the hub decides who may do what by your account. Rendered nothing
 * outside the hosted server's browser client.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import { isServerClient } from "../../lib/transport/linkState";
import { useProjectsStore } from "../../stores/projects";
import { UntestedTag } from "../common/UntestedTag";
import { Dropdown } from "../common/Dropdown";
import { SettingsCard } from "../layout/settingsUi";

interface Member {
  user: string;
  role: "viewer" | "editor";
  since: number;
}

interface ShareRow {
  id: string;
  name: string;
  owner: string;
  role: "owner" | "editor" | "viewer";
  state: "active" | "revoked" | "deleted";
  members: Member[];
  presence: { user: string; since: number }[];
  projectId: string | null;
  /** Agent-facing files from others not yet reviewed (§6.5 gate 2). */
  pendingReview?: string[];
}

interface Review {
  commit: string;
  paths: string[];
  text: string;
  truncated: boolean;
  digest: string;
}

interface Overview {
  me: string;
  rows: ShareRow[];
}

interface BranchState {
  name: string;
  ahead: number;
  behind: number;
}

export function ServerSharing() {
  const t = useT();
  const projects = useProjectsStore((s) => s.projects);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [pick, setPick] = useState("");
  const [drafts, setDrafts] = useState<Record<string, { user: string; role: string }>>({});
  const [branches, setBranches] = useState<Record<string, BranchState[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const refresh = () =>
    invoke<Overview>("share_list")
      .then((o) => setOverview(o))
      .catch(() => setOverview(null));

  useEffect(() => {
    if (isServerClient()) void refresh();
  }, []);

  if (!overview) return null;

  const run = async (key: string, job: () => Promise<string | null>) => {
    setBusy(key);
    setStatus(null);
    try {
      setStatus(await job());
      await refresh();
    } catch (e) {
      setStatus(t("server.settings.error", { error: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const mine = overview.rows.filter((r) => r.role === "owner" && r.state === "active");
  const incoming = overview.rows.filter((r) => r.role !== "owner" || r.state !== "active");
  const sharedProjects = new Set(overview.rows.map((r) => r.projectId).filter(Boolean));
  const shareable = projects.filter((p) => !sharedProjects.has(p.id));
  const roleLabel = (role: string) => t(`server.sharing.role.${role === "owner" || role === "editor" ? role : "viewer"}` as const);

  const pushed = (p: { branch: string; unchanged: boolean }) =>
    p.unchanged ? t("server.sharing.unchanged") : t("server.sharing.pushed", { branch: p.branch.replace(/^refs\/heads\//, "") });

  const tools = (row: ShareRow) =>
    row.projectId ? (
      <ShareTools
        projectId={row.projectId}
        pending={row.pendingReview ?? []}
        branches={branches[row.id] ?? []}
        disabled={busy !== null}
        run={(job) => run(`tools-${row.id}`, job)}
        onBranches={(report) => setBranches((b) => ({ ...b, [row.id]: report }))}
      />
    ) : null;

  return (
    <>
      <div className="settings-subheader">
        {t("server.sharing.header")} <UntestedTag id="server.sharing" />
      </div>
      <p className="settings-help">{t("server.sharing.help")}</p>
      <div className="settings-link-row">
        <Dropdown
          ariaLabel={t("server.sharing.pickProject")}
          placeholder={t("server.sharing.pickProject")}
          value={pick}
          disabled={busy !== null}
          options={shareable.map((p) => ({ value: p.id, label: p.name }))}
          onChange={setPick}
        />
        <button
          type="button"
          className="settings-btn sm"
          disabled={busy !== null || !pick}
          onClick={() =>
            void run("create", async () => {
              await invoke("share_create", { projectId: pick });
              setPick("");
              return t("server.sharing.created");
            })
          }
        >
          {t("server.sharing.share")}
        </button>
      </div>
      {overview.rows.length === 0 && <p className="settings-help">{t("server.sharing.none")}</p>}
      {mine.map((row) => {
        const draft = drafts[row.id] ?? { user: "", role: "viewer" };
        return (
          <SettingsCard key={row.id}>
            <div className="settings-card-label">
              {row.name} · {roleLabel("owner")}
            </div>
            <p className="settings-help">
              {row.members.length
                ? t("server.sharing.members", { members: row.members.map((m) => `${m.user} (${roleLabel(m.role)})`).join(", ") })
                : t("server.sharing.noMembers")}
              {row.presence.length > 0 && ` · ${t("server.sharing.here", { users: row.presence.map((p) => p.user).join(", ") })}`}
            </p>
            <div className="settings-link-row">
              {row.members.map((m) => (
                <button
                  key={m.user}
                  type="button"
                  className="settings-btn sm"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(`revoke-${row.id}`, async () => {
                      await invoke("share_revoke", { share: row.id, user: m.user });
                      return t("server.sharing.done");
                    })
                  }
                >
                  {t("server.sharing.revoke", { user: m.user })}
                </button>
              ))}
            </div>
            <div className="settings-link-row">
              <input
                className="ollama-pull-input"
                aria-label={t("server.sharing.userPlaceholder")}
                placeholder={t("server.sharing.userPlaceholder")}
                value={draft.user}
                disabled={busy !== null}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setDrafts((d) => ({ ...d, [row.id]: { ...draft, user: e.target.value.trim() } }))}
              />
              <Dropdown
                ariaLabel={t("server.sharing.roleLabel")}
                value={draft.role}
                disabled={busy !== null}
                options={["viewer", "editor"].map((r) => ({ value: r, label: roleLabel(r) }))}
                onChange={(role) => setDrafts((d) => ({ ...d, [row.id]: { ...draft, role } }))}
              />
              <button
                type="button"
                className="settings-btn sm"
                disabled={busy !== null || !draft.user}
                onClick={() =>
                  void run(`grant-${row.id}`, async () => {
                    await invoke("share_grant", { share: row.id, user: draft.user, role: draft.role });
                    setDrafts((d) => ({ ...d, [row.id]: { user: "", role: "viewer" } }));
                    return t("server.sharing.done");
                  })
                }
              >
                {t("server.sharing.grant")}
              </button>
            </div>
            {tools(row)}
            <div className="settings-link-row">
              {row.projectId && (
                <button
                  type="button"
                  className="settings-btn sm"
                  disabled={busy !== null}
                  onClick={() => void run(`push-${row.id}`, async () => pushed(await invoke("share_push", { projectId: row.projectId })))}
                >
                  {t("server.sharing.push")}
                </button>
              )}
              <button
                type="button"
                className="settings-btn sm"
                disabled={busy !== null}
                onClick={() =>
                  void run(`delete-${row.id}`, async () => {
                    await invoke("share_delete", { share: row.id });
                    return t("server.sharing.stopped");
                  })
                }
              >
                {t("server.sharing.stop")}
              </button>
            </div>
          </SettingsCard>
        );
      })}
      {incoming.length > 0 && <div className="settings-card-label">{t("server.sharing.incoming")}</div>}
      {incoming.map((row) => {
        const gone = row.state !== "active";
        return (
          <SettingsCard key={row.id}>
            <div className="settings-card-label" style={gone ? { opacity: 0.6 } : undefined}>
              {row.name} · {t("server.sharing.by", { owner: row.owner, role: roleLabel(row.role) })}
            </div>
            {gone && <p className="settings-help">{t(row.state === "deleted" ? "server.sharing.deleted" : "server.sharing.revoked")}</p>}
            {!gone && row.presence.length > 0 && (
              <p className="settings-help">{t("server.sharing.here", { users: row.presence.map((p) => p.user).join(", ") })}</p>
            )}
            {!gone && tools(row)}
            {!gone && (
              <div className="settings-link-row">
                {!row.projectId && (
                  <button
                    type="button"
                    className="settings-btn sm"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(`add-${row.id}`, async () => {
                        await invoke("share_add", { share: row.id });
                        await useProjectsStore.getState().load();
                        return t("server.sharing.added");
                      })
                    }
                  >
                    {t("server.sharing.add")}
                  </button>
                )}
                {row.projectId && row.role === "editor" && (
                  <button
                    type="button"
                    className="settings-btn sm"
                    disabled={busy !== null}
                    onClick={() => void run(`push-${row.id}`, async () => pushed(await invoke("share_push", { projectId: row.projectId })))}
                  >
                    {t("server.sharing.push")}
                  </button>
                )}
              </div>
            )}
          </SettingsCard>
        );
      })}
      {status && <p className="settings-help">{status}</p>}
    </>
  );
}

/**
 * A shared project's own tools (§6.3, §6.5 gate 2): Fetch and its branch
 * report, a merge of a hub branch — shown for review first when it changes
 * agent-facing files, and bound to what was shown — and the review of
 * agent instructions already in the project from others (a fresh clone, a
 * merge made in a terminal), without which no agent starts there.
 */
function ShareTools({
  projectId,
  pending,
  branches,
  disabled,
  run,
  onBranches,
}: {
  projectId: string;
  pending: string[];
  branches: BranchState[];
  disabled: boolean;
  run: (job: () => Promise<string | null>) => Promise<void>;
  onBranches: (report: BranchState[]) => void;
}) {
  const t = useT();
  const [review, setReview] = useState<{ kind: "pending" | "merge"; branch?: string; review: Review } | null>(null);

  const merge = (branch: string, digest: string | null) =>
    run(async () => {
      await invoke("share_merge", { projectId, branch, digest });
      setReview(null);
      onBranches(await invoke<BranchState[]>("share_fetch", { projectId }));
      return t("server.sharing.merged");
    });

  return (
    <>
      {pending.length > 0 && (
        <p className="settings-help">
          <UntestedTag id="server.sharing.review" /> {t("server.sharing.pending", { paths: pending.join(", ") })}
        </p>
      )}
      {branches.map((b) => (
        <div key={b.name} className="settings-link-row">
          <span className="settings-help">{t("server.sharing.branch", { name: b.name, ahead: b.ahead, behind: b.behind })}</span>
          {b.ahead > 0 && (
            <button
              type="button"
              className="settings-btn sm"
              disabled={disabled}
              onClick={() =>
                void run(async () => {
                  const r = await invoke<Review>("share_review", { projectId, branch: b.name });
                  if (r.paths.length === 0) {
                    await merge(b.name, null);
                    return null;
                  }
                  setReview({ kind: "merge", branch: b.name, review: r });
                  return null;
                })
              }
            >
              {t("server.sharing.merge", { branch: b.name })}
            </button>
          )}
        </div>
      ))}
      {review && (
        <SettingsCard>
          <p className="settings-help">
            {t(review.kind === "merge" ? "server.sharing.reviewMerge" : "server.sharing.reviewPending", { paths: review.review.paths.join(", ") })}
          </p>
          <pre className="settings-prompt-text" style={{ maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap" }}>
            {review.review.text}
            {review.review.truncated ? "\n…" : ""}
          </pre>
          <div className="settings-link-row">
            <button
              type="button"
              className="settings-btn sm"
              disabled={disabled}
              onClick={() =>
                review.kind === "merge" && review.branch
                  ? void merge(review.branch, review.review.digest)
                  : void run(async () => {
                      await invoke("share_accept", { projectId, digest: review.review.digest });
                      setReview(null);
                      return t("server.sharing.reviewed");
                    })
              }
            >
              {t(review.kind === "merge" ? "server.sharing.confirmMerge" : "server.sharing.accept")}
            </button>
            <button type="button" className="settings-btn sm" disabled={disabled} onClick={() => setReview(null)}>
              {t("common.cancel")}
            </button>
          </div>
        </SettingsCard>
      )}
      <div className="settings-link-row">
        <button
          type="button"
          className="settings-btn sm"
          disabled={disabled}
          onClick={() =>
            void run(async () => {
              onBranches(await invoke<BranchState[]>("share_fetch", { projectId }));
              return null;
            })
          }
        >
          {t("server.sharing.fetch")}
        </button>
        {pending.length > 0 && (
          <button
            type="button"
            className="settings-btn sm"
            disabled={disabled}
            onClick={() =>
              void run(async () => {
                const r = await invoke<Review | null>("share_pending", { projectId });
                if (r) setReview({ kind: "pending", review: r });
                return null;
              })
            }
          >
            {t("server.sharing.review")}
          </button>
        )}
      </div>
    </>
  );
}

/** How often an open shared project's presence is re-reported (the hub
 * forgets a report after ten minutes). */
const PRESENCE_EVERY_MS = 4 * 60 * 1000;

/**
 * Report the active project's presence to its co-members (§6.4): open on
 * activation, closed on leaving it, refreshed while it stays open. A
 * project that is not a share is ignored by the daemon. Mounted once by the
 * browser client's shell.
 */
export function SharePresence() {
  const activeId = useProjectsStore((s) => s.activeId);
  useEffect(() => {
    if (!activeId || !isServerClient()) return;
    const report = (open: boolean) => void invoke("share_presence", { projectId: activeId, open }).catch(() => {});
    report(true);
    const timer = window.setInterval(() => report(true), PRESENCE_EVERY_MS);
    return () => {
      window.clearInterval(timer);
      report(false);
    };
  }, [activeId]);
  return null;
}
