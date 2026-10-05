import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { applyWorkspacePatch, type WorkspacePatch } from "../../stores/tabs";

/**
 * The desktop's ear for the workspace service (headless owner plan, H1b):
 * `workspace:patch` fires when a client of this backend moved a scope's
 * shared tab set; `applyWorkspacePatch` re-fetches the snapshot when it is
 * newer than what this window knows and reconciles the store. Renders
 * nothing. Mounted once, at the shell. A write from the Mobile sidecar is
 * another process and reaches a window at its next sync or hydrate instead.
 */
export function WorkspacePatchHost() {
  useEffect(() => {
    let disposed = false;
    const unlisten = listen<WorkspacePatch>("workspace:patch", (event) => {
      if (disposed) return;
      void applyWorkspacePatch(event.payload);
    });
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop());
    };
  }, []);
  return null;
}
