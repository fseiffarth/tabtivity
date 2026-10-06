# Help MCP

A read-only MCP server, `tabtivity-help`,
answering questions about Tabtivity from its user docs (`docs/help/*.md`), handed
to every **local** agent tab. On by default (`Settings::help_mcp`, absent = on).

Why it is shaped this way:

- **Compiled in, not read at runtime.** `build.rs` embeds `docs/help/*.md`
  with `include_str!`. Nothing in a project folder is trusted, and the docs a
  tab is told are the docs its binary shipped with. Editing `docs/help/` means
  a backend rebuild; `real_corpus_parses` fails `cargo test` on a malformed file.
- **Its own caller class and route.** `Caller::Helper` on `POST /mcp/help`,
  behind the same listener checks as `/mcp` (loopback Host, no Origin, bearer
  token, rate limit, bounded body). The four tools are in the security
  registry as served to that class alone; that class is served nothing else.
- **A lane beside the others.** A tab can hold a help token and a root, reader
  or schedule token at once; `register_token` replaces per lane. Help sessions
  are hidden from MCP session access, cannot be re-granted, and do not keep a
  tab's review sandbox alive.
- **Not audited per call.** Every tab may ask; doc lookups would flood the
  500-row audit ring and push root-tool records out. Admission failures are
  still audited.
- **Wired like schedule.** Claude (`--mcp-config`) and Codex (`-c
  mcp_servers.…`) on their own command line; tool-tagged Vibe local models via
  env, merged after the root/schedule wiring; other CLIs the env pair only.
  Never another app's config file.
- **Local only.** Remote, worker, VM and container tabs are not wired: their
  loopback is not Tabtivity's, and a tunnel would expose the listener. The VM
  `guestfwd` address stays `Reader`-only.
- **`tabtivity_help_status` leaks nothing**: compile-time constants and OS/arch.
- **Headless tabs too.** A tab the Mobile host starts with no window gets the
  server from the host's own listener (`docs/headless_mcp_plan.md`).

Frontend hooks: `root_mcp_status.help` (`enabled`, `wiredClis`, `topics`) and
the Tauri commands `help_search`, `help_read`, `help_topics` (camelCase).
