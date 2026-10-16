/**
 * Browser stand-ins for `client`-class backend commands (hosted plan §3.3,
 * §7.1): the commands that act on the machine the user sits at — which, in a
 * browser, is the browser. What the browser can do itself is done here; the
 * rest answers `{code:"client"}` and the UI shows the control was not for this
 * machine (`server_capabilities` already hides most of them).
 *
 * Deliberately short. A row is added when a feature needs it, with the
 * backend command's own argument names; nothing here reaches the server.
 */
import type { WsClient } from "./wsClient";

type Args = Record<string, unknown>;

async function openContentUrl(client: WsClient, path: string, download: boolean): Promise<void> {
  const ticket = (await client.call("desktop_file_ticket", { path, download })) as { url: string };
  const opened = window.open(ticket.url, "_blank", "noopener");
  if (!opened && !download) throw new Error("the browser blocked the new tab");
}

/**
 * Answer `cmd` in the browser, or `undefined` when it has no browser form.
 * Rejections are the command's own errors, as on the desktop.
 */
export function adaptClientCommand(client: WsClient, cmd: string, args: Args): Promise<unknown> | undefined {
  switch (cmd) {
    // Clipboard: the browser's, which a secure context (https or loopback) allows.
    case "copy_text_to_clipboard":
      return navigator.clipboard.writeText(String(args.text ?? ""));
    case "clipboard_has_image":
      return Promise.resolve(false);
    // The browser's files are not the server's: nothing to paste into a project.
    case "clipboard_file_paths":
      return Promise.resolve([]);
    // Open outside / reveal: a download or a new tab on the user-content origin.
    case "open_file":
      // The desktop's launcher check (gap 21) has nothing to judge here: the
      // browser downloads or shows the file itself. The ask still runs.
      if (args.checkOnly) return Promise.resolve(null);
      return openContentUrl(client, String(args.path ?? ""), false);
    case "open_in_file_manager":
      return Promise.reject(new Error("open_in_file_manager: the server's folders cannot be shown in this browser"));
    case "open_external_url": {
      const url = String(args.url ?? "");
      if (!/^https?:\/\//.test(url)) return Promise.reject(new Error("refusing to open a non-web URL"));
      window.open(url, "_blank", "noopener");
      return Promise.resolve();
    }
    // A project switch's window half has nothing to do in a browser; its
    // backend half (name migration, layout save, session load, the
    // `project-runtime-switched` event) runs on the server.
    case "switch_project_runtime":
      return client.call("switch_project_session", args);
    // The desktop's own state: nothing to save, nothing to show.
    case "save_window_state":
      return Promise.resolve();
    case "os_clock_format":
      return Promise.resolve(null);
    case "desktop_owns_super_key":
      // A browser never gets the Super key.
      return Promise.resolve(true);
    case "get_power_state":
      return Promise.resolve(null);
    case "list_recent_downloads":
      // Recent Downloads are the device's own; the browser cannot list its
      // folder, so the section hides (user decision 2026-10-03).
      return Promise.resolve([]);
    case "detach_subwindow":
    case "attach_subwindow":
    case "focus_detached_window":
    case "snap_detached_window":
    case "sync_detached_scope":
    case "detached_retire_ack":
    case "detached_retire_ready":
    case "detached_window_frontmost":
    case "detached_window_is_parked":
      return Promise.resolve(null);
    case "get_opened_windows":
    case "list_tracked_windows":
      return Promise.resolve([]);
    case "workspace_capabilities":
      return Promise.resolve({});
    case "webview_renderer_claim":
    case "webview_renderer_memory":
    case "webview_renderer_rss":
    case "webview_rss_kib":
    case "debug_app_resource_usage":
      return Promise.resolve(null);
    default:
      return undefined;
  }
}

/**
 * The window plugin (`plugin:window|*`, `plugin:webview|*`), answered for the
 * one window a browser page is. Geometry comes from the viewport; the
 * desktop's maximize/minimize/decorations have no meaning and resolve.
 * Answers and argument keys are what `@tauri-apps/api`'s `window.js` and
 * `webview.js` read and send (sizes `{width, height}`, positions `{x, y}`,
 * setters' `value`); `WebTransport.test.ts` drives the installed ones.
 */
export function adaptWindowCommand(command: string, args: Args): Promise<unknown> {
  switch (command) {
    case "get_all_windows":
    case "get_all_webviews":
      return Promise.resolve(["main"]);
    case "scale_factor":
      return Promise.resolve(window.devicePixelRatio || 1);
    case "inner_size":
    case "outer_size":
      return Promise.resolve({ width: Math.round(window.innerWidth * (window.devicePixelRatio || 1)), height: Math.round(window.innerHeight * (window.devicePixelRatio || 1)) });
    case "inner_position":
    case "outer_position":
      return Promise.resolve({ x: 0, y: 0 });
    case "current_monitor":
    case "primary_monitor":
    case "monitor_from_point":
      return Promise.resolve(null);
    case "available_monitors":
      return Promise.resolve([]);
    case "is_fullscreen":
      return Promise.resolve(document.fullscreenElement !== null);
    case "is_maximized":
      return Promise.resolve(true);
    case "is_minimized":
    case "is_always_on_top":
      return Promise.resolve(false);
    case "is_focused":
      return Promise.resolve(document.hasFocus());
    case "is_visible":
    case "is_decorated":
    case "is_resizable":
    case "is_maximizable":
    case "is_minimizable":
    case "is_closable":
    case "is_enabled":
      return Promise.resolve(true);
    case "title":
      return Promise.resolve(document.title);
    case "set_title":
      document.title = String(args.value ?? document.title);
      return Promise.resolve();
    case "theme":
      return Promise.resolve(window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    case "set_fullscreen":
      if (args.value) return document.documentElement.requestFullscreen?.().catch(() => undefined) ?? Promise.resolve();
      return document.fullscreenElement ? document.exitFullscreen().catch(() => undefined) : Promise.resolve();
    case "set_webview_zoom":
      // The desktop zooms the whole webview; a page zooms its root.
      document.documentElement.style.setProperty("zoom", String(Number(args.value ?? 1)));
      return Promise.resolve();
    default:
      // maximize, minimize, show, hide, set_size, set_position, center,
      // set_focus, close, destroy, start_dragging, …: not a page's to do.
      return Promise.resolve();
  }
}
