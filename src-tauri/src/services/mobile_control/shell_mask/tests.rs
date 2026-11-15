use super::{mask_command, HIDDEN};

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
