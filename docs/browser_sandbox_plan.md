# Containerised Live Pages — Plan

> **Scope: this replaces the live-page window and nothing else.** Reader mode
> (`browser_reader_fetch` → `mail_sanitize` → `sandbox=""` frame) is untouched
> and remains the default surface. Everything here is about the *other* half of
> `docs/browser_plan_b.md`: the surface that runs real JavaScript.
>
> Verification gates: `npx tsc --noEmit`, `npx vitest run`, and
> `cargo test --manifest-path src-tauri/Cargo.toml`. **Never launch Tabtivity** —
> a second instance corrupts workspace state. Nothing in this document can be
> proven by an agent; every behavioural claim is a manual-QA item.

---

## 0. Verdict

**Better than the committed live window: yes.** The two findings the security
audit could not close are closed here by *topology* rather than by policy, which
is the only kind of fix that survives an app-code refactor:

| Finding | Today | Containerised |
|---|---|---|
| A live page reaches a loopback service by any hostname resolving there (audit B‑1a) | Unfixable — WebKit resolves after the synchronous `on_navigation` callback | **Gone.** `127.0.0.1` inside a network namespace is the container's own loopback. Ollama/Jupyter/Vite are not on it. |
| `ws://` reaches loopback regardless of the scheme allowlist (audit B‑2) | Unfixable — a WebSocket is not a navigation, and WebSocket has no CORS | **Gone**, same reason. Nothing to allowlist. |
| Tauri injects `__TAURI_INTERNALS__` into every webview | Mitigated by the ACL origin gate | **Gone.** It is a browser binary, not a Tauri webview. No bridge exists to reject. |
| VPN pivot | Traffic follows host routes like every process | **Explicit.** The container gets the routes it is given; a tunnel is opt-in, not inherited. |
| Renderer unsandboxed on Linux (wry never enables bubblewrap) | Unfixable from app code | A real browser ships its own sandbox, *plus* the container. |
| Autoplay cannot be disabled | Unfixable — wry defaults it on, Tauri never plumbs it | A real browser has a preference for it. |

**Not better, and explicitly not claimed:** this is Linux-only, slower, and a
large amount of new machinery. It does not make reader mode safer, because
reader mode does not have these problems.

**The alternative that beats both for most cases** — stated here so it is
rejected deliberately rather than by omission — is *reader mode plus the user's
real browser*, which is already what `browser_link_target` defaults to. Firefox
has their password manager, their extensions, their profile and its own sandbox.
Build this only if live pages **inside the workspace** are worth the cost: tab
context, per-project session isolation, and #53 (drag a tab into an upload
field). If that answer is "not really", the correct action is to delete
`browser_open_live` and keep the reader, not to build this.

---

## 1. The display channel is the whole design

The filesystem is the easy gate — Tabtivity already quarantines downloads, strips
exec bits, sniffs MIME, and requires a native save dialog. **The hard crossing is
pixels out and input in.** Everything else follows from how that is answered.

| Option | Isolation | Verdict |
|---|---|---|
| Bind-mount the host X11 socket | **Broken.** X11 has no client isolation: a client can read keystrokes destined for every other window and screenshot the whole session. A container with `/tmp/.X11-unix` is not sandboxed in any sense that matters. | **Reject outright.** This is the option that looks like it works and does not. |
| Bind-mount the host Wayland socket | Good — Wayland clients cannot snoop other clients' input or surfaces | Viable **only** on a Wayland session; Tabtivity supports X11 too (`platform/x11.rs`). Not a universal answer. |
| Nested display server (Xephyr on X11, `cage`/wlroots on Wayland) | Good — the container sees only a display server that contains itself | **Adopt.** Works on both session types with one abstraction, and the nested server's own window *is* the visible window. |
| Headless + stream (VNC/WebRTC into the webview) | Complete — pixels out, events in, no socket shared at all | **Reject for v1.** DMABUF is off app-wide (`project_webkit_paint_perf`), so decoding a video stream inside a software-rendered WebKitGTK is the worst possible place to put it. Keep as the answer for *remote* hosts later. |
| Full VM (microVM/Qubes-style) | Strongest | Out of proportion to a desktop workspace app. |

### 1.1 A correction that shapes v1

An earlier draft of this plan assumed Tabtivity could reparent the nested server's
window into a pane, because `embed/EmbedPane.tsx` exists. **It cannot.**
`EmbedPane` is Phase 1 of Group K #40: it opens the file in an external app and
renders a placeholder. Its own doc comment says the X11-reparent path "is Phase
2", and Phase 2 is unbuilt.

This is good news for scoping. **The committed live page is already a separate
OS window**, so a containerised live page in a separate OS window is the *same
UX*, not a downgrade — and it needs no reparenting, no codec, and no dependency
on unbuilt work. In-pane embedding becomes a later enhancement that rides Group K
#40 Phase 2 whenever that lands, rather than a precondition.

**Decision: v1 is a container whose nested display server's window is a normal
top-level window**, positioned and tracked with the existing external-window
machinery in `platform/x11.rs` / `commands::apps`.

---

## 2. Architecture

### 2.1 What already exists and must be reused

`services/sandbox.rs` is the precedent and most of the machinery. From its own
source: `docker_create_args` already emits `--security-opt no-new-privileges`,
`--cap-drop ALL`, `--pids-limit`, `--memory`, `--cpus`, and **`--network`** (its
doc already names `none`). It has an idempotent `up()`, a spec fingerprint that
detects a stale container, `down_for_project`, `down_all` at exit, and
`sweep_orphans` at startup.

**Do not write a second container manager.** The browser container is a second
*spec* handed to that machinery, not a parallel implementation. Where the shapes
genuinely differ (one per *browser session* rather than one per project; a
display socket; no identical-path project mount) the difference belongs in the
spec, and any refactor of `sandbox.rs` to admit a second caller should be its
own commit, landed and green before any browser code.

### 2.2 Container spec

```
docker run -d
  --name tabtivity-browser-<session>
  --network <netns>          # see §2.3 — NEVER the default bridge without thought
  --cap-drop ALL --security-opt no-new-privileges
  --pids-limit … --memory … --cpus …
  --user <uid>:<gid>
  --read-only                # writable layers are explicit tmpfs, see below
  --tmpfs /tmp --tmpfs /run
  --shm-size=…               # a real browser needs this; too small = silent renderer crashes
  -v <nested-display-socket>:<…>:ro
  -v <state_dir>/browser/quarantine:/downloads:rw    # THE gate
  <image>
```

Two things deliberately absent: `/dev/dri` (GPU passthrough re-opens a driver
attack surface and the host is already software-rendering) and any bind mount of
a project directory. **A browser must never see the project tree** — a page that
reaches it can read source and, worse, write into a tree that byte-sync or git
lockstep will replicate to a remote host.

### 2.3 The network, which is the actual point

- **Default `--network` gives the container the Docker bridge**, from which the
  host is reachable at the gateway address. That is *not* isolation, and getting
  this wrong silently reproduces exactly the hole this plan exists to close.
  A dedicated network with host access denied, or `--network none` plus an
  explicit egress proxy, is required. **Whichever is chosen, the acceptance test
  is the same and it is not optional: from inside the container, the host's
  loopback services must be unreachable by IP *and* by any hostname that
  resolves to them.**
- DNS: the container's resolver must not be the host's stub resolver if that
  stub answers for `.local`/internal names.
- VPN: a tunnel is opt-in per session, never inherited. If a user wants the
  browser inside the tunnel, that is a deliberate route added to the container,
  surfaced in the UI, and it re-opens the pivot by choice.

### 2.4 The two gates

**Downloads — the designed gate.** `/downloads` is the only writable bind mount.
The existing pipeline applies unchanged: quarantine → exec bits stripped →
`infer` + `mime_guess` sniff → consent dialog → native save dialog raised from
Rust → the user picks the one path in the system. `browser_download_decide`
still returns a display name, never a path. The container never learns where the
file went.

**Clipboard — the gate people forget.** If the nested server shares a clipboard
with the host session, it is a bidirectional channel that bypasses everything
above: a page reads whatever the user last copied (tokens, passwords, source) and
can plant content into it. v1 must **isolate the clipboard by default** and, if
sharing is offered at all, make it an explicit per-direction opt-in. A design
that mounts a downloads folder and then leaves the clipboard wide open has not
closed the boundary; it has moved it.

### 2.5 Lifecycle

One container per **browser session**, not per project (a browser is not
project-scoped; see `browser_plan_b.md`). Ephemeral by construction: no
persistent profile volume, so quitting *is* the delete — the same bargain
`incognito(true)` strikes today. Teardown on window close, `down_all` at app
exit, `sweep_orphans` at startup, all inherited from `sandbox.rs`. A liveness
guard so closing one window does not kill a session another window is using.

---

## 3. Phases

Each is individually committable, with acceptance criteria checkable by
`cargo test` / `tsc` / `vitest` alone. **Anything requiring a running Tabtivity or a
running container is manual QA, listed in §5, and cannot be signed off by an
agent.**

**Phase 0 — decide the display abstraction.** Pure Rust: a `DisplayServer` trait
with `Xephyr` and `Cage` implementations behind session detection, plus argv
builders. Acceptance: argv builders unit-tested for both, session detection
tested against fixture env, no container involved.

**Phase 1 — `sandbox.rs` admits a second caller.** Refactor only; no browser
code. Acceptance: every existing sandbox test still passes unchanged, and a new
test builds a browser-shaped spec through the same path.

**Phase 2 — the container spec and its argv.** Acceptance: `docker_create_args`
for the browser spec is unit-tested to contain the network flag, the read-only
root, the single rw mount, and **not** to contain `/dev/dri`, a project mount, or
a host X11 socket. This last is a tripwire: assert the *absence* of
`/tmp/.X11-unix` in the argv, so the broken-but-easy option cannot be
reintroduced quietly.

**Phase 3 — lifecycle + window tracking.** Up/down/sweep wired to the existing
machinery; the nested server's window registered with the external-window
tracker so it can be positioned, parked on project switch, and closed with the
session.

**Phase 4 — the gates.** Downloads re-pointed at the bind mount (the existing
consent path is reused, not rewritten). Clipboard isolation, with a test that
fails if a clipboard-sharing flag appears in the argv without an explicit
setting behind it.

**Phase 5 — swap `browser_open_live`.** The command keeps its contract
(`LiveWindowRef`, the same events) and changes its implementation. The
`browser_live_pages` opt-in stays, because a container is a mitigation and not a
proof. Its help text changes to state what is now true.

---

## 4. Rejected

- **Host X11 socket passthrough.** §1. Looks like a sandbox, is not one.
- **Streaming into the webview for v1.** §1 — wrong place to decode video given
  DMABUF is off. Revisit for remote hosts, where it is the *only* option.
- **GPU passthrough.** Re-opens a driver attack surface for a workload the host
  already renders in software.
- **In-pane embedding as a precondition.** §1.1 — depends on unbuilt Group K #40
  Phase 2, and buys nothing over a separate window that the committed design
  does not already have.
- **Keeping the current in-process live window as a fallback.** Two live-page
  implementations means the weaker one is what ships when the container is
  unavailable, which is precisely when the user is least protected. If Docker is
  absent, live pages are **unavailable** and reader mode is offered — the same
  call `services::sandbox` already makes on Windows.
- **Doing nothing / external browser only.** §0. Genuinely competitive; the
  right choice unless in-workspace live browsing is specifically wanted.

---

## 5. What no agent can verify

Every item below needs a human, a running Tabtivity, and a running container.

1. **The network claim, which is the whole plan.** From inside the container:
   every host loopback service unreachable by IP; unreachable by a hostname that
   resolves to loopback (a public wildcard resolver is the test case); the Docker
   gateway address unreachable; a VPN-side host unreachable unless the tunnel was
   explicitly requested.
2. Clipboard: copy a secret on the host, confirm a page in the container cannot
   read it; confirm a page cannot plant content into the host clipboard.
3. Downloads: the container can write only to `/downloads`; nothing reaches disk
   before consent; cancel leaves quarantine empty; the container never learns the
   saved path.
4. No project tree is visible from inside the container.
5. The container dies with the window, with the app, and is swept after a
   `kill -9`.
6. Usability at all: scrolling, video, and typing latency through the nested
   server on a software-rendered host. **This is the go/no-go.** If a page is
   unpleasant to use, the honest outcome is to delete live pages and keep reader
   mode plus the external browser, per §0.

---

## 6. Open questions

1. Xephyr and `cage` are additional runtime dependencies. Ship detection +
   a clear "install this" path (repo rule: install flows are one-click
   open-a-tab-and-run, never a copy-it-yourself instruction), or bake them into
   the image and nest differently?
2. Which browser in the image, and who patches it? A stale browser in a container
   is a worse browser than a current one outside it. This is an ongoing
   maintenance commitment, not a one-time build.
3. Image provenance and size — this is a supply-chain question the current
   feature does not have.
4. macOS: Docker Desktop is a VM; the display story is different again. Probably
   "not available", matching Windows.
5. Does per-project session isolation still make sense, or is one ephemeral
   session for the whole app simpler and just as useful?
6. #53 (drag a tab into an upload field) crosses this boundary by definition.
   It needs its own consent design; do not assume the downloads gate covers it.
