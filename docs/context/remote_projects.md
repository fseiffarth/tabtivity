# Remote projects (SSH/SFTP-native, mount-free)

Referenced from `AGENTS.md`.

Remote (SSH) projects are **mount-free** (no sshfs/FUSE): they are SSH/SFTP-
native. Agent/terminal tabs run on the host over `ssh -tt`, file browsing and
file I/O go over SFTP, and git runs on the host over SSH — all riding one
pooled ControlMaster + `Sftp` session per active remote project (opened via
`remote_connect`, see `services::remote`). Such projects carry a `remote` spec
(`user?`, `host`, `port?`, `remote_path`, `openvpn?`) in their `project.json`
and mirrored into the `projects.json` entry's `extra` (the always-local source
of truth `remote_target_for` reads). Their `directory` is a **local** per-
project state dir (`~/.local/share/tabtivity/remote-projects/<id>/`) that holds
`project.json`; the actual tree lives on `host:remote_path`. Remoteness is
resolved explicitly by `services::remote::remote_target_for{,_dir}`, never by a
path convention.
