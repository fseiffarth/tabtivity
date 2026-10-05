/**
 * **When may "connect on launch" be armed?** — one formula, four surfaces.
 *
 * There were four spellings of it (`useRemoteReconnect`, `ProjectPill`, the
 * Connect modal's non-headless branch, the Machines menu) and they disagreed on
 * the part that matters: a host tagged **HPC** is one Tabtivity promises never to
 * dial by itself (`lib/remote/hpc/hpcHost.ts` — `stores/projects` refuses the connect at the
 * gate). The Machines menu said so and disabled the switch; the project surfaces
 * left it live, so the user armed a toggle that was guaranteed to do nothing and
 * had no way to find out.
 *
 * The other half is the older rule, unchanged: auto-connect **never prompts**, so
 * it is only offered when the connect can complete without one — a saved password
 * or a host recorded as key/agent auth. With `connections_headless` **off** there
 * is no keychain to qualify against at all: "auto-connect" there means this same
 * login opening in the root terminal for the user to answer, which needs no
 * stored credential (the substitution `autoConnectInteractive` makes, and the one
 * the header's "Connect on launch" already makes for a tunnel).
 *
 * `reason` is what the surface *says*: an ineligible switch must explain which of
 * the two walls it hit, because they have completely different remedies (save a
 * password vs. untag the machine).
 */
export type AutoConnectBlock = "hpc" | "noCredential";

export interface AutoConnectEligibility {
  /** The switch may be armed. */
  eligible: boolean;
  /** Why not, when it may not. `null` when it may. */
  reason: AutoConnectBlock | null;
}

export function autoConnectEligibility(opts: {
  /** `connections_headless` — off means Tabtivity handles no passwords at all. */
  headless: boolean;
  /** The backend recorded key/agent auth on this host's last connect. */
  keyAuth: boolean;
  /** A password is *known* to be in the keychain. An unreadable store must pass
   *  `false`: an auto-connect that can't read its credential can't be silent, so
   *  "we don't know" has to read as "not yet" here — the same direction
   *  `mayAutoTouch` fails in. */
  savedPassword: boolean;
  /** This host is tagged as a shared cluster login node. */
  hpc: boolean;
}): AutoConnectEligibility {
  // The tag outranks everything: it is a statement about the machine, not about
  // what Tabtivity happens to have in its keychain for it.
  if (opts.hpc) return { eligible: false, reason: "hpc" };
  if (!opts.headless || opts.keyAuth || opts.savedPassword) {
    return { eligible: true, reason: null };
  }
  return { eligible: false, reason: "noCredential" };
}
