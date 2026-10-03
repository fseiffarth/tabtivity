//! The daemon's sharing code against the real share hub
//! (`app_gateway::hub`) on temp sockets. Every account is this process's
//! own uid (only a mapped uid can be named in an ACL), so one hub instance
//! per account answers as that account; they share one root and table.
use super::*;
use app_gateway::hub::{Hub, HubPeers};

struct As(&'static str);

const USERS: &[&str] = &["alice", "bob", "carol"];

impl HubPeers for As {
    fn user_of(&self, _uid: u32) -> Option<String> {
        Some(self.0.to_string())
    }
    fn uid_of(&self, name: &str) -> Option<u32> {
        // SAFETY: no preconditions.
        USERS.contains(&name).then(|| unsafe { libc::geteuid() })
    }
}

struct Server {
    dir: tempfile::TempDir,
    root: PathBuf,
}

impl Server {
    /// `None` where this filesystem has no POSIX ACLs.
    fn new() -> Option<Server> {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("shared");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(dir.path().join("hub-state")).unwrap();
        // SAFETY: no preconditions.
        if app_gateway::acl::set_user(&root, unsafe { libc::geteuid() }, true).is_err() {
            eprintln!("no POSIX ACLs here; skipped");
            return None;
        }
        Some(Server { dir, root })
    }

    /// A hub answering every connection as `user`, on its own socket.
    fn socket_for(&self, user: &'static str) -> PathBuf {
        let socket = self.dir.path().join(format!("{user}.sock"));
        let hub = Hub::new(self.root.clone(), self.dir.path().join("hub-state"), Box::new(As(user)));
        let (ready, wait) = std::sync::mpsc::channel();
        let path = socket.clone();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            runtime.block_on(async move {
                let listener = tokio::net::UnixListener::bind(&path).unwrap();
                ready.send(()).unwrap();
                let _ = app_gateway::hub::serve(std::sync::Arc::new(hub), listener).await;
            });
        });
        wait.recv().unwrap();
        socket
    }

    fn state(&self, user: &str) -> PathBuf {
        let dir = self.dir.path().join(format!("state-{user}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn home(&self, user: &str) -> PathBuf {
        let dir = self.dir.path().join(format!("home-{user}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn commit(dir: &Path, file: &str, text: &str) -> String {
    std::fs::write(dir.join(file), text).unwrap();
    git(dir, &["add", file]);
    git(dir, &["commit", "-qm", text]);
    git(dir, &["rev-parse", "HEAD"])
}

/// Alice's project: one commit, and the app's in-tree session files beside it.
fn alices_project(server: &Server) -> PathBuf {
    let dir = server.home("alice").join("paper");
    std::fs::create_dir_all(dir.join(brand::PROJECT_DIR).join("sessions")).unwrap();
    git(&dir, &["init", "-q"]);
    commit(&dir, "a.txt", "one\n");
    std::fs::write(dir.join(brand::PROJECT_DIR).join("sessions").join("terminals.json"), "{}").unwrap();
    dir
}

fn hub_ref(hub: &Path, name: &str) -> Option<String> {
    let out = std::process::Command::new("git").arg("--git-dir").arg(hub).args(["rev-parse", "--verify", "--quiet", name]).output().unwrap();
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[test]
fn an_owner_shares_a_viewer_clones_and_fetches_and_a_revoke_greys_the_row() {
    let Some(server) = Server::new() else { return };
    let (alice_sock, bob_sock) = (server.socket_for("alice"), server.socket_for("bob"));
    let (alice_state, bob_state) = (server.state("alice"), server.state("bob"));
    let dir = alices_project(&server);
    let one = git(&dir, &["rev-parse", "HEAD"]);

    let share = create_in(&alice_state, &alice_sock, "p-alice", &dir, "Paper", "alice").unwrap();
    let hub = PathBuf::from(&share.path);
    assert_eq!(hub_ref(&hub, "refs/heads/main").as_deref(), Some(one.as_str()), "the checked-out branch went to the hub");
    assert_eq!(hub_ref(&hub, "HEAD").as_deref(), Some(one.as_str()), "the hub's HEAD names the owner's branch");
    // The app's folder is excluded in the owner's repo: never staged, never pushed.
    git(&dir, &["add", "-A"]);
    assert!(!git(&dir, &["status", "--porcelain"]).contains(brand::PROJECT_DIR), "session files stay untracked");
    assert_eq!(link_of(&alice_state, "p-alice").unwrap().role, "owner");
    assert!(create_in(&alice_state, &alice_sock, "p-alice", &dir, "Paper", "alice").unwrap_err().contains("already shared"));

    assert!(ask_at(&alice_sock, &Request::Grant { share: share.id.clone(), user: "bob".into(), role: Role::Viewer }, None).unwrap().ok);
    let mine = list_at(&bob_sock).unwrap();
    assert_eq!((mine.len(), mine[0].role.as_str(), mine[0].owner.as_str()), (1, "viewer", "alice"));
    let clone = clone_into(&server.home("bob").join("projects"), &mine[0]).unwrap();
    assert_eq!(std::fs::read_to_string(clone.join("a.txt")).unwrap(), "one\n");
    assert!(!clone.join(brand::PROJECT_DIR).exists(), "the owner's session files never reached the hub");
    assert!(std::fs::read_to_string(clone.join(".git/info/exclude")).unwrap().lines().any(|l| l == brand::PROJECT_DIR_EXCLUDE_RULE));
    assert!(!clone.join(".git/hooks").exists(), "cloned with no template: no sample hooks");
    adopt_in(&bob_state, "p-bob", &mine[0], &clone).unwrap();
    let bob_link = link_of(&bob_state, "p-bob").unwrap();
    // A viewer cannot push, here or at the hub.
    commit(&clone, "b.txt", "bob's\n");
    assert!(push_in(&bob_state, &bob_sock, &bob_link, "bob").unwrap_err().contains("not push"));
    let forced = Link { role: "editor".into(), ..bob_link.clone() };
    assert!(push_in(&bob_state, &bob_sock, &forced, "bob").unwrap_err().contains("may not move"), "the hub refuses a viewer whatever the daemon claims");

    // Alice moves on; Bob's fetch reports it, and resolves nothing.
    let two = commit(&dir, "c.txt", "two\n");
    let pushed = push_in(&alice_state, &alice_sock, &link_of(&alice_state, "p-alice").unwrap(), "alice").unwrap();
    assert_eq!((pushed.branch.as_str(), pushed.commit.as_str(), pushed.unchanged), ("refs/heads/main", two.as_str(), false));
    let report = fetch_report(&bob_link).unwrap();
    let main = report.iter().find(|b| b.name == "main").unwrap();
    assert_eq!((main.ahead, main.behind), (1, 1), "diverged: one each way");
    assert!(push_in(&alice_state, &alice_sock, &link_of(&alice_state, "p-alice").unwrap(), "alice").unwrap().unchanged);

    // Revoke: Bob's list loses it, his project becomes a greyed row, kept.
    assert!(ask_at(&alice_sock, &Request::Revoke { share: share.id.clone(), user: "bob".into() }, None).unwrap().ok);
    let rows = overview_in(&bob_state, list_at(&bob_sock).unwrap()).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0].state.as_str(), rows[0].project_id.as_deref()), ("revoked", Some("p-bob")));
    assert!(clone.join("a.txt").exists(), "the clone is a copy by design and stays");
    assert!(fetch_report(&link_of(&bob_state, "p-bob").unwrap()).unwrap_err().contains("no longer shared"));
    assert!(is_shared_dir_in(&bob_state, &clone), "the gates still know it came from a share");
}

fn is_shared_dir_in(state: &Path, dir: &Path) -> bool {
    link_for_dir(state, dir).is_some()
}

#[test]
fn an_editor_pushes_only_under_her_own_name_and_session_files_are_refused() {
    let Some(server) = Server::new() else { return };
    let (alice_sock, carol_sock) = (server.socket_for("alice"), server.socket_for("carol"));
    let (alice_state, carol_state) = (server.state("alice"), server.state("carol"));
    let dir = alices_project(&server);
    let share = create_in(&alice_state, &alice_sock, "p-alice", &dir, "Paper", "alice").unwrap();
    assert!(ask_at(&alice_sock, &Request::Grant { share: share.id.clone(), user: "carol".into(), role: Role::Editor }, None).unwrap().ok);
    let info = list_at(&carol_sock).unwrap().remove(0);
    let clone = clone_into(&server.home("carol"), &info).unwrap();
    adopt_in(&carol_state, "p-carol", &info, &clone).unwrap();
    let mine = commit(&clone, "d.txt", "carol's\n");
    let pushed = push_in(&carol_state, &carol_sock, &link_of(&carol_state, "p-carol").unwrap(), "carol").unwrap();
    assert_eq!(pushed.branch, "refs/heads/carol/main");
    let hub = PathBuf::from(&share.path);
    assert_eq!(hub_ref(&hub, "refs/heads/carol/main").as_deref(), Some(mine.as_str()));
    assert_ne!(hub_ref(&hub, "refs/heads/main").as_deref(), Some(mine.as_str()), "main is the owner's");
    // A commit carrying the app's folder (forced past the exclude) is refused.
    std::fs::create_dir_all(clone.join(brand::PROJECT_DIR)).unwrap();
    std::fs::write(clone.join(brand::PROJECT_DIR).join("state.json"), "{}").unwrap();
    git(&clone, &["add", "-f", &format!("{}/state.json", brand::PROJECT_DIR)]);
    git(&clone, &["commit", "-qm", "oops"]);
    let error = push_in(&carol_state, &carol_sock, &link_of(&carol_state, "p-carol").unwrap(), "carol").unwrap_err();
    assert!(error.contains("session files"), "{error}");
}

/// The exact scope of git's ownership check (plan §6.2 step 5), with
/// `GIT_TEST_ASSUME_DIFFERENT_OWNER` (git's own switch for testing it
/// without a second account): git refuses to *open* a repository another uid
/// owns — a local-path clone does — unless `safe.directory` names exactly
/// that path; the transport (`--no-local`, `fetch`), which runs
/// `upload-pack` against it, does not check (git 2.53). Tabtivity uses the
/// transport and pins the exact hub anyway, never `*`: a git that starts
/// checking the transport needs no change, and nothing else is opened.
#[test]
fn safe_directory_is_pinned_to_the_exact_hub() {
    let dir = tempfile::tempdir().unwrap();
    let hub = dir.path().join("hub.git");
    git(dir.path(), &["init", "-q", "--bare", &hub.to_string_lossy()]);
    let src = dir.path().join("src");
    std::fs::create_dir_all(&src).unwrap();
    git(&src, &["init", "-q"]);
    commit(&src, "a.txt", "x");
    git(&src, &["push", "-q", &hub.to_string_lossy(), "HEAD:refs/heads/main"]);
    let clone = |name: &str, pinned: Option<&Path>, transport: bool| {
        let mut args: Vec<String> = pinned.map(|p| pin(p).to_vec()).unwrap_or_default();
        args.extend(["clone", "--quiet", "--template="].map(String::from));
        if transport {
            args.push("--no-local".into());
        }
        args.push(hub.to_string_lossy().into_owned());
        args.push(dir.path().join(name).to_string_lossy().into_owned());
        crate::commands::git::hookless_git_command_in(dir.path(), &args).env("GIT_TEST_ASSUME_DIFFERENT_OWNER", "1").env("GIT_CONFIG_GLOBAL", "/dev/null").output().unwrap()
    };
    let unpinned = clone("a", None, false);
    assert!(!unpinned.status.success() && String::from_utf8_lossy(&unpinned.stderr).contains("dubious ownership"), "{}", String::from_utf8_lossy(&unpinned.stderr));
    let elsewhere = clone("b", Some(&dir.path().join("other.git")), false);
    assert!(!elsewhere.status.success(), "a pin of another path does not open this hub");
    let exact = clone("c", Some(&hub), false);
    assert!(exact.status.success(), "{}", String::from_utf8_lossy(&exact.stderr));
    let transport = clone("d", Some(&hub), true);
    assert!(transport.status.success(), "{}", String::from_utf8_lossy(&transport.stderr));
    assert!(dir.path().join("d").join(".git").is_dir());
}

#[test]
fn the_fence_hides_every_hub_but_the_scopes_own() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state");
    let shared = dir.path().join("shared");
    std::fs::create_dir_all(&state).unwrap();
    std::fs::create_dir_all(shared.join("x.git")).unwrap();
    std::fs::create_dir_all(shared.join("y.git")).unwrap();
    let link = |share: &str, project: &str, state_word: &str| Link { share: share.into(), role: "viewer".into(), owner: "alice".into(), hub: shared.join(format!("{share}.git")), dir: dir.path().join(project), state: state_word.into() };
    let mut map = Map::default();
    map.links.insert("px".into(), link("x", "proj-x", "active"));
    map.links.insert("py".into(), link("y", "proj-y", "active"));
    save_map(&state, &map).unwrap();
    let roots = vec![dir.path().join("proj-x")];
    let args = fence_args(&state, &shared, &roots, true);
    let shared_s = shared.to_string_lossy().into_owned();
    let x = shared.join("x.git").to_string_lossy().into_owned();
    let y = shared.join("y.git").to_string_lossy().into_owned();
    assert_eq!(args, ["--tmpfs", &shared_s, "--ro-bind-try", &x, &x]);
    assert!(!args.contains(&y), "project Y's hub stays hidden from X's agents");
    assert!(fence_args(&state, &shared, &[dir.path().join("elsewhere")], true) == ["--tmpfs", shared_s.as_str()], "a scope with no share sees no hub at all");
    assert!(fence_args(&state, &shared, &roots, false).is_empty(), "the desktop is unchanged");
    assert!(fence_args(&state, &dir.path().join("missing"), &roots, true).is_empty());
    // A revoked link binds nothing back.
    map.links.insert("px".into(), link("x", "proj-x", "revoked"));
    save_map(&state, &map).unwrap();
    assert_eq!(fence_args(&state, &shared, &roots, true), ["--tmpfs", shared_s.as_str()]);
}

#[test]
fn a_deleted_share_reads_as_deleted_by_owner_and_its_project_stays() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state");
    std::fs::create_dir_all(&state).unwrap();
    let info = ShareInfo { id: "a".repeat(32), name: "Old".into(), owner: "alice".into(), role: "viewer".into(), path: "/srv/x/shared/a.git".into(), deleted: Some(5), ..ShareInfo::default() };
    adopt_in(&state, "p", &ShareInfo { deleted: None, ..info.clone() }, &dir.path().join("old")).unwrap();
    let rows = overview_in(&state, vec![info]).unwrap();
    assert_eq!((rows.len(), rows[0].state.as_str(), rows[0].project_id.as_deref()), (1, "deleted", Some("p")));
    assert_eq!(link_of(&state, "p").unwrap().state, "deleted");
}
