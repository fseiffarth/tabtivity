//! The **format-agnostic seam** for end-to-end encrypted and signed mail
//! (`docs/mail_encryption_plan.md` §4).
//!
//! Not to be confused with [`crate::services::mail_crypt`], which encrypts the
//! local store at rest and shares nothing with this module but a prefix. This
//! one is about the *message*: what the sender did to it before it left their
//! machine.
//!
//! Two formats reduce to the same four operations, so they are declared once
//! here and implemented separately. Today only OpenPGP is implemented
//! ([`crate::services::mail_pgp`]); S/MIME is **detected but not handled**, and
//! that asymmetry is deliberate rather than an oversight — a detected-but-
//! unhandled message renders a banner saying so, which is strictly better than
//! rendering its ASN.1 blob as if it were the mail.
//!
//! # The one ordering that is not negotiable
//!
//! ```text
//! decrypt → parse → sanitize → render
//! ```
//!
//! Decryption confers **no trust whatsoever**. A decrypted body is still
//! attacker-controlled — more so, if anything, because it arrived wearing a
//! padlock — so it goes through `mail_sanitize::sanitize_message_html` exactly
//! as server-delivered content does, and lands in the same `sandbox=""` frame.
//! That frame is what makes EFAIL-class exfiltration hard: the attack is to
//! wrap a victim's ciphertext in markup whose *rendering* phones the plaintext
//! home, and it needs a renderer willing to fetch. Ours is not.
//!
//! # What the panel may and may not say
//!
//! The display vocabulary is copied from `mail_authres` on purpose
//! (`state`/`identifier`/`aligned`), because the misreading it was built to
//! prevent is the same one here: **a good signature is a statement about bytes,
//! not about a person.** `dkim=pass header.d=evil.example` on mail claiming to
//! be from a bank is a genuine pass by the wrong signer; a valid OpenPGP
//! signature from a key nobody verified is a genuine signature by an unknown
//! party. Both get the same treatment — the identity is shown next to the
//! verdict, and positive chrome requires the verdict *and* the alignment.
//!
//! And headers sit **outside** the signature in both formats. A signed message
//! does not authenticate its own `From`, `Subject` or `Date`; only its body is
//! covered. The panel therefore never implies that a green tick vouches for the
//! sender line above it.

use crate::schema::mail::{MailCryptoFormat, MailCryptoInfo, MailCryptoState};

// ── What a message turns out to be ──────────────────────────────────────────

/// The cryptographic shape of an incoming message.
///
/// Detection is about *structure*, not validity: a `CryptoKind` says what the
/// sender claims to have done, and says nothing about whether it holds. That
/// separation is what lets detection ship (Phase 3) before verification
/// (Phase 5) without a half-built verifier ever being able to report a pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CryptoKind {
    /// RFC 3156 `multipart/signed; protocol="application/pgp-signature"`.
    PgpSigned,
    /// RFC 3156 `multipart/encrypted; protocol="application/pgp-encrypted"`.
    PgpEncrypted,
    /// The pre-MIME form: `-----BEGIN PGP SIGNED MESSAGE-----` in a text part.
    PgpInlineSigned,
    /// The pre-MIME form: `-----BEGIN PGP MESSAGE-----` in a text part.
    PgpInlineEncrypted,
    /// `multipart/signed; protocol="application/pkcs7-signature"`.
    SmimeSigned,
    /// `application/pkcs7-mime` carrying `enveloped-data`.
    SmimeEncrypted,
    /// `application/pkcs7-mime` carrying `signed-data` — the opaque form, where
    /// the content is *inside* the CMS blob rather than beside it.
    SmimeOpaqueSigned,
}

impl CryptoKind {
    pub fn format(self) -> MailCryptoFormat {
        match self {
            CryptoKind::PgpSigned
            | CryptoKind::PgpEncrypted
            | CryptoKind::PgpInlineSigned
            | CryptoKind::PgpInlineEncrypted => MailCryptoFormat::OpenPgp,
            CryptoKind::SmimeSigned
            | CryptoKind::SmimeEncrypted
            | CryptoKind::SmimeOpaqueSigned => MailCryptoFormat::Smime,
        }
    }

    pub fn is_encrypted(self) -> bool {
        matches!(
            self,
            CryptoKind::PgpEncrypted | CryptoKind::PgpInlineEncrypted | CryptoKind::SmimeEncrypted
        )
    }

    pub fn is_signed(self) -> bool {
        matches!(
            self,
            CryptoKind::PgpSigned
                | CryptoKind::PgpInlineSigned
                | CryptoKind::SmimeSigned
                | CryptoKind::SmimeOpaqueSigned
        )
    }

    /// Whether this build can do anything but name it. S/MIME is detected and
    /// deferred (`docs/mail_encryption_plan.md` §5) — no certificate is issued
    /// to the user, so there is no credential the track could load.
    pub fn is_supported(self) -> bool {
        self.format() == MailCryptoFormat::OpenPgp
    }
}

/// What a verification attempt concluded.
///
/// `Good` is deliberately **not** "verified": it means the signature checks out
/// against a key we hold, which is a fact about bytes. Whether that key belongs
/// to anyone in particular is a separate question, answered by
/// [`SignerTrust`], and the two are kept apart because collapsing them is the
/// entire failure mode this feature has.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyOutcome {
    Good {
        /// The signing key's fingerprint, uppercase hex, no spaces.
        fingerprint: String,
        /// The address on the key's user id, when it carries one.
        identity: Option<String>,
        trust: SignerTrust,
    },
    /// A signature was present and did not check out. Distinct from
    /// [`VerifyOutcome::NoKey`], because "this is forged" and "I cannot tell"
    /// are different sentences and must not share chrome.
    Bad,
    /// No key for the signer, so nothing could be checked either way.
    NoKey { key_id: Option<String> },
    /// Structurally broken, or an algorithm this build does not implement.
    Unusable(String),
}

/// How much the signing key is worth.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignerTrust {
    /// The user compared the fingerprint out of band and said yes. **The only
    /// value that earns positive chrome.**
    Verified,
    /// We have the key — it arrived attached to mail, or came from a keyserver,
    /// or was imported without a fingerprint check. It signs; it proves nothing
    /// about who sent it.
    ///
    /// OpenPGP has no CA, so there is no `webpki` to lean on and no third party
    /// asserting the binding. This state is what that absence looks like, and
    /// the UI must show it as a shrug rather than a tick.
    Known,
}

/// Why a decryption did not produce plaintext.
///
/// Coarse on purpose. Every failure mode that could distinguish "wrong key"
/// from "malformed packet" from "bad padding" is an oracle, and the padding
/// oracle in RSA PKCS#1 v1.5 (RUSTSEC-2023-0071, unpatched, and inherited by
/// `pgp` through its unconditional `rsa` dependency) is exactly the shape of
/// attack that feeds on such a distinction. There is one failure state, it is
/// reached only on an explicit user click, and it is never observable over the
/// wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecryptError {
    /// One indistinguishable failure. The message text is fixed.
    Failed,
    /// No private key for any of the message's recipients. Safe to distinguish:
    /// it is answered from our own keyring without touching the ciphertext, so
    /// it leaks nothing about the message.
    NoKey,
    /// The keyring is locked, or there is no key at all yet.
    Locked,
    /// A format this build does not implement (today: all of S/MIME).
    Unsupported(&'static str),
}

impl std::fmt::Display for DecryptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecryptError::Failed => f.write_str("this message could not be decrypted"),
            DecryptError::NoKey => {
                f.write_str("this message was not encrypted to any key you hold")
            }
            DecryptError::Locked => f.write_str("your key is not available"),
            DecryptError::Unsupported(what) => write!(f, "{what} is not supported yet"),
        }
    }
}

// ── Detection ───────────────────────────────────────────────────────────────

/// The armor headers that mark the pre-MIME ("inline") OpenPGP forms.
const PGP_MESSAGE_ARMOR: &str = "-----BEGIN PGP MESSAGE-----";
const PGP_SIGNED_ARMOR: &str = "-----BEGIN PGP SIGNED MESSAGE-----";

/// Identify what, if anything, was done to a parsed message.
///
/// Runs over the already-parsed tree rather than over raw bytes, so it inherits
/// every structural cap `parse_bounded` applied — depth, part count, size. A
/// detector that re-scanned the raw message would be a second parser with its
/// own idea of the structure, and two parsers disagreeing about where a part
/// begins is how a signature ends up checked over the wrong bytes.
pub fn detect(msg: &mail_parser::Message<'_>) -> Option<CryptoKind> {
    use mail_parser::MimeHeaders;

    // MIME shapes first: they are unambiguous, and an inline-armored body inside
    // an encrypted wrapper must be reported as the wrapper.
    //
    // **The root part only.** A signed or encrypted node nested anywhere else
    // sits beside content it does not cover: `multipart/mixed[attacker html,
    // <Alice's genuine signed part>]` would otherwise show "verified" over the
    // attacker's HTML, and a captured ciphertext wrapped the same way would be
    // decrypted and shown under the attacker's From. A nested one is ordinary
    // mail with an attachment, which is exactly what it is to the reader.
    let root = msg.root_part();
    if let Some(ctype) = root.content_type() {
        let main = ctype.ctype().to_ascii_lowercase();
        let sub = ctype.subtype().unwrap_or_default().to_ascii_lowercase();
        let protocol = ctype
            .attribute("protocol")
            .unwrap_or_default()
            .to_ascii_lowercase();

        if main == "multipart" && sub == "signed" {
            if protocol.contains("pgp-signature") {
                return Some(CryptoKind::PgpSigned);
            }
            if protocol.contains("pkcs7-signature") {
                return Some(CryptoKind::SmimeSigned);
            }
        }
        if main == "multipart" && sub == "encrypted" && protocol.contains("pgp-encrypted") {
            return Some(CryptoKind::PgpEncrypted);
        }
        if main == "application" && (sub == "pkcs7-mime" || sub == "x-pkcs7-mime") {
            let smime_type = ctype
                .attribute("smime-type")
                .unwrap_or_default()
                .to_ascii_lowercase();
            // An unrecognized `smime-type` is treated as enveloped rather than
            // signed: guessing "signed" would mean guessing that there is
            // readable content beside it, and there is not.
            return Some(if smime_type.contains("signed") {
                CryptoKind::SmimeOpaqueSigned
            } else {
                CryptoKind::SmimeEncrypted
            });
        }
    }

    // Then the pre-MIME forms, which are just armor sitting in a text body —
    // and only when that body is the **one** thing the message displays. With a
    // second body part beside it, decrypting the armor would render the
    // plaintext inside someone else's message, the same splice as above.
    let [only] = msg.text_body.as_slice() else {
        return None;
    };
    if msg.html_body.as_slice() != [*only] {
        return None;
    }
    let text = msg.part(*only).and_then(|p| p.text_contents())?;
    detect_inline(text)
}

/// The inline (pre-MIME) forms, over a decoded text body.
///
/// Anchored to a line start, because the armor header is a line in the OpenPGP
/// grammar and matching it anywhere would let a message *quoting* one — a
/// mailing-list thread about PGP, most obviously — present itself as encrypted.
pub fn detect_inline(text: &str) -> Option<CryptoKind> {
    for line in text.lines() {
        let line = line.trim_end();
        if line == PGP_SIGNED_ARMOR {
            return Some(CryptoKind::PgpInlineSigned);
        }
        if line == PGP_MESSAGE_ARMOR {
            return Some(CryptoKind::PgpInlineEncrypted);
        }
    }
    None
}

// ── The seam ────────────────────────────────────────────────────────────────

/// The four operations both formats reduce to.
///
/// Declared even though one implementor exists, because the point is the
/// *shape*: `commands::mail` and `MailCryptoPanel` are written against this, so
/// un-deferring S/MIME (plan §5, if a certificate ever appears) is an added
/// implementor rather than a fork of the message pipeline.
pub trait MailCrypto: Send + Sync {
    /// Whether this implementation handles `kind`.
    fn handles(&self, kind: CryptoKind) -> bool;

    /// Check a detached signature over `signed` — the exact bytes the signature
    /// covers, canonicalized by the caller, since getting those bytes wrong is
    /// how a verifier reports a pass over something the sender never signed.
    fn verify(&self, signed: &[u8], signature: &[u8]) -> VerifyOutcome;

    /// Decrypt, returning the inner MIME message.
    fn decrypt(&self, enveloped: &[u8]) -> Result<zeroize::Zeroizing<Vec<u8>>, DecryptError>;
}

/// Build the panel's wire shape from a verification outcome.
///
/// The single place the "does this earn positive chrome" rule is applied, so
/// there is one answer rather than one per surface. Both conditions are
/// required, and the doc comment on [`MailCryptoState::Verified`] carries why.
pub fn info_for(
    kind: CryptoKind,
    outcome: Option<&VerifyOutcome>,
    decrypted: bool,
    from_address: &str,
) -> MailCryptoInfo {
    let mut info = MailCryptoInfo {
        format: kind.format(),
        encrypted: kind.is_encrypted(),
        decrypted,
        signed: kind.is_signed(),
        state: MailCryptoState::None,
        identifier: None,
        aligned: None,
        supported: kind.is_supported(),
        notes: Vec::new(),
    };
    if !kind.is_supported() {
        info.state = MailCryptoState::Unsupported;
        info.notes.push("format-not-supported".into());
        return info;
    }
    match outcome {
        None => {}
        Some(VerifyOutcome::Bad) => {
            info.state = MailCryptoState::Invalid;
            info.notes.push("signature-invalid".into());
        }
        Some(VerifyOutcome::Unusable(why)) => {
            info.state = MailCryptoState::Unusable;
            info.notes.push(why.clone());
        }
        Some(VerifyOutcome::NoKey { key_id }) => {
            info.state = MailCryptoState::NoKey;
            info.identifier = key_id.clone();
            info.notes.push("signer-key-missing".into());
        }
        Some(VerifyOutcome::Good {
            fingerprint,
            identity,
            trust,
        }) => {
            let aligned = identity
                .as_deref()
                .map(|id| addresses_match(id, from_address));
            info.identifier = Some(identity.clone().unwrap_or_else(|| fingerprint.clone()));
            info.aligned = aligned;
            info.state = match (trust, aligned) {
                // Verified key AND the signing identity is the one the message
                // claims to be from. Anything less is a statement about bytes.
                (SignerTrust::Verified, Some(true)) => MailCryptoState::Verified,
                (SignerTrust::Verified, _) => {
                    info.notes.push("signer-not-aligned".into());
                    MailCryptoState::Unaligned
                }
                (SignerTrust::Known, _) => {
                    info.notes.push("signer-key-unverified".into());
                    if aligned == Some(false) {
                        info.notes.push("signer-not-aligned".into());
                    }
                    MailCryptoState::Known
                }
            };
        }
    }
    // Stated on every signed message, in both formats, because it is the thing
    // users most reliably assume the tick covers and it never does.
    if kind.is_signed() {
        info.notes.push("headers-not-signed".into());
    }
    info
}

/// Whether two addresses are the same mailbox, for the alignment check.
///
/// A plain case-insensitive comparison of the whole address, **not** a
/// registrable-domain comparison like `mail_authres`'s. The difference is what
/// each is comparing: DKIM signs on behalf of a *domain*, so `header.d` matching
/// the From's domain is the right question there. A PGP key's user id names a
/// *person*, so `alice@example.com` signing mail from `bob@example.com` is not
/// alignment, however much the two share a domain.
fn addresses_match(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim().trim_matches(['<', '>']).to_ascii_lowercase();
    let a = norm(a);
    let b = norm(b);
    !a.is_empty() && a == b
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str) -> mail_parser::Message<'_> {
        mail_parser::MessageParser::default()
            .parse(raw.as_bytes())
            .unwrap()
    }

    const HEAD: &str = "From: a@example.com\r\nTo: b@example.org\r\nSubject: x\r\n";

    #[test]
    fn a_plain_message_is_not_crypto() {
        assert_eq!(detect(&parse(&format!("{HEAD}\r\nhello\r\n"))), None);
    }

    #[test]
    fn rfc_3156_shapes_are_recognized() {
        let signed = format!(
            "{HEAD}Content-Type: multipart/signed; protocol=\"application/pgp-signature\"; \
             micalg=pgp-sha256; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nhi\r\n\
             --b\r\nContent-Type: application/pgp-signature\r\n\r\nsig\r\n--b--\r\n"
        );
        assert_eq!(detect(&parse(&signed)), Some(CryptoKind::PgpSigned));

        let enc = format!(
            "{HEAD}Content-Type: multipart/encrypted; protocol=\"application/pgp-encrypted\"; \
             boundary=b\r\n\r\n--b\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n\
             --b\r\nContent-Type: application/octet-stream\r\n\r\nblob\r\n--b--\r\n"
        );
        assert_eq!(detect(&parse(&enc)), Some(CryptoKind::PgpEncrypted));
    }

    #[test]
    fn smime_is_detected_even_though_it_is_not_handled() {
        // The whole value of detecting an unhandled format: the reader gets a
        // banner instead of a screenful of base64 rendered as the message.
        let signed = format!(
            "{HEAD}Content-Type: multipart/signed; protocol=\"application/pkcs7-signature\"; \
             boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nhi\r\n\
             --b\r\nContent-Type: application/pkcs7-signature\r\n\r\nsig\r\n--b--\r\n"
        );
        let kind = detect(&parse(&signed)).unwrap();
        assert_eq!(kind, CryptoKind::SmimeSigned);
        assert!(!kind.is_supported());

        let env = format!(
            "{HEAD}Content-Type: application/pkcs7-mime; smime-type=enveloped-data; \
             name=smime.p7m\r\n\r\nMIIB\r\n"
        );
        assert_eq!(detect(&parse(&env)), Some(CryptoKind::SmimeEncrypted));

        let opaque = format!(
            "{HEAD}Content-Type: application/pkcs7-mime; smime-type=signed-data; \
             name=smime.p7m\r\n\r\nMIIB\r\n"
        );
        assert_eq!(detect(&parse(&opaque)), Some(CryptoKind::SmimeOpaqueSigned));
    }

    /// An unrecognized `smime-type` must not be guessed as `signed`: that would
    /// claim there is readable content beside the blob when there is not.
    #[test]
    fn an_unknown_smime_type_is_treated_as_enveloped() {
        let odd =
            format!("{HEAD}Content-Type: application/pkcs7-mime; smime-type=future\r\n\r\nX\r\n");
        assert_eq!(detect(&parse(&odd)), Some(CryptoKind::SmimeEncrypted));
    }

    #[test]
    fn inline_armor_is_recognized_only_at_a_line_start() {
        assert_eq!(
            detect_inline("-----BEGIN PGP MESSAGE-----\nblah\n"),
            Some(CryptoKind::PgpInlineEncrypted)
        );
        assert_eq!(
            detect_inline("-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n"),
            Some(CryptoKind::PgpInlineSigned)
        );
        // A message *about* PGP is not a PGP message. Without the anchor, every
        // mailing-list thread on the subject would grow a padlock.
        assert_eq!(
            detect_inline("you write \"-----BEGIN PGP MESSAGE-----\" at the top"),
            None
        );
        assert_eq!(detect_inline("nothing here"), None);
    }

    #[test]
    fn a_mime_wrapper_outranks_inline_armor_inside_it() {
        // The armor inside an encrypted wrapper is the *ciphertext*. Reporting
        // the inner form would describe the payload instead of the message.
        let enc = format!(
            "{HEAD}Content-Type: multipart/encrypted; protocol=\"application/pgp-encrypted\"; \
             boundary=b\r\n\r\n--b\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n\
             --b\r\nContent-Type: application/octet-stream\r\n\r\n-----BEGIN PGP MESSAGE-----\r\n\
             --b--\r\n"
        );
        assert_eq!(detect(&parse(&enc)), Some(CryptoKind::PgpEncrypted));
    }

    /// A signed or encrypted node that is not the root covers only itself, so
    /// it must not lend the whole message a verdict or be decrypted into it.
    #[test]
    fn a_nested_crypto_part_does_not_speak_for_the_message() {
        let spliced_signed = format!(
            "{HEAD}Content-Type: multipart/mixed; boundary=m\r\n\r\n--m\r\n\
             Content-Type: text/html\r\n\r\n<b>pay here</b>\r\n--m\r\n\
             Content-Type: multipart/signed; protocol=\"application/pgp-signature\"; \
             boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nhi\r\n\
             --b\r\nContent-Type: application/pgp-signature\r\n\r\nsig\r\n--b--\r\n--m--\r\n"
        );
        assert_eq!(detect(&parse(&spliced_signed)), None);

        let spliced_enc = format!(
            "{HEAD}Content-Type: multipart/mixed; boundary=m\r\n\r\n--m\r\n\
             Content-Type: text/plain\r\n\r\nsee below\r\n--m\r\n\
             Content-Type: multipart/encrypted; protocol=\"application/pgp-encrypted\"; \
             boundary=b\r\n\r\n--b\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n\
             --b\r\nContent-Type: application/octet-stream\r\n\r\nblob\r\n--b--\r\n--m--\r\n"
        );
        assert_eq!(detect(&parse(&spliced_enc)), None);
    }

    #[test]
    fn inline_armor_counts_only_as_the_sole_body() {
        let alone = format!("{HEAD}\r\n-----BEGIN PGP MESSAGE-----\r\nx\r\n");
        assert_eq!(detect(&parse(&alone)), Some(CryptoKind::PgpInlineEncrypted));

        let with_attachment = format!(
            "{HEAD}Content-Type: multipart/mixed; boundary=m\r\n\r\n--m\r\n\
             Content-Type: text/plain\r\n\r\n-----BEGIN PGP MESSAGE-----\r\nx\r\n--m\r\n\
             Content-Type: application/pdf\r\nContent-Disposition: attachment; filename=a.pdf\r\n\r\n\
             %PDF\r\n--m--\r\n"
        );
        assert_eq!(
            detect(&parse(&with_attachment)),
            Some(CryptoKind::PgpInlineEncrypted)
        );

        let beside_html = format!(
            "{HEAD}Content-Type: multipart/mixed; boundary=m\r\n\r\n--m\r\n\
             Content-Type: text/html\r\n\r\n<b>reply to this</b>\r\n--m\r\n\
             Content-Type: text/plain\r\n\r\n-----BEGIN PGP MESSAGE-----\r\nx\r\n--m--\r\n"
        );
        assert_eq!(detect(&parse(&beside_html)), None);
    }

    // ── The chrome rule ─────────────────────────────────────────────────────

    fn good(trust: SignerTrust, identity: &str) -> VerifyOutcome {
        VerifyOutcome::Good {
            fingerprint: "ABCD1234".into(),
            identity: Some(identity.into()),
            trust,
        }
    }

    #[test]
    fn only_a_verified_and_aligned_signature_earns_positive_chrome() {
        let v = info_for(
            CryptoKind::PgpSigned,
            Some(&good(SignerTrust::Verified, "a@example.com")),
            false,
            "a@example.com",
        );
        assert_eq!(v.state, MailCryptoState::Verified);

        // Verified key, wrong person.
        let u = info_for(
            CryptoKind::PgpSigned,
            Some(&good(SignerTrust::Verified, "someone@else.example")),
            false,
            "a@example.com",
        );
        assert_eq!(u.state, MailCryptoState::Unaligned);

        // Right person, key nobody checked. This is the OpenPGP-specific case
        // and the one most likely to be misread as a tick.
        let k = info_for(
            CryptoKind::PgpSigned,
            Some(&good(SignerTrust::Known, "a@example.com")),
            false,
            "a@example.com",
        );
        assert_eq!(k.state, MailCryptoState::Known);
        assert!(k.notes.contains(&"signer-key-unverified".to_string()));
    }

    #[test]
    fn a_bad_signature_and_a_missing_key_do_not_share_a_state() {
        let bad = info_for(
            CryptoKind::PgpSigned,
            Some(&VerifyOutcome::Bad),
            false,
            "a@example.com",
        );
        let none = info_for(
            CryptoKind::PgpSigned,
            Some(&VerifyOutcome::NoKey { key_id: None }),
            false,
            "a@example.com",
        );
        assert_eq!(bad.state, MailCryptoState::Invalid);
        assert_eq!(none.state, MailCryptoState::NoKey);
        assert_ne!(
            bad.state, none.state,
            "'forged' and 'I cannot tell' are different sentences"
        );
    }

    #[test]
    fn every_signed_message_says_its_headers_are_not_covered() {
        for kind in [CryptoKind::PgpSigned, CryptoKind::PgpInlineSigned] {
            let info = info_for(
                kind,
                Some(&good(SignerTrust::Verified, "a@example.com")),
                false,
                "a@example.com",
            );
            assert!(
                info.notes.contains(&"headers-not-signed".to_string()),
                "{kind:?} must state that From/Subject are outside the signature"
            );
        }
    }

    #[test]
    fn an_unsupported_format_reports_itself_and_verifies_nothing() {
        let info = info_for(CryptoKind::SmimeSigned, None, false, "a@example.com");
        assert_eq!(info.state, MailCryptoState::Unsupported);
        assert!(!info.supported);
    }

    /// Alignment is per-mailbox, not per-domain — unlike DKIM's, and for a
    /// reason: a PGP user id names a person, so a colleague's key signing mail
    /// that claims to be from you is not alignment.
    #[test]
    fn alignment_compares_the_whole_address() {
        assert!(addresses_match("A@Example.COM", "a@example.com"));
        assert!(addresses_match("<a@example.com>", "a@example.com"));
        assert!(!addresses_match("alice@example.com", "bob@example.com"));
        assert!(!addresses_match("", "a@example.com"));
    }
}
