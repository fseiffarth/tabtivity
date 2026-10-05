# Agent sandbox image

Reference Docker image for Tabtivity's per-project **"Run agents in Docker sandbox"**
toggle (right-click a project pill → *Run agents in Docker sandbox*).

When enabled for a (local) project, every **agent** tab (Claude, Codex, Gemini,
Vibe — anything with `kind: "agent"`) is launched inside an ephemeral
`docker run --rm` container that bind-mounts **only the project directory** plus a
minimal set of agent auth/state paths (see *How it runs* below), so the agent
cannot reach unrelated host files. The agent's own auth dirs (`~/.claude`,
`~/.codex`, Gemini creds) are shared so login and session-resume keep working;
everything else under `$HOME` is not. Plain shell/files tabs keep running on the
host. The toggle is **off by default** and per project.

## Build

```bash
docker build -t tabtivity-agent-sandbox:latest docker/agent-sandbox
```

`tabtivity-agent-sandbox:latest` is the default image name the backend looks for.
If the image (or `docker` itself) is missing, opening a sandboxed agent tab fails
loudly in the terminal with a `[spawn error: …]` message rather than silently
running the agent on the host.

## How it runs

The backend (`src-tauri/src/services/sandbox.rs`) wraps the agent command as:

```
docker run --rm -it \
  --user <host-uid>:<host-gid> \
  --security-opt no-new-privileges --cap-drop ALL --pids-limit <n> \
  [ --memory <m> --cpus <c> --network <net> --read-only --tmpfs /tmp ] \  # opt-in
  -e HOME=<host-home> \
  -w <project-dir> \
  -v <project-dir>:<project-dir> \
  -v <home>/.claude:<home>/.claude \                # if present
  -v <home>/.codex:<home>/.codex \                  # if present
  -v <state_dir>/live_sessions:<state_dir>/live_sessions \   # hook write target (rw)
  [ -v <home>/.gemini:… -v <home>/.config/gemini:… ] \       # Gemini creds only, if present
  -v <state_dir>/hooks:<state_dir>/hooks:ro \                # hook script (read-only)
  -v <stage>/…_settings.json:<home>/.claude/settings.json \  # writable copy (shadows host)
  [ -v <stage>/…_settings.local.json:… -v <stage>/…_config.toml:… ] \
  -e TABTIVITY_TAB_UID=… -e TERM=… -e <agent auth vars> \
  tabtivity-agent-sandbox:latest <agent> <args>
```

`<stage>` is a per-tab dir under `<state_dir>/sandbox-stage/`.

Only these host paths are exposed — **not** the whole `~/.config` or the whole
`state_dir`, so unrelated secrets (`gh`, `gcloud`, …), `projects.json`, and other
projects' conversation history stay out of the container.

The `~/.claude` / `~/.codex` / `live_sessions` mounts (at identical paths, as the
host uid, with `HOME` set to the host home) are what keep **agent auth and session
resume** working inside the container. Do not remove them.

The SessionStart hook's absolute path is baked into `~/.claude/settings.json` /
`~/.codex/config.toml`, so those files are an escape vector. Two defences:

- The hook **script dir** (`<state_dir>/hooks`) is shared with host-run agents,
  so it is mounted **read-only** (`:ro`) — a writable copy would let the sandbox
  rewrite the script and run code on the host. Do not drop the `:ro`.
- The **registration files** are mounted as **per-tab writable copies** (staged
  under `<state_dir>/sandbox-stage/<tab>`) that shadow the host originals. The
  container gets a real, writable file (so agents that persist config don't
  error), but its writes land in the throwaway copy — the host's settings can
  never be repointed at an attacker command. The copy still carries the hook
  registration, so resume keeps working.

## Customizing

- Add your project toolchain (python, go, rustup, …) to the `Dockerfile` if your
  agents need to build/run code inside the sandbox.
- Hardening flags: `--security-opt no-new-privileges`, `--cap-drop ALL`, and a
  `--pids-limit` are always applied. Per project you can also set `memory`,
  `cpus`, `network`, and `readonly_rootfs` in the project's `sandbox` config
  (`project.json`) — e.g. `"network": "none"` for no egress, or a custom
  allowlist network.
- Network defaults to the Docker bridge (full egress). Because the mounted auth
  dirs contain live credentials, consider an egress allowlist: base this image /
  its run on Anthropic's reference devcontainer `init-firewall.sh`, or set
  `"network"` to a locked-down network. Rootful Docker runs its daemon as root, so
  prefer rootless Docker or Podman if a container-escape CVE is a concern.
- Remote (SSH) projects are out of scope: the sandbox toggle is hidden for them,
  and the backend ssh-wraps remote agent tabs instead of docker-wrapping them.
