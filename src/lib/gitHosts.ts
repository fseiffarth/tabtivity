/**
 * Settings → Git Hosting's host list: one profile URL and one default access
 * token per hosting service (`get_git_hosts` / `set_git_hosts`,
 * `services::git_hosting` in the backend). Tokens live only in the OS keyring;
 * the renderer learns only whether one is stored (`has_token`).
 *
 * One module-level cache, shared by every subscriber, so a save in Settings
 * reaches an open project dialog without a refetch of its own.
 */
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { GitProvider } from "../types";

/** A listed host, as the backend reports it. */
export interface GitHostEntry {
  profile_url: string;
  /** `scheme://host[:port]`: what the token is offered to. */
  origin: string;
  has_token: boolean;
}

/** One row as it is saved: `token` set = store it, `clearToken` = remove the
 *  stored one, neither = keep whatever is stored. */
export interface GitHostEdit {
  profileUrl: string;
  token?: string;
  clearToken?: boolean;
}

/** Hosts the list takes (`git_hosting::MAX_HOSTS`). */
export const MAX_GIT_HOSTS = 8;

let cache: GitHostEntry[] | null = null;
const listeners = new Set<(hosts: GitHostEntry[]) => void>();

function publish(hosts: GitHostEntry[]): GitHostEntry[] {
  cache = hosts;
  for (const listener of listeners) listener(hosts);
  return hosts;
}

export async function loadGitHosts(): Promise<GitHostEntry[]> {
  const hosts = await invoke<GitHostEntry[]>("get_git_hosts");
  return publish(Array.isArray(hosts) ? hosts : []);
}

export async function saveGitHosts(hosts: GitHostEdit[]): Promise<GitHostEntry[]> {
  const saved = await invoke<GitHostEntry[]>("set_git_hosts", { hosts });
  return publish(Array.isArray(saved) ? saved : []);
}

/** The host list, `null` until the first answer. */
export function useGitHosts(): GitHostEntry[] | null {
  const [hosts, setHosts] = useState<GitHostEntry[] | null>(cache);
  useEffect(() => {
    listeners.add(setHosts);
    if (cache === null) void loadGitHosts().catch(() => publish([]));
    return () => {
      listeners.delete(setHosts);
    };
  }, []);
  return hosts;
}

/** Which provider a profile URL belongs to: GitLab when it says so, else GitHub
 *  (a self-hosted GitLab names itself in its host far more often than not). */
export function hostProvider(profileUrl: string): GitProvider {
  return profileUrl.toLowerCase().includes("gitlab") ? "gitlab" : "github";
}

/** Whether a default token is stored for a host of `provider`. */
export function hasTokenFor(hosts: GitHostEntry[] | null, provider: GitProvider): boolean {
  return (hosts ?? []).some((h) => h.has_token && hostProvider(h.profile_url) === provider);
}
