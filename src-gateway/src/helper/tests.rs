//! The helper's plans and hard rules against a fake machine. Nothing here
//! needs root: execution goes through a recording [`Exec`].

use super::*;
use std::cell::RefCell;
use std::collections::HashMap;

#[derive(Default)]
struct FakeAccounts {
    accounts: RefCell<HashMap<String, UnixAccount>>,
    groups: Vec<String>,
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
    fn group_exists(&self, name: &str) -> bool {
        self.groups.iter().any(|g| g == name)
    }
}

#[derive(Default)]
struct Recorder<'a> {
    log: Vec<String>,
    /// `useradd` "creates" the account here, as the real one would.
    accounts: Option<&'a FakeAccounts>,
    stdin_seen: Vec<(String, String)>,
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
}

fn users() -> String {
    names::users_group()
}

#[test]
fn only_regular_non_admin_members_of_the_users_group_are_linked() {
    let ok = UnixAccount { name: "alice".into(), uid: 1001, gid: 1001, home: "/home/alice".into(), groups: vec!["alice".into(), users()] };
    assert!(check_linkable(&ok).is_ok());
    let refused = [
        UnixAccount { uid: 0, ..ok.clone() },
        UnixAccount { uid: 999, ..ok.clone() },
        UnixAccount { uid: 65534, ..ok.clone() },
        UnixAccount { groups: vec![users(), "sudo".into()], ..ok.clone() },
        UnixAccount { groups: vec![users(), "wheel".into()], ..ok.clone() },
        UnixAccount { groups: vec!["alice".into()], ..ok.clone() },
        UnixAccount { name: names::gateway_account(), ..ok.clone() },
        UnixAccount { name: "al-ice".into(), ..ok.clone() },
    ];
    for account in refused {
        assert!(check_linkable(&account).is_err(), "{account:?}");
    }
    assert!(check_linkable(&UnixAccount { groups: vec!["alice".into()], ..ok }).unwrap_err().contains("usermod -aG"));
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
    let accounts = FakeAccounts { groups: vec![users()], ..FakeAccounts::default() }.with(&names::gateway_account(), 990, &[]);
    let plan = plan_install(&accounts, "https://desk.example.ts.net", Some("https://desk.example.ts.net:8443")).unwrap();
    let text = plan.to_string();
    assert!(!text.contains("groupadd"), "the group exists");
    assert!(!text.contains(&format!("--shell /usr/sbin/nologin {}\n", names::gateway_account())), "the gateway account exists");
    assert!(text.contains(&names::cli_account()));
    assert!(text.contains("systemd-tmpfiles --create") && text.contains(&format!("enable --now {SLUG}-gateway.service")));
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
