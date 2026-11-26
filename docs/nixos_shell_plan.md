# Tabtivity as an OS: a NixOS image that boots into it

> **Status (2026-11-24):** IDEA, not scheduled. Step 1 (NixOS path handling)
> is DONE in `7c7b01671`; never run on NixOS. Steps 2–4 NOT-STARTED.

Decision the user made when this was written: **not now as a product.** Make
Tabtivity work on a normal NixOS desktop (step 1), and come back to the kiosk
or OS image once the desktop app has run stably for a while.

---

## 1. The idea

Keep Linux as the base and make Tabtivity the only thing on screen: a login
session that starts it full-screen, shipped as an image you can install. The
user's question started from "Nyx OS"; that name covers several hobby kernels
(nyx-os/Gaia, Intuex/Nyx-Os) with none of what Tabtivity needs (WebKitGTK,
Linux namespaces for the bubblewrap fence, tmux, git, ssh, Podman, Ollama, GPU
drivers). Porting means writing a Linux-compatible OS first. Ruled out.

NixOS fits because the whole system is one declarative config: Tabtivity,
everything it depends on and the kiosk session in one module, built into an
installer ISO or a VM image, with rollback from the boot menu after a bad
update.

## 2. Why not now

- **Stability.** In a kiosk session a crash takes the whole desktop, not one
  window. Silent SIGKILL deaths, the webview freeze (Mesa SIGBUS) and heap
  corruption are still open.
- **Scope.** An OS owns Wi-Fi, Bluetooth, suspend, displays, sound, printing,
  updates and hardware quirks; users still want a browser and an office suite,
  so a desktop gets rebuilt around Tabtivity.
- **Focus.** Many features are not yet live-tested and Windows/macOS support
  is unfinished; this would be a fourth platform that Tabtivity owns outright.

## 3. Steps

1. **NixOS path handling — DONE (`7c7b01671`).** NixOS keeps programs under
   `/run/wrappers/bin` (setuid wrappers: the only `pkexec` that elevates) and
   `/run/current-system/sw/bin`; `/usr/bin` holds only `env`.
   - `paths::system_executable` also looks in both, wrappers first
     (`SYSTEM_BIN_DIRS`). The root-owned check is unchanged; `~/.nix-profile`
     and `/etc/profiles/per-user` stay out (the user's choice, not root's).
   - The agent fence binds `/run/current-system` back read-only under its
     private `/run` (`bwrap_args`), so fenced agents find `bash`, `git` and
     nix-ld's loader. The store was already readable through `/`.
   - Copilot resolves `bwrap` through `system_executable`.
   - The bubblewrap install pill offers nothing on NixOS, on purpose: there
     installing means editing the system config, not running a command.
2. **Package.** A `flake.nix` that builds Tabtivity (Rust + npm, WebKitGTK
   4.1, `wrapGAppsHook`), and a NixOS module that enables what it needs:
   bubblewrap, tmux, git, OpenVPN, polkit, Podman, Ollama with GPU drivers,
   PipeWire for voice, and `programs.nix-ld` — the one-click installers fetch
   ready-made Linux binaries (agent CLIs, Piper voices) that NixOS cannot run
   without it.
3. **Kiosk image.** `services.cage` running Tabtivity as the only full-screen
   app, plus a `nix build` target for an installer ISO; try it in a VM first.
4. **Settings an OS needs.** Wi-Fi, Bluetooth, displays, sound and power inside
   Tabtivity, through system services (NetworkManager, BlueZ, PipeWire,
   logind) — never by editing another app's config files.

## 4. Open problems

- **Copilot on NixOS.** Its fence (`fence_args` in
  `src-tauri/src/services/copilot/process.rs`) is deliberately narrower than
  the agent fence and mounts only `/usr`, `/lib*`, `/bin` and a few `/etc`
  files. On NixOS the language server's loader and libraries live in
  `/nix/store` (through `/run/current-system` and `/etc/static`), so it still
  cannot start. Mounting the store fixes it but widens what Copilot reads:
  people sometimes put secrets in the store through their system config. The
  user's call.
- **GPU in the fence.** `/run/opengl-driver` is still hidden under the
  fence's `/run`; nothing fenced needs the GPU today.
- **Verification.** None of step 1 has run on NixOS. To check: in an agent
  tab, `which git`; connect a VPN; start Copilot (expected to fail until the
  store question is settled).

## 5. A better first use: the server image

The hosted plan (`docs/server.md`) runs `tabtivity-server` on a VM. A NixOS
image for that VM is reproducible and rolls back after a bad update, which
matters more on a server than on a desktop. Worth weighing once the hosted
plan reaches deployment.
