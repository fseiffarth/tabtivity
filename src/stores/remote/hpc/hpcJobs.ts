import { create } from "zustand";

/**
 * The jobs this Tabtivity session submitted, per project — so the Jobs view can show
 * a freshly-submitted job (and re-open its log) *before* the next `squeue` poll
 * catches up, and can resolve a job id back to the output file it should tail.
 *
 * `squeue` on the host is the source of truth for what is actually queued/running
 * (`slurm_queue`); this store is only the small local memory of "what did *I* just
 * launch, and where does its log live". It is purely in-memory: a relaunch forgets
 * it, and the next `squeue` poll re-lists whatever is still real. No persistence —
 * the out-file paths are re-derivable from `scontrol` and a stale path helps nobody.
 */
export interface HpcJob {
  jobId: string;
  name: string;
  /** Absolute path to the job's stdout on the host — what a Watch tab tails. */
  outFile: string;
  /** Host id the job runs on (`"primary"` or a worker id). */
  host: string;
  /** Submit time, ms since epoch (local clock — display only). */
  submittedAt: number;
}

interface HpcJobsStore {
  /** projectId → jobs submitted this session, newest first. */
  byProject: Record<string, HpcJob[]>;
  /** Record a just-submitted job (deduped by jobId+host, newest kept). */
  add: (projectId: string, job: HpcJob) => void;
  /** Forget a job (e.g. after a successful cancel). */
  remove: (projectId: string, jobId: string, host: string) => void;
}

export const useHpcJobsStore = create<HpcJobsStore>((set) => ({
  byProject: {},
  add: (projectId, job) =>
    set((s) => {
      const prev = s.byProject[projectId] ?? [];
      const deduped = prev.filter((j) => !(j.jobId === job.jobId && j.host === job.host));
      return { byProject: { ...s.byProject, [projectId]: [job, ...deduped] } };
    }),
  remove: (projectId, jobId, host) =>
    set((s) => {
      const prev = s.byProject[projectId] ?? [];
      return {
        byProject: {
          ...s.byProject,
          [projectId]: prev.filter((j) => !(j.jobId === jobId && j.host === host)),
        },
      };
    }),
}));
