use super::*;
use std::collections::HashMap;

/// Names by fake uid; every account's *ACL* uid is this process's own (only
/// a uid mapped into the test's namespace can be named in an ACL).
struct Fake(HashMap<u32, &'static str>);

impl HubPeers for Fake {
    fn user_of(&self, uid: u32) -> Option<String> {
        self.0.get(&uid).map(|s| s.to_string())
    }
    fn uid_of(&self, name: &str) -> Option<u32> {
        // SAFETY: no preconditions.
        self.0.values().any(|n| *n == name).then(|| unsafe { libc::geteuid() })
    }
}

const ALICE: u32 = 1001;
const BOB: u32 = 1002;
const CAROL: u32 = 1003;
const MALLORY: u32 = 1999;

struct World {
    _dir: tempfile::TempDir,
    hub: Hub,
    src: PathBuf,
    scratch: PathBuf,
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn world() -> Option<World> {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("shared");
    let state = dir.path().join("state");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&state).unwrap();
    // SAFETY: no preconditions.
    if acl::set_user(&root, unsafe { libc::geteuid() }, true).is_err() {
        eprintln!("this filesystem has no POSIX ACLs; skipped");
        return None;
    }
    let _ = acl::set_user(&root, unsafe { libc::geteuid() }, false);
    let peers = Fake(HashMap::from([(ALICE, "alice"), (BOB, "bob"), (CAROL, "carol")]));
    let hub = Hub::new(root, state, Box::new(peers));
    let src = dir.path().join("src");
    std::fs::create_dir_all(&src).unwrap();
    git(&src, &["init", "-q"]);
    std::fs::write(src.join("a.txt"), "one\n").unwrap();
    git(&src, &["add", "a.txt"]);
    git(&src, &["commit", "-qm", "one"]);
    let scratch = dir.path().join("scratch");
    std::fs::create_dir_all(&scratch).unwrap();
    Some(World { _dir: dir, hub, src, scratch })
}

impl World {
    fn create(&self, uid: u32, name: &str) -> ShareInfo {
        let reply = self.hub.answer(uid, Request::Create { name: name.into() }, None);
        assert!(reply.ok, "{reply:?}");
        reply.share.unwrap()
    }

    fn commit(&self, file: &str, text: &str) -> String {
        std::fs::write(self.src.join(file), text).unwrap();
        git(&self.src, &["add", file]);
        git(&self.src, &["commit", "-qm", text]);
        git(&self.src, &["rev-parse", "HEAD"])
    }

    /// A bundle of `tip` without what the hub already has.
    fn bundle(&self, tip: &str, have: &[&str]) -> PathBuf {
        let path = self.scratch.join(format!("{}.bundle", new_id()));
        git(&self.src, &["branch", "-f", "out", tip]);
        let mut args = vec!["bundle".to_string(), "create".into(), "-q".into(), path.to_string_lossy().into_owned(), "out".into()];
        args.extend(have.iter().map(|h| format!("^{h}")));
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        git(&self.src, &args);
        path
    }

    fn push(&self, uid: u32, share: &str, update: (&str, &str, &str), bundle: Option<&Path>, force: bool) -> Reply {
        let (name, old, new) = update;
        let updates = vec![RefUpdate { name: name.into(), old: old.into(), new: new.into(), force }];
        let request = Request::Push { share: share.into(), updates, bytes: bundle.map_or(0, |b| std::fs::metadata(b).unwrap().len()), head: None };
        if let Err(reply) = self.hub.may_push(uid, &request) {
            return *reply;
        }
        self.hub.answer(uid, request, bundle)
    }

    fn hub_ref(&self, share: &str, name: &str) -> Option<String> {
        self.hub.git_ok(&self.hub.hub_path(share), &["rev-parse", "--verify", "--quiet", name]).ok().map(|s| s.trim().to_string())
    }
}

const Z: &str = hub_wire::ZERO_OID;

#[test]
fn a_new_hub_is_bare_hookless_private_and_readable_by_its_owner_only() {
    let Some(w) = world() else { return };
    let share = w.create(ALICE, "Thesis");
    assert!(hub_wire::valid_share_id(&share.id));
    assert_eq!((share.owner.as_str(), share.role.as_str()), ("alice", "owner"));
    let path = w.hub.hub_path(&share.id);
    assert_eq!(share.path, path.to_string_lossy());
    assert!(path.join("HEAD").is_file() && path.join("objects").is_dir());
    assert!(!path.join("hooks").exists() && !path.join("info").exists(), "no template: no hooks, no sample files");
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode & 0o007, 0, "others get nothing: {mode:o}");
    // SAFETY: no preconditions.
    let me = unsafe { libc::geteuid() };
    assert_eq!(acl::users_of(&path).unwrap().get(&me), Some(&(acl::R | acl::X)), "the owner reads through a named entry");
    assert_eq!(acl::default_users_of(&path.join("objects")).unwrap().get(&me), Some(&(acl::R | acl::X)));
    // Bob is not a member: he does not see it, and it reads like no share.
    assert!(w.hub.answer(BOB, Request::List, None).shares.is_empty());
    assert_eq!(w.hub.answer(BOB, Request::Presence { share: share.id.clone(), open: true }, None).error.as_deref(), Some("unknown-share"));
    assert_eq!(w.hub.answer(MALLORY, Request::List, None).error.as_deref(), Some("refused"), "not a server user");
    let audit = std::fs::read_to_string(w.hub.state.join(crate::audit::AUDIT_FILE)).unwrap();
    assert!(audit.contains(VERB_CREATE) && audit.contains(&share.id) && !audit.contains("Thesis"), "{audit}");
    assert_eq!(w.hub.answer(ALICE, Request::Create { name: "bad\nname".into() }, None).error.as_deref(), Some("invalid"));
}

#[test]
fn the_owner_pushes_a_viewer_cannot_and_an_editor_only_under_their_name() {
    let Some(w) = world() else { return };
    let share = w.create(ALICE, "Paper").id;
    let one = git(&w.src, &["rev-parse", "HEAD"]);
    let first = w.bundle(&one, &[]);
    let reply = w.push(ALICE, &share, ("refs/heads/main", Z, &one), Some(&first), false);
    assert!(reply.ok, "{reply:?}");
    assert_eq!(w.hub_ref(&share, "refs/heads/main").as_deref(), Some(one.as_str()));
    // The owner points HEAD at main.
    let head = Request::Push { share: share.clone(), updates: vec![RefUpdate { name: "refs/heads/main".into(), old: one.clone(), new: one.clone(), force: false }], bytes: 0, head: Some("refs/heads/main".into()) };
    assert!(w.hub.answer(ALICE, head, None).ok);
    assert_eq!(w.hub.git_ok(&w.hub.hub_path(&share), &["symbolic-ref", "HEAD"]).unwrap().trim(), "refs/heads/main");

    assert!(w.hub.answer(ALICE, Request::Grant { share: share.clone(), user: "bob".into(), role: Role::Viewer }, None).ok);
    assert!(w.hub.answer(ALICE, Request::Grant { share: share.clone(), user: "carol".into(), role: Role::Editor }, None).ok);
    let two = w.commit("b.txt", "two");
    let incr = w.bundle(&two, &[&one]);
    // Bob, a viewer: refused before a byte is read, whatever the ref.
    for name in ["refs/heads/main", "refs/heads/bob/main"] {
        let reply = w.push(BOB, &share, (name, Z, &two), Some(&incr), false);
        assert_eq!(reply.error.as_deref(), Some("ref-refused"), "{name}: {reply:?}");
    }
    // Carol, an editor: not main, not Bob's, yes her own.
    assert_eq!(w.push(CAROL, &share, ("refs/heads/main", &one, &two), Some(&incr), false).error.as_deref(), Some("ref-refused"));
    assert_eq!(w.push(CAROL, &share, ("refs/heads/bob/main", Z, &two), Some(&incr), false).error.as_deref(), Some("ref-refused"));
    let reply = w.push(CAROL, &share, ("refs/heads/carol/main", Z, &two), Some(&incr), false);
    assert!(reply.ok, "{reply:?}");
    assert_eq!(w.hub_ref(&share, "refs/heads/main").as_deref(), Some(one.as_str()), "main did not move");
    assert_eq!(w.hub_ref(&share, "refs/heads/carol/main").as_deref(), Some(two.as_str()));
    // Compare-and-swap: a stale old value moves nothing.
    assert_eq!(w.push(CAROL, &share, ("refs/heads/carol/main", &one, &two), None, false).error.as_deref(), Some("stale"));
    // A rewrite needs force; an editor may force her own branch.
    git(&w.src, &["reset", "-q", "--hard", &one]);
    let other = w.commit("c.txt", "other");
    let side = w.bundle(&other, &[&one]);
    assert_eq!(w.push(CAROL, &share, ("refs/heads/carol/main", &two, &other), Some(&side), false).error.as_deref(), Some("non-fast-forward"));
    assert!(w.push(CAROL, &share, ("refs/heads/carol/main", &two, &other), Some(&side), true).ok);
    // A ref may only name a commit that arrived.
    let ghost = "1".repeat(40);
    assert_eq!(w.push(CAROL, &share, ("refs/heads/carol/ghost", Z, &ghost), None, false).error.as_deref(), Some("bad-bundle"));
    // Deleting her own branch.
    assert!(w.push(CAROL, &share, ("refs/heads/carol/main", &other, Z), None, false).ok);
    assert_eq!(w.hub_ref(&share, "refs/heads/carol/main"), None);
    // A garbage bundle is refused and moves nothing.
    let junk = w.scratch.join("junk.bundle");
    std::fs::write(&junk, b"# v2 git bundle\nnot really\n").unwrap();
    assert_eq!(w.push(ALICE, &share, ("refs/heads/main", &one, &two), Some(&junk), false).error.as_deref(), Some("bad-bundle"));
    assert_eq!(w.hub_ref(&share, "refs/heads/main").as_deref(), Some(one.as_str()));
}

#[test]
fn a_revoked_member_loses_the_share_and_its_acl_entry() {
    let Some(w) = world() else { return };
    let share = w.create(ALICE, "Data").id;
    let one = git(&w.src, &["rev-parse", "HEAD"]);
    assert!(w.push(ALICE, &share, ("refs/heads/main", Z, &one), Some(&w.bundle(&one, &[])), false).ok);
    assert_eq!(w.hub.answer(BOB, Request::Grant { share: share.clone(), user: "carol".into(), role: Role::Viewer }, None).error.as_deref(), Some("unknown-share"), "a stranger cannot grant");
    assert!(w.hub.answer(ALICE, Request::Grant { share: share.clone(), user: "bob".into(), role: Role::Editor }, None).ok);
    assert_eq!(w.hub.answer(BOB, Request::Grant { share: share.clone(), user: "carol".into(), role: Role::Viewer }, None).error.as_deref(), Some("not-owner"));
    assert_eq!(w.hub.answer(ALICE, Request::Grant { share: share.clone(), user: "dave".into(), role: Role::Viewer }, None).error.as_deref(), Some("not-a-user"));
    assert_eq!(w.hub.answer(ALICE, Request::Grant { share: share.clone(), user: "alice".into(), role: Role::Viewer }, None).error.as_deref(), Some("invalid"));
    let list = w.hub.answer(BOB, Request::List, None).shares;
    assert_eq!((list.len(), list[0].role.as_str(), list[0].owner.as_str()), (1, "editor", "alice"));
    assert!(w.hub.answer(BOB, Request::Presence { share: share.clone(), open: true }, None).ok);
    let seen = w.hub.answer(ALICE, Request::List, None).shares;
    assert_eq!(seen[0].presence.iter().map(|p| p.user.as_str()).collect::<Vec<_>>(), ["bob"], "alice sees bob");
    assert!(w.hub.answer(BOB, Request::List, None).shares[0].presence.is_empty(), "nobody sees themselves");

    assert!(w.hub.answer(ALICE, Request::Revoke { share: share.clone(), user: "bob".into() }, None).ok);
    assert!(w.hub.answer(BOB, Request::List, None).shares.is_empty(), "gone from bob's list");
    assert_eq!(w.push(BOB, &share, ("refs/heads/bob/x", Z, &one), None, false).error.as_deref(), Some("unknown-share"));
    // SAFETY: no preconditions.
    let me = unsafe { libc::geteuid() };
    // Bob's uid and Alice's are one in this test: the entry is gone everywhere.
    let path = w.hub.hub_path(&share);
    assert!(!acl::users_of(&path).unwrap().contains_key(&me));
    assert!(!acl::users_of(&path.join("HEAD")).unwrap().contains_key(&me));
    assert!(w.hub.answer(ALICE, Request::List, None).shares[0].presence.is_empty(), "a revoked member's presence goes too");
    let audit = std::fs::read_to_string(w.hub.state.join(crate::audit::AUDIT_FILE)).unwrap();
    assert!(audit.contains(VERB_REVOKE) && audit.contains(&format!("{share}/bob")), "{audit}");
}

#[test]
fn only_root_can_make_the_hub_forget_a_removed_account() {
    let Some(w) = world() else { return };
    let share = w.create(ALICE, "Gone").id;
    assert!(w.hub.answer(ALICE, Request::Grant { share: share.clone(), user: "bob".into(), role: Role::Viewer }, None).ok);
    assert_eq!(w.hub.answer(ALICE, Request::Forget { user: "bob".into() }, None).error.as_deref(), Some("refused"));
    assert!(w.hub.answer(0, Request::Forget { user: "bob".into() }, None).ok);
    assert!(w.hub.answer(BOB, Request::List, None).shares.is_empty());
    assert!(w.hub.answer(ALICE, Request::List, None).shares[0].members.is_empty());
}

#[test]
fn a_deleted_share_is_held_then_purged_and_members_see_why() {
    let Some(w) = world() else { return };
    let share = w.create(ALICE, "Old").id;
    assert!(w.hub.answer(ALICE, Request::Grant { share: share.clone(), user: "bob".into(), role: Role::Viewer }, None).ok);
    assert_eq!(w.hub.answer(BOB, Request::Delete { share: share.clone() }, None).error.as_deref(), Some("not-owner"));
    assert!(w.hub.answer(ALICE, Request::Delete { share: share.clone() }, None).ok);
    assert!(!w.hub.hub_path(&share).exists());
    let held: Vec<_> = std::fs::read_dir(w.hub.root.join(HOLDING_DIR)).unwrap().flatten().collect();
    assert_eq!(held.len(), 1);
    let list = w.hub.answer(BOB, Request::List, None).shares;
    assert!(list[0].deleted.is_some(), "bob sees 'deleted by owner'");
    assert_eq!(w.hub.answer(BOB, Request::Presence { share: share.clone(), open: true }, None).error.as_deref(), Some("unknown-share"));
    w.hub.purge(crate::now() + hub_wire::RETENTION + 1);
    assert!(w.hub.answer(BOB, Request::List, None).shares.is_empty());
    assert_eq!(std::fs::read_dir(w.hub.root.join(HOLDING_DIR)).unwrap().count(), 0, "the held hub is gone after the window");
}

#[test]
fn with_sharing_switched_off_nothing_new_is_shared_and_what_exists_stays() {
    let Some(w) = world() else { return };
    let policy = w.scratch.join("policy.json");
    let share = w.create(ALICE, "Kept").id;
    assert!(w.hub.answer(ALICE, Request::Grant { share: share.clone(), user: "bob".into(), role: Role::Viewer }, None).ok);
    let hub = Hub { policy_file: Some(policy.clone()), ..w.hub };
    std::fs::write(&policy, br#"{"features":{"project_sharing":false}}"#).unwrap();
    assert_eq!(hub.answer(ALICE, Request::Create { name: "New".into() }, None).error.as_deref(), Some("sharing-off"));
    assert_eq!(hub.answer(ALICE, Request::Grant { share: share.clone(), user: "carol".into(), role: Role::Viewer }, None).error.as_deref(), Some("sharing-off"));
    assert!(hub.answer(ALICE, Request::Grant { share: share.clone(), user: "bob".into(), role: Role::Editor }, None).ok, "an existing member's role may change");
    assert_eq!(hub.answer(BOB, Request::List, None).shares.len(), 1, "an existing share keeps working");
    std::fs::write(&policy, b"{broken").unwrap();
    assert_eq!(hub.answer(ALICE, Request::Create { name: "New".into() }, None).error.as_deref(), Some("sharing-off"), "unreadable policy: off");
}

#[tokio::test]
async fn the_socket_takes_a_bundle_after_the_line_and_refuses_an_oversized_one() {
    let Some(w) = world() else { return };
    // SAFETY: no preconditions.
    let me = unsafe { libc::geteuid() };
    let hub = Hub { peers: Box::new(Fake(HashMap::from([(me, "alice")]))), ..w.hub };
    let share = hub.answer(me, Request::Create { name: "Sock".into() }, None).share.unwrap().id;
    let hub = Arc::new(hub);
    let socket = w.scratch.join("hub.sock");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    tokio::spawn(serve(hub.clone(), listener));
    let one = git(&w.src, &["rev-parse", "HEAD"]);
    let bundle = std::fs::read(w.scratch.join({
        let path = w.scratch.join("x.bundle");
        git(&w.src, &["bundle", "create", "-q", &path.to_string_lossy(), "main"]);
        "x.bundle"
    }))
    .unwrap();
    let request = Request::Push { share: share.clone(), updates: vec![RefUpdate { name: "refs/heads/main".into(), old: Z.into(), new: one.clone(), force: false }], bytes: bundle.len() as u64, head: Some("refs/heads/main".into()) };
    let reply = ask(&socket, &request, &bundle).await.unwrap();
    assert!(reply.ok, "{reply:?}");
    assert_eq!(hub.git_ok(&hub.hub_path(&share), &["rev-parse", "main"]).unwrap().trim(), one);
    assert_eq!(std::fs::read_dir(hub.state.join("incoming")).unwrap().count(), 0, "the upload is removed after use");
    let huge = Request::Push { share, updates: vec![RefUpdate { name: "refs/heads/x".into(), old: Z.into(), new: one, force: false }], bytes: hub_wire::MAX_BUNDLE + 1, head: None };
    assert_eq!(ask(&socket, &huge, b"").await.unwrap().error.as_deref(), Some("too-large"));
}
