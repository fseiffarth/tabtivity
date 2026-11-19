use super::{mask_command, mask_path, mask_url, HIDDEN};

const ROOT: &str = "/work/me/proj";

fn masked(command: &str) -> String {
    mask_command(command, &[ROOT])
}

#[test]
fn the_tabs_own_folder_becomes_project_relative() {
    assert_eq!(masked("cd /work/me/proj && cargo test -q"), "cd . && cargo test -q");
    assert_eq!(masked("cat /work/me/proj/src/main.rs"), "cat src/main.rs");
    assert_eq!(masked("ls '/work/me/proj/'"), "ls '.'");
    assert_eq!(masked("cargo build --manifest-path=/work/me/proj/Cargo.toml"), "cargo build --manifest-path=Cargo.toml");
    // Not on a path boundary: a sibling folder and a deeper mount are other
    // paths, which keep only their leaf.
    assert_eq!(masked("ls /work/me/project/a"), "ls …/a");
    assert_eq!(masked("ls /mnt/work/me/proj/a"), "ls …/a");
}

#[test]
fn a_member_folder_inside_the_root_wins_over_the_root() {
    let out = mask_command("cat /work/me/proj/sub/x /work/me/proj/y", &[ROOT, "/work/me/proj/sub/"]);
    assert_eq!(out, "cat x y");
}

#[test]
fn other_paths_keep_only_their_leaf() {
    assert_eq!(masked("cat ~/.ssh/config"), "cat ~/…/config");
    assert_eq!(masked("tail -f /tmp/claude-1000/abc/tasks/b1.output"), "tail -f …/b1.output");
    assert_eq!(masked("rsync -a host:/srv/data/ ."), "rsync -a host:…/data/ .");
    assert_eq!(masked("ls / /tmp ~/x"), "ls / /tmp ~/x");
    // A URL's path is not a host path.
    assert_eq!(masked("curl https://example.org/a/b"), "curl https://example.org/a/b");
}

#[test]
fn credentials_in_headers_urls_and_schemes_are_hidden() {
    assert_eq!(
        masked("curl -H 'Authorization: Bearer abc.DEF-123' https://api.example.org/v1"),
        format!("curl -H 'Authorization: {HIDDEN}' https://api.example.org/v1")
    );
    assert_eq!(masked(r#"curl -H "X-Api-Key: k3y" x"#), format!(r#"curl -H "X-Api-Key: {HIDDEN}" x"#)); // privacy-check: ok — made-up fixture secret the masker must hide
    assert_eq!(masked("git clone https://me:hunter2@example.org/r.git"), format!("git clone https://{HIDDEN}@example.org/r.git"));
    assert!(!masked("wget --header=Cookie:\\ s=1 x").contains("s=1"));
    assert_eq!(masked("echo Bearer Zm9vOmJhcg=="), format!("echo Bearer {HIDDEN}"));
    // Prose after the word keeps its word.
    assert_eq!(masked("git commit -m 'add basic support'"), "git commit -m 'add basic support'");
}

#[test]
fn secret_named_values_are_hidden() {
    assert_eq!(masked("GITHUB_TOKEN=abc123 gh pr list"), format!("GITHUB_TOKEN={HIDDEN} gh pr list"));
    assert_eq!(masked("mysql --password=s3cret db"), format!("mysql --password={HIDDEN} db")); // privacy-check: ok — made-up fixture secret the masker must hide
    assert_eq!(masked("tool --api-key 'x y z' run"), format!("tool --api-key {HIDDEN} run"));
    assert_eq!(masked("tool --token --verbose"), "tool --token --verbose");
    assert_eq!(masked("curl 'x?access_token=abc&page=2'"), format!("curl 'x?access_token={HIDDEN}&page=2'"));
    assert_eq!(masked(r#"curl -d '{"password": "pw", "user": "me"}'"#), format!(r#"curl -d '{{"password": "{HIDDEN}", "user": "me"}}'"#));
    // A secret word inside a message is not a flag.
    assert_eq!(masked("git commit -m 'fix token refresh'"), "git commit -m 'fix token refresh'");
}

#[test]
fn known_tokens_keys_and_random_runs_are_hidden() {
    for token in [
        "ghp_0123456789abcdefABCDEF0123", // privacy-check: ok — made-up fixture secret the masker must hide
        "github_pat_11ABCDEFG0123456789_abcdefghij", // privacy-check: ok — made-up fixture secret the masker must hide
        "sk-ant-api03-abcdefghijklmnop", // privacy-check: ok — made-up fixture secret the masker must hide
        "AKIAABCDEFGHIJKLMNOP", // privacy-check: ok — made-up fixture secret the masker must hide
        "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4", // privacy-check: ok — made-up fixture secret the masker must hide
        "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z",
    ] {
        let out = masked(&format!("run {token} now"));
        assert_eq!(out, format!("run {HIDDEN} now"), "{token}");
    }
    let key = "echo '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----' > k";
    assert_eq!(masked(key), format!("echo '{HIDDEN}' > k"));
    // A commit hash, a UUID and a long snake_case name are not secrets.
    for plain in [
        "git show 612304531a8fb4ae07c3b1d2e4f5a6b7c8d9e0f1",
        "rm -r 0b2f6c9e-1f7a-4c1e-9c55-7a1d2b3c4d5e",
        "cargo test the_generated_command_classes_ts_is_current",
    ] {
        assert_eq!(masked(plain), plain);
    }
}

#[test]
fn a_command_with_nothing_to_hide_is_unchanged() {
    let plain = "npm run build 2>&1 | tail -40 && git status --short";
    assert_eq!(masked(plain), plain);
    assert_eq!(mask_command("ls /a/b", &[]), "ls …/b");
    assert_eq!(mask_command("", &[ROOT]), "");
}

/// Windows folders match in any case, with either separator and spelled
/// verbatim; the masker is pure, so these run on every OS.
#[test]
fn a_windows_folder_becomes_project_relative_in_every_spelling() {
    let root = r"C:\Users\me\proj";
    let masked = |command: &str| mask_command(command, &[root]);
    assert_eq!(masked(r"cd C:\Users\me\proj && cargo test"), "cd . && cargo test");
    assert_eq!(masked(r"type c:\users\ME\Proj\src\main.rs"), r"type src\main.rs");
    assert_eq!(masked("Fetch into C:/Users/me/proj/data"), "Fetch into data");
    assert_eq!(masked(r"cd C:\Users\me\proj\"), "cd .");
    assert_eq!(masked(r"dir \\?\C:\Users\me\proj\x"), r"dir x");
    // A verbatim folder matches its plain spelling on the line.
    assert_eq!(mask_command(r"cd C:\Users\me\proj", &[r"\\?\C:\Users\me\proj"]), "cd .");
    let unc = r"\\srv\share\proj";
    assert_eq!(mask_command(r"cd \\?\UNC\srv\share\proj\a", &[unc]), "cd a");
    assert_eq!(mask_command(r"cd \\srv\share\proj", &[unc]), "cd .");
    // Not on a path boundary: a sibling folder is another path.
    assert_eq!(masked(r"dir C:\Users\me\project\a"), r"dir …\a");
    // A drive root is no tab folder.
    assert_eq!(mask_command(r"dir C:\a\b", &[r"C:\"]), r"dir …\b");
}

/// Any other Windows path keeps only its leaf, a spelling of the tab's folder
/// that pass 1 does not know (an 8.3 short name) included: masked more,
/// never shown whole.
#[test]
fn other_windows_paths_keep_only_their_leaf() {
    let masked = |command: &str| mask_command(command, &[r"C:\Users\runneradmin\AppData\Local\Temp\x\work"]);
    assert_eq!(masked(r"cd C:\Users\RUNNER~1\AppData\Local\Temp\x\work && dir"), r"cd …\work && dir");
    assert_eq!(masked("type C:/Users/me/.ssh/config"), "type …/config");
    assert_eq!(masked(r"dir C:\Users\me\out\"), r"dir …\out\");
    assert_eq!(masked(r"dir C:\Users C:\"), r"dir C:\Users C:\");
    assert_eq!(masked(r#"copy "\\?\D:\deep\a.txt" x"#), r#"copy "…\a.txt" x"#);
    // A UNC path names a host and a share: neither crosses.
    assert_eq!(masked(r"copy \\fileserver\team\docs\a.txt ."), r"copy …\a.txt .");
    assert_eq!(masked(r"net use \\fileserver\team"), "net use …");
    for leaked in ["RUNNER~1", "fileserver", ".ssh", "deep"] {
        for command in [
            r"cd C:\Users\RUNNER~1\AppData\Local\Temp\x\work",
            r"copy \\fileserver\team\docs\a.txt .",
            "type C:/Users/me/.ssh/config",
            r#"copy "\\?\D:\deep\a.txt" x"#,
        ] {
            assert!(!masked(command).contains(leaked), "{leaked}: {command}");
        }
    }
}

#[test]
fn a_file_path_is_project_relative_or_cut_to_its_leaf_as_one_whole() {
    let path = |p: &str| mask_path(p, &[ROOT]);
    assert_eq!(path("/work/me/proj/src/a.rs"), "src/a.rs");
    assert_eq!(path("/work/me/proj"), ".");
    // A relative path the agent wrote stays.
    assert_eq!(path("src/a.rs"), "src/a.rs");
    // Anything else absolute keeps its leaf; a space in a folder name lets nothing through.
    assert_eq!(path("/home/me/other/b.txt"), "…/b.txt");
    assert_eq!(path("/home/my user/secret dir/b.txt"), "…/b.txt");
    assert_eq!(path("~/.ssh/config"), "~/…/config");
    assert_eq!(path("~/x"), "~/x");
    assert_eq!(path("/tmp"), "/tmp");
    assert_eq!(path("/work/me/project/a"), "…/a");
    // Secret-shaped text in the leaf goes too.
    assert_eq!(path("/work/me/proj/token=abcdef.txt"), format!("token={HIDDEN}"));
    for leaked in ["home", "me/other", "secret dir", ".ssh"] {
        for p in ["/home/me/other/b.txt", "/home/my user/secret dir/b.txt", "~/.ssh/config"] {
            assert!(!path(p).contains(leaked), "{leaked}: {p}");
        }
    }
}

#[test]
fn a_path_that_climbs_out_or_names_another_place_keeps_only_its_leaf() {
    let path = |p: &str| mask_path(p, &[ROOT]);
    // Taking the folder off must not leave a way back out of it.
    assert_eq!(path("/work/me/proj/../../../home/alice/.ssh/id"), "…/id");
    assert_eq!(path("../../home/alice/.ssh/id"), "…/id");
    assert_eq!(path("src/../../alice/id"), "…/id");
    assert_eq!(path(r"..\..\alice\id"), r"…\id");
    assert_eq!(path("file:///home/alice/.ssh/id"), "…/id");
    assert_eq!(path("~alice/.ssh/id"), "…/id");
    assert_eq!(path(r"\Users\alice\id"), r"…\id");
    assert_eq!(path("notes /home/alice/.ssh/id"), "…/id");
    assert_eq!(path("C:alice\\id"), r"…\id");
    for p in ["/work/me/proj/../../../home/alice/.ssh/id", "file:///home/alice/.ssh/id", "~alice/.ssh/id", "notes /home/alice/.ssh/id"] {
        assert!(!path(p).contains("alice"), "{p}");
    }
    // Plain relative ones stay, a `..` inside a name too.
    assert_eq!(path("src/a..b/c.rs"), "src/a..b/c.rs");
    assert_eq!(path("my docs/a.txt"), "my docs/a.txt");
}

#[test]
fn invisible_and_reordering_characters_are_dropped_from_a_path() {
    let path = |p: &str| mask_path(p, &[ROOT]);
    assert_eq!(path("/home/me/evil\u{202E}txt.exe"), "…/eviltxt.exe");
    assert_eq!(path("src/a\u{200B}.rs\u{2066}"), "src/a.rs");
    assert_eq!(path("/work/me/proj/a\nb.rs"), "ab.rs");
}

#[test]
fn a_host_in_another_script_shows_nothing() {
    // Cyrillic `а`/`о` look like the Latin letters: the phone could not tell it from the real host.
    for odd in ["https://p\u{0430}ypal.example.org/x", "https://exampl\u{0435}.org", "https://b\u{fc}cher.example.org"] {
        assert_eq!(mask_url(odd), "", "{odd}");
    }
    assert_eq!(mask_url("https://xn--bcher-kva.example.org/x"), "https://xn--bcher-kva.example.org");
}

#[test]
fn a_windows_file_path_keeps_its_leaf_unless_it_is_in_the_tabs_folder() {
    let root = r"C:\Users\me\proj";
    let path = |p: &str| mask_path(p, &[root]);
    assert_eq!(path(r"C:\Users\me\proj\src\a.rs"), r"src\a.rs");
    assert_eq!(path("c:/users/ME/proj/src/a.rs"), "src/a.rs");
    assert_eq!(path(r"C:\Users\me\out\b.txt"), r"…\b.txt");
    assert_eq!(path("C:/Users/me/.ssh/config"), "…/config");
    assert_eq!(path(r"C:\Users"), r"C:\Users");
    assert_eq!(path(r"\\?\D:\deep\a.txt"), r"…\a.txt");
    assert_eq!(path(r"\\fileserver\team\docs\a.txt"), r"…\a.txt");
    assert_eq!(path(r"\\fileserver\team"), "…");
    for leaked in ["fileserver", "deep", ".ssh", "me"] {
        for p in [r"\\fileserver\team\docs\a.txt", r"\\?\D:\deep\a.txt", "C:/Users/me/.ssh/config", r"C:\Users\me\out\b.txt"] {
            assert!(!path(p).contains(leaked), "{leaked}: {p}");
        }
    }
}

#[test]
fn a_url_shows_its_scheme_and_host_and_nothing_else() {
    assert_eq!(mask_url("https://example.org/a/b?q=1#f"), "https://example.org");
    assert_eq!(mask_url("  http://docs.example.org  "), "http://docs.example.org");
    assert_eq!(mask_url("https://user:pw@example.org:8443/a"), "https://example.org");
    assert_eq!(mask_url("https://tok@example.org"), "https://example.org");
    // User info that holds an `@` or a `/`-less secret: everything before the last `@` goes.
    assert_eq!(mask_url("https://a@b@example.org/x"), "https://example.org");
    assert_eq!(mask_url("https://example.org?token=abc"), "https://example.org");
    assert_eq!(mask_url("https://example.org#frag"), "https://example.org");
    assert_eq!(mask_url("http://[::1]:8080/x"), "http://[::1]");
    assert_eq!(mask_url("http://203.0.113.7:3000/admin"), "http://203.0.113.7");
    // A backslash ends the host as browsers read it: nothing after it crosses.
    assert_eq!(mask_url(r"https://example.org\@evil.test/x"), "https://example.org");
    // No host, no URL: nothing crosses.
    for odd in ["", "example.org/a", "data:text/plain;base64,AAAA", "file:///etc/passwd", "https://", "https:///x", "://host", "ht tp://x.org", "https://exa mple.org", "https://[zz]/x", "https://exa%6Dple.org/"] {
        assert_eq!(mask_url(odd), "", "{odd}");
    }
    // A random run as a host label is hidden.
    let token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    assert_eq!(mask_url(&format!("https://{token}.example.org/x")), format!("https://{HIDDEN}.example.org"));
}

/// Each line, what it masks to, and the components above the leaf that must
/// not cross (threat model gap 117): a path is found by what it is, not by
/// what precedes it.
const GLUED_POSIX_PATHS: &[(&str, &str, &[&str])] = &[
    ("make 2>/home/alice/private/build.log", "make 2>…/build.log", &["home", "alice", "private"]),
    ("sort </home/alice/in.txt >/home/alice/out.txt", "sort <…/in.txt >…/out.txt", &["home", "alice"]),
    (
        "curl -d @/home/alice/private/body.json https://example.org",
        "curl -d @…/body.json https://example.org",
        &["home", "alice", "private"],
    ),
    ("gcc -I/home/alice/sdk/include -L/home/alice/sdk/lib x.c", "gcc -I…/include -L…/lib x.c", &["home", "alice", "sdk"]),
    ("ls;/home/alice/bin/tool", "ls;…/tool", &["home", "alice", "bin"]),
    ("echo `/home/alice/bin/tool`", "echo `…/tool`", &["home", "alice", "bin"]),
    ("cp {/home/alice/a/b,/home/alice/c/d} .", "cp {…/b,…/d} .", &["home", "alice", "a/", "c/"]),
    ("xdg-open file:///home/alice/Documents/tax/2026.pdf", "xdg-open file://…/2026.pdf", &["home", "alice", "Documents", "tax"]),
    ("x=$(cat</home/alice/secret/key.txt)", "x=$(cat<…/key.txt)", &["home", "alice", "secret"]),
    (
        r#"cat "/home/alice/My Documents/secret plan/file.txt""#,
        r#"cat "…/file.txt""#,
        &["home", "alice", "My", "Documents", "secret", "plan"],
    ),
    ("cat '/home/alice/My Documents/secret plan/file.txt'", "cat '…/file.txt'", &["home", "alice", "My", "Documents", "secret", "plan"]),
    (r"cat /home/alice/My\ Documents/secret\ plan/file.txt", "cat …/file.txt", &["home", "alice", "My", "Documents", "secret", "plan"]),
    ("cat ~/private/notes/x.md|wc -l", "cat ~/…/x.md|wc -l", &["private", "notes"]),
    (
        r#"sh -c "cat '/home/alice/My Documents/a.txt' >/home/alice/out/b.txt""#,
        r#"sh -c "cat '…/a.txt' >…/b.txt""#,
        &["home", "alice", "My", "Documents", "out"],
    ),
];

#[test]
fn a_path_glued_to_an_operator_or_a_short_flag_keeps_only_its_leaf() {
    for (line, want, hidden) in GLUED_POSIX_PATHS {
        let out = masked(line);
        assert_eq!(out, *want, "{line}");
        for part in *hidden {
            assert!(!out.contains(part), "{part} crossed in {out:?} from {line}");
        }
    }
}

const GLUED_WINDOWS_PATHS: &[(&str, &str, &[&str])] = &[
    (r"make 2>C:\Users\alice\private\build.log", r"make 2>…\build.log", &["Users", "alice", "private"]),
    (r"sort <C:\Users\alice\in.txt >C:\Users\alice\out.txt", r"sort <…\in.txt >…\out.txt", &["Users", "alice"]),
    (
        r"curl -d @C:\Users\alice\private\body.json https://example.org",
        r"curl -d @…\body.json https://example.org",
        &["Users", "alice", "private"],
    ),
    (r"cl /IC:\Users\alice\sdk\include -LC:\Users\alice\sdk\lib x.c", r"cl /I…\include -L…\lib x.c", &["Users", "alice", "sdk"]),
    (r"dir;C:\Users\alice\bin\tool", r"dir;…\tool", &["Users", "alice", "bin"]),
    (r"echo `C:\Users\alice\bin\tool`", r"echo `…\tool`", &["Users", "alice", "bin"]),
    (r"copy {C:\Users\alice\a\b,C:\Users\alice\c\d} .", r"copy {…\b,…\d} .", &["Users", "alice", r"a\", r"c\"]),
    ("start file:///C:/Users/alice/Documents/tax/2026.pdf", "start file://…/2026.pdf", &["Users", "alice", "Documents", "tax"]),
    (r"x=$(type<C:\Users\alice\secret\key.txt)", r"x=$(type<…\key.txt)", &["Users", "alice", "secret"]),
    (
        r#"type "C:\Users\alice\My Documents\secret plan\file.txt""#,
        r#"type "…\file.txt""#,
        &["Users", "alice", "My", "Documents", "secret", "plan"],
    ),
    (r"copy 2>\\fileserver\team\private\log.txt", r"copy 2>…\log.txt", &["fileserver", "team", "private"]),
    (r#"copy "\\fileserver\team\My Docs\a b.txt" x"#, r#"copy "…\a b.txt" x"#, &["fileserver", "team", "My", "Docs"]),
];

#[test]
fn a_windows_path_glued_to_an_operator_or_a_short_flag_keeps_only_its_leaf() {
    for (line, want, hidden) in GLUED_WINDOWS_PATHS {
        let out = masked(line);
        assert_eq!(out, *want, "{line}");
        for part in *hidden {
            assert!(!out.contains(part), "{part} crossed in {out:?} from {line}");
        }
    }
}

#[test]
fn relative_paths_urls_and_quoted_text_are_not_taken_for_paths() {
    for plain in [
        "cat src/lib/x.ts",
        "ls ./src/a/b ../c/d",
        "a-I/b/c",
        "cp src/*/a/b dist",
        "curl http://localhost:8080/a/b",
        "git push git@example.org:team/repo.git",
        "npm i @scope/pkg",
        "open file:///tmp",
        r#"git commit -m "fix /tmp handling""#,
        "echo 'it is fine'",
    ] {
        assert_eq!(masked(plain), plain);
    }
    // A quoted command is no single path: each path in it is cut alone.
    assert_eq!(masked(r#"sh -c "/home/alice/bin/tool --in /home/alice/x/y""#), r#"sh -c "…/tool --in …/y""#);
}

/// Paths that crossed whole: one glued to a parameter default's sign or to a
/// `git+` scheme, another user's `~alice/` home, and a path whose backslash
/// escapes (`\'`, `\(`, `\;`, `\"` in double quotes) ended it early.
const MORE_POSIX_PATHS: &[(&str, &str, &[&str])] = &[
    ("echo ${DIR:-/home/alice/private/out}", "echo ${DIR:-…/out}", &["home", "alice", "private"]),
    ("echo ${DIR:+/home/alice/private/out}", "echo ${DIR:+…/out}", &["home", "alice", "private"]),
    ("pip install git+file:///home/alice/private/proj", "pip install git+file://…/proj", &["home", "alice", "private"]),
    ("cat ~alice/.ssh/id_ed25519", "cat …/id_ed25519", &["alice", ".ssh"]),
    ("ls ~bob/notes", "ls …/notes", &["bob"]),
    (r"cat /home/alice/Alice\'s\ Docs/tax/2026.pdf", "cat …/2026.pdf", &["home", "alice", "Docs", "tax"]),
    (r"cd /home/alice/My\ Files\ \(old\)/work && ls", "cd …/work && ls", &["home", "alice", "Files", "old"]),
    (r"cat /home/alice/a\;b/private/x", "cat …/x", &["home", "alice", ";b", "private"]),
    (r#"cat "/home/alice/\"hi\"/private/x" -n"#, r#"cat "…/x" -n"#, &["home", "alice", "hi", "private"]),
];

#[test]
fn a_path_after_a_sign_a_scheme_or_another_users_home_or_with_escapes_keeps_only_its_leaf() {
    for (line, want, hidden) in MORE_POSIX_PATHS {
        let out = masked(line);
        assert_eq!(out, *want, "{line}");
        for part in *hidden {
            assert!(!out.contains(part), "{part} crossed in {out:?} from {line}");
        }
    }
    // Not another user's home: a revision, the directory stack.
    for plain in ["git diff HEAD~1/x", "ls ~1/a/b", "ls ~+/a/b", "ls ~-/a/b"] {
        assert_eq!(masked(plain), plain);
    }
}

/// Paths that still showed a parent: one with a quoted stretch glued inside
/// the word (one word to the shell), and a POSIX network path, whose server
/// and share name a host as a UNC path's do.
const GLUED_QUOTES_AND_NETWORK_PATHS: &[(&str, &str, &[&str])] = &[
    ("cat /home/alice/x'y/z'/w", "cat …/w", &["home", "alice", "y/z"]),
    (r#"cat /home/alice/"My Docs"/tax/2026.pdf -n"#, "cat …/2026.pdf -n", &["home", "alice", "Docs", "tax"]),
    ("ls /home/alice/'secret dir'/x; echo done", "ls …/x; echo done", &["home", "alice", "secret"]),
    ("smbclient //nas/finance/q3/report.xlsx", "smbclient …/report.xlsx", &["nas", "finance", "q3"]),
    ("cp a.txt //nas/finance/", "cp a.txt …", &["nas", "finance"]),
    ("mount //nas/finance /mnt", "mount … /mnt", &["nas", "finance"]),
    (r#"cp "//nas/finance/My Docs/x" ."#, r#"cp "…/x" ."#, &["nas", "finance", "Docs"]),
];

#[test]
fn a_path_with_a_glued_quote_or_a_network_path_keeps_only_its_leaf() {
    for (line, want, hidden) in GLUED_QUOTES_AND_NETWORK_PATHS {
        let out = masked(line);
        assert_eq!(out, *want, "{line}");
        for part in *hidden {
            assert!(!out.contains(part), "{part} crossed in {out:?} from {line}");
        }
    }
    // A URL's host stays, and so do a lone `//`, a quote that never closes
    // and a quote after the word.
    for plain in ["curl https://example.com/a", "echo a // b", "echo /tmp 'x y'"] {
        assert_eq!(masked(plain), plain);
    }
    assert_eq!(mask_path("//nas/finance/q3/report.xlsx", &[]), "…/report.xlsx");
    assert_eq!(mask_path("//nas/finance", &[]), "…");
}
