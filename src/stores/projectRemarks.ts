import { create } from "zustand";
import { fileMtime, readFileText, writeFileText } from "../components/embed/fileAccess";
import { translateNow } from "../lib/i18n";
import { resolvePath } from "../lib/paths";
import {
  REMARKS_FILE, REMARKS_TEMPLATE, addRemark as addRemarkText,
  editRemarkText, parseRemarks, remarkCountsByFile, removeRemark,
  setRemarkDone, type ProjectRemark,
} from "../lib/projects/projectRemarks";

export interface ProjectRemarksEntry {
  remarks: ProjectRemark[];
  countsByFile: Record<string, number>;
  fileMissing: Record<string, boolean>;
  mtime: number | null;
  loading: boolean;
  error: string | null;
}

interface ProjectRemarksStore {
  byProject: Record<string, ProjectRemarksEntry>;
  load(projectId: string, projectDir: string): Promise<void>;
  refreshIfStale(projectId: string, projectDir: string): Promise<void>;
  add(projectId: string, projectDir: string, file: string, line: number | null, text: string): Promise<void>;
  setDone(projectId: string, projectDir: string, remark: ProjectRemark, done: boolean): Promise<void>;
  edit(projectId: string, projectDir: string, remark: ProjectRemark, text: string): Promise<void>;
  remove(projectId: string, projectDir: string, remark: ProjectRemark): Promise<void>;
  setFileMissing(projectId: string, missing: Record<string, boolean>): void;
}

const empty = (): ProjectRemarksEntry => ({
  remarks: [], countsByFile: {}, fileMissing: {}, mtime: null, loading: false, error: null,
});
const remarksPath = (dir: string) => resolvePath(dir, REMARKS_FILE);

export const useProjectRemarksStore = create<ProjectRemarksStore>((set, get) => {
  const commit = (projectId: string, src: string, mtime: number | null) => set((state) => ({
    byProject: {
      ...state.byProject,
      [projectId]: {
        ...(state.byProject[projectId] ?? empty()),
        remarks: parseRemarks(src),
        countsByFile: remarkCountsByFile(parseRemarks(src)),
        mtime, loading: false, error: null,
      },
    },
  }));
  const fail = (projectId: string, error: unknown) => set((state) => ({
    byProject: {
      ...state.byProject,
      [projectId]: { ...(state.byProject[projectId] ?? empty()), loading: false, error: String(error) },
    },
  }));
  const loadFresh = async (projectId: string, projectDir: string) => {
    const path = remarksPath(projectDir);
    const src = await readFileText(path, projectId);
    const mtime = await fileMtime(path, projectId).catch(() => null);
    commit(projectId, src, mtime);
  };
  const mutate = async (
    projectId: string,
    projectDir: string,
    change: (src: string) => string | null,
    create = false,
  ) => {
    const path = remarksPath(projectDir);
    try {
      let src: string;
      try { src = await readFileText(path, projectId); }
      catch (error) { if (!create) throw error; src = REMARKS_TEMPLATE; }
      const next = change(src);
      if (next == null) {
        await loadFresh(projectId, projectDir);
        throw new Error(translateNow("projectRemarks.reloadedStale"));
      }
      await writeFileText(path, next, projectId);
      commit(projectId, next, await fileMtime(path, projectId).catch(() => null));
    } catch (error) { fail(projectId, error); throw error; }
  };
  return {
    byProject: {},
    load: async (projectId, projectDir) => {
      set((state) => ({ byProject: { ...state.byProject, [projectId]: {
        ...(state.byProject[projectId] ?? empty()), loading: true, error: null,
      } } }));
      try { await loadFresh(projectId, projectDir); }
      catch (error) {
        // Missing REMARKS.md is a normal pre-repair state; show an empty view.
        commit(projectId, "", null);
        if (!/not found|no such|does not exist/i.test(String(error))) fail(projectId, error);
      }
    },
    refreshIfStale: async (projectId, projectDir) => {
      const current = get().byProject[projectId];
      if (!current) return get().load(projectId, projectDir);
      try {
        const next = await fileMtime(remarksPath(projectDir), projectId);
        if (current.mtime !== next) await loadFresh(projectId, projectDir);
      } catch { if (current.mtime !== null) await get().load(projectId, projectDir); }
    },
    add: (id, dir, file, line, text) => mutate(id, dir, (src) => addRemarkText(src, file, line, text), true),
    setDone: (id, dir, remark, done) => mutate(id, dir, (src) => setRemarkDone(src, remark, done)),
    edit: (id, dir, remark, text) => mutate(id, dir, (src) => editRemarkText(src, remark, text)),
    remove: (id, dir, remark) => mutate(id, dir, (src) => removeRemark(src, remark)),
    setFileMissing: (projectId, fileMissing) => set((state) => ({ byProject: {
      ...state.byProject,
      [projectId]: { ...(state.byProject[projectId] ?? empty()), fileMissing },
    } })),
  };
});
