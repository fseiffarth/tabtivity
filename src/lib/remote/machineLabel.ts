/** A global machine's SSH target as one string: `user@host:port`, each part only
 *  when set. Its own module so the Extend-to-remote dialog can name a machine
 *  without importing the (lazily split) Machines menu, perf plan §6. */
export function targetLabel(m: { user?: string; host: string; port?: number }): string {
  return `${m.user ? `${m.user}@` : ""}${m.host}${m.port ? `:${m.port}` : ""}`;
}
