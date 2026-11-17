import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IS_HOST_WINDOWS } from "./platform";

/**
 * Whether the host has a usable tmux (2442r): persistent local terminals and
 * phone terminals run in it, and a Mac ships without. `null` while unknown,
 * and always `null` on a Windows host (no tmux there by design) or when the
 * backend cannot answer — the caller says nothing then. Asked again whenever
 * the window regains focus, so an install finished in a terminal shows.
 */
export function useTmuxAvailable(): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    if (IS_HOST_WINDOWS) return;
    let alive = true;
    const probe = () => {
      invoke<boolean>("local_tmux_available")
        .then((answer) => {
          if (alive && typeof answer === "boolean") setAvailable(answer);
        })
        .catch(() => {});
    };
    probe();
    window.addEventListener("focus", probe);
    return () => {
      alive = false;
      window.removeEventListener("focus", probe);
    };
  }, []);
  return available;
}
