//! The server's fixed names and places (hosted plan §3.1, §8.1), each built
//! from the brand module so the app's name is spelled once.

use std::path::PathBuf;

use crate::brand::{SERVER_ACCOUNT_PREFIX, SLUG};

/// The gateway's service account and group (`<slug>-gw`).
pub fn gateway_account() -> String {
    format!("{SERVER_ACCOUNT_PREFIX}gw")
}

/// The group every server user is in (`<slug>-users`); the helper links only
/// its members.
pub fn users_group() -> String {
    format!("{SERVER_ACCOUNT_PREFIX}users")
}

/// The account that owns the server-wide CLI install root (`<slug>-cli`).
pub fn cli_account() -> String {
    format!("{SERVER_ACCOUNT_PREFIX}cli")
}

/// The account that holds the administrator's agent API keys
/// (`<slug>-auth`, the key keeper's; plan §5.4).
pub fn auth_account() -> String {
    format!("{SERVER_ACCOUNT_PREFIX}auth")
}

/// The share hub's account (`<slug>-hub`, plan §6.2): owns every bare hub
/// under [`shared_root`] and is the only uid that ever writes one.
pub fn hub_account() -> String {
    format!("{SERVER_ACCOUNT_PREFIX}hub")
}

/// The shared-calendar service's account (`<slug>-cal`, plan §6.7).
pub fn calendar_account() -> String {
    format!("{SERVER_ACCOUNT_PREFIX}cal")
}

/// The `/proc` exception group (`<slug>-proc`): `/proc` is mounted
/// `hidepid=invisible,gid=<this group>`, and only the system services that
/// must see every process are in it — never a server user. On a machine with
/// a graphical session polkit needs it, or authorizations of a desktop
/// session fail (hosted plan §8).
pub fn proc_group() -> String {
    format!("{SERVER_ACCOUNT_PREFIX}proc")
}

/// The system units given [`proc_group`] (`SupplementaryGroups=` drop-ins).
/// polkit is the one a GNOME/KDE desktop needs: it reads the subject's
/// `/proc/<pid>` for every authorization. systemd-logind, GDM's workers,
/// accounts-daemon and colord run as root or only look at their own
/// processes; add a unit here only for a failure seen with hidepid on.
pub const PROC_EXCEPTION_UNITS: &[&str] = &["polkit.service"];

/// `/etc/systemd/system/<unit>.d/<slug>-proc.conf`.
pub fn proc_dropin(unit: &str) -> PathBuf {
    PathBuf::from("/etc/systemd/system").join(format!("{unit}.d")).join(format!("{SERVER_ACCOUNT_PREFIX}proc.conf"))
}

/// The population's slice, the ceiling for every user together.
pub fn population_slice() -> String {
    format!("{SERVER_ACCOUNT_PREFIX}users.slice")
}

/// One user's slice. The dash nests it under [`population_slice`] — systemd
/// reads `a-b-c.slice` as a child of `a-b.slice` — which is why account
/// names never contain one (`wire::valid_account_name`).
pub fn user_slice(user: &str) -> String {
    format!("{SERVER_ACCOUNT_PREFIX}users-{user}.slice")
}

pub fn gateway_unit() -> String {
    format!("{SERVER_ACCOUNT_PREFIX}gateway.service")
}

/// `<slug>-serverd@<user>.socket` (or `.service` with `kind = "service"`).
pub fn serverd_unit(user: &str, kind: &str) -> String {
    format!("{SERVER_ACCOUNT_PREFIX}serverd@{user}.{kind}")
}

/// `<slug>-auth-keeper.socket` / `.service`: the key keeper.
pub fn keeper_unit(kind: &str) -> String {
    format!("{SERVER_ACCOUNT_PREFIX}auth-keeper.{kind}")
}

/// `<slug>-hub.socket` / `.service`: the share hub.
pub fn hub_unit(kind: &str) -> String {
    format!("{SERVER_ACCOUNT_PREFIX}hub.{kind}")
}

/// `<slug>-calendar.socket` / `.service`: the shared-calendar service.
pub fn calendar_unit(kind: &str) -> String {
    format!("{SERVER_ACCOUNT_PREFIX}calendar.{kind}")
}

pub fn tmux_unit(user: &str) -> String {
    format!("{SERVER_ACCOUNT_PREFIX}tmux@{user}.service")
}

/// Where the binaries live (`/usr/lib/<slug>`).
pub fn lib_dir() -> PathBuf {
    PathBuf::from("/usr/lib").join(SLUG)
}

pub fn serverd_binary() -> PathBuf {
    lib_dir().join(format!("{SERVER_ACCOUNT_PREFIX}serverd"))
}

pub fn helper_binary() -> PathBuf {
    lib_dir().join(format!("{SERVER_ACCOUNT_PREFIX}admin-helper"))
}

pub fn gateway_binary() -> PathBuf {
    lib_dir().join(format!("{SERVER_ACCOUNT_PREFIX}gateway"))
}

/// `/etc/<slug>`: the shared environment file of the units.
pub fn etc_dir() -> PathBuf {
    PathBuf::from("/etc").join(SLUG)
}

pub fn server_env_file() -> PathBuf {
    etc_dir().join("server.env")
}

/// `/run/<slug>/users`: the daemons' sockets, `0750 root:<slug>-gw`.
pub fn socket_dir() -> PathBuf {
    PathBuf::from("/run").join(SLUG).join("users")
}

/// `/run/<slug>/tmux/<user>`: the user's tmux server socket directory, made
/// by the tmux unit (`RuntimeDirectory=`), `0700` the user's.
pub fn tmux_dir(user: &str) -> PathBuf {
    PathBuf::from("/run").join(SLUG).join("tmux").join(user)
}

/// `/var/lib/<slug>-gateway`: the gateway's state (account table, key, audit
/// log, policy).
pub fn gateway_state_dir() -> PathBuf {
    PathBuf::from("/var/lib").join(format!("{SERVER_ACCOUNT_PREFIX}gateway"))
}

/// `/var/lib/<slug>-auth`: the key keeper's state (the administrator's API
/// keys, `0700`, and its audit log).
pub fn keeper_state_dir() -> PathBuf {
    PathBuf::from("/var/lib").join(format!("{SERVER_ACCOUNT_PREFIX}auth"))
}

/// `/run/<slug>/auth.sock`: the key keeper's socket (systemd's, `0666`;
/// the keeper decides by the caller's uid).
pub fn keeper_socket() -> PathBuf {
    PathBuf::from("/run").join(SLUG).join(crate::keys_wire::SOCKET_NAME)
}

/// `/run/<slug>/hub.sock`: the share hub's socket (systemd's, `0666`; the
/// hub decides by the caller's uid).
pub fn hub_socket() -> PathBuf {
    PathBuf::from("/run").join(SLUG).join(crate::hub_wire::SOCKET_NAME)
}

/// `/var/lib/<slug>-hub`: the hub's table of shares, its audit log and the
/// bundles of pushes in flight (`0700`).
pub fn hub_state_dir() -> PathBuf {
    PathBuf::from("/var/lib").join(format!("{SERVER_ACCOUNT_PREFIX}hub"))
}

/// `/srv/<slug>`: root's, `0755`.
pub fn srv_dir() -> PathBuf {
    PathBuf::from("/srv").join(SLUG)
}

/// `/srv/<slug>/shared`: the bare hubs, `<id>.git` each. `0711` and the
/// hub's: everyone may pass through, nobody but the hub may list it, and
/// each hub inside is `0700` with a named-user entry per member (§6.2).
/// Every fence mounts a tmpfs over it and binds back only its own
/// project's hub (§6.3).
pub fn shared_root() -> PathBuf {
    srv_dir().join("shared")
}

/// `/run/<slug>/calendar.sock`: the shared-calendar service (plan §6.7).
pub fn calendar_socket() -> PathBuf {
    PathBuf::from("/run").join(SLUG).join(crate::cal_wire::SOCKET_NAME)
}

/// `/var/lib/<slug>-calendar`: shared calendars and their members (`0700`).
pub fn calendar_state_dir() -> PathBuf {
    PathBuf::from("/var/lib").join(format!("{SERVER_ACCOUNT_PREFIX}calendar"))
}

/// `/opt/<slug>/agents`: the server-wide CLI install root (§5.1).
pub fn cli_root() -> PathBuf {
    PathBuf::from("/opt").join(SLUG).join("agents")
}

/// `/usr/share/<slug>`: the web bundle and the PWA the gateway serves.
pub fn share_dir() -> PathBuf {
    PathBuf::from("/usr/share").join(SLUG)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_slug_and_nest_slices() {
        assert_eq!(gateway_account(), format!("{SLUG}-gw"));
        assert_eq!(user_slice("alice"), format!("{SLUG}-users-alice.slice"));
        // systemd's nesting: drop the last `-part` of the user slice → the population slice.
        let user = user_slice("alice");
        let parent = format!("{}.slice", user.trim_end_matches(".slice").rsplit_once('-').unwrap().0);
        assert_eq!(parent, population_slice());
        assert_eq!(serverd_unit("bob", "socket"), [&format!("{SLUG}-serverd"), "bob.socket"].join("@"));
        assert_eq!(crate::wire::socket_path(&socket_dir(), "bob"), PathBuf::from(format!("/run/{SLUG}/users/bob.sock")));
        assert_eq!(keeper_socket(), PathBuf::from(format!("/run/{SLUG}/auth.sock")));
        assert_eq!((auth_account(), keeper_unit("socket")), (format!("{SLUG}-auth"), format!("{SLUG}-auth-keeper.socket")));
        assert_eq!((hub_account(), hub_unit("service"), hub_socket()), (format!("{SLUG}-hub"), format!("{SLUG}-hub.service"), PathBuf::from(format!("/run/{SLUG}/hub.sock"))));
        assert_eq!(shared_root(), PathBuf::from(format!("/srv/{SLUG}/shared")));
        assert_eq!((calendar_account(), calendar_unit("socket"), calendar_socket()), (format!("{SLUG}-cal"), format!("{SLUG}-calendar.socket"), PathBuf::from(format!("/run/{SLUG}/calendar.sock"))));
    }
}
