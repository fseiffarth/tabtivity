/**
 * The desktop app's Connect window (hosted plan §7.2, P5): this binary's own
 * frontend, reached over the server's desktop socket — bridged through this
 * app's backend (`commands::connect`) — with `client` commands answered on
 * this machine. Loaded by `main.tsx` for `?connect=1`; the same order as
 * `main-web.tsx`: transport and the server's `hello` before the app.
 */
import { hardenPrototype } from "./lib/hardenPrototype";
import { installConnectTransport } from "./lib/transport/installWeb";

const transport = installConnectTransport();

void transport.ready
  .then(() => import("./web/WebShell"))
  .then((shell) => {
    shell.mountWebShell(transport.client);
    hardenPrototype();
    return import("./bootstrap");
  });
