/**
 * The browser entry (hosted plan §7.1): the same app as `main.tsx`, reached
 * over a WebSocket instead of Tauri's IPC. Built by `vite.web.config.ts` into
 * `web-dist/`, served by the Mobile sidecar at `/desktop/`.
 *
 * Order matters: the transport is installed and the server's `hello` awaited
 * BEFORE `bootstrap.tsx` is imported, so every `@tauri-apps/api` import finds
 * the shim and `lib/platform.ts` finds the host's OS. `hardenPrototype()` runs
 * right before the app, as in `main.tsx`.
 */
import "./lib/brandMigrationBoot";
import { hardenPrototype } from "./lib/hardenPrototype";
import { installWebTransport } from "./lib/transport/installWeb";

const transport = installWebTransport();

void transport.ready
  .then(() => import("./web/WebShell"))
  .then((shell) => {
    shell.mountWebShell(transport.client);
    hardenPrototype();
    return import("./bootstrap");
  });
