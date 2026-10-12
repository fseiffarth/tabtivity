//! A picked file as an opaque, short-lived grant — the browser client's
//! stand-in for "the OS dialog returned a path" (hosted plan §3.5).
//!
//! `commands::mail` names no location the frontend controls (its rule 2, held
//! by `no_command_takes_a_path`): on the desktop its five file commands raise
//! the OS dialog in Rust and never see a frontend path. A browser has no OS
//! dialog; its picker runs in the page and browses the server's files. So the
//! page does not hand the mail command a path — it hands it a **grant**: the
//! transport minted one for the path the user just picked (`desktop_file_grant`),
//! single-use, a few minutes long, and the mail command resolves it here. The
//! mail subsystem's reach stays "what the user picked a moment ago", exactly
//! what the dialog gave it; the frontend's word alone opens nothing.
//!
//! Managed by every host (`lib.rs::Singletons`); only a server transport ever
//! mints, so in the desktop window the table stays empty.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long a grant may be redeemed.
pub const GRANT_TTL: Duration = Duration::from_secs(5 * 60);
/// The most grants held at once; the oldest goes when a new one is minted.
const MAX_GRANTS: usize = 64;

pub type PickGrantsState = Arc<Mutex<PickGrants>>;

pub fn new_state() -> PickGrantsState {
    Arc::new(Mutex::new(PickGrants::default()))
}

struct Grant {
    path: PathBuf,
    expires: Instant,
}

#[derive(Default)]
pub struct PickGrants {
    grants: HashMap<String, Grant>,
}

impl PickGrants {
    /// A new grant for `path`; the id is what the frontend gets.
    pub fn grant(&mut self, path: PathBuf, id: String) -> String {
        let now = Instant::now();
        self.grants.retain(|_, g| g.expires > now);
        if self.grants.len() >= MAX_GRANTS {
            if let Some(oldest) = self.grants.iter().min_by_key(|(_, g)| g.expires).map(|(k, _)| k.clone()) {
                self.grants.remove(&oldest);
            }
        }
        self.grants.insert(id.clone(), Grant { path, expires: now + GRANT_TTL });
        id
    }

    /// The path behind `id`, once: a grant is spent by redeeming it.
    pub fn take(&mut self, id: &str) -> Option<PathBuf> {
        let grant = self.grants.remove(id)?;
        (grant.expires > Instant::now()).then_some(grant.path)
    }

    pub fn len(&self) -> usize {
        self.grants.len()
    }

    pub fn is_empty(&self) -> bool {
        self.grants.is_empty()
    }
}

/// Redeem `id` from the managed table, with the error the mail commands show.
pub fn redeem(state: &PickGrantsState, id: &str) -> Result<PathBuf, String> {
    state
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take(id)
        .ok_or_else(|| "that file pick has expired; choose the file again".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_grant_is_redeemed_once() {
        let mut grants = PickGrants::default();
        let id = grants.grant(PathBuf::from("/srv/a.vcf"), "g1".into());
        assert_eq!(grants.take(&id), Some(PathBuf::from("/srv/a.vcf")));
        assert_eq!(grants.take(&id), None, "spent");
        assert_eq!(grants.take("never"), None);
        assert!(grants.is_empty());
    }

    #[test]
    fn the_table_is_bounded() {
        let mut grants = PickGrants::default();
        for i in 0..(MAX_GRANTS + 5) {
            grants.grant(PathBuf::from(format!("/f/{i}")), format!("g{i}"));
        }
        assert_eq!(grants.len(), MAX_GRANTS);
        assert_eq!(grants.take("g0"), None, "the oldest went");
        assert!(grants.take(&format!("g{}", MAX_GRANTS + 4)).is_some());
    }

    #[test]
    fn redeem_speaks_for_the_mail_commands() {
        let state = new_state();
        state.lock().unwrap().grant(PathBuf::from("/x"), "g".into());
        assert_eq!(redeem(&state, "g"), Ok(PathBuf::from("/x")));
        assert!(redeem(&state, "g").unwrap_err().contains("expired"));
    }
}
