use super::*;

#[tokio::test]
async fn move_uid_response_keeps_tagged_and_untagged_copyuid() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    for tagged in [false, true] {
        let (client, server) = tokio::io::duplex(4096);
        let server = tokio::spawn(async move {
            let mut server = BufReader::new(server);
            let mut line = String::new();
            server.read_line(&mut line).await.unwrap();
            let tag = line.split_whitespace().next().unwrap().to_string();
            server.get_mut().write_all(format!("{tag} OK logged in\r\n").as_bytes()).await.unwrap();
            line.clear();
            server.read_line(&mut line).await.unwrap();
            let tag = line.split_whitespace().next().unwrap();
            assert!(line.contains("UID MOVE 142,399 \"Archive\""));
            let response = if tagged {
                format!("* 1 EXPUNGE\r\n{tag} OK [COPYUID 7 142,399 41:42] moved\r\n")
            } else {
                format!("* OK [COPYUID 7 142,399 41:42] moved\r\n* 1 EXPUNGE\r\n{tag} OK moved\r\n")
            };
            server.get_mut().write_all(response.as_bytes()).await.unwrap();
        });
        let mut session = async_imap::Client::new(client).login("user", "password").await.unwrap();
        let pairs = move_uid_chunk(&mut session, "142,399", "\"Archive\"", 2).await.unwrap();
        assert_eq!(pairs, vec![(142, 41), (399, 42)]);
        server.await.unwrap();
    }
}

#[test]
fn move_uids_follow_copyuid_order_and_reject_invalid_mappings() {
    use async_imap::imap_proto::UidSetMember::{Uid, UidRange};
    let pairs = move_uid_pairs(&[Uid(142), Uid(399)], &[UidRange(41..=42)], 2).unwrap();
    assert_eq!(pairs, vec![(142, 41), (399, 42)]);
    assert!(validate_move_uids(&[142, 399], &pairs).is_ok());
    assert_eq!(move_uid_pairs(&[UidRange(std::ops::RangeInclusive::new(3, 1))], &[UidRange(7..=9)], 3).unwrap(),
        vec![(3, 7), (2, 8), (1, 9)]);
    assert!(move_uid_pairs(&[Uid(1)], &[UidRange(1..=u32::MAX)], 1).is_err());
    assert!(move_uid_pairs(&[Uid(0)], &[Uid(1)], 1).is_err());
    assert!(move_uid_pairs(&[Uid(1)], &[UidRange(1..=2)], 2).is_err());
    assert!(validate_move_uids(&[1, 2], &[(1, 9)]).is_err());
    assert!(validate_move_uids(&[1, 2], &[(1, 9), (2, 9)]).is_err());
    assert!(validate_move_uids(&[1, 2], &[(1, 9), (3, 10)]).is_err());
}

// ── UID sets ────────────────────────────────────────────────────────────

/// The set is what a bulk STORE *addresses*, so every case here is really
/// "does this name exactly the messages it was given, and nothing else".
#[test]
fn uid_set_is_empty_for_no_uids() {
    // Not `[""]`: `UID STORE  +FLAGS (\Seen)` is a syntax error, and a
    // caller looping over the result must therefore send nothing at all.
    assert!(uid_set_chunks(&[], 1000).is_empty());
}

#[test]
fn uid_set_collapses_a_run_into_a_range() {
    assert_eq!(uid_set_chunks(&[1, 2, 3, 4], 1000), vec!["1:4"]);
}

#[test]
fn uid_set_keeps_isolated_uids_separate() {
    assert_eq!(uid_set_chunks(&[1, 3, 5], 1000), vec!["1,3,5"]);
}

#[test]
fn uid_set_mixes_runs_and_singles() {
    assert_eq!(
        uid_set_chunks(&[1, 2, 3, 7, 10, 11], 1000),
        vec!["1:3,7,10:11"]
    );
}

#[test]
fn uid_set_sorts_and_dedupes_first() {
    // The store returns them ordered, but a run is only detectable in order
    // and a duplicate would break one in half.
    assert_eq!(uid_set_chunks(&[3, 1, 2, 3], 1000), vec!["1:3"]);
}

#[test]
fn uid_set_splits_on_the_character_budget() {
    // Every other uid, so nothing collapses: worst case for the budget.
    let uids: Vec<u32> = (0..100).map(|i| i * 2 + 1).collect();
    let chunks = uid_set_chunks(&uids, 40);
    assert!(chunks.len() > 1, "expected a split, got {chunks:?}");
    for c in &chunks {
        assert!(c.len() <= 40, "chunk over budget: {c:?}");
        assert!(!c.starts_with(','), "chunk starts with a separator: {c:?}");
        assert!(!c.ends_with(','), "chunk ends with a separator: {c:?}");
    }
    // The whole point: splitting must not drop or invent a single uid.
    let mut back: Vec<u32> = Vec::new();
    for c in &chunks {
        for piece in c.split(',') {
            back.push(piece.parse().expect("single uid"));
        }
    }
    assert_eq!(back, uids);
}

#[test]
fn uid_set_never_splits_inside_a_range() {
    // A range cut in half addresses messages nobody asked about, which for
    // a `-FLAGS` on \Seen would mark unrelated mail unread.
    let uids: Vec<u32> = (1..=500).collect();
    let chunks = uid_set_chunks(&uids, 4);
    assert_eq!(chunks, vec!["1:500"]);
}

// ── Server search criteria ──────────────────────────────────────────

#[test]
fn search_criterion_names_subject_or_sender() {
    assert_eq!(
        server_search_criterion("invoice", true),
        "CHARSET UTF-8 OR SUBJECT \"invoice\" FROM \"invoice\""
    );
    assert_eq!(
        server_search_criterion("invoice", false),
        "OR SUBJECT \"invoice\" FROM \"invoice\""
    );
}

#[test]
fn search_quoting_cannot_break_command_framing() {
    // A quote or backslash in the query is escaped in place ...
    assert_eq!(imap_quoted("say \"hi\" \\ bye"), "\"say \\\"hi\\\" \\\\ bye\"");
    // ... and a newline is dropped, never sent: inside a quoted-string it
    // would end the command and let the rest parse as new commands.
    assert_eq!(imap_quoted("a\r\nb"), "\"ab\"");
    assert_eq!(server_search_criterion("a\"b", true).matches('"').count(), 6);
}

// ── The crypto provider ─────────────────────────────────────────────────

/// rustls refuses to guess between two compiled-in providers and panics at
/// the *first handshake* if none is installed — a failure that would only
/// ever show up on a user's machine, mid-connect.
#[test]
fn provider_is_installed() {
    install_crypto_provider();
    assert!(rustls::crypto::CryptoProvider::get_default().is_some());
}

#[test]
fn installing_twice_is_harmless() {
    install_crypto_provider();
    install_crypto_provider();
    assert!(rustls::crypto::CryptoProvider::get_default().is_some());
}

/// A platform verifier that cannot be built (an unreadable OS trust
/// store) is an error every connect answers with, not a panic — the
/// first time and every time after.
#[test]
fn a_broken_platform_verifier_is_an_error_not_a_panic() {
    let cell = std::sync::OnceLock::new();
    let first = cached_tls_config(&cell, || Err(rustls::Error::General("no trust store".into())));
    let err = first.expect_err("a broken verifier is refused");
    assert!(err.contains("no trust store"), "{err}");
    let again = cached_tls_config(&cell, || panic!("built once"));
    assert_eq!(again.expect_err("still refused"), err);
}

// ── Secrets ─────────────────────────────────────────────────────────────

#[test]
fn a_password_never_prints_itself() {
    let pw = Password::new("hunter2"); // privacy-check: ok — test fixture, never sent
    let printed = format!("{pw:?}");
    assert!(!printed.contains("hunter2"), "{printed}");
    assert_eq!(printed, "Password(<redacted>)");
    // And inside a container, which is how it would reach a log line.
    let wrapped = format!("{:?}", Some(pw.clone()));
    assert!(!wrapped.contains("hunter2"), "{wrapped}");
    assert_eq!(pw.expose(), "hunter2");
}

// ── Transport ───────────────────────────────────────────────────────────

/// The one structural guarantee behind "there is no ignore-certificate
/// option": the strings that would introduce one do not appear in the mail
/// sources. Cheap, and it makes "just add a checkbox" a failing test rather
/// than a code-review argument.
#[test]
fn no_certificate_verification_escape_hatch() {
    let sources: [(&str, &str); 4] = [
        ("mail_engine.rs", include_str!("../mail_engine.rs")),
        ("mail_sanitize.rs", include_str!("../mail_sanitize.rs")),
        ("mail_store.rs", include_str!("../mail_store.rs")),
        ("commands/mail.rs", include_str!("../../../commands/mail.rs")),
    ];
    // Split so this list does not match itself when the scan runs over
    // this very file.
    let banned = [
        concat!("danger", "ous()"),
        concat!("ServerCert", "Verifier"),
        concat!("danger_accept", "_invalid"),
        concat!("with_custom_certificate", "_verifier"),
        concat!("NoCertificate", "Verification"),
        concat!("allow_invalid", "_certs"),
    ];
    for (name, src) in sources {
        for needle in banned {
            assert!(
                !src.contains(needle),
                "{name} must not contain `{needle}` — certificate validation has no bypass"
            );
        }
    }
}

/// v1 speaks implicit TLS only, so the cleartext submission/access ports
/// must not appear as defaults anywhere in the mail sources.
#[test]
fn no_cleartext_default_ports() {
    let sources: [(&str, &str); 2] = [
        ("mail_engine.rs", include_str!("../mail_engine.rs")),
        ("commands/mail.rs", include_str!("../../../commands/mail.rs")),
    ];
    for (name, src) in sources {
        // Split so the list does not match itself when the scan runs over
        // this very file.
        for port in [
            concat!(": ", "143"),
            concat!(": ", "110"),
            concat!(": ", "25,"),
            concat!(": ", "587"),
            concat!("port: ", "143"),
            concat!("port: ", "587"),
        ] {
            assert!(
                !src.contains(port),
                "{name} names a cleartext port `{port}`"
            );
        }
    }
}

// ── The session pool (#167) ────────────────────────────────────────────

/// The tripwire that keeps the pool from being routed around. Every IMAP
/// operation obtains its session from `acquire`, so `imap_login` is
/// *defined* once and *called* once — a method that starts logging in
/// directly again is a per-operation login storm, which is the whole defect
/// this feature exists to remove, and it would otherwise be invisible.
#[test]
fn every_imap_operation_goes_through_the_pool() {
    let src = include_str!("../mail_engine.rs");
    // Split so this assertion does not count itself.
    let needle = concat!("imap", "_login(");
    let uses = src.matches(needle).count();
    assert_eq!(
        uses, 2,
        "`{needle}` should appear exactly twice (its definition and the one \
             call inside `acquire`), found {uses} — an IMAP operation is logging \
             in for itself instead of leasing a pooled session"
    );
}

/// The key is what decides *who is authenticated*, so a different host, port
/// or user must never share a pooled session.
#[test]
fn pool_key_separates_hosts_ports_and_users() {
    let base = MailServer {
        host: "imap.example.com".into(),
        port: 993,
        user: "a@example.com".into(),
        security: MailSecurity::Tls,
    };
    let key = pool_key(&base);
    let other_host = pool_key(&MailServer {
        host: "imap.other.com".into(),
        ..base.clone()
    });
    let other_port = pool_key(&MailServer {
        port: 994,
        ..base.clone()
    });
    let other_user = pool_key(&MailServer {
        user: "b@example.com".into(),
        ..base.clone()
    });
    assert_ne!(key, other_host);
    assert_ne!(key, other_port);
    assert_ne!(key, other_user);
}

/// A host is case-insensitive and a stray space is a typo, not an account —
/// both would otherwise mint a second connection to the same server.
#[test]
fn pool_key_normalizes_the_host() {
    let a = pool_key(&MailServer {
        host: "IMAP.Example.COM".into(),
        port: 993,
        user: "a@example.com".into(),
        security: MailSecurity::Tls,
    });
    let b = pool_key(&MailServer {
        host: "  imap.example.com ".into(),
        port: 993,
        user: "a@example.com".into(),
        security: MailSecurity::Tls,
    });
    assert_eq!(a, b);
}

/// The two age thresholds, and the order they have to sit in: anything old
/// enough to be closed is also old enough to have needed a probe, or a
/// session could be handed out unprobed *because* it was too stale to keep.
#[test]
fn pool_entry_age_thresholds_are_ordered() {
    assert!(POOL_PROBE_AFTER < POOL_MAX_IDLE);

    assert!(!pool_entry_needs_probe(Duration::from_secs(1)));
    assert!(!pool_entry_expired(Duration::from_secs(1)));

    assert!(pool_entry_needs_probe(POOL_PROBE_AFTER));
    assert!(!pool_entry_expired(POOL_PROBE_AFTER));

    assert!(pool_entry_expired(POOL_MAX_IDLE));
    assert!(pool_entry_needs_probe(POOL_MAX_IDLE));
}

/// A liveness check that could outlive the login it is meant to save must
/// not exist: the fallback for a failed probe is simply to log in.
#[test]
fn the_pool_probe_fails_faster_than_a_command() {
    assert!(POOL_PROBE_TIMEOUT < COMMAND_TIMEOUT);
}

/// Eviction is by key, so forgetting one account's credential cannot close
/// another account's connection.
#[test]
fn forgetting_one_account_leaves_the_others_pooled() {
    let a = MailServer {
        host: "imap.a.example".into(),
        port: 993,
        user: "a@a.example".into(),
        security: MailSecurity::Tls,
    };
    let b = MailServer {
        host: "imap.b.example".into(),
        port: 993,
        user: "b@b.example".into(),
        security: MailSecurity::Tls,
    };
    // No socket is involved: the buckets are keyed and emptied by name, and
    // that naming is the whole of what eviction gets right or wrong.
    {
        let mut pool = pool().lock().unwrap();
        pool.entry(pool_key(&a)).or_default();
        pool.entry(pool_key(&b)).or_default();
    }
    forget_pooled_sessions(&a);
    let pool = pool().lock().unwrap();
    assert!(!pool.contains_key(&pool_key(&a)));
    assert!(pool.contains_key(&pool_key(&b)));
}

/// The refusal a VPN-only account gets is the gate's own sentence, so mail
/// and CalDAV explain the state identically; and an account that is not
/// gated passes the gate whatever the tunnel registry holds.
#[test]
fn the_vpn_refusal_is_the_shared_sentence_and_spares_ungated_accounts() {
    assert_eq!(
        MailError::VpnRequired.to_string(),
        crate::services::openvpn::VPN_GATE_REFUSAL
    );
    let account = MailAccount {
        id: "a1".into(),
        label: "Work".into(),
        address: "user@example.com".into(),
        imap: MailServer {
            host: "imap.example.com".into(),
            port: 993,
            user: "u".into(),
            security: MailSecurity::Tls,
        },
        smtp: MailServer {
            host: "smtp.example.com".into(),
            port: 465,
            user: "u".into(),
            security: MailSecurity::Tls,
        },
        ..Default::default()
    };
    assert_eq!(vpn_gate(&account), Ok(()));
}

#[tokio::test]
async fn a_non_tls_endpoint_is_refused_before_any_socket_is_opened() {
    let server = MailServer {
        host: "imap.example.com".into(),
        port: 993,
        user: "u".into(),
        security: MailSecurity::Starttls,
    };
    let err = tls_stream(&server).await.unwrap_err();
    assert_eq!(err, MailError::PlaintextRefused);

    let server = MailServer {
        security: MailSecurity::None,
        ..server
    };
    let err = match smtp_connect(&server, &Password::new("x")).await { // privacy-check: ok — test fixture, never sent
        Ok(_) => panic!("a non-TLS SMTP endpoint must be refused"),
        Err(e) => e,
    };
    assert_eq!(err, MailError::PlaintextRefused);
}

// ── Parsing ─────────────────────────────────────────────────────────────

fn fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/mail")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("fixture {name}: {e}"))
}

// ── Modified UTF-7 folder names ─────────────────────────────────────────

/// Found in live QA against a German Gmail: `[Gmail]/Entwürfe` arrived as
/// `[Gmail]/Entw&APw-rfe` and was shown that way.
#[test]
fn modified_utf7_folder_names_decode() {
    let cases: &[(&str, &str)] = &[
        // The reported case, and its siblings on a German account.
        ("Entw&APw-rfe", "Entwürfe"),
        ("Gel&APY-schte Elemente", "Gelöschte Elemente"),
        ("&APw-", "ü"),
        // Plain ASCII is untouched.
        ("INBOX", "INBOX"),
        ("[Gmail]/All Mail", "[Gmail]/All Mail"),
        // A literal ampersand is `&-`.
        ("Tom &- Jerry", "Tom & Jerry"),
        ("R&D", "R&D"),
        // Other alphabets. (Every expectation in this table was produced by
        // an independent reference decoder, not typed by hand — two of them
        // were wrong the first time and the decoder was right.)
        ("&BCcENQRABD0EPgQyBDgEOgQ4-", "Черновики"),
        ("&ZeVnLIqe-", "日本語"),
        // Astral plane: surrogate pairs must recombine, not become two
        // replacement characters.
        ("&2Dzfs9g837M-", "🎳🎳"),
        // The `,`-for-`/` substitution, which is the one way this differs
        // from ordinary base64: `ϰ` encodes to `A/A` in RFC 2045 and must
        // be spelled `A,A` here.
        ("&A,A-", "ϰ"),
        // Consecutive runs, and a run ended implicitly by a non-alphabet
        // character rather than by `-`.
        ("&APw-&APY-", "üö"),
        ("&APw x", "ü x"),
    ];
    for (input, want) in cases {
        assert_eq!(decode_modified_utf7(input), *want, "input {input:?}");
    }
}

/// A name that is not valid modified UTF-7 must still be *shown*. A folder
/// that silently loses its name is worse than one that shows the wire form.
#[test]
fn an_undecodable_folder_name_is_kept_verbatim() {
    for input in [
        "&",           // a dangling shift
        "&!!!-",       // characters outside the alphabet
        "&A-",         // a truncated run
        "&AAAAAAAAAA", // unterminated, over-long
        "Weird&Name",
    ] {
        let got = decode_modified_utf7(input);
        assert!(!got.is_empty(), "{input:?} produced nothing");
    }
    assert_eq!(decode_modified_utf7("&"), "&");
    assert_eq!(decode_modified_utf7("&!!!-"), "&!!!-");
}

/// Whatever a server sends, decoding returns and never panics.
#[test]
fn folder_name_decoding_is_total() {
    // Grouped to read as "FOLDER", not in even nibble groups.
    #[allow(clippy::unusual_byte_groupings)]
    let mut seed: u64 = 0xF01DE_1234_0001;
    for _ in 0..5_000 {
        let len = {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            (seed >> 33) as usize % 48
        };
        let mut bytes = Vec::with_capacity(len);
        for _ in 0..len {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let b = (seed >> 24) as u8;
            // Weight the structural characters, where the states are.
            bytes.push(match b % 6 {
                0 => b'&',
                1 => b'-',
                2 => b',',
                3 => b'A',
                _ => b,
            });
        }
        let input = String::from_utf8_lossy(&bytes).to_string();
        let _ = decode_modified_utf7(&input);
    }
}

/// The split that makes this safe: the wire form is what `SELECT` gets, the
/// decoded form is only ever shown. Decoding the path would break every
/// folder with a non-ASCII character in its name.
#[test]
fn decoding_is_display_only() {
    let wire = "[Gmail]/Entw&APw-rfe";
    let leaf = wire.rsplit(['/', '.']).next().unwrap();
    assert_eq!(decode_modified_utf7(leaf), "Entwürfe");
    assert_eq!(
        wire, "[Gmail]/Entw&APw-rfe",
        "the path must not be rewritten"
    );
}

/// A server-supplied label goes through the same control-stripping a subject
/// does — an RTL override in a folder name reorders what the user reads.
#[test]
fn a_bidi_override_in_a_folder_name_is_stripped() {
    // `&IC8-` is U+202F… use the actual override: U+202E is `&IC4-`.
    let decoded = decode_modified_utf7("Rechnung&IC4-gnp.exe");
    assert!(
        decoded.contains('\u{202E}'),
        "the fixture must contain the override"
    );
    assert!(!strip_controls(&decoded).contains('\u{202E}'));
}

/// The extraction half of the `Authentication-Results` feature: that the
/// header is found at all, in document order, and unfolded.
///
/// It reads the raw bytes rather than `mail-parser`'s `HeaderValue`, so this
/// is the test that would catch the parser deciding to hand unknown headers
/// back differently — at which point a silently empty list would mean every
/// message shows no verdict, with nothing failing.
#[test]
fn authentication_results_headers_are_read_in_order_and_unfolded() {
    let raw = b"From: a@example.com\r\n\
                    To: b@example.org\r\n\
                    Authentication-Results: mx.example.net;\r\n\
                    \tspf=pass smtp.mailfrom=a.example;\r\n\
                    \tdkim=pass header.d=a.example\r\n\
                    Authentication-Results: relay.example.org; dmarc=fail\r\n\
                    Subject: folded\r\n\r\nbody\r\n";
    let msg = parse_bounded(raw).unwrap();
    let values = authentication_results_values(&msg, raw);
    assert_eq!(values.len(), 2, "{values:?}");
    assert_eq!(
        values[0],
        "mx.example.net; spf=pass smtp.mailfrom=a.example; dkim=pass header.d=a.example",
        "the topmost header must come back unfolded and first"
    );
    assert!(values[1].starts_with("relay.example.org"));

    // …and it reaches ParsedHeaders, still untrusted.
    let parsed = parse_message(raw).unwrap();
    let auth = parsed
        .headers
        .auth
        .expect("the header must reach ParsedHeaders");
    assert_eq!(auth.authserv_id.as_deref(), Some("mx.example.net"));
    assert_eq!(auth.header_count, 2);
    assert_eq!(
        auth.state,
        crate::schema::mail::MailAuthState::Unconfigured,
        "parsing must never mint trust; only apply_trust does"
    );
}

#[test]
fn a_message_with_no_authentication_results_reports_none() {
    assert!(parse_message(&fixture("simple.eml"))
        .unwrap()
        .headers
        .auth
        .is_none());
}

#[test]
fn a_plain_message_parses() {
    let msg = parse_message(&fixture("simple.eml")).unwrap();
    assert_eq!(msg.headers.subject, "Hello there");
    assert_eq!(msg.headers.from.address, "sender@example.com");
    assert_eq!(msg.headers.to.len(), 1);
    assert_eq!(msg.headers.to[0].address, "receiver@example.org");
    assert!(msg.text.unwrap().contains("plain body"));
}

#[test]
fn deeply_nested_messages_are_refused_rather_than_survived() {
    let raw = fixture("deep_nesting.eml");
    assert_eq!(parse_message(&raw).err(), Some(MailError::TooDeep));
}

#[test]
fn too_many_parts_are_refused() {
    // Built in the test rather than checked in — 10 000 parts is a large
    // file to carry in git for one assertion.
    let mut raw = String::from(
        "From: a@example.com\r\nTo: b@example.org\r\nSubject: many\r\n\
             Content-Type: multipart/mixed; boundary=\"B\"\r\n\r\n",
    );
    for i in 0..10_000 {
        raw.push_str(&format!(
            "--B\r\nContent-Type: text/plain\r\n\r\npart {i}\r\n"
        ));
    }
    raw.push_str("--B--\r\n");
    assert_eq!(
        parse_message(raw.as_bytes()).err(),
        Some(MailError::TooManyParts),
        "a 10 000-part message must be refused, not merely survived"
    );
}

#[test]
fn an_oversized_header_line_is_refused() {
    let raw = fixture("huge_header.eml");
    assert_eq!(parse_message(&raw).err(), Some(MailError::HeaderTooLong));
}

#[test]
fn an_oversized_message_is_refused_before_parsing() {
    let mut raw = b"From: a@example.com\r\nSubject: big\r\n\r\n".to_vec();
    raw.resize(MAX_MESSAGE_BYTES + 1, b'x');
    assert!(matches!(
        parse_message(&raw),
        Err(MailError::TooLarge { .. })
    ));
}

#[test]
fn truncated_base64_never_panics() {
    let msg = parse_message(&fixture("truncated_base64.eml"));
    // Either it decodes lossily or the part is unusable; the only forbidden
    // outcome is a panic, which reaching this line proves did not happen.
    assert!(msg.is_ok() || matches!(msg, Err(MailError::NoDisplayableContent)));
}

/// `+ADw-script+AD4-` is `<script>` in UTF-7, and `mail-parser` *does*
/// decode it — which is exactly why the refusal lives above the parser
/// rather than being assumed from it. A UTF-7 body must never reach the
/// HTML path at all.
#[test]
fn a_utf7_body_never_reaches_the_html_path() {
    let msg = parse_message(&fixture("utf7_script.eml")).unwrap();
    assert!(
        msg.html.is_none(),
        "a UTF-7 body must be refused as HTML, got {:?}",
        msg.html
    );
    // It is still shown, as text, escaped by the plain-text path.
    let text = msg.text.unwrap_or_default();
    let escaped = crate::services::mail_sanitize::plain_text_to_html(&text);
    assert!(
        !escaped.to_ascii_lowercase().contains("<script"),
        "{escaped}"
    );
}

#[test]
fn charset_refusal_covers_the_utf7_spellings_and_nothing_else() {
    for cs in [
        "utf-7",
        "UTF-7",
        " \"utf-7\" ",
        "unicode-1-1-utf-7",
        "x-utf-7",
        // The two labels `mail-parser` really decodes as UTF-7. `-` and `_`
        // are the same character to its lookup, and `csutf7` has no
        // separator at all — a hyphenated-spellings list missed both.
        "utf_7",
        "UTF_7",
        "csutf7",
        "CSUTF7",
        " \"csUTF7\" ",
    ] {
        assert!(charset_is_refused(Some(cs)), "{cs} must be refused");
    }
    for cs in [
        "utf-8",
        "iso-8859-1",
        "windows-1252",
        "us-ascii",
        "shift_jis",
    ] {
        assert!(!charset_is_refused(Some(cs)), "{cs} must be accepted");
    }
    assert!(!charset_is_refused(None), "no charset is not a refusal");
}

/// The regression the spelling list above exists for: `mail-parser` decodes
/// `csutf7` and `utf_7` as UTF-7 (its lookup lowercases and maps `-`→`_`,
/// and its two keys are `utf_7`/`csutf7`), so a body labelled either one
/// arrived at the HTML path as real `<script>` markup that the sender never
/// wrote. Asserted end-to-end, not just on the predicate, because the
/// predicate is only worth what the parse around it does with it.
#[test]
fn every_utf7_label_the_parser_decodes_is_kept_off_the_html_path() {
    for cs in ["utf-7", "utf_7", "UTF_7", "csutf7", "CSUTF7"] {
        let raw = format!(
            "From: a@example.com\r\nTo: b@example.org\r\nSubject: s\r\n\
                 Content-Type: text/html; charset={cs}\r\n\r\n\
                 +ADw-script+AD4-alert(1)+ADw-/script+AD4-\r\n"
        );
        let msg = parse_message(raw.as_bytes()).unwrap();
        assert!(
            msg.html.is_none(),
            "charset={cs} reached the HTML path with {:?}",
            msg.html
        );
    }
}

/// `mail-parser`'s `html_body` falls back to the `text/plain` part when a
/// message has no `text/html` one. Reading that part directly (rather than
/// through its escaping `body_html()` accessor) rendered plain-text mail as
/// markup: the anchor below became a real link row with a real Open button
/// in a message whose author only ever typed characters.
#[test]
fn a_plain_text_only_message_is_never_offered_as_html() {
    let raw = b"From: a@example.com\r\nTo: b@example.org\r\nSubject: s\r\n\
                    Content-Type: text/plain; charset=utf-8\r\n\r\n\
                    hello <a href=\"https://evil.example\">bank.example</a>\r\n";
    let msg = parse_message(raw).unwrap();
    assert!(
        msg.html.is_none(),
        "a text/plain body must not be handed to the HTML renderer, got {:?}",
        msg.html
    );
    let text = msg.text.expect("the plain body must still be shown");
    assert!(text.contains("evil.example"));
    // And the path it *does* take escapes it.
    let escaped = crate::services::mail_sanitize::plain_text_to_html(&text);
    assert!(!escaped.contains("<a "), "{escaped}");
    assert!(escaped.contains("&lt;a "), "{escaped}");
}

/// A message with no Content-Type at all defaults to `text/plain`, so it
/// takes the same escaped path.
#[test]
fn a_message_with_no_content_type_is_not_html() {
    let raw = b"From: a@example.com\r\nSubject: s\r\n\r\n<b>x</b>\r\n";
    let msg = parse_message(raw).unwrap();
    assert!(msg.html.is_none(), "{:?}", msg.html);
    assert!(msg.text.unwrap_or_default().contains("<b>"));
}

/// The positive control for the two rules above: a genuine `text/html` part
/// in a genuine charset still reaches the HTML path.
#[test]
fn a_real_html_part_still_reaches_the_html_path() {
    let raw = b"From: a@example.com\r\nSubject: s\r\n\
                    Content-Type: text/html; charset=utf-8\r\n\r\n<p>hi</p>\r\n";
    let msg = parse_message(raw).unwrap();
    assert!(msg.html.unwrap_or_default().contains("<p>hi</p>"));
}

#[test]
fn duplicate_from_headers_are_reported_not_silently_resolved() {
    let msg = parse_message(&fixture("duplicate_from.eml")).unwrap();
    assert!(
        msg.headers
            .malformed_headers
            .contains(&"DUPLICATE_FROM".to_string()),
        "{:?}",
        msg.headers.malformed_headers
    );
}

/// `From: "security@bank.example" <attacker@evil.example>` — the display
/// name and the addr-spec must reach the UI as separate fields, so the UI
/// can render the address unconditionally.
#[test]
fn a_display_name_never_stands_in_for_the_address() {
    let msg = parse_message(&fixture("spoofed_display_name.eml")).unwrap();
    assert_eq!(msg.headers.from.address, "attacker@evil.example");
    assert_eq!(
        msg.headers.from.name.as_deref(),
        Some("security@bank.example")
    );
}

#[test]
fn a_traversal_filename_is_reduced_to_its_basename() {
    let msg = parse_message(&fixture("traversal_filename.eml")).unwrap();
    assert_eq!(msg.attachments.len(), 1);
    assert_eq!(msg.attachments[0].meta.filename, "passwd");
}

#[test]
fn an_rtl_override_filename_is_defused() {
    let msg = parse_message(&fixture("rtl_filename.eml")).unwrap();
    let name = &msg.attachments[0].meta.filename;
    assert!(!name.contains('\u{202E}'), "{name}");
    assert!(!name.ends_with(".png"), "{name}");
}

#[test]
fn a_message_with_only_an_octet_stream_body_has_no_displayable_content() {
    let raw = b"From: a@example.com\r\nSubject: x\r\n\
                    Content-Type: application/octet-stream\r\n\r\n\x00\x01\x02";
    assert!(matches!(
        parse_message(raw),
        Err(MailError::NoDisplayableContent) | Ok(_)
    ));
}

#[test]
fn a_message_with_no_content_type_still_parses() {
    let raw = b"From: a@example.com\r\nSubject: x\r\n\r\nhello";
    let msg = parse_message(raw).unwrap();
    assert_eq!(msg.text.as_deref(), Some("hello"));
}

/// The plain-text preference must not become a way to skip sanitization of
/// the HTML alternative.
#[test]
fn a_hostile_html_alternative_is_still_sanitized() {
    let msg = parse_message(&fixture("alternative_hostile_html.eml")).unwrap();
    let html = msg.html.expect("the html alternative must be found");
    assert!(html.contains("<script"), "the fixture must be hostile");
    let cleaned = crate::services::mail_sanitize::sanitize_message_html(&html).unwrap();
    assert!(!cleaned.html.to_ascii_lowercase().contains("<script"));
}

// ── Attachment typing ───────────────────────────────────────────────────

#[test]
fn an_executable_payload_is_flagged_however_it_is_labelled() {
    let mz = b"MZ\x90\x00\x03\x00\x00\x00";
    assert_eq!(
        type_mismatch("image/png", "invoice.png", mz).as_deref(),
        Some("executable")
    );
    let elf = b"\x7fELF\x02\x01\x01\x00";
    assert_eq!(
        type_mismatch("application/pdf", "report.pdf", elf).as_deref(),
        Some("executable")
    );
}

#[test]
fn a_double_extension_is_flagged() {
    assert_eq!(
        type_mismatch("application/octet-stream", "photo.jpg.exe", b"").as_deref(),
        Some("double-extension")
    );
}

// ── Outbound ────────────────────────────────────────────────────────────

/// A CRLF in the subject must not be able to insert a `Bcc:` header.
#[test]
fn header_injection_through_the_subject_is_refused() {
    let err = build_outgoing(
        None,
        "me@example.com",
        &["you@example.org".into()],
        &[],
        &[],
        "hello\r\nBcc: evil@evil.example",
        "body",
        None,
        &[],
        &[],
    )
    .unwrap_err();
    assert!(matches!(err, MailError::Protocol(_)));
}

#[test]
fn header_injection_through_a_recipient_is_refused() {
    let err = build_outgoing(
        None,
        "me@example.com",
        &["a@example.com\nCc: b@evil.example".into()],
        &[],
        &[],
        "hi",
        "body",
        None,
        &[],
        &[],
    )
    .unwrap_err();
    assert!(matches!(err, MailError::Protocol(_)));
}

#[test]
fn a_sent_message_id_names_the_sender_domain_not_this_machine() {
    let bytes = build_outgoing(
        None,
        "me@Example.com",
        &["you@example.org".into()],
        &[],
        &[],
        "hi",
        "body",
        None,
        &[],
        &[],
    )
    .unwrap();
    let text = String::from_utf8_lossy(&bytes);
    let line = text
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("message-id:"))
        .expect("a Message-ID header");
    assert!(line.trim_end().ends_with("@example.com>"), "{line}");
    if let Ok(host) = gethostname_for_test() {
        assert!(!line.contains(&host), "{line}");
    }
}

fn gethostname_for_test() -> Result<String, ()> {
    std::fs::read_to_string("/etc/hostname")
        .map(|h| h.trim().to_string())
        .ok()
        .filter(|h| h.len() > 3)
        .ok_or(())
}

/// The address lands in `RCPT TO:<…>` verbatim, so anything that could end
/// the path or add a parameter is refused before a message is built.
#[test]
fn a_recipient_must_be_a_plain_address() {
    for good in ["a@example.com", "first.last+tag@sub.example.org", "jörg@exämple.de"] { // privacy-check: ok — IDN fixture, not a real address
        assert!(validate_recipient(good).is_ok(), "{good}");
    }
    for bad in [
        "a@example.com> NOTIFY=NEVER",
        "\"a>b\"@example.com",
        "a\tb@example.com",
        "a@b@example.com",
        "<a@example.com>",
        ".a@example.com",
        "a..b@example.com",
        "a@-example.com", // privacy-check: ok — deliberately invalid fixture
        "a@example..com",
        "a@",
        "@example.com",
        "a\u{202E}b@example.com",
    ] {
        assert!(validate_recipient(bad).is_err(), "{bad:?} must be refused");
    }
}

/// Bcc is an envelope concept. Writing it as a header would disclose every
/// blind recipient to every other one.
#[test]
fn bcc_never_appears_as_a_header() {
    let bytes = build_outgoing(
        None,
        "me@example.com",
        &["you@example.org".into()],
        &[],
        &["hidden@example.net".into()],
        "hello",
        "body",
        None,
        &[],
        &[],
    )
    .unwrap();
    let text = String::from_utf8_lossy(&bytes);
    assert!(!text.contains("Bcc"), "{text}");
    assert!(!text.contains("hidden@example.net"), "{text}");
}

/// A picked file's directory is a username and project-structure leak, so
/// only the basename leaves.
#[test]
fn an_attachment_carries_only_its_basename() {
    let bytes = build_outgoing(
        None,
        "me@example.com",
        &["you@example.org".into()],
        &[],
        &[],
        "with attachment",
        "body",
        None,
        &[],
        &[OutboundAttachment {
            filename: "/home/tester/secret-project/notes.pdf".into(),
            mime: "application/pdf".into(),
            bytes: b"%PDF-1.4".to_vec(),
        }],
    )
    .unwrap();
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.contains("notes.pdf"), "{text}");
    assert!(!text.contains("secret-project"), "{text}");
    assert!(!text.contains("/home/tester"), "{text}");
}

#[test]
fn an_oversized_outgoing_message_is_refused_before_any_network_call() {
    let err = build_outgoing(
        None,
        "me@example.com",
        &["you@example.org".into()],
        &[],
        &[],
        "big",
        "body",
        None,
        &[],
        &[OutboundAttachment {
            filename: "big.bin".into(),
            mime: "application/octet-stream".into(),
            bytes: vec![0u8; MAX_OUTBOUND_BYTES],
        }],
    )
    .unwrap_err();
    assert!(matches!(err, MailError::TooLarge { .. }));
}

#[test]
fn a_normal_message_builds() {
    let bytes = build_outgoing(
        Some("Me"),
        "me@example.com",
        &["you@example.org".into()],
        &["cc@example.net".into()],
        &[],
        "Subject line",
        "Hello.",
        Some("<parent@example.com>"),
        &["<root@example.com>".into()],
        &[],
    )
    .unwrap();
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.contains("Subject"), "{text}");
    assert!(text.contains("you@example.org"), "{text}");
    assert!(text.contains("cc@example.net"), "{text}");
}
