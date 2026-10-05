/**
 * Imported first by the desktop's and the phone's entry modules, for its
 * side effect: the localStorage keys an older build wrote move to their
 * current names before any store reads them. Does nothing while the app's
 * name is unchanged (`migrateStorageKeys` returns before touching the
 * storage).
 */
import { migrateStorageKeys } from "./brandMigration";

try {
  if (typeof localStorage !== "undefined") migrateStorageKeys(localStorage);
} catch {
  // Storage unavailable (a private window, a blocked site): nothing to move.
}
