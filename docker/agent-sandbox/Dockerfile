# Reference image for Tabtivity's per-project "Run agents in Docker sandbox" toggle.
#
# When the toggle is on for a project, Tabtivity launches each agent tab as:
#   docker run --rm -it --user <uid>:<gid> \
#     --security-opt no-new-privileges --cap-drop ALL --pids-limit <n> \
#     -e HOME=<host-home> -w <project> \
#     -v <project>:<project> \
#     -v <home>/.claude:<home>/.claude -v <home>/.codex:<home>/.codex \
#     -v <state_dir>/live_sessions:<state_dir>/live_sessions \
#     -v <state_dir>/hooks:<state_dir>/hooks:ro \
#     -v <stage>/..._settings.json:<home>/.claude/settings.json \  # writable copy
#     -e <agent-auth/env vars> tabtivity-agent-sandbox:latest <agent> <args>
# (see docker/agent-sandbox/README.md and src-tauri/src/services/sandbox.rs).
#
# The container therefore needs the agent CLIs on PATH. Auth + session-resume
# state lives in the bind-mounted host dirs (run as the host uid, with HOME set
# to the host home), so this image carries no credentials.
#
# Build:
#   docker build -t tabtivity-agent-sandbox:latest docker/agent-sandbox
#
# The container is started with `--user <host-uid>:<host-gid>` and is NOT root,
# so install everything to global locations at build time (below). The named
# user does not need to exist in /etc/passwd; HOME is provided via `-e HOME`.

FROM node:22-bookworm-slim

# Tools agents commonly shell out to. Add the rest of your project toolchain (go,
# rustup, a JDK, …) here if your agents need to build/run code inside the sandbox.
#
# Python is included rather than left as an exercise because its absence is not a
# missing convenience, it is a broken feature: an agent in a Python project that
# cannot run `python3` fails at its first attempt to check its own work, and the
# viewer's Run/Debug button (which opens an ordinary terminal tab, so it lands
# inside the container like everything else) reported `python3: not found`.
#
# It does NOT make a host `.venv` work. A venv is not self-contained: its
# `bin/python` is a symlink to the system interpreter recorded in `pyvenv.cfg`,
# and the project directory being bind-mounted brings the venv in while leaving
# that interpreter on the host. If the version below matches the one the venv was
# built against, the symlink resolves and it works; otherwise the venv is skipped
# as unusable (see `commands::python`'s in-container probe) and the image's own
# python3 is used, without the project's dependencies. Two ways out: build a venv
# inside the container, or set the container to "Agent tabs only" so Run/Debug
# stays on the host with the host's environment.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates ripgrep less procps curl \
        python3 python3-venv python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Agent CLIs. Pin versions in your own fork if you want reproducible builds.
#   - Claude Code:  @anthropic-ai/claude-code  (provides `claude`)
#   - Codex:        @openai/codex               (provides `codex`)
#   - Gemini CLI:   @google/gemini-cli          (provides `gemini`)
# Vibe and any other agents you use should be added here as well.
RUN npm install -g \
        @anthropic-ai/claude-code \
        @openai/codex \
        @google/gemini-cli \
    && npm cache clean --force

# Make global npm bins resolvable regardless of the (host) uid we run as, and
# give npm a writable cache/prefix under a world-writable dir so a non-root,
# /etc/passwd-less user can still operate.
ENV NPM_CONFIG_CACHE=/tmp/.npm
ENV PATH=/usr/local/bin:$PATH

# No ENTRYPOINT: Tabtivity passes the agent command + args as the container command.
