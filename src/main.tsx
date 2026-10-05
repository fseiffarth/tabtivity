/**
 * Thin entry. In dev, the perf monitor must be fully installed before the app
 * module graph (react, react-dom, the stores) is pulled in — react-scan's
 * fiber hook has to exist when react-dom evaluates, and the IPC tracer wants
 * to see the first invokes — so the real entry (`bootstrap.tsx`) is imported
 * only after `installDevPerf()` settles. In production the dev branch is
 * compiled out (`import.meta.env.DEV` is statically false) and bootstrap
 * loads immediately; `src/dev/` never ships.
 *
 * `hardenPrototype()` runs before bootstrap in both branches, so no app or
 * library code ever sees a mutable `Object.prototype` (#159).
 */
// First: storage keys an older build wrote move to their current names
// before any store reads them (a no-op while the app's name is unchanged).
import "./lib/brandMigrationBoot";
import { hardenPrototype } from "./lib/hardenPrototype";

if (import.meta.env.DEV) {
  void import("./dev/perfMonitor")
    .then((m) => m.installDevPerf())
    .catch(() => undefined)
    .then(() => {
      hardenPrototype();
      return import("./bootstrap");
    });
} else {
  hardenPrototype();
  void import("./bootstrap");
}
