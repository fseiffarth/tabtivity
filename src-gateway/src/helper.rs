//! The admin helper (hosted plan §3.1, §4.1, §5.1): the server's only root
//! code, a fixed verb set the admin runs with `sudo`. Each verb is first a
//! [`Plan`] — a list of [`Step`]s built from the machine's accounts and the
//! gateway's table — which `--dry-run` prints and [`execute`] runs.
//!
//! **Hard rules** (each enforced below and tested):
//! * **Names, never paths.** Verbs take an account name (validated as
//!   `wire::valid_account_name`), a device id or a CLI id; every path is
//!   built here from fixed roots. Nothing a daemon wrote is ever read as an
//!   argument.
//! * **It never copies or chowns a user's tree.** It makes one directory
//!   `0700` (the home, opened `O_NOFOLLOW | O_DIRECTORY`, then `fchmod`);
//!   anything written into a user's state — the invite — is written by that
//!   user's own uid (`runuser`), with the code on stdin, not in `argv`.
//! * **Only real people.** It links an existing account only when its uid is
//!   ≥ 1000 (not `nobody`), it is already in `<slug>-users` (the admin's
//!   deliberate step), it is in no root-equivalent group ([`ADMIN_GROUPS`]:
//!   `sudo`, `wheel`, `admin`, `root`, and `docker`, `lxd`, `incus-admin`,
//!   `libvirt`, `disk`), sudoers names it in no rule ([`crate::sudoers`],
//!   read-only, fail closed), and it is not one of the server's own service
//!   accounts — re-checked at execution, after `useradd`, not only at
//!   planning. This holds for admin-role accounts too: an admin who needs
//!   Docker or VMs uses a separate, unlinked account for them.
//! * **No root verbs for the gateway.** Daemons start by socket activation,
//!   so the gateway never calls this; there is no polkit rule.
//! * CLI installs run as `<slug>-cli` into the server-wide root, never as root
//!   (vendor install scripts are code).

use std::fmt;
use std::path::{Path, PathBuf};

use crate::brand::{SERVER_ACCOUNT_PREFIX, SLUG};
use crate::db::{self, Db, Role};
use crate::units::{self, Deployment, Limits};
use crate::{audit, names, prereq, wire};

/// Groups whose members are never linked: they can become root anyway — by
/// `sudo`, or through a daemon socket or device that is root on the host
/// (Docker, LXD/Incus, libvirt, raw disks). User decision 2026-10-03.
pub const ADMIN_GROUPS: &[&str] = &["sudo", "wheel", "admin", "root", "docker", "lxd", "incus-admin", "libvirt", "disk"];
/// How long an invite may be redeemed (`auth::INVITE_TTL`).
pub const INVITE_TTL: u64 = 24 * 60 * 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnixAccount {
    pub name: String,
    pub uid: u32,
    pub gid: u32,
    pub home: PathBuf,
    pub groups: Vec<String>,
}

/// The machine's account database.
pub trait Accounts {
    fn lookup(&self, name: &str) -> Option<UnixAccount>;
    fn group_exists(&self, name: &str) -> bool {
        self.group_gid(name).is_some()
    }
    fn group_gid(&self, name: &str) -> Option<u32>;
    /// The first sudoers rule naming `account`; an error when sudoers cannot
    /// be read completely (the caller refuses then).
    fn sudo_rule(&self, account: &UnixAccount) -> Result<Option<String>, String>;
}

/// Why an account may not be a server user, or `Ok`: [`check_account`],
/// then sudoers.
pub fn check_linkable(accounts: &dyn Accounts, account: &UnixAccount) -> Result<(), String> {
    check_account(account)?;
    match accounts.sudo_rule(account) {
        Ok(None) => Ok(()),
        Ok(Some(rule)) => Err(format!("{} is named by a sudoers rule ({rule}): an account sudo grants anything is never a server user", account.name)),
        Err(error) => Err(format!("{}: sudoers could not be checked, so the account is refused: {error}", account.name)),
    }
}

/// The checks on the account record alone (name, uid, groups).
pub fn check_account(account: &UnixAccount) -> Result<(), String> {
    if !wire::valid_account_name(&account.name) {
        return Err(format!("{:?} is not a name the server accepts (a-z, 0-9, _; no dashes)", account.name));
    }
    if account.name.starts_with(SERVER_ACCOUNT_PREFIX) {
        return Err(format!("{} is one of the server's own service accounts", account.name));
    }
    if account.uid < 1000 || account.uid == 65534 {
        return Err(format!("{} has uid {}: only regular accounts (uid >= 1000) are linked", account.name, account.uid));
    }
    if let Some(group) = account.groups.iter().find(|g| ADMIN_GROUPS.contains(&g.as_str())) {
        return Err(format!("{} is in {group}: an account that can become root is never a server user", account.name));
    }
    if account.groups.contains(&names::proc_group()) {
        return Err(format!("{} is in {}, the /proc exception group: a server user must not see other users' processes", account.name, names::proc_group()));
    }
    if !account.groups.contains(&names::users_group()) {
        return Err(format!("{} is not in {}: add them first (usermod -aG {} {})", account.name, names::users_group(), names::users_group(), account.name));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// A command, as root.
    Run(Vec<String>),
    /// Write a file (`O_NOFOLLOW`), replacing it.
    Write { path: PathBuf, contents: String, mode: u32 },
    Remove(PathBuf),
    /// Make the user's home `0700`.
    HomePrivate { user: String },
    /// A directory owned by `owner`, `mode` (the CLI install root).
    OwnedDir { path: PathBuf, mode: u32, owner: String },
    /// `/etc/<slug>/server.env`, with the gateway account's uid looked up then.
    ServerEnv { origin: String, content_origin: Option<String> },
    /// [`check_linkable`] at execution time.
    CheckLinkable { user: String },
    DbAdd { user: String, role: Role },
    DbRemove { user: String },
    DbRole { user: String, role: Role },
    DbRevoke { user: String, device: String },
    /// A fresh single-use code, written by the user's own uid; printed as
    /// `user:code`.
    Invite { user: String },
    /// A CLI installed or updated by `<slug>-cli` into the install root.
    CliInstall { id: String },
    /// Print the `/etc/fstab` line for `/proc` (`hidepid=invisible`, the
    /// exception group's gid, looked up at execution) and how to apply it.
    /// Never applied by the helper: remounting `/proc` on a live machine —
    /// someone's desktop — is the admin's step.
    ProcMountLine,
    Audit { user: String, verb: String },
}

impl fmt::Display for Step {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Step::Run(argv) => write!(f, "run: {}", argv.join(" ")),
            Step::Write { path, mode, .. } => write!(f, "write {} ({mode:o})", path.display()),
            Step::Remove(path) => write!(f, "remove {}", path.display()),
            Step::HomePrivate { user } => write!(f, "chmod 0700 the home of {user} (O_NOFOLLOW)"),
            Step::OwnedDir { path, mode, owner } => write!(f, "directory {} ({mode:o}, {owner})", path.display()),
            Step::ServerEnv { .. } => write!(f, "write {} (0644)", names::server_env_file().display()),
            Step::CheckLinkable { user } => write!(f, "check {user} may be a server user"),
            Step::DbAdd { user, role } => write!(f, "gateway table: add {user} as {}", role.as_str()),
            Step::DbRemove { user } => write!(f, "gateway table: remove {user} and their devices"),
            Step::DbRole { user, role } => write!(f, "gateway table: {user} becomes {}", role.as_str()),
            Step::DbRevoke { user, device } => write!(f, "gateway table: revoke {user}'s device {device}"),
            Step::Invite { user } => write!(f, "invite: a new pairing code for {user}, written as {user}"),
            Step::CliInstall { id } => write!(f, "install or update the {id} CLI as {} into {}", names::cli_account(), names::cli_root().display()),
            Step::Audit { user, verb } => write!(f, "audit: {verb} {user}"),
            Step::ProcMountLine => write!(
                f,
                "print (not applied) the /etc/fstab line: {} — then `mount -o remount /proc`",
                crate::units::proc_fstab_line(0).replace("gid=0", &format!("gid=<gid of {}>", names::proc_group()))
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub verb: String,
    pub steps: Vec<Step>,
}

impl fmt::Display for Plan {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "{} — {} step(s):", self.verb, self.steps.len())?;
        for (i, step) in self.steps.iter().enumerate() {
            writeln!(f, "  {:>2}. {step}", i + 1)?;
        }
        Ok(())
    }
}

fn run(argv: &[&str]) -> Step {
    Step::Run(argv.iter().map(|s| s.to_string()).collect())
}

fn known(db: &Db, user: &str) -> Result<(), String> {
    if !wire::valid_account_name(user) {
        return Err(format!("{user:?} is not an account name"));
    }
    db.account(user).map(|_| ()).ok_or_else(|| format!("{user} is not a server user"))
}

/// `install`: service accounts, units, runtime dirs, the CLI root, the gateway.
pub fn plan_install(accounts: &dyn Accounts, origin: &str, content_origin: Option<&str>) -> Result<Plan, String> {
    let origin = crate::config::validate_origin(origin)?;
    let content_origin = content_origin.map(crate::config::validate_origin).transpose()?;
    if content_origin.as_deref() == Some(origin.as_str()) {
        return Err("the user-content origin must differ from the app's origin".into());
    }
    let nologin = "/usr/sbin/nologin";
    let mut steps = Vec::new();
    if !accounts.group_exists(&names::users_group()) {
        steps.push(run(&["groupadd", "--system", &names::users_group()]));
    }
    let gw = names::gateway_account();
    if accounts.lookup(&gw).is_none() {
        steps.push(run(&["useradd", "--system", "--user-group", "--no-create-home", "--home-dir", "/nonexistent", "--shell", nologin, &gw]));
    }
    let cli = names::cli_account();
    let cli_root = names::cli_root();
    if accounts.lookup(&cli).is_none() {
        steps.push(run(&["useradd", "--system", "--user-group", "--no-create-home", "--home-dir", &cli_root.to_string_lossy(), "--shell", nologin, &cli]));
    }
    steps.push(Step::OwnedDir { path: cli_root, mode: 0o755, owner: cli });
    // The key keeper's account (plan §5.4): holds the administrator's agent
    // API keys; its state directory is systemd's (`StateDirectory=`, 0700).
    let auth = names::auth_account();
    if accounts.lookup(&auth).is_none() {
        steps.push(run(&["useradd", "--system", "--user-group", "--no-create-home", "--home-dir", "/nonexistent", "--shell", nologin, &auth]));
    }
    // `/proc` hidepid=invisible with an exception group for the system
    // services that must see every process (polkit, on a desktop machine).
    if !accounts.group_exists(&names::proc_group()) {
        steps.push(run(&["groupadd", "--system", &names::proc_group()]));
    }
    for unit in names::PROC_EXCEPTION_UNITS {
        steps.push(Step::Write { path: names::proc_dropin(unit), contents: crate::units::proc_dropin(), mode: 0o644 });
    }
    steps.push(Step::ServerEnv { origin: origin.clone(), content_origin: content_origin.clone() });
    let probe = Deployment { origin, content_origin, gateway_uid: 0 };
    for (path, contents, mode) in units::render_all(&probe).into_iter().skip(1) {
        steps.push(Step::Write { path, contents, mode });
    }
    steps.push(run(&["systemd-tmpfiles", "--create"]));
    steps.push(run(&["systemctl", "daemon-reload"]));
    steps.push(run(&["systemctl", "enable", "--now", &names::gateway_unit()]));
    steps.push(run(&["systemctl", "enable", "--now", &names::keeper_unit("socket")]));
    for unit in names::PROC_EXCEPTION_UNITS {
        steps.push(run(&["systemctl", "try-restart", unit]));
    }
    steps.push(Step::ProcMountLine);
    Ok(Plan { verb: "install".into(), steps })
}

/// `user-add`: create or link the account, its slice and socket, its row,
/// its first invite.
pub fn plan_user_add(accounts: &dyn Accounts, db: &Db, user: &str, role: Role, limits: &Limits) -> Result<Plan, String> {
    if !wire::valid_account_name(user) {
        return Err(format!("{user:?} is not a name the server accepts (a-z, 0-9, _; starts with a letter; no dashes)"));
    }
    if user.starts_with(SERVER_ACCOUNT_PREFIX) {
        return Err(format!("{user} is reserved for the server's own accounts"));
    }
    limits.validate()?;
    if db.account(user).is_some() {
        return Err(format!("{user} is already a server user (use `invite` for a new code)"));
    }
    let mut steps = Vec::new();
    match accounts.lookup(user) {
        Some(account) => check_linkable(accounts, &account)?,
        None => steps.push(run(&["useradd", "--create-home", "--shell", "/bin/bash", "--groups", &names::users_group(), user])),
    }
    steps.push(Step::CheckLinkable { user: user.into() });
    steps.push(Step::HomePrivate { user: user.into() });
    steps.push(Step::Write { path: units::user_slice_path(user), contents: units::user_slice(user, limits), mode: 0o644 });
    steps.push(run(&["systemctl", "daemon-reload"]));
    steps.push(Step::DbAdd { user: user.into(), role });
    steps.push(run(&["systemctl", "enable", "--now", &names::serverd_unit(user, "socket")]));
    steps.push(Step::Invite { user: user.into() });
    steps.push(Step::Audit { user: user.into(), verb: "user-add".into() });
    Ok(Plan { verb: format!("user-add {user}"), steps })
}

/// `user-remove`: stop and disable the units, drop the slice and the row.
/// Never deletes the Unix account or its home.
pub fn plan_user_remove(db: &Db, user: &str) -> Result<Plan, String> {
    known(db, user)?;
    Ok(Plan {
        verb: format!("user-remove {user}"),
        steps: vec![
            Step::DbRemove { user: user.into() },
            run(&["systemctl", "disable", "--now", &names::serverd_unit(user, "socket"), &names::serverd_unit(user, "service"), &names::tmux_unit(user)]),
            Step::Remove(units::user_slice_path(user)),
            run(&["systemctl", "daemon-reload"]),
            run(&["gpasswd", "--delete", user, &names::users_group()]),
            Step::Audit { user: user.into(), verb: "user-remove".into() },
        ],
    })
}

pub fn plan_invite(db: &Db, user: &str) -> Result<Plan, String> {
    known(db, user)?;
    Ok(Plan { verb: format!("invite {user}"), steps: vec![Step::CheckLinkable { user: user.into() }, Step::Invite { user: user.into() }, Step::Audit { user: user.into(), verb: "invite".into() }] })
}

pub fn plan_role(db: &Db, user: &str, role: Role) -> Result<Plan, String> {
    known(db, user)?;
    Ok(Plan { verb: format!("role {user} {}", role.as_str()), steps: vec![Step::DbRole { user: user.into(), role }, Step::Audit { user: user.into(), verb: format!("role-{}", role.as_str()) }] })
}

/// `device-revoke`: the gateway stops routing the device and closes its
/// sockets within a reload; the user's daemon drops its key too.
pub fn plan_device_revoke(db: &Db, user: &str, device: &str) -> Result<Plan, String> {
    known(db, user)?;
    if !wire::valid_device_id(device) {
        return Err(format!("{device:?} is not a device id"));
    }
    Ok(Plan {
        verb: format!("device-revoke {user} {device}"),
        steps: vec![Step::DbRevoke { user: user.into(), device: device.into() }, Step::Audit { user: user.into(), verb: "device-revoke".into() }],
    })
}

/// The CLI ids the daemon's installer knows; the helper passes nothing else.
pub fn valid_cli_id(id: &str) -> bool {
    (1..=32).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub fn plan_cli_install(id: &str) -> Result<Plan, String> {
    if !valid_cli_id(id) {
        return Err(format!("{id:?} is not a CLI id"));
    }
    Ok(Plan { verb: format!("cli-install {id}"), steps: vec![Step::CliInstall { id: id.into() }, Step::Audit { user: names::cli_account(), verb: format!("cli-install-{id}") }] })
}

/// What execution needs of the machine.
pub trait Exec {
    fn run(&mut self, argv: &[String]) -> Result<(), String>;
    /// Run `argv` as `user` with a clean environment and `stdin` fed.
    fn run_as(&mut self, account: &UnixAccount, argv: &[String], stdin: &str) -> Result<(), String>;
    fn write(&mut self, path: &Path, contents: &str, mode: u32) -> Result<(), String>;
    fn remove(&mut self, path: &Path) -> Result<(), String>;
    fn chmod_home(&mut self, home: &Path, mode: u32) -> Result<(), String>;
    fn owned_dir(&mut self, path: &Path, mode: u32, owner: &UnixAccount) -> Result<(), String>;
    /// Give the gateway's state files to its account (after a root write).
    fn hand_to_gateway(&mut self, dir: &Path, gateway: &UnixAccount) -> Result<(), String>;
    fn say(&mut self, line: &str);
}

/// Where execution writes the gateway's table and audit log.
pub struct Ctx<'a> {
    pub accounts: &'a dyn Accounts,
    pub gateway_dir: PathBuf,
    pub now: u64,
}

fn eight_digits() -> String {
    use rand::Rng;
    format!("{:08}", rand::rngs::OsRng.gen_range(0..100_000_000u32))
}

/// Run `plan`, step by step; the first failure stops it.
pub fn execute(plan: &Plan, ctx: &Ctx, exec: &mut dyn Exec) -> Result<(), String> {
    let lookup = |name: &str| ctx.accounts.lookup(name).ok_or_else(|| format!("no account {name}"));
    let mut table_touched = false;
    for step in &plan.steps {
        match step {
            Step::Run(argv) => exec.run(argv)?,
            Step::Write { path, contents, mode } => exec.write(path, contents, *mode)?,
            Step::Remove(path) => exec.remove(path)?,
            Step::HomePrivate { user } => {
                let account = lookup(user)?;
                check_linkable(ctx.accounts, &account)?;
                exec.chmod_home(&account.home, 0o700)?;
            }
            Step::OwnedDir { path, mode, owner } => exec.owned_dir(path, *mode, &lookup(owner)?)?,
            Step::ServerEnv { origin, content_origin } => {
                let gw = lookup(&names::gateway_account())?;
                let d = Deployment { origin: origin.clone(), content_origin: content_origin.clone(), gateway_uid: gw.uid };
                std::fs::create_dir_all(names::etc_dir()).ok();
                exec.write(&names::server_env_file(), &units::server_env(&d), 0o644)?;
            }
            Step::CheckLinkable { user } => check_linkable(ctx.accounts, &lookup(user)?)?,
            Step::DbAdd { user, role } => {
                let account = lookup(user)?;
                check_linkable(ctx.accounts, &account)?;
                db::update(&ctx.gateway_dir, |db| db.add_account(user, account.uid, *role, ctx.now)).map_err(|e| e.to_string())?;
                table_touched = true;
            }
            Step::DbRemove { user } => {
                db::update(&ctx.gateway_dir, |db| db.remove_account(user).map(|_| ())).map_err(|e| e.to_string())?;
                table_touched = true;
            }
            Step::DbRole { user, role } => {
                db::update(&ctx.gateway_dir, |db| db.set_role(user, *role)).map_err(|e| e.to_string())?;
                table_touched = true;
            }
            Step::DbRevoke { user, device } => {
                let had = db::update(&ctx.gateway_dir, |db| db.revoke_device(user, device)).map_err(|e| e.to_string())?;
                table_touched = true;
                exec.say(if had { "the gateway no longer routes that device" } else { "the gateway had no route for that device" });
                // The daemon's own key, by the user's own uid.
                let account = lookup(user)?;
                let argv = vec![names::serverd_binary().to_string_lossy().into_owned(), "--revoke-device".into()];
                exec.run_as(&account, &argv, device)?;
            }
            Step::Invite { user } => {
                let account = lookup(user)?;
                check_linkable(ctx.accounts, &account)?;
                let code = eight_digits();
                let expires = ctx.now + INVITE_TTL;
                let argv = vec![names::serverd_binary().to_string_lossy().into_owned(), "--write-invite".into(), expires.to_string()];
                exec.run_as(&account, &argv, &code)?;
                // Only now may the gateway forward a pair to this account.
                db::update(&ctx.gateway_dir, |db| db.set_invite(user, expires)).map_err(|e| e.to_string())?;
                table_touched = true;
                exec.say(&format!("pairing code for {user} (single use, 24 h): {}", wire::routed_code(user, &code)));
            }
            Step::CliInstall { id } => {
                let cli = lookup(&names::cli_account())?;
                let argv = vec![names::serverd_binary().to_string_lossy().into_owned(), "--install-cli".into(), id.clone()];
                exec.run_as(&cli, &argv, "")?;
            }
            Step::Audit { user, verb } => {
                audit::AuditLog::in_dir(&ctx.gateway_dir).record(audit::Row::new(user, None, verb, "ok").resource("admin-helper"));
                table_touched = true;
            }
            Step::ProcMountLine => {
                let gid = ctx.accounts.group_gid(&names::proc_group()).ok_or_else(|| format!("no group {}", names::proc_group()))?;
                exec.say(&format!(
                    "/proc: put this line in /etc/fstab (replacing any proc line), then run `mount -o remount /proc` and `{} check`:\n  {}",
                    names::helper_binary().display(),
                    crate::units::proc_fstab_line(gid)
                ));
            }
        }
    }
    if table_touched {
        if let Some(gw) = ctx.accounts.lookup(&names::gateway_account()) {
            exec.hand_to_gateway(&ctx.gateway_dir, &gw)?;
        }
    }
    Ok(())
}

/// `check`: the §8 prerequisites, with every server user's home.
pub fn plan_check(accounts: &dyn Accounts, db: &Db, probe: &dyn prereq::Probe) -> Vec<prereq::Check> {
    let homes: Vec<(String, PathBuf)> = db.accounts.iter().filter_map(|a| accounts.lookup(&a.name).map(|u| (a.name.clone(), u.home))).collect();
    prereq::all(probe, &homes)
}

/// The real machine: `getpwnam_r`, `getgrouplist`, `getgrnam_r`.
pub struct SystemAccounts;

impl Accounts for SystemAccounts {
    fn lookup(&self, name: &str) -> Option<UnixAccount> {
        use std::ffi::{CStr, CString};
        let cname = CString::new(name).ok()?;
        let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
        let mut buf = vec![0 as libc::c_char; 16 * 1024];
        let mut result: *mut libc::passwd = std::ptr::null_mut();
        // SAFETY: every pointer is valid for the call; `buf` outlives the
        // borrowed strings we copy out below.
        let rc = unsafe { libc::getpwnam_r(cname.as_ptr(), &mut pwd, buf.as_mut_ptr(), buf.len(), &mut result) };
        if rc != 0 || result.is_null() {
            return None;
        }
        // SAFETY: pw_dir is a NUL-terminated string inside `buf`.
        let home = PathBuf::from(unsafe { CStr::from_ptr(pwd.pw_dir) }.to_string_lossy().into_owned());
        let mut count: libc::c_int = 64;
        let mut gids: Vec<libc::gid_t> = vec![0; count as usize];
        loop {
            // SAFETY: `gids` has room for `count` entries.
            let n = unsafe { libc::getgrouplist(cname.as_ptr(), pwd.pw_gid, gids.as_mut_ptr(), &mut count) };
            if n >= 0 {
                gids.truncate(n as usize);
                break;
            }
            gids.resize(count.max(1) as usize * 2, 0);
            count = gids.len() as libc::c_int;
        }
        let groups = gids.into_iter().filter_map(group_name).collect();
        Some(UnixAccount { name: name.into(), uid: pwd.pw_uid, gid: pwd.pw_gid, home, groups })
    }

    fn sudo_rule(&self, account: &UnixAccount) -> Result<Option<String>, String> {
        crate::sudoers::rule_for(Path::new("/"), &crate::sudoers::Subject { name: &account.name, uid: account.uid, gid: account.gid, groups: &account.groups })
    }

    fn group_gid(&self, name: &str) -> Option<u32> {
        let cname = std::ffi::CString::new(name).ok()?;
        let mut grp: libc::group = unsafe { std::mem::zeroed() };
        let mut buf = vec![0 as libc::c_char; 16 * 1024];
        let mut result: *mut libc::group = std::ptr::null_mut();
        // SAFETY: valid pointers for the call.
        let rc = unsafe { libc::getgrnam_r(cname.as_ptr(), &mut grp, buf.as_mut_ptr(), buf.len(), &mut result) };
        (rc == 0 && !result.is_null()).then_some(grp.gr_gid)
    }
}

fn group_name(gid: libc::gid_t) -> Option<String> {
    let mut grp: libc::group = unsafe { std::mem::zeroed() };
    let mut buf = vec![0 as libc::c_char; 16 * 1024];
    let mut result: *mut libc::group = std::ptr::null_mut();
    // SAFETY: valid pointers for the call; the name is copied before `buf` drops.
    let rc = unsafe { libc::getgrgid_r(gid, &mut grp, buf.as_mut_ptr(), buf.len(), &mut result) };
    if rc != 0 || result.is_null() {
        return None;
    }
    // SAFETY: gr_name is NUL-terminated inside `buf`.
    Some(unsafe { std::ffi::CStr::from_ptr(grp.gr_name) }.to_string_lossy().into_owned())
}

/// The real execution, as root.
pub struct SystemExec;

fn open_nofollow_dir(path: &Path) -> Result<std::fs::File, String> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
        .open(path)
        .map_err(|e| format!("{}: {e}", path.display()))
}

impl Exec for SystemExec {
    fn run(&mut self, argv: &[String]) -> Result<(), String> {
        let (program, args) = argv.split_first().ok_or("empty command")?;
        let status = std::process::Command::new(program).args(args).status().map_err(|e| format!("{program}: {e}"))?;
        status.success().then_some(()).ok_or_else(|| format!("{} failed: {status}", argv.join(" ")))
    }

    fn run_as(&mut self, account: &UnixAccount, argv: &[String], stdin: &str) -> Result<(), String> {
        use std::io::Write;
        let mut child = run_as_command(account, argv).stdin(std::process::Stdio::piped()).spawn().map_err(|e| format!("runuser: {e}"))?;
        if let Some(mut pipe) = child.stdin.take() {
            pipe.write_all(stdin.as_bytes()).map_err(|e| e.to_string())?;
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        status.success().then_some(()).ok_or_else(|| format!("{} as {} failed: {status}", argv.join(" "), account.name))
    }

    fn write(&mut self, path: &Path, contents: &str, mode: u32) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        crate::write_atomic(path, contents.as_bytes(), mode).map_err(|e| format!("{}: {e}", path.display()))
    }

    fn remove(&mut self, path: &Path) -> Result<(), String> {
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    }

    fn chmod_home(&mut self, home: &Path, mode: u32) -> Result<(), String> {
        use std::os::unix::fs::PermissionsExt;
        let dir = open_nofollow_dir(home)?;
        dir.set_permissions(std::fs::Permissions::from_mode(mode)).map_err(|e| format!("{}: {e}", home.display()))
    }

    fn owned_dir(&mut self, path: &Path, mode: u32, owner: &UnixAccount) -> Result<(), String> {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let dir = open_nofollow_dir(path)?;
        std::os::unix::fs::fchown(&dir, Some(owner.uid), Some(owner.gid)).map_err(|e| format!("{}: {e}", path.display()))?;
        dir.set_permissions(std::fs::Permissions::from_mode(mode)).map_err(|e| format!("{}: {e}", path.display()))
    }

    fn hand_to_gateway(&mut self, dir: &Path, gateway: &UnixAccount) -> Result<(), String> {
        for leaf in [db::DB_FILE, db::LOCK_FILE, audit::AUDIT_FILE] {
            let path = dir.join(leaf);
            if let Ok(file) = std::fs::OpenOptions::new().read(true).custom_flags_nofollow().open(&path) {
                // Only the plain file root just wrote: a hard link the
                // gateway's account planted to someone else's file is never
                // handed to it.
                let meta = file.metadata().map_err(|e| format!("{}: {e}", path.display()))?;
                if !chown_target_ok(&meta) {
                    return Err(format!("{}: not a plain file with one link; refusing to change its owner", path.display()));
                }
                std::os::unix::fs::fchown(&file, Some(gateway.uid), Some(gateway.gid)).map_err(|e| format!("{}: {e}", path.display()))?;
            }
        }
        Ok(())
    }

    fn say(&mut self, line: &str) {
        println!("{line}");
    }
}

/// May root hand this file to the gateway's account? A regular file with a
/// single link only (`fs.protected_hardlinks` normally stops the link being
/// made at all; this does not rely on it).
fn chown_target_ok(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    meta.is_file() && meta.nlink() == 1
}

/// `runuser -u <account> -- env -i <fixed env> <argv>`, started in the
/// account's own home: never in the admin's working directory, which may be a
/// directory a user controls — an installer reads project config from its
/// cwd (`npm` takes `./.npmrc`: a registry, scripts), and the CLI account's
/// installs are what every user then runs.
fn run_as_command(account: &UnixAccount, argv: &[String]) -> std::process::Command {
    let mut env = vec![
        format!("HOME={}", account.home.display()),
        format!("USER={}", account.name),
        format!("LOGNAME={}", account.name),
        "PATH=/usr/local/bin:/usr/bin:/bin".to_string(),
    ];
    if account.name == names::cli_account() {
        // The installer needs the root it installs into; `env -i` dropped everything.
        env.push(format!("{}={}", crate::brand::CURRENT.env_name(wire::env::CLI_ROOT), names::cli_root().display()));
    }
    let mut command = std::process::Command::new("runuser");
    command.args(["-u", &account.name, "--", "env", "-i"]).args(&env).args(argv).current_dir(&account.home);
    command
}

trait NoFollow {
    fn custom_flags_nofollow(&mut self) -> &mut Self;
}

impl NoFollow for std::fs::OpenOptions {
    fn custom_flags_nofollow(&mut self) -> &mut Self {
        use std::os::unix::fs::OpenOptionsExt;
        self.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
    }
}

/// The slug, for the binary's messages.
pub fn slug() -> &'static str {
    SLUG
}

#[cfg(test)]
mod tests;
