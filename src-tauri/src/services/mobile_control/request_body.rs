//! The one place the phone API turns a request body into a typed value.
//! Keep it to `serde` and `serde_json`, no `crate::` paths, so the server
//! gateway can compile it by `#[path]` like `limits.rs`.
//!
//! CodeQL's `rust/unsafe-deserialization` flags every `serde_json` parse of a
//! request body, though serde builds only the concrete type named: no type
//! tag in the input picks a type and nothing runs during the parse, so there
//! is no gadget to reach. Each route's own checks of the parsed fields are
//! the validation. Routing every body through here puts that one finding at
//! one line, reviewed once in `.github/codeql/reviewed.json` (its entry pins
//! this file's hash, so keep edits here rare and re-review after one).

use serde::de::DeserializeOwned;

/// Parse a JSON request body into `T`, or the parse error. Only for concrete
/// types; a route that takes open JSON (`serde_json::Value`) still checks
/// each field it reads.
pub fn parse_json<T: DeserializeOwned>(body: &[u8]) -> serde_json::Result<T> {
    serde_json::from_slice(body)
}
