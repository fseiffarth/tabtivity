//! The helper's plans and hard rules against a fake machine. Nothing here
//! needs root: execution goes through a recording [`Exec`].

use super::*;
use std::cell::RefCell;
use std::collections::HashMap;

#[derive(Default)]
struct FakeAccounts {
    accounts: RefCell<HashMap<String, UnixAccount>>,
    groups: Vec<String>,
    /// A fixture filesystem root holding `etc/sudoers` (none: no rules).
    sudoers_root: RefCell<Option<PathBuf>>,
}

impl FakeAccounts {
    fn with(mut self, name: &str, uid: u32, groups: &[&str]) -> Self {
        self.accounts.get_mut().insert(
            name.into(),
            UnixAccount { name: name.into(), uid, gid: uid, home: PathBuf::from("/home").join(name), groups: groups.iter().map(|g| g.to_string()).collect() },
        );
        self
    }
}

impl Accounts for FakeAccounts {
    fn lookup(&self, name: &str) -> Option<UnixAccount> {
        self.accounts.borrow().get(name).cloned()
    }
    fn group_gid(&self, name: &str) -> Option<u32> {
        self.groups.iter().position(|g| g == name).map(|i| 990 - i as u32)
    }
    fn sudo_rule(&self, account: &UnixAccount) -> Result<Option<String>, String> {
        match self.sudoers_root.borrow().as_deref() {
            Some(root) => crate::sudoers::rule_for(root, &crate::sudoers::Subject { name: &account.name, uid: account.uid, gid: account.gid, groups: &account.groups }),
            None => Ok(None),
        }
    }
}

/// A fixture root whose `etc/sudoers` is `text`.
fn sudoers_root(text: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("etc")).unwrap();
    std::fs::write(dir.path().join("etc/sudoers"), text).unwrap();
    dir
}

#[derive(Default)]
struct Recorder<'a> {
    log: Vec<String>,
    /// `useradd` "creates" the account here, as the real one would.
    accounts: Option<&'a FakeAccounts>,
    stdin_seen: Vec<(String, String)>,
    /// What `read_secret` answers (`None`: no input).
    secret: Option<String>,
}

impl Exec for Recorder<'_> {
    fn run(&mut self, argv: &[String]) -> Result<(), String> {
        self.log.push(argv.join(" "));
        if argv[0] == "useradd" && !argv.contains(&"--system".to_string()) {
            let name = argv.last().unwrap().clone();
            if let Some(accounts) = self.accounts {
                accounts.accounts.borrow_mut().insert(name.clone(), UnixAccount { name: name.clone(), uid: 1500, gid: 1500, home: PathBuf::from("/home").join(&name), groups: vec![name.clone(), names::users_group()] });
            }
        }
        Ok(())
    }
    fn run_as(&mut self, account: &UnixAccount, argv: &[String], stdin: &str) -> Result<(), String> {
        self.log.push(format!("as {}: {}", account.name, argv.join(" ")));
        self.stdin_seen.push((account.name.clone(), stdin.into()));
        Ok(())
    }
    fn write(&mut self, path: &Path, _: &str, mode: u32) -> Result<(), String> {
        self.log.push(format!("write {} {mode:o}", path.display()));
        Ok(())
    }
    fn remove(&mut self, path: &Path) -> Result<(), String> {
        self.log.push(format!("remove {}", path.display()));
        Ok(())
    }
    fn chmod_home(&mut self, home: &Path, mode: u32) -> Result<(), String> {
        self.log.push(format!("chmod {} {mode:o}", home.display()));
        Ok(())
    }
    fn owned_dir(&mut self, path: &Path, mode: u32, owner: &UnixAccount) -> Result<(), String> {
        self.log.push(format!("dir {} {mode:o} {}", path.display(), owner.name));
        Ok(())
    }
    fn hand_to_gateway(&mut self, _: &Path, gateway: &UnixAccount) -> Result<(), String> {
        self.log.push(format!("hand to {}", gateway.name));
        Ok(())
    }
    fn say(&mut self, line: &str) {
        self.log.push(format!("say {line}"));
    }
    fn read_secret(&mut self, _: &str) -> Result<String, String> {
        self.secret.clone().ok_or_else(|| "no input".into())
    }
}

fn users() -> String {
    names::users_group()
}

#[test]
fn only_regular_non_admin_members_of_the_users_group_are_linked() {
    let ok = UnixAccount { name: "alice".into(), uid: 1001, gid: 1001, home: "/home/alice".into(), groups: vec!["alice".into(), users()] };
    let accounts = FakeAccounts::default();
    assert!(check_linkable(&accounts, &ok).is_ok());
    let refused = [
        UnixAccount { uid: 0, ..ok.clone() },
        UnixAccount { uid: 999, ..ok.clone() },
        UnixAccount { uid: 65534, ..ok.clone() },
        UnixAccount { groups: vec![users(), "sudo".into()], ..ok.clone() },
        UnixAccount { groups: vec![users(), "wheel".into()], ..ok.clone() },
        UnixAccount { groups: vec![users(), "docker".into()], ..ok.clone() },
        UnixAccount { groups: vec![users(), "lxd".into()], ..ok.clone() },
        UnixAccount { groups: vec![users(), "incus-admin".into()], ..ok.clone() },
        UnixAccount { groups: vec![users(), "libvirt".into()], ..ok.clone() },
        UnixAccount { groups: vec![users(), "disk".into()], ..ok.clone() },
        UnixAccount { groups: vec!["alice".into()], ..ok.clone() },
        UnixAccount { name: names::gateway_account(), ..ok.clone() },
        UnixAccount { name: "al-ice".into(), ..ok.clone() },
    ];
    for account in refused {
        assert!(check_linkable(&accounts, &account).is_err(), "{account:?}");
    }
    assert!(check_linkable(&accounts, &UnixAccount { groups: vec!["alice".into()], ..ok }).unwrap_err().contains("usermod -aG"));
}

/// P3 review finding 11 (user decision 2026-10-03): any sudoers rule naming
/// the account refuses it — the admin role included — and so does a sudoers
/// the helper cannot read completely.
#[test]
fn an_account_sudo_grants_anything_is_never_linked() {
    let ok = UnixAccount { name: "alice".into(), uid: 1001, gid: 1001, home: "/home/alice".into(), groups: vec!["alice".into(), users()] };
    let accounts = FakeAccounts::default();
    let plain = sudoers_root("root ALL=(ALL:ALL) ALL\n%sudo ALL=(ALL:ALL) ALL\n");
    *accounts.sudoers_root.borrow_mut() = Some(plain.path().into());
    check_linkable(&accounts, &ok).unwrap();
    let narrow = sudoers_root("root ALL=(ALL:ALL) ALL\nalice ALL=(root) NOPASSWD: /usr/bin/systemctl restart nginx\n");
    *accounts.sudoers_root.borrow_mut() = Some(narrow.path().into());
    assert!(check_linkable(&accounts, &ok).unwrap_err().contains("sudoers rule"));
    let missing = tempfile::tempdir().unwrap();
    *accounts.sudoers_root.borrow_mut() = Some(missing.path().into());
    assert!(check_linkable(&accounts, &ok).unwrap_err().contains("could not be checked"), "fail closed");
}

#[test]
fn a_sudoers_rule_added_after_planning_is_refused_at_execution() {
    let accounts = FakeAccounts::default().with("alice", 1001, &["alice", &users()]);
    let mut db = Db::default();
    db.add_account("alice", 1001, Role::Admin, 1).unwrap();
    let plan = plan_invite(&db, "alice").unwrap();
    let granted = sudoers_root("@includedir /etc/sudoers.d\n");
    std::fs::create_dir_all(granted.path().join("etc/sudoers.d")).unwrap();
    std::fs::write(granted.path().join("etc/sudoers.d/alice"), "alice ALL=(ALL) ALL\n").unwrap();
    *accounts.sudoers_root.borrow_mut() = Some(granted.path().into());
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx { accounts: &accounts, gateway_dir: dir.path().into(), now: 1 };
    let mut rec = Recorder::default();
    assert!(execute(&plan, &ctx, &mut rec).unwrap_err().contains("sudoers"), "an admin-role account too");
    assert!(rec.stdin_seen.is_empty(), "no invite was written");
}

#[test]
fn user_add_creates_a_missing_account_and_rechecks_it_before_touching_anything() {
    let accounts = FakeAccounts::default().with(&names::gateway_account(), 990, &[]);
    let plan = plan_user_add(&accounts, &Db::default(), "carol", Role::User, &Limits::default()).unwrap();
    let text = plan.to_string();
    assert!(text.contains(&format!("useradd --create-home --shell /bin/bash --groups {} carol", users())), "{text}");
    let order: Vec<&Step> = plan.steps.iter().collect();
    assert!(matches!(order[1], Step::CheckLinkable { .. }), "the new account is checked right after useradd");
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx { accounts: &accounts, gateway_dir: dir.path().into(), now: 100 };
    let mut rec = Recorder { accounts: Some(&accounts), ..Recorder::default() };
    execute(&plan, &ctx, &mut rec).unwrap();
    let log = rec.log.join("\n");
    assert!(log.contains("chmod /home/carol 700"), "{log}");
    assert!(log.contains(&format!("write /etc/systemd/system/{SLUG}-users-carol.slice 644")));
    assert!(log.contains(&format!("systemctl enable --now {}", names::serverd_unit("carol", "socket"))));
    assert!(log.contains(&format!("as carol: /usr/lib/{SLUG}/{SLUG}-serverd --write-invite {}", 100 + INVITE_TTL)), "{log}");
    assert!(log.contains("hand to"), "the table goes back to the gateway's account");
    // The code went on stdin, never into argv, and is printed routed.
    let (who, code) = &rec.stdin_seen[0];
    assert_eq!((who.as_str(), code.len()), ("carol", 8));
    assert!(!log.contains(&format!("--write-invite {code}")));
    assert!(log.contains(&format!("say pairing code for carol (single use, 24 h): carol:{code}")));
    let db = Db::load(dir.path()).unwrap();
    assert_eq!(db.account("carol").unwrap().uid, 1500);
    assert_eq!(db.account("carol").unwrap().invite_until, 100 + INVITE_TTL, "the gateway forwards pairs only while an invite is pending");
    assert!(audit::AuditLog::in_dir(dir.path()).rows().iter().any(|r| r.user == "carol" && r.verb == "user-add"));
}

#[test]
fn user_add_refuses_sudoers_strangers_and_bad_input_before_planning() {
    let accounts = FakeAccounts::default().with("bob", 1002, &["bob", "sudo", &users()]).with("dave", 1003, &["dave"]).with("svc", 120, &["svc", &users()]);
    let db = Db::default();
    assert!(plan_user_add(&accounts, &db, "bob", Role::User, &Limits::default()).unwrap_err().contains("sudo"));
    assert!(plan_user_add(&accounts, &db, "dave", Role::User, &Limits::default()).unwrap_err().contains(&users()));
    assert!(plan_user_add(&accounts, &db, "svc", Role::User, &Limits::default()).unwrap_err().contains("uid"));
    assert!(plan_user_add(&accounts, &db, "../etc", Role::User, &Limits::default()).is_err());
    assert!(plan_user_add(&accounts, &db, "erin", Role::User, &Limits { memory_max: "lots".into(), ..Limits::default() }).is_err());
    let mut db = Db::default();
    db.add_account("erin", 1004, Role::User, 1).unwrap();
    assert!(plan_user_add(&accounts, &db, "erin", Role::User, &Limits::default()).unwrap_err().contains("already"));
}

#[test]
fn an_account_that_became_a_sudoer_since_planning_is_refused_at_execution() {
    let accounts = FakeAccounts::default().with("alice", 1001, &["alice", &users()]);
    let mut db = Db::default();
    db.add_account("alice", 1001, Role::User, 1).unwrap();
    let plan = plan_invite(&db, "alice").unwrap();
    accounts.accounts.borrow_mut().get_mut("alice").unwrap().groups.push("sudo".into());
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx { accounts: &accounts, gateway_dir: dir.path().into(), now: 1 };
    let mut rec = Recorder::default();
    assert!(execute(&plan, &ctx, &mut rec).unwrap_err().contains("sudo"));
    assert!(rec.stdin_seen.is_empty(), "no invite was written");
}

#[test]
fn verbs_on_existing_users_take_names_from_the_table_only() {
    let mut db = Db::default();
    db.add_account("alice", 1001, Role::User, 1).unwrap();
    for plan in [plan_user_remove(&db, "zed"), plan_invite(&db, "zed"), plan_role(&db, "zed", Role::Admin), plan_device_revoke(&db, "zed", "dev_00000001")] {
        assert!(plan.unwrap_err().contains("not a server user"));
    }
    assert!(plan_device_revoke(&db, "alice", "../../x").is_err());
    assert!(plan_cli_install("claude").is_ok());
    assert!(plan_cli_install("../bin/sh").is_err());
    assert!(plan_cli_install("Claude Code").is_err());
    let remove = plan_user_remove(&db, "alice").unwrap().to_string();
    assert!(!remove.contains("userdel") && !remove.contains("rm "), "the account and its home are never deleted:\n{remove}");
    assert!(remove.contains(&format!("gpasswd --delete alice {}", users())));
    assert!(remove.contains(&format!("{SLUG}-gateway hub-forget alice")), "a removed account's hub ACL entries go too:\n{remove}");
    assert!(remove.contains(&format!("{SLUG}-gateway keys-forget alice")), "and every admin-key list it was on:\n{remove}");
}

#[test]
fn revoking_a_device_drops_the_route_and_asks_the_users_daemon_as_the_user() {
    let accounts = FakeAccounts::default().with("alice", 1001, &["alice", &users()]);
    let dir = tempfile::tempdir().unwrap();
    db::update(dir.path(), |db| {
        db.add_account("alice", 1001, Role::User, 1)?;
        db.add_device("alice", "dev_alice_0001", "Phone", 2)
    })
    .unwrap();
    let plan = plan_device_revoke(&Db::load(dir.path()).unwrap(), "alice", "dev_alice_0001").unwrap();
    let ctx = Ctx { accounts: &accounts, gateway_dir: dir.path().into(), now: 3 };
    let mut rec = Recorder::default();
    execute(&plan, &ctx, &mut rec).unwrap();
    assert!(!Db::load(dir.path()).unwrap().routes("alice", "dev_alice_0001"));
    assert_eq!(rec.stdin_seen, vec![("alice".to_string(), "dev_alice_0001".to_string())]);
    assert!(rec.log.iter().any(|l| l.ends_with("--revoke-device")));
}

#[test]
fn install_creates_only_what_is_missing_and_never_runs_installers_as_root() {
    let accounts = FakeAccounts { groups: vec![users(), names::proc_group()], ..FakeAccounts::default() }.with(&names::gateway_account(), 990, &[]);
    let plan = plan_install(&accounts, "https://desk.example.ts.net", Some("https://desk.example.ts.net:8443")).unwrap();
    let text = plan.to_string();
    assert!(!text.contains("groupadd"), "the group exists");
    assert!(!text.contains(&format!("--shell /usr/sbin/nologin {}\n", names::gateway_account())), "the gateway account exists");
    assert!(text.contains(&names::cli_account()));
    assert!(text.contains("systemd-tmpfiles --create") && text.contains(&format!("enable --now {SLUG}-gateway.service")));
    // The key keeper (plan §5.4): its own system account, its socket unit
    // enabled, its key directory left to systemd (`StateDirectory=`, 0700).
    assert!(text.contains(&format!("--shell /usr/sbin/nologin {}\n", names::auth_account())), "{text}");
    assert!(text.contains(&format!("enable --now {SLUG}-auth-keeper.socket")));
    assert!(!text.contains(&names::keeper_state_dir().display().to_string()), "the helper never makes or chowns the key directory");
    // The share hub (plan §6.2): its own account, the shared root `0711` and
    // the hub's, `/srv/<slug>` root's, its socket enabled.
    assert!(text.contains(&format!("--shell /usr/sbin/nologin {}\n", names::hub_account())), "{text}");
    assert!(text.contains(&format!("directory /srv/{SLUG}/shared (711, {})", names::hub_account())), "{text}");
    assert!(text.contains(&format!("directory /srv/{SLUG} (755, root)")), "{text}");
    assert!(text.contains(&format!("enable --now {SLUG}-hub.socket")));
    // The shared-calendar service (plan §6.7): its own account and socket.
    assert!(text.contains(&format!("--shell /usr/sbin/nologin {}\n", names::calendar_account())), "{text}");
    assert!(text.contains(&format!("enable --now {SLUG}-calendar.socket")));
    assert!(!text.contains(&names::calendar_state_dir().display().to_string()), "the helper never makes the calendar store");
    let with_auth = FakeAccounts { groups: vec![users(), names::proc_group()], ..FakeAccounts::default() }.with(&names::auth_account(), 992, &[]);
    assert!(!plan_install(&with_auth, "https://desk.example.ts.net", None).unwrap().to_string().contains(&format!("nologin {}\n", names::auth_account())));
    assert!(plan_install(&accounts, "http://plain.example", None).is_err());
    let cli = plan_cli_install("codex").unwrap();
    let accounts = accounts.with(&names::cli_account(), 991, &[]);
    let dir = tempfile::tempdir().unwrap();
    let mut rec = Recorder::default();
    execute(&cli, &Ctx { accounts: &accounts, gateway_dir: dir.path().into(), now: 1 }, &mut rec).unwrap();
    assert!(rec.log[0].starts_with(&format!("as {}: ", names::cli_account())), "{:?}", rec.log);
    assert!(rec.log[0].ends_with("--install-cli codex"));
}

#[test]
fn check_reads_each_server_users_home() {
    struct P;
    impl prereq::Probe for P {
        fn read(&self, _: &Path) -> Option<String> {
            None
        }
        fn mode_owner(&self, path: &Path) -> Option<(u32, u32)> {
            (path == Path::new("/home/alice")).then_some((0o40755, 1001))
        }
        fn run(&self, _: &[&str]) -> Result<String, String> {
            Err("no".into())
        }
    }
    let accounts = FakeAccounts::default().with("alice", 1001, &["alice", &users()]);
    let mut db = Db::default();
    db.add_account("alice", 1001, Role::User, 1).unwrap();
    let homes = plan_check(&accounts, &db, &P).into_iter().find(|c| c.id == "homes_0700").unwrap();
    assert_eq!(homes.verdict, prereq::Verdict::Fail);
    assert!(homes.detail.contains("alice"));
}

#[test]
fn only_a_plain_singly_linked_file_is_handed_to_the_gateway() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("gateway.json");
    std::fs::write(&file, b"{}").unwrap();
    assert!(chown_target_ok(&std::fs::metadata(&file).unwrap()));
    // A hard link the gateway's account planted to another file: never chowned.
    std::fs::hard_link(&file, dir.path().join("gateway.lock")).unwrap();
    assert!(!chown_target_ok(&std::fs::metadata(&file).unwrap()));
    assert!(!chown_target_ok(&std::fs::metadata(dir.path()).unwrap()), "a directory");
}

#[test]
fn a_command_as_an_account_starts_in_its_home_with_a_clean_environment() {
    let cli = UnixAccount { name: names::cli_account(), uid: 997, gid: 997, home: names::cli_root(), groups: vec![] };
    let command = run_as_command(&cli, &["/usr/lib/x/serverd".into(), "--install-cli".into(), "claude".into()]);
    assert_eq!(command.get_current_dir(), Some(names::cli_root().as_path()), "never the admin's cwd (an installer reads ./.npmrc)");
    let args: Vec<String> = command.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
    assert_eq!(&args[..5], ["-u", names::cli_account().as_str(), "--", "env", "-i"]);
    assert!(args.iter().any(|a| a.ends_with(&format!("SERVER_CLI_ROOT={}", names::cli_root().display()))), "{args:?}");
    assert_eq!(args.last().map(String::as_str), Some("claude"));
    let alice = UnixAccount { name: "alice".into(), uid: 1001, gid: 1001, home: "/home/alice".into(), groups: vec![] };
    let command = run_as_command(&alice, &["x".into()]);
    assert_eq!(command.get_current_dir(), Some(std::path::Path::new("/home/alice")));
    assert!(!command.get_args().any(|a| a.to_string_lossy().contains("SERVER_CLI_ROOT")), "only the CLI account gets the install root");
}

/// The machine may be someone's desktop (user decision 2026-10-03): `/proc`
/// is hidepid=invisible with an exception group that polkit is given by a
/// drop-in — never a server user — and the fstab line is printed, not applied.
#[test]
fn install_prepares_the_proc_exception_group_and_only_prints_the_mount_line() {
    let accounts = FakeAccounts { groups: vec![users()], ..FakeAccounts::default() }.with(&names::gateway_account(), 990, &[]);
    let plan = plan_install(&accounts, "https://desk.example.ts.net", None).unwrap();
    let text = plan.to_string();
    assert!(text.contains(&format!("groupadd --system {}", names::proc_group())), "{text}");
    assert!(text.contains(&names::proc_dropin("polkit.service").display().to_string()));
    assert!(text.contains("systemctl try-restart polkit.service"));
    assert!(text.contains("print (not applied) the /etc/fstab line") && text.contains("hidepid=invisible"), "{text}");
    let accounts = FakeAccounts { groups: vec![users(), names::proc_group()], ..FakeAccounts::default() }
        .with(&names::gateway_account(), 990, &[])
        .with(&names::cli_account(), 991, &[])
        .with(&names::hub_account(), 988, &[])
        .with("root", 0, &[]);
    let plan = plan_install(&accounts, "https://desk.example.ts.net", None).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let mut rec = Recorder { accounts: Some(&accounts), ..Recorder::default() };
    execute(&plan, &Ctx { accounts: &accounts, gateway_dir: dir.path().into(), now: 1 }, &mut rec).unwrap();
    let log = rec.log.join("\n");
    assert!(log.contains("SupplementaryGroups") || log.contains(&names::proc_dropin("polkit.service").display().to_string()), "{log}");
    assert!(log.contains("proc /proc proc defaults,nosuid,nodev,noexec,hidepid=invisible,gid=989 0 0"), "{log}");
    assert!(!rec.log.iter().any(|l| !l.starts_with("say ") && (l.contains("mount") || l.contains("fstab"))), "nothing mounts or writes fstab: {log}");
    // A member of the exception group is never linked.
    let member = UnixAccount { name: "alice".into(), uid: 1001, gid: 1001, home: "/home/alice".into(), groups: vec![users(), names::proc_group()] };
    assert!(check_account(&member).unwrap_err().contains("exception group"));
}

/// P5 OIDC: the provider's settings land in the gateway's state with the
/// secret from stdin only; a link goes to the table (routing) and, by the
/// user's own uid, to the daemon's binding (authority).
#[test]
fn oidc_set_reads_the_secret_from_stdin_and_a_link_reaches_both_sides() {
    let accounts = FakeAccounts::default().with(&names::gateway_account(), 990, &[]).with("alice", 1001, &["alice", &users()]).with("bob", 1002, &["bob", &users()]);
    let dir = tempfile::tempdir().unwrap();
    db::update(dir.path(), |db| {
        db.add_account("alice", 1001, Role::User, 1)?;
        db.add_account("bob", 1002, Role::User, 1)
    })
    .unwrap();
    assert!(plan_oidc_set("http://idp.example", "desk", "Lab SSO").is_err(), "https only");
    assert!(plan_oidc_set("https://idp.example", "desk", "").is_err());
    let set = plan_oidc_set("https://idp.example/realms/lab/", "desk", "Lab SSO").unwrap();
    let text = set.to_string();
    assert!(text.contains("https://idp.example/realms/lab (client desk") && text.contains("stdin"), "{text}");
    let ctx = Ctx { accounts: &accounts, gateway_dir: dir.path().into(), now: 5 };
    let link = |sub: &str| Some(crate::oidc_wire::Link { claim: "sub".into(), value: sub.into() });
    // Linking before a provider exists fails at execution.
    let early = plan_user_oidc(&Db::load(dir.path()).unwrap(), "alice", link("u-1")).unwrap();
    assert!(execute(&early, &ctx, &mut Recorder::default()).unwrap_err().contains("oidc-set"));
    assert!(execute(&set, &ctx, &mut Recorder::default()).unwrap_err().contains("no input"), "no secret, nothing written");
    assert!(crate::oidc::OidcConfig::load(dir.path()).is_none());
    let mut rec = Recorder { secret: Some("fake-client-pass".into()), ..Recorder::default() };
    execute(&set, &ctx, &mut rec).unwrap();
    let config = crate::oidc::OidcConfig::load(dir.path()).unwrap();
    assert_eq!((config.issuer.as_str(), config.client_secret.as_str()), ("https://idp.example/realms/lab", "fake-client-pass"));
    assert!(rec.log.iter().any(|l| l.starts_with("hand to")), "the gateway's account must read it");
    let plan = plan_user_oidc(&Db::load(dir.path()).unwrap(), "alice", link("u-1")).unwrap();
    let mut rec = Recorder::default();
    execute(&plan, &ctx, &mut rec).unwrap();
    assert!(rec.log.iter().any(|l| l == &format!("as alice: /usr/lib/{SLUG}/{SLUG}-serverd --write-oidc-binding")), "{:?}", rec.log);
    let (who, binding) = &rec.stdin_seen[0];
    let binding: crate::oidc_wire::Binding = serde_json::from_str(binding).unwrap();
    assert_eq!((who.as_str(), binding.issuer.as_str(), binding.client_id.as_str(), binding.link.value.as_str()), ("alice", "https://idp.example/realms/lab", "desk", "u-1"));
    assert!(!rec.stdin_seen[0].1.contains("fake-client-pass"), "the daemon never gets the client secret");
    assert_eq!(Db::load(dir.path()).unwrap().account("alice").unwrap().oidc, link("u-1"));
    // One person, one account.
    assert!(plan_user_oidc(&Db::load(dir.path()).unwrap(), "bob", link("U-1")).unwrap_err().contains("already linked"));
    let unlink = plan_user_oidc(&Db::load(dir.path()).unwrap(), "alice", None).unwrap();
    let mut rec = Recorder::default();
    execute(&unlink, &ctx, &mut rec).unwrap();
    assert_eq!(rec.stdin_seen[0].1, "", "an empty binding removes the daemon's");
    assert_eq!(Db::load(dir.path()).unwrap().account("alice").unwrap().oidc, None);
}

#[test]
fn invite_codes_are_eight_digits_from_the_whole_range() {
    let codes: Vec<String> = (0..2000).map(|_| eight_digits()).collect();
    assert!(codes.iter().all(|c| c.len() == 8 && c.bytes().all(|b| b.is_ascii_digit())), "{codes:?}");
    // Every leading digit turns up: no bias toward the low codes, and the
    // zero padding is kept (a code below 10^7 starts with '0').
    for d in b'0'..=b'9' {
        assert!(codes.iter().any(|c| c.as_bytes()[0] == d), "no code starts with {}", d as char);
    }
}
