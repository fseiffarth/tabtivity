//! The session table (plan §2, Per session): which sessions exist, by exact
//! name, and the pure rules over them — name validation, create-or-attach,
//! the window-size policy, the dead state and the idle-exit decision. No PTYs
//! and no I/O: [`super::server`] keeps the runtime half (PTY, screen, client
//! queues) keyed by [`SessionId`].
//!
//! Names follow tmux's rule on the Unix side
//! (`ssh_exec::valid_tmux_session_name`) and always match exactly: `foo`
//! never reaches `foo-1` the way a bare tmux target would.

use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use super::protocol::SizePolicy;

/// A session's stable id: survives a rename, never reused within one host.
pub type SessionId = u64;
/// An attached stream client.
pub type ClientId = u64;

/// Milliseconds on some fixed scale, injectable for tests. The host's real
/// clock is Unix milliseconds ([`SystemClock`]).
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> u64;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TableError {
    BadName,
    NotFound,
    Exists,
    Dead,
    /// Its child is still being spawned.
    Starting,
}

/// The tmux name rule, shared with the Unix side.
pub fn valid_name(name: &str) -> bool {
    crate::services::ssh_exec::valid_tmux_session_name(name)
}

/// Refuses a launch that could smuggle something past the host: `argv[0]`
/// must be absolute and not a UNC or device path (`\\server\share`,
/// `\\?\`, `//x`); no NUL in any argument, the cwd or the environment; an env
/// key is non-empty and has no `=`. (The Windows spawner must also pass
/// `argv[0]` as `CreateProcess`'s `lpApplicationName`, so the command line's
/// own parsing never picks the program.) A batch program is refused too
/// ([`is_batch_program`]).
pub fn validate_spawn(argv: &[String], env: &[(String, String)], cwd: Option<&str>) -> Result<(), &'static str> {
    let Some(program) = argv.first() else { return Err("argv is empty") };
    if is_batch_program(program) {
        return Err("argv[0] is a batch script (resolve it to its interpreter first)");
    }
    if program.starts_with("\\\\") || program.starts_with("//") {
        return Err("argv[0] is a UNC or device path");
    }
    if !std::path::Path::new(program).is_absolute() {
        return Err("argv[0] must be an absolute path");
    }
    if argv.iter().any(|a| a.contains('\0')) || cwd.is_some_and(|c| c.contains('\0')) {
        return Err("NUL in argv or cwd");
    }
    for (key, value) in env {
        if key.is_empty() || key.contains('=') || key.contains('\0') || value.contains('\0') {
            return Err("bad environment entry");
        }
    }
    Ok(())
}

/// Whether `mark` may be kept as a session's MCP stamp: at most
/// [`MAX_MCP_MARK`](super::protocol::MAX_MCP_MARK) bytes of printable ASCII
/// with no space (`root_mcp_mark::Mark::render` writes hex, `-`, `:` and
/// digits), so a listing never carries a control byte.
pub fn valid_mcp_mark(mark: &str) -> bool {
    !mark.is_empty() && mark.len() <= super::protocol::MAX_MCP_MARK && mark.bytes().all(|b| b.is_ascii_graphic())
}

/// Whether `program` would run as a batch script — `CreateProcess` hands a
/// `.bat`/`.cmd` to `cmd.exe /c`, which re-parses the whole command line
/// (`& | ^ % < >`; `%` cannot even be escaped: the BatBadBut class) — or is a
/// `.com`, refused alongside. The extension is read the way Windows resolves
/// the file: any case, with trailing dots and spaces dropped and an
/// alternate-data-stream suffix (`::$DATA`) cut off.
pub fn is_batch_program(program: &str) -> bool {
    let lower = program.to_ascii_lowercase();
    let mut name = lower.as_str();
    if let Some(i) = name.find("::$data") {
        name = &name[..i];
    }
    let name = name.trim_end_matches(['.', ' ']);
    let leaf = name.rsplit(['\\', '/']).next().unwrap_or(name);
    matches!(leaf.rsplit_once('.').map(|(_, ext)| ext), Some("bat" | "cmd" | "com"))
}

/// One attached client's size and when it last attached, typed or resized.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClientSize {
    pub client: ClientId,
    pub cols: u16,
    pub rows: u16,
    /// A table-wide sequence number; higher is more recent.
    pub touched: u64,
}

/// The window size `policy` gives these clients; `None` with no clients (the
/// session keeps its size, as a detached tmux session does).
pub fn window_size(policy: SizePolicy, clients: &[ClientSize]) -> Option<(u16, u16)> {
    match policy {
        SizePolicy::Latest => clients.iter().max_by_key(|c| c.touched).map(|c| (c.cols, c.rows)),
        SizePolicy::Largest => {
            let cols = clients.iter().map(|c| c.cols).max()?;
            let rows = clients.iter().map(|c| c.rows).max()?;
            Some((cols, rows))
        }
    }
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub id: SessionId,
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub created: u64,
    pub activity: u64,
    pub policy: SizePolicy,
    pub remain_on_exit: bool,
    /// `(cols, rows)` the session runs at.
    pub size: (u16, u16),
    pub clients: Vec<ClientSize>,
    /// `Some(exit code)` once a remain-on-exit command ended.
    pub dead: Option<Option<i32>>,
    /// Created, its child not spawned yet ([`Table::mark_started`]).
    pub starting: bool,
    /// The MCP stamp the creating `Spawn` carried; an attach never changes it.
    pub mcp_mark: Option<String>,
}

impl Entry {
    pub fn is_dead(&self) -> bool {
        self.dead.is_some()
    }
}

/// What a new session is created with.
#[derive(Debug, Clone)]
pub struct NewSession {
    pub name: String,
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub policy: SizePolicy,
    pub remain_on_exit: bool,
    pub create_only: bool,
    /// Kept only if this creates the session.
    pub mcp_mark: Option<String>,
}

/// Whether [`Table::create_or_attach`] made the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Created {
    New(SessionId),
    Existing(SessionId),
}

#[derive(Debug, Default)]
pub struct Table {
    entries: BTreeMap<String, Entry>,
    next_id: SessionId,
    seq: u64,
}

impl Table {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, name: &str) -> Option<&Entry> {
        self.entries.get(name)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &Entry)> {
        self.entries.iter()
    }

    /// The name and entry of session `id`.
    pub fn by_id(&self, id: SessionId) -> Option<(&str, &Entry)> {
        self.entries.iter().find(|(_, e)| e.id == id).map(|(n, e)| (n.as_str(), e))
    }

    fn by_id_mut(&mut self, id: SessionId) -> Option<&mut Entry> {
        self.entries.values_mut().find(|e| e.id == id)
    }

    fn tick(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }

    /// Create-or-attach by exact name: an existing session is returned as is
    /// (its command, cwd and size untouched), unless `create_only`.
    pub fn create_or_attach(&mut self, new: NewSession, now: u64) -> Result<Created, TableError> {
        if !valid_name(&new.name) {
            return Err(TableError::BadName);
        }
        if let Some(e) = self.entries.get(&new.name) {
            return if new.create_only { Err(TableError::Exists) } else { Ok(Created::Existing(e.id)) };
        }
        self.next_id += 1;
        let id = self.next_id;
        self.entries.insert(
            new.name,
            Entry {
                id,
                argv: new.argv,
                cwd: new.cwd,
                created: now,
                activity: now,
                policy: new.policy,
                remain_on_exit: new.remain_on_exit,
                size: (new.cols.max(1), new.rows.max(1)),
                clients: Vec::new(),
                dead: None,
                starting: true,
                mcp_mark: new.mcp_mark,
            },
        );
        Ok(Created::New(id))
    }

    /// The child of session `id` is running; `false` when the session went
    /// away while it was being spawned.
    pub fn mark_started(&mut self, id: SessionId) -> bool {
        match self.by_id_mut(id) {
            Some(e) => {
                e.starting = false;
                true
            }
            None => false,
        }
    }

    pub fn remove(&mut self, name: &str) -> Option<Entry> {
        self.entries.remove(name)
    }

    pub fn remove_id(&mut self, id: SessionId) -> Option<(String, Entry)> {
        let name = self.by_id(id)?.0.to_string();
        self.entries.remove(&name).map(|e| (name, e))
    }

    /// Names starting with `prefix`, sorted.
    pub fn names_with_prefix(&self, prefix: &str) -> Vec<String> {
        self.entries.keys().filter(|n| n.starts_with(prefix)).cloned().collect()
    }

    pub fn rename(&mut self, old: &str, new: &str) -> Result<(), TableError> {
        if !valid_name(new) {
            return Err(TableError::BadName);
        }
        if !self.entries.contains_key(old) {
            return Err(TableError::NotFound);
        }
        if old == new {
            return Ok(());
        }
        if self.entries.contains_key(new) {
            return Err(TableError::Exists);
        }
        let entry = self.entries.remove(old).ok_or(TableError::NotFound)?;
        self.entries.insert(new.to_string(), entry);
        Ok(())
    }

    /// The session input may go to: refused while dead.
    pub fn input_target(&self, name: &str) -> Result<SessionId, TableError> {
        let e = self.entries.get(name).ok_or(TableError::NotFound)?;
        if e.starting {
            return Err(TableError::Starting);
        }
        if e.is_dead() {
            return Err(TableError::Dead);
        }
        Ok(e.id)
    }

    /// Marks a remain-on-exit session dead; `false` when it is not one (the
    /// caller then removes it).
    pub fn mark_dead(&mut self, id: SessionId, code: Option<i32>) -> bool {
        match self.by_id_mut(id) {
            Some(e) if e.remain_on_exit => {
                e.dead.get_or_insert(code);
                true
            }
            _ => false,
        }
    }

    pub fn note_activity(&mut self, id: SessionId, now: u64) {
        if let Some(e) = self.by_id_mut(id) {
            e.activity = now;
        }
    }

    pub fn set_cwd(&mut self, id: SessionId, cwd: &str) {
        if let Some(e) = self.by_id_mut(id) {
            if e.cwd.as_deref() != Some(cwd) {
                e.cwd = Some(cwd.to_string());
            }
        }
    }

    /// Sets the size directly (a resize with no client behind it).
    pub fn set_size(&mut self, id: SessionId, cols: u16, rows: u16) -> Option<(u16, u16)> {
        let e = self.by_id_mut(id)?;
        let size = (cols.max(1), rows.max(1));
        (e.size != size).then(|| {
            e.size = size;
            size
        })
    }

    /// A client attached, typed (`size` `None`) or resized: it becomes the
    /// most recent. Returns the new window size when the policy changes it.
    pub fn touch_client(&mut self, id: SessionId, client: ClientId, size: Option<(u16, u16)>) -> Option<(u16, u16)> {
        let seq = self.tick();
        let e = self.by_id_mut(id)?;
        match e.clients.iter_mut().find(|c| c.client == client) {
            Some(c) => {
                c.touched = seq;
                if let Some((cols, rows)) = size {
                    c.cols = cols.max(1);
                    c.rows = rows.max(1);
                }
            }
            None => {
                let (cols, rows) = size.unwrap_or(e.size);
                e.clients.push(ClientSize { client, cols: cols.max(1), rows: rows.max(1), touched: seq });
            }
        }
        Self::apply_policy(e)
    }

    /// A client left. Returns the new window size when the policy changes it.
    pub fn detach_client(&mut self, id: SessionId, client: ClientId) -> Option<(u16, u16)> {
        let e = self.by_id_mut(id)?;
        e.clients.retain(|c| c.client != client);
        Self::apply_policy(e)
    }

    fn apply_policy(e: &mut Entry) -> Option<(u16, u16)> {
        let size = window_size(e.policy, &e.clients)?;
        (size != e.size).then(|| {
            e.size = size;
            size
        })
    }
}

/// The idle-exit rule: exit once there has been no session and no connection
/// for `after_ms` straight.
#[derive(Debug, Clone)]
pub struct IdleTimer {
    after_ms: u64,
    since: Option<u64>,
}

impl IdleTimer {
    pub fn new(after_ms: u64) -> Self {
        Self { after_ms, since: None }
    }

    /// A connection opened or closed: the quiet period starts over, so a
    /// connection that came and went between two observations counts.
    pub fn reset(&mut self) {
        self.since = None;
    }

    /// Records the current state; `true` means exit now.
    pub fn observe(&mut self, now: u64, sessions: usize, connections: usize) -> bool {
        if sessions > 0 || connections > 0 {
            self.since = None;
            return false;
        }
        let since = *self.since.get_or_insert(now);
        now.saturating_sub(since) >= self.after_ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new(name: &str) -> NewSession {
        NewSession {
            name: name.into(),
            argv: vec!["/bin/agent".into()],
            cwd: None,
            cols: 200,
            rows: 50,
            policy: SizePolicy::Latest,
            remain_on_exit: false,
            create_only: false,
            mcp_mark: None,
        }
    }

    #[test]
    fn the_mcp_stamp_is_set_on_create_only() {
        let mut t = Table::new();
        let mut first = new("s");
        first.mcp_mark = Some("nonce:grant:1".into());
        t.create_or_attach(first, 0).unwrap();
        let mut again = new("s");
        again.mcp_mark = Some("other:grant:2".into());
        assert!(matches!(t.create_or_attach(again, 1), Ok(Created::Existing(_))));
        assert_eq!(t.get("s").unwrap().mcp_mark.as_deref(), Some("nonce:grant:1"), "an attach keeps it");
        t.create_or_attach(new("bare"), 0).unwrap();
        assert_eq!(t.get("bare").unwrap().mcp_mark, None);
        t.rename("s", "t").unwrap();
        assert_eq!(t.get("t").unwrap().mcp_mark.as_deref(), Some("nonce:grant:1"), "a rename keeps it");
    }

    #[test]
    fn an_mcp_stamp_is_short_printable_ascii() {
        let real = format!("{}:{}:49152", "a".repeat(32), "b".repeat(64));
        assert!(valid_mcp_mark(&real));
        assert!(valid_mcp_mark(&format!("{}:-:1", "a".repeat(32))));
        assert!(!valid_mcp_mark(""));
        assert!(!valid_mcp_mark("a b"));
        assert!(!valid_mcp_mark("a\nb"));
        assert!(!valid_mcp_mark("a\u{1b}b"));
        assert!(!valid_mcp_mark("ä"));
        assert!(!valid_mcp_mark(&"x".repeat(super::super::protocol::MAX_MCP_MARK + 1)));
    }

    #[test]
    fn names_follow_the_tmux_rule() {
        let mut t = Table::new();
        for bad in ["", "a b", "a:b", "a.b", "ä", "a\n"] {
            assert_eq!(t.create_or_attach(new(bad), 0), Err(TableError::BadName), "{bad:?}");
        }
        assert!(matches!(t.create_or_attach(new("tab_1-x"), 0), Ok(Created::New(_))));
        assert_eq!(t.rename("tab_1-x", "x.y"), Err(TableError::BadName));
    }

    #[test]
    fn create_or_attach_matches_the_exact_name() {
        let mut t = Table::new();
        let Ok(Created::New(long)) = t.create_or_attach(new("foo-1"), 0) else { panic!() };
        // `foo` is a prefix of `foo-1` but a different session.
        let Ok(Created::New(short)) = t.create_or_attach(new("foo"), 0) else { panic!() };
        assert_ne!(long, short);
        let mut other = new("foo");
        other.argv = vec!["/bin/other".into()];
        other.cols = 10;
        assert_eq!(t.create_or_attach(other, 5), Ok(Created::Existing(short)));
        let e = t.get("foo").unwrap();
        assert_eq!(e.argv, vec!["/bin/agent".to_string()], "the existing command is kept");
        assert_eq!(e.size, (200, 50));
        let mut only = new("foo");
        only.create_only = true;
        assert_eq!(t.create_or_attach(only, 0), Err(TableError::Exists));
        assert!(t.get("fo").is_none());
        assert_eq!(t.names_with_prefix("foo"), vec!["foo".to_string(), "foo-1".to_string()]);
    }

    #[test]
    fn rename_keeps_the_id_and_refuses_a_taken_name() {
        let mut t = Table::new();
        let Ok(Created::New(a)) = t.create_or_attach(new("a"), 0) else { panic!() };
        t.create_or_attach(new("b"), 0).unwrap();
        assert_eq!(t.rename("a", "b"), Err(TableError::Exists));
        assert_eq!(t.rename("zz", "c"), Err(TableError::NotFound));
        t.rename("a", "c").unwrap();
        assert_eq!(t.get("c").unwrap().id, a);
        assert!(t.get("a").is_none());
        assert_eq!(t.by_id(a).unwrap().0, "c");
    }

    #[test]
    fn latest_policy_follows_the_most_recent_client() {
        let mut t = Table::new();
        let Ok(Created::New(id)) = t.create_or_attach(new("s"), 0) else { panic!() };
        assert_eq!(t.touch_client(id, 1, Some((100, 30))), Some((100, 30)));
        assert_eq!(t.touch_client(id, 2, Some((40, 20))), Some((40, 20)));
        // Client 1 types: the window follows it back.
        assert_eq!(t.touch_client(id, 1, None), Some((100, 30)));
        assert_eq!(t.touch_client(id, 1, None), None, "no change, no resize");
        // Client 1 leaves: client 2 is the latest left.
        assert_eq!(t.detach_client(id, 1), Some((40, 20)));
        // The last client leaves: the session keeps its size.
        assert_eq!(t.detach_client(id, 2), None);
        assert_eq!(t.get("s").unwrap().size, (40, 20));
    }

    #[test]
    fn largest_policy_takes_the_largest_of_each_dimension() {
        let mut t = Table::new();
        let mut n = new("s");
        n.policy = SizePolicy::Largest;
        let Ok(Created::New(id)) = t.create_or_attach(n, 0) else { panic!() };
        t.touch_client(id, 1, Some((100, 20)));
        assert_eq!(t.touch_client(id, 2, Some((80, 40))), Some((100, 40)));
        assert_eq!(t.touch_client(id, 2, None), None, "typing changes nothing under largest");
        assert_eq!(t.detach_client(id, 1), Some((80, 40)));
        assert_eq!(window_size(SizePolicy::Largest, &[]), None);
        assert_eq!(window_size(SizePolicy::Latest, &[]), None);
    }

    #[test]
    fn a_dead_session_refuses_input() {
        let mut t = Table::new();
        let mut n = new("keep");
        n.remain_on_exit = true;
        let Ok(Created::New(keep)) = t.create_or_attach(n, 0) else { panic!() };
        let Ok(Created::New(ends)) = t.create_or_attach(new("ends"), 0) else { panic!() };
        assert_eq!(t.input_target("keep"), Err(TableError::Starting), "no child yet");
        assert!(t.mark_started(keep));
        assert_eq!(t.input_target("keep"), Ok(keep));
        assert!(t.mark_dead(keep, Some(3)));
        assert_eq!(t.input_target("keep"), Err(TableError::Dead));
        assert_eq!(t.get("keep").unwrap().dead, Some(Some(3)));
        assert!(!t.mark_dead(ends, Some(0)), "not remain-on-exit: the caller removes it");
        assert_eq!(t.input_target("nope"), Err(TableError::NotFound));
    }

    #[test]
    fn idle_exit_waits_for_a_quiet_minute_on_the_clock() {
        let mut idle = IdleTimer::new(60_000);
        assert!(!idle.observe(1_000, 0, 1), "a connection keeps the host");
        assert!(!idle.observe(2_000, 0, 0));
        assert!(!idle.observe(61_999, 0, 0));
        assert!(!idle.observe(62_000, 1, 0), "a session resets the timer");
        assert!(!idle.observe(63_000, 0, 0));
        assert!(!idle.observe(122_999, 0, 0));
        assert!(idle.observe(123_000, 0, 0));
        // A connection that opened and closed between two observations.
        idle.reset();
        assert!(!idle.observe(124_000, 0, 0));
        assert!(idle.observe(184_000, 0, 0));
    }

    #[test]
    fn spawn_validation_refuses_smuggling() {
        let abs = std::env::temp_dir().join("agent").to_string_lossy().into_owned();
        let env = |k: &str, v: &str| vec![(k.to_string(), v.to_string())];
        assert_eq!(validate_spawn(&[abs.clone(), "--x".into()], &env("PATH", "p"), Some("/w")), Ok(()));
        assert!(validate_spawn(&[], &[], None).is_err());
        assert!(validate_spawn(&["agent".into()], &[], None).is_err(), "relative");
        assert!(validate_spawn(&["\\\\server\\share\\a.exe".into()], &[], None).is_err(), "UNC");
        assert!(validate_spawn(&["\\\\?\\C:\\a.exe".into()], &[], None).is_err(), "device path");
        assert!(validate_spawn(&["//server/share/a".into()], &[], None).is_err());
        assert!(validate_spawn(&[abs.clone(), "a\0b".into()], &[], None).is_err());
        assert!(validate_spawn(std::slice::from_ref(&abs), &[], Some("/w\0")).is_err());
        assert!(validate_spawn(std::slice::from_ref(&abs), &env("", "v"), None).is_err());
        assert!(validate_spawn(std::slice::from_ref(&abs), &env("A=B", "v"), None).is_err());
        assert!(validate_spawn(std::slice::from_ref(&abs), &env("A\0", "v"), None).is_err());
        assert!(validate_spawn(std::slice::from_ref(&abs), &env("A", "v\0"), None).is_err());
        let bat = std::env::temp_dir().join("npm.cmd").to_string_lossy().into_owned();
        assert!(validate_spawn(&[bat], &[], None).is_err(), "batch");
    }

    #[test]
    fn batch_programs_are_known_however_they_are_spelled() {
        for p in [
            r"C:\x\a.bat",
            r"C:\x\a.CMD",
            r"C:\x\a.Bat.",
            r"C:\x\a.cmd . .",
            r"C:\x\a.bat::$DATA",
            r"C:\x\a.cmd::$data",
            r"C:\x\a.com",
            "/x/a.bat",
        ] {
            assert!(is_batch_program(p), "{p}");
        }
        for p in [r"C:\x\a.exe", r"C:\x.bat\a.exe", r"C:\x\bat", r"C:\x\a.batx", r"C:\x\cmd"] {
            assert!(!is_batch_program(p), "{p}");
        }
    }
}
