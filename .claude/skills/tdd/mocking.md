# When to mock

Adapted from mattpocock/skills `tdd/mocking.md` (MIT).

Mock at **system boundaries** only. In this repo those are:

- the Tauri bridge: `vi.mock("@tauri-apps/api/core", …)` recording `invoke`
  calls, and event subscriptions (`subscribeTauri`/`useTauriListener`);
- time and randomness (`vi.useFakeTimers`, a seeded RNG);
- the filesystem on the Rust side — prefer a real `tempfile::tempdir()` over a
  mock; build paths with `Path::join`;
- network, git remotes, SSH hosts, agent CLIs: a stub process or a recorded
  fixture, never the real service.

Don't mock your own modules, stores or services: test through them.

## Designing for mockability

- **Inject the boundary.** Take the directory, clock or client as an argument
  (`fn list_installed_at(dir: &Path)` beside `list_installed(target)`), so a
  test drives the real logic against a tempdir.
- **One function per operation** at a boundary (`installSkill`,
  `uninstallSkill`, …) rather than one generic fetcher, so each mock returns
  one shape and the test shows which commands it exercises.
