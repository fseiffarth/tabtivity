import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LEGACY_NAMES, NAMES } from "./brand";

/** The app's own folders inside a project. */
export type GeneratedDirKind = "screenshots" | "emails";

const CURRENT: Record<GeneratedDirKind, string> = {
  screenshots: NAMES.screenshotsDir,
  emails: NAMES.emailsDir,
};

const LEGACY: Record<GeneratedDirKind, string> = {
  screenshots: LEGACY_NAMES.screenshotsDir,
  emails: LEGACY_NAMES.emailsDir,
};

/**
 * The name the app's `kind` folder goes by in the project at `projectDir`: a
 * project that already has the folder under the app's old name keeps it, so it
 * never grows a second one (backend `project_generated_dir`). While the name
 * is unchanged there is nothing to ask; a backend that cannot answer (an older
 * one still running, a project with no directory) gives the current name.
 */
export async function generatedDirName(projectDir: string, kind: GeneratedDirKind): Promise<string> {
  const current = CURRENT[kind];
  if (!projectDir || LEGACY[kind] === current) return current;
  try {
    return await invoke<string>("project_generated_dir", { projectDir, kind });
  } catch {
    return current;
  }
}

/** [`generatedDirName`] as state: the current name until the answer is in. */
export function useGeneratedDirName(projectDir: string, kind: GeneratedDirKind): string {
  const [name, setName] = useState(CURRENT[kind]);
  useEffect(() => {
    let cancelled = false;
    setName(CURRENT[kind]);
    void generatedDirName(projectDir, kind).then((found) => {
      if (!cancelled) setName(found);
    });
    return () => {
      cancelled = true;
    };
  }, [projectDir, kind]);
  return name;
}
