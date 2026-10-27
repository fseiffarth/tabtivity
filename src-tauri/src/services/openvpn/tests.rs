/// The gate's truth table. `account_gate` itself is not exercised against
/// the registry here: these tests share one process with the ones that
/// register tunnels, so "no tunnel is up" is not a state a test can assume.
#[test]
fn the_vpn_gate_only_bites_a_gated_account_with_no_tunnel() {
    assert!(super::gate_allows(false, false));
    assert!(super::gate_allows(false, true));
    assert!(super::gate_allows(true, true));
    assert!(!super::gate_allows(true, false));
    // An account that is not gated never sees the refusal, whatever is up.
    assert_eq!(super::account_gate(false), Ok(()));
    assert!(!super::VPN_GATE_REFUSAL.contains("  "), "the sentence is one line");
}

use super::*;

#[test]
fn shell_quote_wraps_and_escapes() {
    assert_eq!(shell_quote("/home/u/a.ovpn"), "'/home/u/a.ovpn'");
    assert_eq!(shell_quote("a b"), "'a b'");
    assert_eq!(shell_quote("a'b"), "'a'\\''b'");
}

/// A config nobody connected is not reported as up. The header's VPN indicator
/// is driven by this, and a false positive parks a "your machine is being
/// rerouted" badge over a machine that isn't.
///
/// Asserts about *this* config rather than global emptiness: the registries are
/// process-global and the tests below register live entries in parallel.
#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
#[test]
fn unconnected_config_is_never_reported_up() {
    let cfg = "/store/never-connected.ovpn";
    assert!(!is_connected(cfg));
    assert!(!active_configs().contains(&cfg.to_string()));
}

/// Drop a config from both the interactive registry and the disk, without going
/// through `disconnect_interactive` — which would try to `kill` the pid, and in
/// these tests that pid is *our own process*.
///
/// Also clears the management endpoint `arm_interactive` now writes, so the suite
/// leaves nothing behind in the user's real runtime dir (these tests run against
/// it, not a temp dir).
#[cfg(unix)]
fn forget_interactive(config: &str) {
    if let Some(pidfile) = interactive_registry().lock().unwrap().remove(config) {
        let _ = std::fs::remove_file(pidfile);
    }
    clear_management(config);
}

/// The interactive command must carry a `--writepid` Tabtivity chose, and claim it.
/// This is the whole fix for #83: without the pid, a root tunnel started in a
/// terminal tab is invisible to `is_connected`/`active_configs` and unkillable by
/// `disconnect`/`disconnect_all` — it outlives the app still owning the routing.
#[cfg(target_os = "linux")]
#[test]
fn interactive_command_claims_a_pidfile() {
    let cfg = "/store/test-claims.ovpn";
    forget_interactive(cfg);

    let argv = interactive_connect_argv(cfg).unwrap();
    let pidfile = interactive_pidfile(cfg);

    let at = argv.iter().position(|a| a == "--writepid").expect("--writepid");
    assert_eq!(argv[at + 1], pidfile.to_string_lossy());
    // Claimed, but OpenVPN hasn't written a pid yet — the user is still at the
    // polkit prompt. Pending is NOT dead: reaping here would forget a tunnel in
    // the seconds before it comes up.
    assert_eq!(interactive_state(cfg), Interactive::Pending);
    assert!(!is_connected(cfg));

    forget_interactive(cfg);
}

/// Once the pid is on disk and alive, the tunnel is up — visible to everything
/// the frontend asks (`openvpn_status`, `openvpn_active`).
#[cfg(unix)]
#[test]
fn interactive_tunnel_with_a_live_pid_is_up() {
    let cfg = "/store/test-live.ovpn";
    forget_interactive(cfg);
    let _ = interactive_connect_argv(cfg).unwrap();

    // Our own pid is, definitionally, alive.
    let me = std::process::id();
    std::fs::write(interactive_pidfile(cfg), format!("{me}\n")).unwrap();

    assert_eq!(interactive_state(cfg), Interactive::Alive(me as i32));
    assert!(is_connected(cfg));
    assert!(active_configs().contains(&cfg.to_string()));

    forget_interactive(cfg);
}

/// A tunnel whose process is gone (the user closed its terminal) is reaped, not
/// reported as up — and its stale pidfile is cleaned up so the next connect
/// can't mistake it for a live one.
#[cfg(unix)]
#[test]
fn interactive_tunnel_with_a_dead_pid_is_reaped() {
    let cfg = "/store/test-dead.ovpn";
    forget_interactive(cfg);
    let _ = interactive_connect_argv(cfg).unwrap();

    // A pid that is *certainly* dead: spawn a process and reap it.
    let mut child = std::process::Command::new("true").spawn().unwrap();
    let dead = child.id();
    child.wait().unwrap();
    let pidfile = interactive_pidfile(cfg);
    std::fs::write(&pidfile, format!("{dead}\n")).unwrap();

    assert_eq!(interactive_state(cfg), Interactive::None);
    assert!(!is_connected(cfg));
    // Reaped from both the registry and the disk.
    assert!(!interactive_registry().lock().unwrap().contains_key(cfg));
    assert!(!pidfile.exists());

    forget_interactive(cfg);
}

/// Arming twice must not resurrect a stale pidfile: a leftover from a previous
/// run would otherwise read as a live tunnel the moment the config is armed.
#[cfg(unix)]
#[test]
fn arming_clears_a_stale_pidfile() {
    let cfg = "/store/test-stale.ovpn";
    forget_interactive(cfg);
    let pidfile = interactive_pidfile(cfg);
    let _ = std::fs::create_dir_all(runtime_dir());
    std::fs::write(&pidfile, format!("{}\n", std::process::id())).unwrap();

    let _ = interactive_connect_argv(cfg).unwrap();

    assert!(!pidfile.exists());
    assert_eq!(interactive_state(cfg), Interactive::Pending);

    forget_interactive(cfg);
}

/// A second login for a config whose tunnel is up is refused and leaves the live
/// tunnel's claim alone: re-arming deleted its pidfile (so `is_connected` and
/// `disconnect_all` lost a root tunnel still rerouting the machine) and rewrote
/// its management endpoint.
#[cfg(unix)]
#[test]
fn a_second_login_for_a_live_tunnel_is_refused() {
    let cfg = "/store/test-relogin-live.ovpn";
    forget_interactive(cfg);
    let _ = interactive_connect_argv(cfg).unwrap();
    let pidfile = interactive_pidfile(cfg);
    let me = std::process::id();
    std::fs::write(&pidfile, format!("{me}\n")).unwrap();
    let endpoint = management_endpoint(cfg);
    assert_eq!(interactive_state(cfg), Interactive::Alive(me as i32));

    let err = interactive_connect_argv(cfg).unwrap_err();
    assert!(err.contains("already connected"), "{err}");
    assert!(pidfile.exists(), "the live tunnel's pidfile must survive");
    assert_eq!(interactive_state(cfg), Interactive::Alive(me as i32));
    assert_eq!(management_endpoint(cfg), endpoint, "its management endpoint too");
    // Releasing a claim never touches a live tunnel either.
    release_interactive_claim(cfg);
    assert!(is_connected(cfg));

    forget_interactive(cfg);
}

/// A tunnel adopted from a previous run (its headless pidfile seated in the
/// interactive registry) is just as live: a login for it is refused too.
#[cfg(unix)]
#[test]
fn a_login_for_an_adopted_tunnel_is_refused() {
    let cfg = "/store/test-relogin-adopted.ovpn";
    forget_interactive(cfg);
    let headless = runtime_dir().join(format!("{}.pid", safe_stem(cfg)));
    let _ = std::fs::create_dir_all(runtime_dir());
    std::fs::write(&headless, format!("{}\n", std::process::id())).unwrap();
    assert!(adopt_config(cfg));

    assert!(interactive_connect_argv(cfg).is_err());
    assert!(headless.exists());
    assert!(is_connected(cfg));

    forget_interactive(cfg);
    let _ = std::fs::remove_file(&headless);
}

/// A Pending claim (a login that never authenticated) is re-armed, and a claim
/// whose login never ran is handed back whole.
#[cfg(unix)]
#[test]
fn a_pending_claim_is_rearmed_and_released() {
    let cfg = "/store/test-relogin-pending.ovpn";
    forget_interactive(cfg);
    let _ = interactive_connect_argv(cfg).unwrap();
    assert_eq!(interactive_state(cfg), Interactive::Pending);
    let _ = interactive_connect_argv(cfg).expect("a pending claim is no live tunnel");

    release_interactive_claim(cfg);
    assert_eq!(interactive_state(cfg), Interactive::None);
    assert!(!interactive_registry().lock().unwrap().contains_key(cfg));
    assert_eq!(management_endpoint(cfg), None);

    forget_interactive(cfg);
}

/// The bug this fixes: a tunnel a *previous* run started is up (its root daemon
/// survived, pidfile on disk) but every registry is empty at launch, so the lamp
/// reads grey while the machine is still routed through it. `adopt_config` recovers
/// it from the headless `{stem}.pid`, making it visible again.
#[cfg(unix)]
#[test]
fn adopt_recovers_a_surviving_headless_tunnel() {
    let cfg = "/store/test-adopt-headless.ovpn";
    forget_interactive(cfg);
    let pidfile = runtime_dir().join(format!("{}.pid", safe_stem(cfg)));
    let _ = std::fs::create_dir_all(runtime_dir());
    // Our own pid stands in for the still-alive root daemon.
    std::fs::write(&pidfile, format!("{}\n", std::process::id())).unwrap();
    assert!(!is_connected(cfg)); // nothing tracks it yet

    assert!(adopt_config(cfg));
    assert!(is_connected(cfg));
    assert!(active_configs().contains(&cfg.to_string()));

    forget_interactive(cfg);
    let _ = std::fs::remove_file(&pidfile);
}

/// The interactive flavour's pidfile is recovered too.
#[cfg(unix)]
#[test]
fn adopt_recovers_a_surviving_interactive_tunnel() {
    let cfg = "/store/test-adopt-interactive.ovpn";
    forget_interactive(cfg);
    let pidfile = interactive_pidfile(cfg);
    let _ = std::fs::create_dir_all(runtime_dir());
    std::fs::write(&pidfile, format!("{}\n", std::process::id())).unwrap();

    assert!(adopt_config(cfg));
    assert!(is_connected(cfg));

    forget_interactive(cfg);
    let _ = std::fs::remove_file(&pidfile);
}

/// A pidfile whose recorded process is gone is not a live tunnel: adopt reports
/// nothing recovered and cleans the stale file, so a later connect can't mistake
/// it for one that is up.
#[cfg(unix)]
#[test]
fn adopt_reaps_a_stale_pidfile_and_recovers_nothing() {
    let cfg = "/store/test-adopt-stale.ovpn";
    forget_interactive(cfg);
    let pidfile = runtime_dir().join(format!("{}.pid", safe_stem(cfg)));
    let _ = std::fs::create_dir_all(runtime_dir());
    // A pid that is certainly dead: spawn a process and reap it.
    let mut child = std::process::Command::new("true").spawn().unwrap();
    let dead = child.id();
    child.wait().unwrap();
    std::fs::write(&pidfile, format!("{dead}\n")).unwrap();

    assert!(!adopt_config(cfg));
    assert!(!is_connected(cfg));
    assert!(!pidfile.exists()); // stale file cleaned up
}

#[cfg(target_os = "linux")]
#[test]
fn interactive_connect_argv_linux_shape() {
    let cfg = "/home/u/my work.ovpn";
    let argv = interactive_connect_argv(cfg).unwrap();
    // Elevated via pkexec; passphrase typed interactively (no --askpass file).
    // Both by absolute path: pkexec resolves a bare name through the caller's PATH.
    assert!(Path::new(&argv[0]).is_absolute() && Path::new(&argv[1]).is_absolute(), "{argv:?}");
    assert_eq!(Path::new(&argv[0]).file_stem().unwrap(), "pkexec");
    assert_eq!(Path::new(&argv[1]).file_stem().unwrap(), "openvpn");
    assert_eq!(&argv[2..4], ["--config", cfg]);
    // #868: the config's own scripts never run as root — and the override
    // follows the config, so the file's `script-security 2` cannot win.
    assert_eq!(&argv[4..6], ["--script-security", "1"]);
    // No --auth-nocache: it made the hourly rekey re-prompt and drop the tunnel.
    assert!(!argv.iter().any(|a| a == "--auth-nocache"));
    assert!(argv.iter().any(|a| a == "--persist-key"));
    assert!(argv.iter().any(|a| a == "--mlock"));
    assert!(!argv.iter().any(|a| a == "--askpass"));
    // An argv, not a shell line: nothing is quoted.
    assert!(!argv.iter().any(|a| a.contains('\'')), "{argv:?}");

    forget_interactive(cfg);
}

/// The whole point of the management socket: a terminal-started tunnel carries
/// one too, so stopping it costs no second polkit prompt either. Without this the
/// interactive flavour would silently keep the old double-password teardown.
#[cfg(target_os = "linux")]
#[test]
fn interactive_connect_argv_arms_a_management_socket() {
    // Skipped while the A/B kill switch is on (no `--management` is appended).
    if MANAGEMENT_SOCKET_DISABLED {
        return;
    }
    let cfg = "/home/u/mgmt-interactive.ovpn";
    forget_interactive(cfg);
    let argv = interactive_connect_argv(cfg).unwrap();
    let at = argv
        .iter()
        .position(|a| a == "--management")
        .unwrap_or_else(|| panic!("interactive tunnels need a management socket too: {argv:?}"));
    assert_eq!(argv[at + 1], "127.0.0.1");
    // The endpoint it armed is the one teardown will read back.
    let (port, password) = management_endpoint(cfg).expect("endpoint recorded");
    assert!(port > 0);
    assert!(!password.is_empty());
    assert_eq!(argv[at + 2], port.to_string());

    forget_interactive(cfg);
}

/// A config that runs its own management socket must be left alone: `--management`
/// twice is an options error, i.e. a tunnel that never comes up at all. Worth a
/// test because the failure is total and only shows on the user's own config.
#[cfg(unix)]
#[test]
fn config_declaring_management_is_detected() {
    let dir = std::env::temp_dir().join(concat!(crate::app_slug!(), "-mgmt-detect"));
    std::fs::create_dir_all(&dir).unwrap();

    let own = dir.join("own.ovpn");
    std::fs::write(
        &own,
        "client\nmanagement 127.0.0.1 7505\nremote vpn.example 1194\n",
    )
    .unwrap();
    assert!(config_declares_management(own.to_str().unwrap()));
    assert!(arm_management(own.to_str().unwrap()).is_none());

    let plain = dir.join("plain.ovpn");
    std::fs::write(
        &plain,
        "client\n# management 127.0.0.1 7505\n; management foo\nremote vpn.example 1194\n",
    )
    .unwrap();
    assert!(
        !config_declares_management(plain.to_str().unwrap()),
        "a commented-out directive is not a declaration"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// `--management <ip> <port> <pwfile>`, in that order — OpenVPN is positional
/// here, so a reordering would be silently accepted and mean something else.
#[test]
fn management_args_shape() {
    let args = management_args(7505, Path::new(concat!("/run/", crate::app_slug!(), "/openvpn/x.mgmt.pw")));
    assert_eq!(
        args,
        vec![
            "--management".to_string(),
            "127.0.0.1".to_string(),
            "7505".to_string(),
            concat!("/run/", crate::app_slug!(), "/openvpn/x.mgmt.pw").to_string(),
        ]
    );
}

/// The credential files OpenVPN reads keep their exact line layout and are
/// owner-only even over a leftover, wider-moded file of the same name.
#[test]
fn credential_files_are_written_whole_and_owner_only() {
    let stem = format!("cred-files-{}", std::process::id());
    let auth = runtime_dir().join(format!("{stem}.auth"));
    std::fs::create_dir_all(runtime_dir()).unwrap();
    std::fs::write(&auth, b"leftover from an earlier run, much longer than the new one").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&auth, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    assert_eq!(write_userpass(&stem, "alice", "pw").unwrap(), auth);
    assert_eq!(std::fs::read_to_string(&auth).unwrap(), "alice\npw\n");
    let pass = write_askpass(&stem, "secret").unwrap();
    assert_eq!(std::fs::read_to_string(&pass).unwrap(), "secret\n");
    #[cfg(unix)]
    for path in [&auth, &pass] {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{}", path.display());
    }
    let _ = std::fs::remove_file(&auth);
    let _ = std::fs::remove_file(&pass);
}

/// An armed endpoint round-trips, and its password file is owner-only — it is the
/// only thing standing between a local process and control of the tunnel.
#[cfg(unix)]
#[test]
fn arm_management_records_an_owner_only_endpoint() {
    use std::os::unix::fs::PermissionsExt;
    // Skipped while the A/B kill switch is on (no endpoint is armed by design).
    if MANAGEMENT_SOCKET_DISABLED {
        return;
    }
    let cfg = "/home/u/mgmt-roundtrip.ovpn";
    let args = arm_management(cfg).expect("endpoint armed");
    assert_eq!(args[0], "--management");
    let (port, password) = management_endpoint(cfg).expect("endpoint readable");
    assert_eq!(args[2], port.to_string());
    assert_eq!(password.len(), 64, "32 random bytes, hex-encoded");

    let mode = std::fs::metadata(management_pwfile(cfg))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(
        mode, 0o600,
        "management password must not be group/world readable"
    );

    clear_management(cfg);
    assert!(
        management_endpoint(cfg).is_none(),
        "cleared endpoint is forgotten"
    );
}

/// The teardown handshake, against a stand-in for OpenVPN. Two things are pinned:
/// the client answers the password prompt (which arrives with **no newline**, so a
/// line-oriented read would hang on it forever), and what it then sends is exactly
/// `signal SIGTERM` — the command that makes the root daemon stop *itself*, which
/// is the entire reason no second password is needed.
#[cfg(unix)]
#[test]
fn management_sigterm_authenticates_then_signals() {
    use std::io::{BufRead, BufReader};
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let (mut sock, _) = listener.accept().unwrap();
        write!(sock, "ENTER PASSWORD:").unwrap(); // privacy-check: ok — test fixture, never sent
        sock.flush().unwrap();
        let mut reader = BufReader::new(sock.try_clone().unwrap());
        let mut pw = String::new();
        reader.read_line(&mut pw).unwrap();
        let _ = tx.send(format!("pw:{}", pw.trim()));
        writeln!(sock, "SUCCESS: password is correct").unwrap();
        sock.flush().unwrap();
        let mut cmd = String::new();
        reader.read_line(&mut cmd).unwrap();
        let _ = tx.send(format!("cmd:{}", cmd.trim()));
    });

    assert!(management_send_sigterm(port, "s3cret"));
    let got: Vec<String> = rx.iter().take(2).collect();
    assert_eq!(got, vec!["pw:s3cret", "cmd:signal SIGTERM"]);
}

/// A refused password must report failure, never a false "tunnel is down" — that
/// is what makes the caller fall back to the elevated kill instead of walking away
/// from a tunnel still rerouting the machine.
#[cfg(unix)]
#[test]
fn management_sigterm_reports_failure_when_auth_is_refused() {
    use std::io::{BufRead, BufReader};
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let (mut sock, _) = listener.accept().unwrap();
        write!(sock, "ENTER PASSWORD:").unwrap(); // privacy-check: ok — test fixture, never sent
        sock.flush().unwrap();
        let mut line = String::new();
        let _ = BufReader::new(sock.try_clone().unwrap()).read_line(&mut line);
        let _ = writeln!(sock, "ERROR: bad password");
        let _ = sock.flush();
    });

    assert!(!management_send_sigterm(port, "wrong"));
}

/// Nothing listening (a tunnel from a previous run whose port is long gone) is an
/// ordinary failure, not a hang or a panic.
#[cfg(unix)]
#[test]
fn management_sigterm_fails_on_a_dead_port() {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener); // nothing is listening now
    assert!(!management_send_sigterm(port, "whatever"));
}

#[cfg(target_os = "linux")]
#[test]
fn interactive_connect_argv_rejects_bad_config() {
    assert!(interactive_connect_argv("-evil").is_err());
    assert!(interactive_connect_argv("/a\nb.ovpn").is_err());
    assert!(interactive_connect_argv("   ").is_err());
}

#[test]
fn win_cmdline_quote_shapes() {
    // No metacharacters → unquoted, byte for byte (backslashes are literal).
    assert_eq!(win_cmdline_quote("plain"), "plain");
    assert_eq!(win_cmdline_quote(r"C:\dir\file.ovpn"), r"C:\dir\file.ovpn");
    assert_eq!(win_cmdline_quote(r"end\"), r"end\");
    // Spaces / emptiness force quotes.
    assert_eq!(win_cmdline_quote("has space"), "\"has space\"");
    assert_eq!(win_cmdline_quote(""), "\"\"");
    // A quote inside: preceding backslashes double and the quote is escaped.
    assert_eq!(win_cmdline_quote(r#"a"b"#), r#""a\"b""#);
    assert_eq!(win_cmdline_quote(r#"a\"b"#), r#""a\\\"b""#);
    // Trailing backslashes double so they can't eat the closing quote.
    assert_eq!(win_cmdline_quote(r"e nd\"), "\"e nd\\\\\"");
    // The options string is the quoted args joined by single spaces.
    assert_eq!(
        svc_options_string(&["--config".to_string(), r"C:\a b\c.ovpn".to_string()]),
        r#"--config "C:\a b\c.ovpn""#
    );
}

#[test]
fn svc_startup_message_is_three_nul_terminated_utf16_strings() {
    // Non-ASCII on purpose: the message is UTF-16LE, not the ANSI codepage.
    let msg = svc_startup_message("C:\\wä", "--config a.ovpn", "");
    assert_eq!(msg.len() % 2, 0);
    let units: Vec<u16> = msg
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_le_bytes(*c))
        .collect();
    // Exactly three NULs, one terminating each string (the last is empty).
    assert_eq!(units.iter().filter(|&&u| u == 0).count(), 3);
    assert_eq!(units.last(), Some(&0));
    let parts: Vec<String> = units
        .split(|&u| u == 0)
        .map(|p| String::from_utf16(p).unwrap())
        .collect();
    assert_eq!(parts, ["C:\\wä", "--config a.ovpn", "", ""]);
}

#[test]
fn svc_parse_response_reads_pid_and_refusals() {
    let enc = |s: &str| -> Vec<u8> { s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect() };
    // Success: code 0, pid on line 2 (both `0x%08x`), description on line 3.
    let ok = svc_parse_response(&enc("0x00000000\n0x00001a2b\nProcess ID")).unwrap();
    assert_eq!(ok.code, 0);
    assert_eq!(svc_response_pid(&ok), Some(0x1a2b));
    // Refusal: nonzero code — never a pid, and the explanation must carry
    // both the service's own text and the actionable one-time fix.
    let err = svc_parse_response(&enc(
        "0x20000001\nValidateOptions\nconfig is not in the allowed location",
    ))
    .unwrap();
    assert_eq!(err.code, 0x2000_0001);
    assert_eq!(svc_response_pid(&err), None);
    let msg = explain_service_refusal(&err);
    assert!(
        msg.contains("config is not in the allowed location"),
        "{msg}"
    );
    assert!(msg.contains("OpenVPN Administrators"), "{msg}");
    assert!(msg.contains("net localgroup"), "{msg}");
    // Garbage is None, not a fabricated verdict.
    assert!(svc_parse_response(&enc("not-a-code\nx\ny")).is_none());
    assert!(svc_parse_response(&[]).is_none());
}

#[test]
fn openvpn_args_askpass_shape() {
    let args = openvpn_args(
        "/home/u/work.ovpn",
        None,
        Some(Path::new(concat!("/run/", crate::app_slug!(), "/openvpn/x.pass"))),
        Path::new(concat!("/run/", crate::app_slug!(), "/openvpn/x.pid")),
    )
    .unwrap();
    // --config then the path as a single item.
    let ci = args.iter().position(|a| a == "--config").unwrap();
    assert_eq!(args[ci + 1], "/home/u/work.ovpn");
    // Passphrase-only configs feed the secret via --askpass.
    let ai = args.iter().position(|a| a == "--askpass").unwrap();
    assert_eq!(args[ai + 1], concat!("/run/", crate::app_slug!(), "/openvpn/x.pass"));
    assert!(!args.iter().any(|a| a == "--auth-user-pass"));
    let pi = args.iter().position(|a| a == "--writepid").unwrap();
    assert_eq!(args[pi + 1], concat!("/run/", crate::app_slug!(), "/openvpn/x.pid"));
    // Credentials stay cached for the rekey; the key survives a reconnect.
    assert!(!args.iter().any(|a| a == "--auth-nocache"));
    assert!(args.iter().any(|a| a == "--persist-key"));
    assert_eq!(args.iter().any(|a| a == "--mlock"), cfg!(target_os = "linux"));
}

/// #868: OpenVPN runs as root, so a config's `up`/`down` scripts would too.
/// Every argv shape pins `--script-security 1`, AFTER `--config` (whose
/// directives apply at that position; a later option wins).
#[test]
fn openvpn_args_always_forbid_config_scripts() {
    let pid = Path::new(concat!("/run/", crate::app_slug!(), "/openvpn/x.pid"));
    let f = Path::new(concat!("/run/", crate::app_slug!(), "/openvpn/x.f"));
    for (userpass, askpass) in [(None, None), (Some(f), None), (None, Some(f)), (Some(f), Some(f))] {
        let args = openvpn_args("/home/u/work.ovpn", userpass, askpass, pid).unwrap();
        let ci = args.iter().position(|a| a == "--config").unwrap();
        let si = args.iter().position(|a| a == "--script-security").unwrap();
        assert_eq!(args[si + 1], "1");
        assert!(si > ci, "{args:?}");
        assert_eq!(args.iter().filter(|a| *a == "--script-security").count(), 1);
    }
    assert!(explain_openvpn_error(
        "WARNING: External program may not be called unless '--script-security 2' or higher is enabled."
    )
    .unwrap()
    .contains("script"));
}

/// #868: root `fopen`s the pidfile in the user's runtime dir; a symlink
/// planted there must be gone (the link, never its target) before launch.
#[cfg(unix)]
#[test]
fn root_pidfile_never_follows_a_planted_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let rt = dir.path().join("openvpn");
    std::fs::create_dir_all(&rt).unwrap();
    let victim = dir.path().join("victim");
    std::fs::write(&victim, b"precious").unwrap();
    let pidfile = rt.join("x.pid");
    std::os::unix::fs::symlink(&victim, &pidfile).unwrap();
    prepare_root_pidfile(&pidfile).unwrap();
    assert!(std::fs::symlink_metadata(&pidfile).is_err(), "the link is removed");
    assert_eq!(std::fs::read(&victim).unwrap(), b"precious");
    // A regular (possibly live) pidfile is left for adoption.
    std::fs::write(&pidfile, b"123\n").unwrap();
    prepare_root_pidfile(&pidfile).unwrap();
    assert!(pidfile.is_file());
    // A symlinked runtime dir is refused outright.
    let linked = dir.path().join("linked-openvpn");
    std::os::unix::fs::symlink(dir.path(), &linked).unwrap();
    assert!(prepare_root_pidfile(&linked.join("x.pid")).is_err());
}

/// A tunnel must survive a blip. `--connect-retry-max` caps reconnects for
/// the tunnel's whole *lifetime*, not just the first connect, so passing it
/// meant a momentary drop exhausted the retries and OpenVPN exited for good
/// — leaving the machine's routing changed and every SSH/SFTP session on top
/// stalled against a peer that would never answer. It must stay absent, with
/// `--persist-tun` holding the device and routes across a reconnect.
#[test]
fn openvpn_args_let_a_dropped_tunnel_reconnect_forever() {
    let args = openvpn_args(
        "/home/u/work.ovpn",
        None,
        Some(Path::new(concat!("/run/", crate::app_slug!(), "/openvpn/x.pass"))),
        Path::new(concat!("/run/", crate::app_slug!(), "/openvpn/x.pid")),
    )
    .unwrap();
    assert!(
        !args.iter().any(|a| a == "--connect-retry-max"),
        "a retry cap makes a blip kill the tunnel permanently: {args:?}"
    );
    assert!(args.iter().any(|a| a == "--persist-tun"));
    // The initial connect stays bounded by CONNECT_TIMEOUT, not by openvpn.
    let ti = args.iter().position(|a| a == "--connect-timeout").unwrap();
    assert_eq!(args[ti + 1], "20");
}

/// Readiness is detected by scanning OpenVPN's output for the
/// "Initialization Sequence Completed" marker, so the argv must pin the
/// logging knobs a config could otherwise sabotage it with: a `mute 16`
/// (as shipped in real configs) suppresses the marker — it follows a burst
/// of same-category route-addition lines — and Tabtivity then reported
/// "timed out" on, and killed, a tunnel that was actually up. `verb 0`
/// hides the marker outright. Both are overridden because command-line
/// options are applied after `--config`.
#[test]
fn openvpn_args_pin_logging_so_the_ready_marker_survives() {
    let args = openvpn_args(
        "/home/u/work.ovpn",
        None,
        Some(Path::new(concat!("/run/", crate::app_slug!(), "/openvpn/x.pass"))),
        Path::new(concat!("/run/", crate::app_slug!(), "/openvpn/x.pid")),
    )
    .unwrap();
    let vi = args.iter().position(|a| a == "--verb").unwrap();
    assert_eq!(args[vi + 1], "3");
    let mi = args.iter().position(|a| a == "--mute").unwrap();
    assert_eq!(args[mi + 1], "0");
    // Overrides only win from *after* the config file's own directives.
    let ci = args.iter().position(|a| a == "--config").unwrap();
    assert!(vi > ci && mi > ci);
}

#[test]
fn openvpn_args_userpass_uses_auth_user_pass() {
    let args = openvpn_args(
        "/home/u/work.ovpn",
        Some(Path::new(concat!("/run/", crate::app_slug!(), "/openvpn/x.auth"))),
        None,
        Path::new(concat!("/run/", crate::app_slug!(), "/openvpn/x.pid")),
    )
    .unwrap();
    let ai = args.iter().position(|a| a == "--auth-user-pass").unwrap();
    assert_eq!(args[ai + 1], concat!("/run/", crate::app_slug!(), "/openvpn/x.auth"));
    assert!(!args.iter().any(|a| a == "--askpass"));
}

#[test]
fn openvpn_args_carries_both_channels_at_once() {
    // The regression this whole change exists for: a config with an
    // `auth-user-pass` account AND an encrypted key needs BOTH flags. Feeding
    // only one leaves OpenVPN's other prompt unanswered and the handshake
    // hangs until it times out.
    let args = openvpn_args(
        "/home/u/work.ovpn",
        Some(Path::new(concat!("/run/", crate::app_slug!(), "/openvpn/x.auth"))),
        Some(Path::new(concat!("/run/", crate::app_slug!(), "/openvpn/x.pass"))),
        Path::new(concat!("/run/", crate::app_slug!(), "/openvpn/x.pid")),
    )
    .unwrap();
    let ui = args.iter().position(|a| a == "--auth-user-pass").unwrap();
    assert_eq!(args[ui + 1], concat!("/run/", crate::app_slug!(), "/openvpn/x.auth"));
    let ai = args.iter().position(|a| a == "--askpass").unwrap();
    assert_eq!(args[ai + 1], concat!("/run/", crate::app_slug!(), "/openvpn/x.pass"));
    // …and the tail options survive both being present.
    let pi = args.iter().position(|a| a == "--writepid").unwrap();
    assert_eq!(args[pi + 1], concat!("/run/", crate::app_slug!(), "/openvpn/x.pid"));
    // Credentials stay cached for the rekey; the key survives a reconnect.
    assert!(!args.iter().any(|a| a == "--auth-nocache"));
    assert!(args.iter().any(|a| a == "--persist-key"));
    assert_eq!(args.iter().any(|a| a == "--mlock"), cfg!(target_os = "linux"));
}

#[test]
fn openvpn_args_rejects_leading_dash_config() {
    assert!(openvpn_args("-evil", None, Some(Path::new("/a")), Path::new("/b")).is_err());
}

#[test]
fn openvpn_args_rejects_control_chars() {
    assert!(openvpn_args("/a\nb.ovpn", None, Some(Path::new("/a")), Path::new("/b")).is_err());
}

#[test]
fn openvpn_args_rejects_empty_config() {
    assert!(openvpn_args("   ", None, Some(Path::new("/a")), Path::new("/b")).is_err());
}

#[test]
fn config_requires_userpass_detects_bare_directive() {
    use std::io::Write;
    let dir = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-ovpn-test-{}"), std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    // Bare `auth-user-pass` → needs a username.
    let bare = dir.join("bare.ovpn");
    let mut f = std::fs::File::create(&bare).unwrap();
    writeln!(
        f,
        "client\nremote vpn.example.com 1194\nauth-user-pass\nauth-nocache"
    )
    .unwrap();
    assert!(config_requires_userpass(bare.to_str().unwrap()));

    // `auth-user-pass creds.txt` supplies its own file → does not.
    let withfile = dir.join("withfile.ovpn");
    let mut f = std::fs::File::create(&withfile).unwrap();
    writeln!(f, "client\nauth-user-pass /etc/creds.txt").unwrap();
    assert!(!config_requires_userpass(withfile.to_str().unwrap()));

    // Commented-out directive → does not.
    let commented = dir.join("commented.ovpn");
    let mut f = std::fs::File::create(&commented).unwrap();
    writeln!(f, "client\n# auth-user-pass\n;auth-user-pass").unwrap();
    assert!(!config_requires_userpass(commented.to_str().unwrap()));

    // Cert-only config → does not.
    let cert = dir.join("cert.ovpn");
    let mut f = std::fs::File::create(&cert).unwrap();
    writeln!(
        f,
        "client\nremote vpn.example.com 1194\ncert a.crt\nkey a.key"
    )
    .unwrap();
    assert!(!config_requires_userpass(cert.to_str().unwrap()));

    // Missing file → false (best-effort fallback).
    assert!(!config_requires_userpass(
        dir.join("nope.ovpn").to_str().unwrap()
    ));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn explain_openvpn_error_names_which_secret_was_wrong() {
    // The whole point: a rejected account and a bad key passphrase are two
    // different fields, and OpenVPN reports them with two different lines.
    let auth = explain_openvpn_error(
        "AUTH: Received control message: AUTH_FAILED; SIGTERM[soft,auth-failure] received",
    )
    .unwrap();
    assert!(auth.contains("username and password"), "{auth}");

    let key = explain_openvpn_error(
        "Cryptographic API error; OpenSSL: error:0308010C:digital envelope routines; \
             Private Key Password verification failed",
    )
    .unwrap();
    assert!(key.contains("private-key passphrase"), "{key}");
    // …and they must never be confused for each other.
    assert!(!key.contains("username"), "{key}");
    assert!(!auth.contains("private-key"), "{auth}");

    // OpenSSL words a bad decrypt several ways; all mean the same field.
    for line in ["OpenSSL: error:0700006C:bad decrypt", "Decryption error"] {
        assert!(
            explain_openvpn_error(line)
                .unwrap()
                .contains("private-key passphrase"),
            "{line}"
        );
    }
}

#[test]
fn explain_openvpn_error_separates_non_credential_failures() {
    // Things no retyped password can fix must not be reported as bad creds.
    let declined = explain_openvpn_error("administrator authorization was declined").unwrap();
    assert!(declined.contains("Elevation"), "{declined}");

    let dns = explain_openvpn_error("RESOLVE: Cannot resolve host address: vpn.x").unwrap();
    assert!(dns.contains("resolve"), "{dns}");

    let tls = explain_openvpn_error("TLS Error: TLS key negotiation failed to occur").unwrap();
    assert!(tls.contains("TLS handshake"), "{tls}");

    let tun = explain_openvpn_error("ERROR: Cannot open TUN/TAP dev /dev/net/tun").unwrap();
    assert!(tun.contains("tunnel device"), "{tun}");
}

/// An expired client certificate must outrank the TLS-timeout branch. Both
/// lines appear in the SAME log — the warning at handshake start, the timeout
/// 60 seconds later — so whichever check runs first decides what the user is
/// told, and only one of them names something they can act on.
#[test]
fn explain_openvpn_error_names_an_expired_client_certificate() {
    let log = "WARNING: Your certificate has expired!\n\
                   VERIFY OK: depth=1\n\
                   TLS Error: TLS key negotiation failed to occur within 60 seconds\n\
                   TLS Error: TLS handshake failed";
    let msg = explain_openvpn_error(log).unwrap();
    assert!(msg.contains("client certificate has expired"), "{msg}");
    assert!(
        !msg.contains("TLS handshake failed"),
        "the timeout is the symptom, not the diagnosis: {msg}"
    );
}

/// The peer's chain failing verification is a different problem with a
/// different owner, so it must not be reported as the user's own cert.
#[test]
fn explain_openvpn_error_separates_a_bad_server_certificate() {
    let msg = explain_openvpn_error(
        "VERIFY ERROR: depth=0, error=certificate has expired: CN=vpn.example",
    )
    .unwrap();
    assert!(msg.contains("server's certificate"), "{msg}");
    assert!(msg.contains("clock"), "{msg}");
}

#[test]
fn explain_openvpn_error_passes_unknown_output_through() {
    // Unrecognized output must fall back to the raw tail — replacing a specific
    // error with a vague guess is worse than showing the real thing.
    assert_eq!(
        explain_openvpn_error("Initialization Sequence In Progress"),
        None
    );
    assert_eq!(explain_openvpn_error(""), None);
}

#[test]
fn config_requires_key_passphrase_detects_encrypted_keys() {
    use std::io::Write;
    let dir = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-ovpn-key-{}"), std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let write = |name: &str, body: &str| {
        let p = dir.join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(body.as_bytes()).unwrap();
        p
    };

    // Inline encrypted key (traditional PEM) → needs a passphrase.
    let inline = write(
        "inline.ovpn",
        "client\nauth-user-pass\n<key>\n-----BEGIN RSA PRIVATE KEY-----\n\
             Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,ABC\n\nbase64==\n\
             -----END RSA PRIVATE KEY-----\n</key>\n",
    );
    assert!(config_requires_key_passphrase(inline.to_str().unwrap()));
    // …and it is orthogonal to the account channel: this config needs both.
    assert!(config_requires_userpass(inline.to_str().unwrap()));

    // Inline PKCS#8 encrypted key → needs a passphrase.
    let pkcs8 = write(
        "pkcs8.ovpn",
        "client\n<key>\n-----BEGIN ENCRYPTED PRIVATE KEY-----\nb64==\n\
             -----END ENCRYPTED PRIVATE KEY-----\n</key>\n",
    );
    assert!(config_requires_key_passphrase(pkcs8.to_str().unwrap()));

    // Inline *unencrypted* key → does not.
    let plain = write(
        "plain.ovpn",
        "client\n<key>\n-----BEGIN PRIVATE KEY-----\nb64==\n-----END PRIVATE KEY-----\n</key>\n",
    );
    assert!(!config_requires_key_passphrase(plain.to_str().unwrap()));

    // Out-of-line key, resolved relative to the config's own directory.
    write(
        "enc.key",
        "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nb64==\n",
    );
    let extenc = write("extenc.ovpn", "client\ncert a.crt\nkey enc.key\n");
    assert!(config_requires_key_passphrase(extenc.to_str().unwrap()));

    write("plain.key", "-----BEGIN PRIVATE KEY-----\nb64==\n");
    let extplain = write("extplain.ovpn", "client\ncert a.crt\nkey plain.key\n");
    assert!(!config_requires_key_passphrase(extplain.to_str().unwrap()));

    // A key file we can't read → false (best-effort, like the userpass twin).
    let missingkey = write("missingkey.ovpn", "client\nkey nope.key\n");
    assert!(!config_requires_key_passphrase(
        missingkey.to_str().unwrap()
    ));

    // `pkcs12` bundles are treated as passphrase-protected (DER — can't sniff).
    let p12 = write("p12.ovpn", "client\npkcs12 bundle.p12\n");
    assert!(config_requires_key_passphrase(p12.to_str().unwrap()));

    // A config that supplies its own `askpass <file>` needs nothing from us…
    let ownaskpass = write(
        "ownaskpass.ovpn",
        "client\naskpass /etc/openvpn/pass.txt\n<key>\n\
             -----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n</key>\n",
    );
    assert!(!config_requires_key_passphrase(
        ownaskpass.to_str().unwrap()
    ));
    // …but a *bare* `askpass` means "prompt on the console" — we must answer it.
    let bareaskpass = write(
        "bareaskpass.ovpn",
        "client\naskpass\n<key>\n-----BEGIN RSA PRIVATE KEY-----\n\
             Proc-Type: 4,ENCRYPTED\n</key>\n",
    );
    assert!(config_requires_key_passphrase(
        bareaskpass.to_str().unwrap()
    ));

    // Commented-out key directive / cert-only config → does not.
    let certonly = write("certonly.ovpn", "client\n# key enc.key\nauth-user-pass\n");
    assert!(!config_requires_key_passphrase(certonly.to_str().unwrap()));

    // Missing config → false.
    assert!(!config_requires_key_passphrase(
        dir.join("nope.ovpn").to_str().unwrap()
    ));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn remove_config_refuses_paths_outside_the_store() {
    // It deletes Tabtivity's copy only — pointed at anything else (the user's
    // original .ovpn, or worse), it must refuse before touching the fs.
    let err = remove_config("/home/u/office.ovpn").unwrap_err();
    assert!(err.contains("not a stored"), "{err}");
    let err = remove_config("/etc/passwd").unwrap_err();
    assert!(err.contains("not a stored"), "{err}");
}

#[test]
fn remove_config_of_missing_stored_file_is_ok() {
    // The goal state is "not stored": a file already gone is success, not an
    // error the UI has to explain.
    let path = configs_dir().join("nope__gone.ovpn");
    assert!(!path.exists());
    assert_eq!(remove_config(path.to_str().unwrap()), Ok(()));
}

#[test]
fn safe_stem_is_filesystem_safe_and_distinct() {
    let a = safe_stem("/home/u/a.ovpn");
    let b = safe_stem("/home/u/b.ovpn");
    assert_ne!(a, b);
    assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
}

#[test]
fn safe_stem_handles_multibyte_paths_without_panicking() {
    // A long path of multibyte chars must not panic on the length-bounding
    // slice (the bug was byte-index slicing into the middle of a char).
    let path = format!(
        "/home/{}/файл-конфигурации-очень-длинное-имя.ovpn",
        "ü".repeat(60)
    );
    let stem = safe_stem(&path);
    // Still filesystem-safe (non-ascii-alnum collapses to '_') and bounded.
    assert!(stem.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
    // 40-char tail + '_' + 16 hex digits.
    assert!(stem.len() <= 40 + 1 + 16);
}

#[test]
fn display_name_recovers_original_from_stored() {
    // `{stem}__{original}` → original; stem may contain `__`.
    assert_eq!(
        display_name("_home_u_work_ovpn_abcd1234__work.ovpn"),
        "work.ovpn"
    );
    assert_eq!(display_name("a__b__client.conf"), "client.conf");
    // No separator → whole name (defensive; shouldn't happen for stored copies).
    assert_eq!(display_name("loose.ovpn"), "loose.ovpn");
}

#[test]
fn is_connected_false_for_unknown_config() {
    assert!(!is_connected("/no/such/config-unit-test.ovpn"));
}

// ── macOS pure helpers (run on any OS) ──────────────────────────────────

#[test]
fn applescript_escape_handles_quotes_and_backslashes() {
    assert_eq!(applescript_escape("plain"), "plain");
    assert_eq!(applescript_escape(r#"a"b"#), r#"a\"b"#);
    assert_eq!(applescript_escape(r"a\b"), r"a\\b");
    assert_eq!(applescript_escape(r#"\""#), r#"\\\""#);
}

/// The admin prompt's `osascript` is the resolver's absolute path, and no
/// root-owned copy refuses instead of running a bare name off `PATH`.
#[test]
fn osascript_is_never_spawned_by_bare_name() {
    let sys = if cfg!(windows) { Path::new(r"C:\sys") } else { Path::new("/usr/bin") };
    let cmd = osascript_command(|bin: &str| Some(sys.join(bin))).unwrap();
    assert_eq!(Path::new(cmd.get_program()), sys.join("osascript"));
    assert!(osascript_command(|_: &str| None).is_err());
}

#[test]
fn macos_admin_shell_command_wraps_and_escapes() {
    let cmd = macos_admin_shell_command("'/opt/x/openvpn' --config 'a\"b.ovpn'", "Prompt.");
    assert!(cmd.starts_with("do shell script \""));
    assert!(cmd.ends_with("with prompt \"Prompt.\""));
    assert!(cmd.contains("with administrator privileges"));
    // The embedded double quote survived AppleScript-escaped.
    assert!(cmd.contains(r#"a\"b.ovpn"#));
}

/// The app-close path tears tunnels down twice by design (the checked teardown
/// while the window is up, then `RunEvent::Exit`). The second pass must not
/// re-elevate for a daemon the first one already TERMed, or the user pays a
/// second polkit password prompt for one tunnel.
#[test]
#[cfg(any(unix, target_os = "windows"))]
fn a_signalled_pid_is_never_killed_a_second_time() {
    // A pid this run has never signalled and that is alive (our own process)
    // still needs its elevated kill.
    let live = std::process::id() as i32;
    assert!(!kill_already_handled(live));
    // Once TERMed, a second teardown pass skips it — no second prompt.
    mark_signalled(live);
    assert!(kill_already_handled(live));
    // A pid that is simply gone needs no kill either. Spawn-and-reap gives a pid
    // that is definitively dead (pid 0 would NOT: `kill(0, 0)` signals the
    // caller's own process group and so reads as alive).
    let mut child = std::process::Command::new(if cfg!(windows) { "cmd" } else { "true" })
        .args(if cfg!(windows) {
            vec!["/D", "/C", "exit"]
        } else {
            vec![]
        })
        .spawn()
        .expect("spawn a trivial child");
    let dead = child.id() as i32;
    child.wait().expect("reap it");
    assert!(kill_already_handled(dead));
}

#[test]
fn pidfile_pid_accepts_digits_only() {
    let dir = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-pidfile-test-{}"), std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let write = |name: &str, body: &str| {
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        p
    };
    assert_eq!(pidfile_pid(&write("ok.pid", "1234\n")), Some(1234));
    assert_eq!(pidfile_pid(&write("ws.pid", "  567  ")), Some(567));
    // Anything non-numeric must never reach `kill`.
    assert_eq!(pidfile_pid(&write("evil.pid", "123; rm -rf /")), None);
    assert_eq!(pidfile_pid(&write("neg.pid", "-1")), None);
    assert_eq!(pidfile_pid(&write("empty.pid", "")), None);
    assert_eq!(pidfile_pid(&dir.join("missing.pid")), None);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn wait_for_ready_logfile_finds_marker() {
    let dir = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-ovpnlog-a-{}"), std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let log = dir.join("t.log");
    std::fs::write(&log, "line one\nInitialization Sequence Completed\nafter\n").unwrap();
    let seen = std::sync::Mutex::new(Vec::<String>::new());
    let result = wait_for_ready_logfile(
        &log,
        Duration::from_secs(5),
        Duration::from_millis(10),
        || true,
        |l| seen.lock().unwrap().push(l.to_string()),
    );
    assert!(result.is_ok());
    let seen = seen.lock().unwrap();
    // Every line up to AND INCLUDING the marker is streamed; nothing after.
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0], "line one");
    assert!(seen[1].contains("Initialization Sequence Completed"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn wait_for_ready_logfile_reports_death_with_tail() {
    let dir = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-ovpnlog-b-{}"), std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let log = dir.join("t.log");
    std::fs::write(&log, "AUTH: Received control message: AUTH_FAILED\n").unwrap();
    let result = wait_for_ready_logfile(
        &log,
        Duration::from_secs(5),
        Duration::from_millis(10),
        || false, // daemon died
        |_| {},
    );
    let err = result.unwrap_err();
    // The failure reason from the log is surfaced, not swallowed.
    assert!(err.contains("AUTH_FAILED"), "{err}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn wait_for_ready_logfile_times_out_and_holds_partial_lines() {
    let dir = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-ovpnlog-c-{}"), std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let log = dir.join("t.log");
    // No trailing newline: the partial line must NOT be emitted.
    std::fs::write(&log, "partial without newline").unwrap();
    let seen = std::sync::Mutex::new(Vec::<String>::new());
    let result = wait_for_ready_logfile(
        &log,
        Duration::from_millis(50),
        Duration::from_millis(10),
        || true, // alive but silent → timeout path
        |l| seen.lock().unwrap().push(l.to_string()),
    );
    assert_eq!(result.unwrap_err(), "OpenVPN connection timed out");
    assert!(
        seen.lock().unwrap().is_empty(),
        "partial line must be held back"
    );
    // A missing logfile behaves like an empty one (daemon hasn't created it
    // yet) rather than erroring out of the wait.
    let result = wait_for_ready_logfile(
        &dir.join("never-created.log"),
        Duration::from_millis(30),
        Duration::from_millis(10),
        || true,
        |_| {},
    );
    assert!(result.is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

/// A failed connect's child that will not exit in time (the root `openvpn`
/// our `kill` cannot reach) is never waited on unboundedly: the reap gives up
/// after its timeout and keeps the child registered, visible and killable.
#[cfg(target_os = "linux")]
#[test]
fn a_child_that_outlives_the_reap_stays_registered() {
    let cfg = "/store/test-reap-timeout.ovpn";
    let dir = tempfile::tempdir().unwrap();
    let child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
    let start = Instant::now();
    let proc = VpnProc { child, pidfile: dir.path().join("t.pid") };
    assert!(!reap_or_register(cfg, proc, Duration::from_millis(200)));
    assert!(start.elapsed() < Duration::from_secs(5));
    assert!(is_connected(cfg), "a still-running tunnel child stays registered");

    let mut proc = registry().lock_ok().remove(cfg).expect("registered");
    let _ = proc.child.kill();
    let _ = proc.child.wait();
}

/// The timeout path of `connect_streaming`: with no pidfile written yet (the
/// polkit prompt was never answered) and no management endpoint, the stop
/// raises no elevated kill, our own kill ends the child, and it is reaped —
/// not registered.
#[cfg(target_os = "linux")]
#[test]
fn a_failed_connect_child_we_can_kill_is_reaped_not_registered() {
    let cfg = "/store/test-failed-connect.ovpn";
    let dir = tempfile::tempdir().unwrap();
    let child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
    let start = Instant::now();
    stop_failed_connect(cfg, child, dir.path().join("never-written.pid"));
    assert!(start.elapsed() < REAP_TIMEOUT);
    assert!(registry().lock_ok().get(cfg).is_none());
    assert!(!is_connected(cfg));
}
