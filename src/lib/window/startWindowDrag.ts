import { getCurrentWindow } from "@tauri-apps/api/window";
import { PLATFORM } from "./dragPlatform";
import { trackWindowMove } from "../../stores/drag/windowMove";

/** Hand the pressed pointer to the OS window-move loop. Shared by the header's
 *  empty-bar drag and the logo chip, which starts it once the press travels. */
export function startWindowDrag() {
  // Windows: hide the heavy terminal panes for the duration of the OS move loop
  // so WebView2 only composites the cheap frame and keeps up with the cursor
  // (otherwise the canvases lag/swim behind the dragged window). Other engines
  // drag the live content smoothly, so they skip the hide.
  if (PLATFORM === "windows") trackWindowMove();
  getCurrentWindow().startDragging().catch(() => {});
}
