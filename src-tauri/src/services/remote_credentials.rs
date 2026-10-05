//! Optional, opt-in secure storage for **remote-connection passwords** (SSH
//! login + OpenVPN passphrase), backed by the OS credential store (Windows
//! Credential Manager / macOS Keychain / Linux Secret Service) via the `keyring`
//! crate — the same mechanism `git_credentials` uses for hosting tokens.
//!
//! The default remains "never persist a password": a password is only written
//! here when the user ticks the per-connection **Save password** checkbox, and it
//! is written **only after authentication has succeeded**. Unticking the box (and
//! reconnecting) clears any previously-saved entry, so the checkbox is the single
//! source of truth for "remember this".
//!
//! Why the OS keychain and not our JSON state? A password in `settings.json` or a
//! project's `project.json` would sit in plaintext on disk (and `project.json`
//! lives in the git working tree). Secrets therefore never touch our JSON — only
//! the keychain holds them, keyed by the **host target** so two projects sharing a
//! host/VPN share one saved credential.
//!
//! All operations degrade gracefully: a keychain that is unavailable (e.g. a
//! headless Linux box with no Secret Service) yields `None` on read and an
//! `Err(String)` on write, so callers fall back to prompting rather than failing.

const SERVICE: &str = crate::brand::KEYRING_REMOTE;

/// The Linux credential handles are trait objects, not `keyring::Entry`, so their
/// `get_password`/`set_password`/`delete_credential` come from this trait. Imported
/// anonymously: only the methods are wanted, never the name.
#[cfg(target_os = "linux")]
use keyring::credential::CredentialApi as _;

/// The keychain account for an SSH host target: `"ssh:{user}@{host}:{port}"`.
/// `user` defaults to empty and `port` to 22 so the key is stable whether the
/// caller passes `None`/`Some(22)` or an omitted user — the same live target
/// always maps to the same entry.
///
/// The **host is lower-cased** for the same reason `ssh_common::target_key`
/// does it: DNS is case-insensitive, so a host typed `Login.Example` in one
/// dialog and `login.example` in another is one machine — but two keychain
/// entries, which reads as "no password saved" on whichever spelling the user
/// did not save under. The login name is *not* folded: a different login is a
/// different account with its own password. Trimming matches: a trailing space
/// pasted into the address field must not mint a second entry.
pub fn ssh_account(user: &Option<String>, host: &str, port: Option<u16>) -> String {
    let user = user.as_deref().unwrap_or("").trim();
    let host = host.trim().to_lowercase();
    let port = port.unwrap_or(22);
    format!("ssh:{user}@{host}:{port}")
}

/// Which mail protocol a saved secret belongs to. IMAP and SMTP get separate
/// entries because they are separate credentials even when they usually match —
/// an app password issued for one is routinely not valid for the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MailProto {
    Imap,
    Smtp,
}

impl MailProto {
    fn as_str(self) -> &'static str {
        match self {
            MailProto::Imap => "imap",
            MailProto::Smtp => "smtp",
        }
    }
}

/// The keychain account for a mail login: `"mail:imap:{user}@{host}:{port}"`.
///
/// Keyed by **server target, not account id**, matching the SSH rule at
/// [`ssh_account`]: one saved secret per login, whichever dialog saved it, so
/// two Tabtivity accounts pointed at the same mailbox share one entry instead of
/// silently disagreeing about whether a password is saved. The host is
/// lower-cased for the same reason it is there (DNS is case-insensitive, so
/// `Imap.Example` and `imap.example` are one machine); the login name is *not*
/// folded, because a different login is a different account.
///
/// The **backend owns this spelling** — the frontend never mints an account
/// string, which is what keeps the key stable when the UI is rewritten.
pub fn mail_account(proto: MailProto, user: &str, host: &str, port: u16) -> String {
    let user = user.trim();
    let host = host.trim().to_lowercase();
    format!("mail:{}:{user}@{host}:{port}", proto.as_str())
}

/// The keychain account for a CalDAV login: `"caldav:{user}@{host}[:{port}]"`.
///
/// Keyed by **server target, not Tabtivity account id**, for the reason
/// [`mail_account`] and [`ssh_account`] give: one saved secret per login, so
/// re-adding an account (or pointing a second one at the same server) finds the
/// password that is already there instead of the two silently disagreeing about
/// whether one is saved.
///
/// Only the *origin* of the base URL goes into the key — a CalDAV account is a
/// login on a server, and one login typically covers several collection paths
/// under it, so including the path would mint a second entry the day discovery
/// resolves a longer URL than the one the user first pasted. A non-default port
/// is part of the target and is kept.
pub fn caldav_account(user: &str, base_url: &str) -> String {
    let user = user.trim();
    let target = origin_of(base_url);
    format!("caldav:{user}@{target}")
}

/// `https://Dav.Example.org:8443/dav/me/` → `dav.example.org:8443`.
///
/// Deliberately string-level rather than a URL parse: this crate's URL type
/// lives in `reqwest`, this module is used from paths that have no HTTP client
/// in scope, and the shape being reduced here is simple enough that a parse
/// would only add a failure mode. An unparseable value degrades to itself,
/// lower-cased — a stable key for a nonsense URL is still a stable key.
fn origin_of(base_url: &str) -> String {
    let raw = base_url.trim();
    let after_scheme = raw.split_once("://").map(|(_, rest)| rest).unwrap_or(raw);
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(after_scheme);
    // A `user@host` in the URL is not part of the target's identity.
    let host = authority
        .rsplit_once('@')
        .map(|(_, h)| h)
        .unwrap_or(authority);
    host.trim().trim_end_matches('.').to_lowercase()
}

/// The keychain account for the **local mail store's** key-encryption key.
///
/// One entry per machine, not per mail account: the master key it wraps seals
/// the whole store, which spans every account. Keyed by nothing, therefore — the
/// store has exactly one home (`state_dir()/mail`) and a second one would be a
/// second Tabtivity installation with its own keychain anyway.
///
/// The secret here is **machine-generated, never a user password**, which is why
/// it does not fall under the "no passwords persisted by default" rule: there is
/// no password to leak, and the alternative to a silent unlock is a passphrase
/// prompt every session, which in practice is people not enabling encryption at
/// all. Turning encryption on is itself the opt-in. See
/// `services::mail_crypt`.
pub fn mail_store_key_account() -> String {
    "mail:store-key".to_string()
}

/// The keychain account for an OpenVPN tunnel's primary secret, keyed by its
/// stored config path — the `auth-user-pass` account password, or (for a config
/// with no account) the private-key passphrase.
pub fn openvpn_account(config: &str) -> String {
    format!("openvpn:{config}")
}

/// The keychain account for an OpenVPN tunnel's **private-key passphrase**, for
/// configs that need it *alongside* an `auth-user-pass` account password. Two
/// independent secrets need two entries; a config that only has a key passphrase
/// keeps storing it under [`openvpn_account`] (there is no account password to
/// collide with).
pub fn openvpn_key_account(config: &str) -> String {
    format!("openvpn-key:{config}")
}

/// The keychain account for an OpenVPN tunnel's **auth username** — the one
/// non-secret in the set, stored here anyway because it is the missing half of a
/// promptless connect and there is nowhere else to put it.
///
/// A username on a *project's* `OpenVpnSpec` only exists for a tunnel a project
/// owns. A tunnel brought up from the header has no project, so without this the
/// username was simply unknown on every reconnect: the silent connect ran without
/// it, `pkexec` raised a polkit prompt, OpenVPN was rejected by the server, and the
/// modal then asked for it — a second polkit prompt for one tunnel. Saved and
/// cleared together with the secrets, under the same opt-in checkbox.
pub fn openvpn_user_account(config: &str) -> String {
    format!("openvpn-user:{config}")
}

/// The platform credential handle for `account`.
///
/// Everywhere but Linux this is `keyring::Entry`, the crate's own dispatch to the
/// Windows Credential Manager / macOS Keychain.
///
/// On **Linux** it is deliberately *not* `Entry`: it is the keyutils-persistent
/// credential built by hand. That store — a kernel-keyring cache in front of the
/// Secret Service, which stays the half that survives a reboot — is what keeps a
/// blocking D-Bus read off every connect path but the first of each boot. It cannot be
/// reached through `Entry`, because keyring 3.6's builder for it
/// (`KeyutilsPersistentCredentialBuilder::build`) returns a plain `SsCredential`:
/// enabling the feature and going on using `Entry` would silently keep today's
/// secret-service-only behaviour. Constructing the credential directly is the whole
/// point of the feature, so it is done here, once.
#[cfg(target_os = "linux")]
fn entry(
    account: &str,
) -> Result<keyring::keyutils_persistent::KeyutilsPersistentCredential, String> {
    entry_in(SERVICE, account)
}

#[cfg(not(target_os = "linux"))]
fn entry(account: &str) -> Result<keyring::Entry, String> {
    entry_in(SERVICE, account)
}

/// [`entry`] under a given service: the current one, or the one an older
/// build saved under (`brand_migration::keyring`).
#[cfg(target_os = "linux")]
fn entry_in(
    service: &str,
    account: &str,
) -> Result<keyring::keyutils_persistent::KeyutilsPersistentCredential, String> {
    keyring::keyutils_persistent::KeyutilsPersistentCredential::new_with_target(
        None, service, account,
    )
    .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "linux"))]
fn entry_in(service: &str, account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, account).map_err(|e| e.to_string())
}

/// The credential store by service name, for the read that also looks under
/// the service named after the app's old name.
struct OsStore;

impl crate::services::brand_migration::keyring::Store for OsStore {
    fn get(&self, service: &str, account: &str) -> Option<String> {
        entry_in(service, account)
            .ok()?
            .get_password()
            .ok()
            .filter(|secret| !secret.is_empty())
    }
    fn set(&self, service: &str, account: &str, secret: &str) -> Result<(), String> {
        entry_in(service, account)?.set_password(secret).map_err(|e| e.to_string())
    }
    fn clear(&self, service: &str, account: &str) -> Result<(), String> {
        match entry_in(service, account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// The kernel-keyring half alone, by service name: what a locked collection
/// can still answer. It is never written through here.
#[cfg(target_os = "linux")]
struct CachedOnlyStore;

#[cfg(target_os = "linux")]
impl crate::services::brand_migration::keyring::Store for CachedOnlyStore {
    fn get(&self, service: &str, account: &str) -> Option<String> {
        use keyring::credential::CredentialApi;
        keyring::keyutils::KeyutilsCredential::new_with_target(None, service, account)
            .ok()?
            .get_password()
            .ok()
            .filter(|secret| !secret.is_empty())
    }
    fn set(&self, _service: &str, _account: &str, _secret: &str) -> Result<(), String> {
        Err("the kernel-keyring cache is read-only here".into())
    }
    fn clear(&self, _service: &str, _account: &str) -> Result<(), String> {
        Ok(())
    }
}

/// What an older build saved for `account` under the service named after the
/// app's old name. `None` at once while the name is unchanged.
///
/// `unlocked` says the caller just read the collection itself: the secret is
/// then also copied to the current service. Otherwise only the kernel
/// keyring is asked and nothing is written — the same rule as [`get`], so
/// this can never be what raises an unlock prompt.
fn legacy_get(account: &str, unlocked: bool) -> Option<String> {
    let pair = crate::brand::PAIR;
    pair.legacy(crate::brand::Name::KEYRING_REMOTE)?;
    #[cfg(target_os = "linux")]
    if !unlocked {
        return crate::services::brand_migration::keyring::get(
            &pair,
            crate::brand::Name::KEYRING_REMOTE,
            &CachedOnlyStore,
            account,
            "keyring-remote",
            false,
        );
    }
    crate::services::brand_migration::keyring::get(
        &pair,
        crate::brand::Name::KEYRING_REMOTE,
        &OsStore,
        account,
        "keyring-remote",
        unlocked,
    )
}

/// Read `account` from the **kernel keyring only**, never touching the Secret Service.
///
/// This is the locked-collection path. The cache half of the store is a plain syscall:
/// it cannot block, cannot raise a prompt, and is readable while the `login` collection
/// is locked — so a credential already read once this boot keeps working through a lock
/// instead of reading as "nothing saved". A miss is simply `None`; there is deliberately
/// no fallback, because the fallback is the call this exists to avoid.
///
/// The key must match the one the combo store's cache half writes, so it is derived the
/// same way: `new_with_target(None, SERVICE, account)`.
#[cfg(target_os = "linux")]
fn get_cached_only(account: &str) -> Option<String> {
    use keyring::credential::CredentialApi;
    let cred =
        keyring::keyutils::KeyutilsCredential::new_with_target(None, SERVICE, account).ok()?;
    cred.get_password().ok().filter(|p| !p.is_empty())
}

/// How long a single keychain **read** may block before we give up on it and answer
/// "nothing readable". Comfortably longer than an unlocked read (milliseconds), short
/// enough that a connect never appears wedged.
const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4);

/// Run a keychain read on a throwaway thread and abandon it after [`READ_TIMEOUT`].
///
/// The Linux Secret Service blocks **indefinitely** while the keyring collection is
/// *locked*: the read triggers an unlock that has to be answered first, and on a
/// session where that prompt never surfaces (a locked `login` collection with no
/// running prompter, a headless run) the call simply never returns. Every credential
/// read here sits on a connect path — `ssh_connect`'s saved-password fallback, the
/// silent-connect probes, auto-connect — so an unbounded one wedges the connect and
/// parks the lamp on "connecting" forever (the amber-that-never-resolves). Bounding it
/// degrades a locked keyring to "nothing saved", which routes the caller to a prompt —
/// the safe direction. The abandoned worker unblocks if the keyring ever does; that
/// costs at most one parked thread per hung read, and only ever happens locked.
fn read_timed<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static, on_timeout: T) -> T {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(READ_TIMEOUT).unwrap_or(on_timeout)
}

/// Read the saved password for `account`. Returns `None` when nothing is stored,
/// the keychain is unavailable, or the read timed out against a locked keyring —
/// never an error, and never a hang, so a missing/unreachable credential cleanly
/// falls through to prompting.
///
/// **A locked collection is never dispatched to.** [`read_timed`] bounds the *caller*,
/// but the abandoned worker stays parked inside the Secret Service call for as long as
/// the unlock prompt goes unanswered — one thread, holding one open D-Bus connection,
/// per read, and every connect path takes one. When the process then exits, all of them
/// drop mid-request, which is a client vanishing between dispatch and reply: the state
/// `gnome-keyring-daemon` aborts on (`assertion 'client' failed` in `OpenSession`). A
/// crashed daemon is restarted by systemd *without* the login password PAM handed the
/// original, so the collection comes back locked — and the next run parks its reads
/// again. Asking [`cached_keyring_state`] first breaks that loop: while locked, the read
/// goes to the kernel-keyring cache, which answers immediately and off the bus.
pub fn get(account: &str) -> Option<String> {
    #[cfg(target_os = "linux")]
    if cached_keyring_state() != KeyringState::Unlocked {
        return get_cached_only(account).or_else(|| legacy_get(account, false));
    }
    let account = account.to_string();
    read_timed(move || get_uncapped(&account).or_else(|| legacy_get(&account, true)), None)
}

/// The unbounded keychain read, run on the worker thread by [`get`].
fn get_uncapped(account: &str) -> Option<String> {
    match entry(account).and_then(|e| match e.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }) {
        Ok(pw) => pw.filter(|p| !p.is_empty()),
        Err(_) => None,
    }
}

/// Store (non-empty) or clear (`None`/empty) the password for `account`. Returns
/// an error string if the keychain write fails so the UI can report it.
///
/// A write to a **locked** collection is refused rather than attempted, for the reason
/// [`get`] gives: it would block on an unlock prompt, and a blocked write is a wedged
/// connect and one more parked D-Bus client. Refusing says the true thing ("locked, so
/// nothing was saved") instead of appearing to save and never returning. Writing only
/// the kernel-keyring half would be worse than either — a credential that reads back
/// fine until the next reboot silently loses it.
pub fn set(account: &str, password: Option<&str>) -> Result<(), String> {
    // No longer Linux-only: a locked macOS keychain refuses the write too, and used to
    // reach `delete_credential` with nothing standing in its way (G.24). Windows'
    // store reports `Unlocked` unconditionally, so this is a no-op there.
    if cached_keyring_state() != KeyringState::Unlocked {
        return Err(
            "the OS keyring is locked, so nothing was saved — unlock it and try again".into(),
        );
    }
    let e = entry(account)?;
    let wrote = match password.filter(|p| !p.is_empty()) {
        Some(secret) => e.set_password(secret).map_err(|err| err.to_string()),
        None => {
            // Cleared under the old service too, or the read would find it
            // there again. Nothing to do while the name is unchanged.
            crate::services::brand_migration::keyring::clear_legacy(
                &crate::brand::PAIR,
                crate::brand::Name::KEYRING_REMOTE,
                &OsStore,
                account,
            );
            match e.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(err) => Err(err.to_string()),
            }
        }
    };
    // A completed write is a first-hand observation that the collection was open —
    // fresher than anything the cache holds, and the cheapest place to notice a lock
    // that was lifted (or dropped) since the last probe.
    forget_keyring_state();
    wrote
}

/// Whether a non-empty password is stored for `account`. Used to tell the
/// frontend "saved" (so it can pre-check the box) without handing back the secret.
pub fn has(account: &str) -> bool {
    get(account).is_some()
}

/// Whether the credential store can be read **right now**, as [`get`]'s own gate
/// sees it (cached on Linux, always true elsewhere — see [`keyring_state`]).
///
/// This is the question every `has(..) == false` silently depends on, and the one
/// no caller used to ask. A locked collection answers every lookup with "nothing
/// saved", so anything that reads absence as a *fact* — "this host authenticates
/// by key", "there is no password to delete" — draws a conclusion from a store it
/// could not read. Callers that would act destructively, or write something down,
/// ask this first and do nothing when it says no.
pub fn store_readable() -> bool {
    // Asked the same way on every platform. It used to be hardcoded `true` off Linux
    // — the assumption that only the Secret Service has a lockable collection — which
    // is wrong for macOS, whose login keychain locks on a timer and on sleep. There
    // the two destructive paths this gate exists to stop were never gated at all: a
    // `Remember::Clear` deleting a credential that merely *read* as absent, and
    // `record_key_auth` stamping `key_auth: true` on a host whose saved password was
    // simply unreadable. Windows genuinely has no such state and answers `Unlocked`
    // from its own branch, so nothing there changes.
    cached_keyring_state() == KeyringState::Unlocked
}

/// Whether the OS credential store can be read **right now** — the question every
/// "is this credential saved?" answer silently depends on.
///
/// On Linux the Secret Service collection holding our entries can be *locked*, and a
/// locked collection is indistinguishable from an empty one through the `keyring`
/// crate: every read answers `None`. So a user who ticked "Save password", connected,
/// and restarted finds the box blank and the silent connect gone — the credential is
/// still there, it just cannot be read. Reporting the lock is what lets the UI say
/// that, and offer [`unlock_keyring`], instead of quietly pretending nothing was saved.
///
/// Windows and macOS have no equivalent state (their stores unlock with the login
/// session), so they always report [`KeyringState::Unlocked`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyringState {
    /// Readable: a `None` from [`get`] really does mean "nothing saved".
    Unlocked,
    /// Present but locked — saved credentials exist but read as absent until unlocked.
    Locked,
    /// No credential store at all (no Secret Service on the bus). Saving is impossible
    /// here, so the UI should stop offering it rather than fail every write silently.
    Unavailable,
}

/// The lock state of the collection our entries live in. Bounded like every other
/// keychain read, and *never* prompts: the probe connects with a zero-second prompt
/// timeout, so asking the question can never put a dialog on screen.
///
/// A timeout answers `Locked` rather than `Unavailable` on purpose — a hung Secret
/// Service call is overwhelmingly a locked collection waiting on an unlock nobody
/// answered, and `Locked` is the state with an action behind it.
pub fn keyring_state() -> KeyringState {
    let state = read_timed(keyring_state_uncapped, KeyringState::Locked);
    remember_keyring_state(state);
    state
}

/// How long [`cached_keyring_state`] trusts a reading. Short enough that unlocking the
/// collection from *outside* Tabtivity (Seahorse, Keychain Access, another app's prompt)
/// is picked up without a restart; long enough that a burst of connects costs one probe,
/// not one per credential. The transition that actually matters — our own
/// [`unlock_keyring`] — does not wait for it: it invalidates the cache outright.
const STATE_TTL: std::time::Duration = std::time::Duration::from_secs(10);

static STATE_CACHE: std::sync::Mutex<Option<(std::time::Instant, KeyringState)>> =
    std::sync::Mutex::new(None);

/// The lock state as [`get`]'s gate sees it: cached, so that asking "may I dispatch a
/// Secret Service read?" before *every* read costs a D-Bus round trip only once per
/// [`STATE_TTL`]. The probe behind it never prompts, so a miss is cheap and safe.
fn cached_keyring_state() -> KeyringState {
    if let Ok(cache) = STATE_CACHE.lock() {
        if let Some((at, state)) = *cache {
            if at.elapsed() < STATE_TTL {
                return state;
            }
        }
    }
    keyring_state()
}

/// Record a freshly-observed lock state.
/// `pub(crate)` only so a test elsewhere can put the gate into a known state
/// without a live probe (see `commands::remote`'s locked-keychain test) — nothing
/// in production code outside this module should be *asserting* a lock state.
pub(crate) fn remember_keyring_state(state: KeyringState) {
    if let Ok(mut cache) = STATE_CACHE.lock() {
        *cache = Some((std::time::Instant::now(), state));
    }
}

/// Drop the cached lock state, so the next [`get`] re-asks. Called wherever the state
/// is known to have just changed under us — an unlock we raised, a write that proved
/// the collection was writable.
pub fn forget_keyring_state() {
    if let Ok(mut cache) = STATE_CACHE.lock() {
        *cache = None;
    }
}

#[cfg(target_os = "linux")]
fn keyring_state_uncapped() -> KeyringState {
    use dbus_secret_service::{EncryptionType, SecretService};
    // 0 = never raise a prompt; this is a probe, and a probe that can pop a system
    // dialog is not a probe. `Plain` because no secret crosses this session — we ask
    // for a boolean, so there is nothing to encrypt.
    let Ok(service) = SecretService::connect_with_max_prompt_timeout(EncryptionType::Plain, 0)
    else {
        return KeyringState::Unavailable;
    };
    let Ok(collection) = service.get_default_collection() else {
        return KeyringState::Unavailable;
    };
    match collection.is_locked() {
        Ok(true) => KeyringState::Locked,
        Ok(false) => KeyringState::Unlocked,
        Err(_) => KeyringState::Unavailable,
    }
}

/// macOS: the login keychain **can** be locked — by `security lock-keychain`, by the
/// "Lock after N minutes of inactivity" setting, or on sleep — and a locked one fails
/// reads with *User interaction is not allowed* rather than answering "no entry". So
/// this is a measurement here too, not the platform claim it used to be
/// (`store_readable()` was hardcoded `true` off Linux, which let a `Remember::Clear`
/// and a `record_key_auth` through on a keychain nobody could read — G.24).
///
/// `show-keychain-info` is the probe because it is the one that **cannot prompt**: it
/// reports the keychain's settings and fails outright when locked, where any read of a
/// real item would raise the unlock dialog — and a probe that can put a dialog on
/// screen is not a probe. It costs a process spawn, which is why only
/// [`cached_keyring_state`] calls it and only once per [`STATE_TTL`]; the whole call is
/// already bounded by [`read_timed`]'s 4 s.
#[cfg(target_os = "macos")]
fn keyring_state_uncapped() -> KeyringState {
    let Ok(out) = crate::paths::command_no_window("security")
        .arg("show-keychain-info")
        .output()
    else {
        // No `security` binary at all — nothing here can be concluded about a store
        // we could not address, and "unavailable" is the answer with no action behind
        // it (the honest reading of "we don't know").
        return KeyringState::Unavailable;
    };
    if out.status.success() {
        return KeyringState::Unlocked;
    }
    // Locked and absent are different failures and must not collapse: only the first
    // has an unlock behind it. The message is matched case-insensitively because it is
    // the stable part; the exit status alone cannot tell them apart.
    let err = String::from_utf8_lossy(&out.stderr).to_lowercase();
    if err.contains("user interaction is not allowed") || err.contains("locked") {
        KeyringState::Locked
    } else {
        KeyringState::Unavailable
    }
}

/// Windows: the credential store is DPAPI-backed and unlocks with the login session —
/// there is genuinely no lockable collection, so there is nothing to measure and
/// `Unlocked` is a fact rather than an assumption. Same for any other target, where a
/// wrong guess would be the unsafe direction and no probe exists to improve on it.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn keyring_state_uncapped() -> KeyringState {
    KeyringState::Unlocked
}

/// Ask the OS to unlock the credential store, raising *its own* unlock dialog.
///
/// Deliberately blocking and unbounded-ish (a generous prompt timeout): the user is
/// typing a password into a system dialog, and abandoning that after four seconds
/// would be worse than not asking. Call it only from an explicit user action — never
/// from a launch path that promises not to prompt.
///
/// Returns `Ok(())` once the collection is unlocked (including when it already was);
/// an `Err` if the dialog was dismissed, timed out, or there is no store to unlock.
pub fn unlock_keyring() -> Result<(), String> {
    let out = unlock_keyring_impl();
    // Whichever way the dialog went, the cached reading is now the stale one — and this
    // is precisely the transition [`get`]'s gate must see immediately, since the click
    // exists to make the next connect find its saved credential.
    forget_keyring_state();
    out
}

#[cfg(target_os = "linux")]
fn unlock_keyring_impl() -> Result<(), String> {
    use dbus_secret_service::{EncryptionType, SecretService};
    // Two minutes: long enough to find and answer the dialog, short enough that a
    // prompt nobody ever sees does not park this thread for the session.
    let service = SecretService::connect_with_max_prompt_timeout(EncryptionType::Plain, 120)
        .map_err(|e| format!("no OS credential store available: {e}"))?;
    let collection = service
        .get_default_collection()
        .map_err(|e| format!("no default keyring collection: {e}"))?;
    match collection.is_locked() {
        Ok(false) => return Ok(()),
        Ok(true) => {}
        Err(e) => return Err(format!("could not read the keyring's lock state: {e}")),
    }
    collection
        .unlock()
        .map_err(|e| format!("keyring unlock failed or was dismissed: {e}"))?;
    // `unlock` returns as soon as the prompt is dismissed, whichever way — so confirm
    // rather than report success on a cancelled dialog.
    match collection.is_locked() {
        Ok(false) => Ok(()),
        _ => Err("the keyring is still locked".to_string()),
    }
}

#[cfg(not(target_os = "linux"))]
fn unlock_keyring_impl() -> Result<(), String> {
    Ok(())
}

/// What a successful connect should do to the stored credential, decided by the
/// caller's `remember` argument.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Remember {
    /// The user ticked "Save password" — persist the working secret.
    Save,
    /// The user *unticked* it — drop any previously-saved secret.
    Clear,
    /// The caller has no checkbox behind it — do not touch the keychain.
    Leave,
}

/// Map a connect command's `remember` argument to a keychain action.
///
/// The case that matters is `None → Leave`. Not every connect comes from a form:
/// a reachability probe, a ControlMaster readiness poll, and a silent auto-connect
/// all authenticate *using* the saved credential while having no opinion about
/// storing it. Folding `None` into "unticked" (the old `unwrap_or(false)`) made
/// each of them delete the very password it had just used — the credential worked
/// exactly once, then the next connect prompted again.
pub fn remember_action(remember: Option<bool>) -> Remember {
    match remember {
        Some(true) => Remember::Save,
        Some(false) => Remember::Clear,
        None => Remember::Leave,
    }
}

/// What the post-auth keychain write actually did, so the connect that triggered
/// it can say so instead of swallowing it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct RememberOutcome {
    /// A secret is stored for this account as a result of this call — either the
    /// save landed, or a clear was **declined** because the store could not be
    /// read (so whatever was there is still there).
    pub saved: bool,
    /// Why the keychain did not do what the checkbox asked. Never a reason to
    /// fail the connect: authentication already succeeded.
    pub error: Option<String>,
}

/// Apply the post-auth keychain write for `account`: save `secret`, clear the
/// entry, or leave it alone, per [`remember_action`]. Call only *after*
/// authentication succeeded, so a rejected credential is never stored.
///
/// Two things this deliberately does **not** do any more. It does not discard
/// [`set`]'s result: a write refused by a locked keyring produced a connect that
/// looked as if it had saved the password, and a next launch with a blank prompt
/// as the only evidence. And it does not clear an entry it could not first read:
/// an unreadable store is not licence to delete — [`get`]/[`has`] answer "nothing
/// saved" while locked, so an untick evaluated against that answer would destroy a
/// password the user still wants (and, keyed by host, possibly another project's).
/// The destructive branch is the one branch that needs the store to be *known*
/// open, so it asks [`store_readable`] first.
pub fn remember_secret(
    account: &str,
    remember: Option<bool>,
    secret: Option<&str>,
) -> RememberOutcome {
    match remember_action(remember) {
        Remember::Save => match set(account, secret) {
            Ok(()) => RememberOutcome {
                saved: secret.is_some_and(|s| !s.is_empty()),
                error: None,
            },
            Err(e) => RememberOutcome {
                saved: false,
                error: Some(e),
            },
        },
        Remember::Clear => {
            if !store_readable() {
                return RememberOutcome {
                    saved: true,
                    error: Some(
                        "the OS keyring is locked, so the saved password was left alone — \
                         unlock it and untick again to remove it"
                            .to_string(),
                    ),
                };
            }
            match set(account, None) {
                Ok(()) => RememberOutcome {
                    saved: false,
                    error: None,
                },
                Err(e) => RememberOutcome {
                    saved: true,
                    error: Some(e),
                },
            }
        }
        // No checkbox behind this call, so nothing was asked and nothing done —
        // `saved` reports this call's doing, not the state of the keychain.
        Remember::Leave => RememberOutcome {
            saved: false,
            error: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_caldav_key_is_the_login_and_the_origin_only() {
        // Two URLs under one server, one login → one saved secret. Including
        // the path would mint a second entry the day discovery resolves a
        // longer URL than the one the user first pasted.
        assert_eq!(
            caldav_account("me", "https://DAV.Example.org/dav/"),
            caldav_account("me", "https://dav.example.org/dav/me/personal/")
        );
        assert_eq!(
            caldav_account(" me ", "https://dav.example.org/"),
            "caldav:me@dav.example.org"
        );
        // A non-default port is part of the target.
        assert_ne!(
            caldav_account("me", "https://dav.example.org/"),
            caldav_account("me", "https://dav.example.org:8443/")
        );
        // A different login is a different account, however same the server.
        assert_ne!(
            caldav_account("me", "https://dav.example.org/"),
            caldav_account("you", "https://dav.example.org/")
        );
        // Userinfo in the URL is not part of the target's identity.
        assert_eq!(
            caldav_account("me", "https://someone@dav.example.org/dav/"),
            caldav_account("me", "https://dav.example.org/dav/")
        );
    }

    /// The whole point of the tri-state: "no checkbox behind this call" must not be
    /// read as "the user unticked the box". A probe or a silent reconnect that
    /// cleared the keychain would delete the password it had just used.
    #[test]
    fn remember_none_leaves_the_keychain_alone() {
        assert_eq!(remember_action(None), Remember::Leave);
        assert_eq!(remember_action(Some(true)), Remember::Save);
        assert_eq!(remember_action(Some(false)), Remember::Clear);
    }

    #[test]
    fn ssh_account_normalizes_default_port() {
        // None and Some(22) must map to the same entry as the live target.
        assert_eq!(
            ssh_account(&Some("alice".into()), "host.example", None),
            "ssh:alice@host.example:22"
        );
        assert_eq!(
            ssh_account(&Some("alice".into()), "host.example", Some(22)),
            "ssh:alice@host.example:22"
        );
    }

    #[test]
    fn ssh_account_omitted_user_is_empty() {
        assert_eq!(
            ssh_account(&None, "host.example", Some(2222)),
            "ssh:@host.example:2222"
        );
        // A blank/whitespace user normalizes to the same empty-user key.
        assert_eq!(
            ssh_account(&Some("  ".into()), "host.example", Some(2222)),
            "ssh:@host.example:2222"
        );
    }

    /// One machine, one entry. DNS is case-insensitive, so the same host typed
    /// `MLAI21…` in one dialog and `mlai21…` in another used to mint two keychain
    /// accounts — and the spelling the user did not save under read back as "no
    /// password saved", i.e. a prompt where a silent reconnect was promised.
    #[test]
    fn ssh_account_folds_host_case_and_trims() {
        assert_eq!(
            ssh_account(&Some("alice".into()), " Login.Example ", None),
            ssh_account(&Some("alice".into()), "login.example", Some(22)),
        );
        // The login name is deliberately NOT folded: a different login is a
        // different account on that host, with its own password.
        assert_ne!(
            ssh_account(&Some("Alice".into()), "login.example", None),
            ssh_account(&Some("alice".into()), "login.example", None),
        );
    }

    /// An unreadable store is not licence to delete. While the collection is
    /// locked every lookup answers "nothing saved", so an untick evaluated against
    /// that answer destroys a password the user still wants — and the entry is
    /// keyed by host, so possibly another project's. Proven by the outcome alone:
    /// reaching `set` would mean the guard let the delete through.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_locked_keyring_never_clears_a_saved_password() {
        remember_keyring_state(KeyringState::Locked);
        let out = remember_secret("test:clear-guard", Some(false), None);
        assert!(out.saved, "the entry must be reported as still present");
        assert!(out.error.unwrap_or_default().contains("locked"));
    }

    /// The other half: a save the keychain refused must reach the caller as a
    /// reason, not vanish. Swallowing it produced a connect that looked as though
    /// it had saved the password, with the next launch's blank prompt as the only
    /// evidence it had not.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_refused_save_is_reported_rather_than_swallowed() {
        remember_keyring_state(KeyringState::Locked);
        let out = remember_secret("test:save-report", Some(true), Some("secret"));
        assert!(!out.saved);
        assert!(out.error.is_some(), "the reason must reach the caller");
    }

    /// `Leave` touches nothing, so it reports nothing — `saved` is what *this
    /// call* did, not a reading of the keychain (which it deliberately never takes).
    #[test]
    fn nothing_asked_means_nothing_done() {
        assert_eq!(
            remember_secret("test:leave", None, Some("secret")),
            RememberOutcome {
                saved: false,
                error: None
            }
        );
    }

    #[test]
    fn ssh_account_distinct_ports_are_distinct_keys() {
        assert_ne!(
            ssh_account(&Some("a".into()), "h", Some(22)),
            ssh_account(&Some("a".into()), "h", Some(2222))
        );
    }

    /// IMAP and SMTP are separate credentials; sharing an entry would mean
    /// saving one overwrote the other.
    #[test]
    fn mail_accounts_are_per_protocol_and_per_target() {
        assert_eq!(
            mail_account(MailProto::Imap, "user@example.com", "imap.example.com", 993),
            "mail:imap:user@example.com@imap.example.com:993"
        );
        assert_ne!(
            mail_account(MailProto::Imap, "u", "h.example", 993),
            mail_account(MailProto::Smtp, "u", "h.example", 993)
        );
        assert_ne!(
            mail_account(MailProto::Imap, "u", "h.example", 993),
            mail_account(MailProto::Imap, "u", "h.example", 143)
        );
    }

    /// One machine, one entry — the same lesson [`ssh_account`] learned.
    #[test]
    fn mail_account_folds_host_case_and_trims() {
        assert_eq!(
            mail_account(MailProto::Imap, " user ", " Imap.Example ", 993),
            mail_account(MailProto::Imap, "user", "imap.example", 993)
        );
        // The login is deliberately not folded.
        assert_ne!(
            mail_account(MailProto::Imap, "User", "imap.example", 993),
            mail_account(MailProto::Imap, "user", "imap.example", 993)
        );
    }

    /// A mail key must never collide with an SSH or OpenVPN one — they share
    /// the `tabtivity-remote` service.
    #[test]
    fn mail_keys_never_collide_with_the_other_credential_kinds() {
        let m = mail_account(MailProto::Imap, "u", "h.example", 993);
        assert!(m.starts_with("mail:"));
        assert_ne!(m, ssh_account(&Some("u".into()), "h.example", Some(993)));
        assert_ne!(m, openvpn_account("h.example"));
    }

    #[test]
    fn openvpn_account_keys_by_config_path() {
        assert_eq!(openvpn_account("/store/x.ovpn"), "openvpn:/store/x.ovpn");
    }

    #[test]
    fn openvpn_user_account_is_distinct_from_both_secret_accounts() {
        // The username shares the config key but must never share an *entry* with a
        // secret: writing it into either would overwrite the password/passphrase.
        let c = "/store/x.ovpn";
        assert_eq!(openvpn_user_account(c), "openvpn-user:/store/x.ovpn");
        assert_ne!(openvpn_user_account(c), openvpn_account(c));
        assert_ne!(openvpn_user_account(c), openvpn_key_account(c));
    }

    /// The gate's cheap half: a reading taken once is reused, so asking "may I dispatch
    /// a Secret Service read?" before every credential read costs one probe, not one per
    /// account. Deterministic — it asserts only what was just remembered, never a live
    /// probe's answer.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_remembered_lock_state_is_served_from_the_cache() {
        remember_keyring_state(KeyringState::Locked);
        assert_eq!(cached_keyring_state(), KeyringState::Locked);
        // Deliberately not cleared: another test clearing it mid-run would send the next
        // one to a *live* probe, which on an unlocked dev machine would let a test write
        // reach the real keychain. The reading expires on its own.
    }

    /// A locked collection must make the write fail *fast*, not wait on an unlock prompt
    /// nobody may answer. Proven by the error alone: reaching the keychain at all would
    /// mean the gate let the call through.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_locked_keyring_refuses_the_write_instead_of_blocking_on_it() {
        remember_keyring_state(KeyringState::Locked);
        let err = set("test:locked-gate", Some("secret")).unwrap_err();
        assert!(err.contains("locked"), "unexpected error: {err}");
    }

    #[test]
    fn openvpn_key_account_is_distinct_from_the_password_account() {
        // Same config, two secrets — they must never share an entry, or saving one
        // would overwrite the other.
        assert_eq!(
            openvpn_key_account("/store/x.ovpn"),
            "openvpn-key:/store/x.ovpn"
        );
        assert_ne!(
            openvpn_key_account("/store/x.ovpn"),
            openvpn_account("/store/x.ovpn")
        );
    }
}
