//! The `mail` group of `services/`: every module here is re-exported from
//! `services/mod.rs`, so `crate::services::<module>` keeps resolving.

// Local-model mail assistant (Group Q, #203–#208): the loopback-only /api/chat
// helper, prompt builders and defensive JSON parsers. AI never touches the net.
pub mod mail_ai;
// A root agent's `attach` on a mail draft: project files resolved under the
// same-roots rule and read without following a link (`docs/mail_mcp_attachments_plan.md`).
pub mod mail_attach;
pub mod mail_authres;
// The mail client's address book: cards, lists, collected addresses, vCard.
pub mod mail_contacts;
pub mod mail_crypt;
pub mod mail_crypto;
pub mod mail_engine;
pub mod mail_filters;
pub mod mail_pgp;
pub mod mail_reader;
pub mod mail_rekey;
pub mod mail_sanitize;
pub mod mail_store;
// Thunderbird address books (abook/history.sqlite), read from a temp copy.
pub mod mail_thunderbird;
