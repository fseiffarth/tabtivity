use super::*;

use std::fs;

fn put(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

/// A scope home with Claude memory for `/work/my.proj` and a Codex folder.
fn home_with_memory(root: &Path) -> (Vec<Source>, Vec<PathBuf>) {
    let home = root.join("home");
    let project = PathBuf::from(if cfg!(windows) { "C:\\work\\my.proj" } else { "/work/my.proj" });
    let name = claude_project_dir_name(&project).unwrap();
    let mem = home.join(".claude").join("projects").join(&name).join("memory");
    put(&mem.join("feedback_a.md"), "a");
    put(&mem.join("MEMORY.md"), "# index\n");
    put(&mem.join("notes.txt"), "not markdown");
    put(&home.join(".codex").join("memories").join("memory_summary.md"), "codex");
    (vec![Source { kind: HOME_SCOPE, home }], vec![project])
}

fn names(entries: &[MemoryEntry]) -> Vec<(&str, &str, &str)> {
    entries.iter().map(|e| (e.cli, e.home, e.name.as_str())).collect()
}

#[test]
fn claude_names_a_project_folder_by_turning_every_other_character_into_a_dash() {
    assert_eq!(claude_project_dir_name(Path::new("/home/u/my.proj")).unwrap(), "-home-u-my-proj");
    assert_eq!(claude_project_dir_name(Path::new("/a b_c/ü")).unwrap(), "-a-b-c--");
    assert!(claude_project_dir_name(Path::new(&format!("/{}", "x".repeat(300)))).is_none());
}

#[test]
fn the_listing_has_the_index_first_then_codex_and_only_markdown() {
    let tmp = tempfile::tempdir().unwrap();
    let (sources, dirs) = home_with_memory(tmp.path());
    let list = list(&sources, &dirs);
    assert_eq!(
        names(&list),
        [
            ("claude", "scope", "MEMORY.md"),
            ("claude", "scope", "feedback_a.md"),
            ("codex", "scope", "memory_summary.md"),
        ]
    );
    assert_eq!(list[0].bytes, "# index\n".len() as u64);
    assert!(list[0].modified_secs.is_some());

    let json = serde_json::to_value(&list[0]).unwrap();
    assert_eq!(json["cli"], "claude");
    assert_eq!(json["home"], "scope");
    assert_eq!(json["name"], "MEMORY.md");
    assert!(json["modifiedSecs"].is_number());
}

#[test]
fn an_absent_home_or_folder_lists_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let source = Source { kind: HOME_SCOPE, home: tmp.path().join("no-home") };
    assert!(list(&[source], &[PathBuf::from("/work/p")]).is_empty());
    let empty = Source { kind: HOME_LOCAL, home: tmp.path().to_path_buf() };
    assert!(list(&[empty], &[PathBuf::from("/work/p")]).is_empty());
}

#[test]
fn a_read_takes_only_a_listed_name() {
    let tmp = tempfile::tempdir().unwrap();
    let (sources, dirs) = home_with_memory(tmp.path());
    assert_eq!(read(&sources, &dirs, "claude", "scope", "MEMORY.md").unwrap(), "# index\n");
    assert_eq!(read(&sources, &dirs, "codex", "scope", "memory_summary.md").unwrap(), "codex");
    for (cli, home, name) in [
        ("claude", "scope", "../MEMORY.md"),
        ("claude", "scope", "notes.txt"),
        ("claude", "scope", "nope.md"),
        ("claude", "scope", "sub/x.md"),
        ("claude", "scope", "/etc/passwd"),
        ("claude", "scope", ""),
        ("codex", "scope", "MEMORY.md"),
        ("claude", "local", "MEMORY.md"),
        ("gemini", "scope", "MEMORY.md"),
    ] {
        assert!(read(&sources, &dirs, cli, home, name).is_none(), "{cli}/{home}/{name}");
    }
}

#[test]
fn the_scope_home_and_the_local_model_home_are_told_apart() {
    let tmp = tempfile::tempdir().unwrap();
    let (mut sources, dirs) = home_with_memory(tmp.path());
    let local = tmp.path().join("home.local");
    let name = claude_project_dir_name(&dirs[0]).unwrap();
    put(&local.join(".claude").join("projects").join(name).join("memory").join("MEMORY.md"), "local index");
    sources.push(Source { kind: HOME_LOCAL, home: local });
    let list = list(&sources, &dirs);
    assert!(names(&list).contains(&("claude", "local", "MEMORY.md")));
    assert!(names(&list).contains(&("claude", "scope", "MEMORY.md")));
    assert_eq!(read(&sources, &dirs, "claude", "local", "MEMORY.md").unwrap(), "local index");
    assert_eq!(read(&sources, &dirs, "claude", "scope", "MEMORY.md").unwrap(), "# index\n");
}

#[test]
fn an_oversize_or_non_utf8_file_is_not_offered_or_not_read() {
    let tmp = tempfile::tempdir().unwrap();
    let (sources, dirs) = home_with_memory(tmp.path());
    let mem = sources[0]
        .home
        .join(".claude")
        .join("projects")
        .join(claude_project_dir_name(&dirs[0]).unwrap())
        .join("memory");
    fs::write(mem.join("big.md"), vec![b'x'; (MAX_MEMORY_BYTES + 1) as usize]).unwrap();
    fs::write(mem.join("bin.md"), [0xff, 0xfe, 0x00]).unwrap();
    let list = list(&sources, &dirs);
    assert!(!names(&list).iter().any(|n| n.2 == "big.md"), "over the cap is not offered");
    assert!(names(&list).iter().any(|n| n.2 == "bin.md"));
    assert!(read(&sources, &dirs, "claude", "scope", "bin.md").is_none());
}

#[cfg(unix)]
#[test]
fn links_and_fifos_in_an_agent_writable_folder_are_never_followed_or_waited_on() {
    let tmp = tempfile::tempdir().unwrap();
    let (sources, dirs) = home_with_memory(tmp.path());
    let mem = sources[0]
        .home
        .join(".claude")
        .join("projects")
        .join(claude_project_dir_name(&dirs[0]).unwrap())
        .join("memory");
    let secret = tmp.path().join("secret.md");
    fs::write(&secret, "TOP SECRET").unwrap();
    std::os::unix::fs::symlink(&secret, mem.join("leak.md")).unwrap();
    std::os::unix::fs::symlink(tmp.path(), mem.join("dir.md")).unwrap();
    crate::services::home_io::mkfifo(&mem.join("pipe.md"));

    let (s, d) = (sources.clone(), dirs.clone());
    let listed = crate::services::home_io::within_deadline(move || list(&s, &d));
    for bad in ["leak.md", "dir.md", "pipe.md"] {
        assert!(!names(&listed).iter().any(|n| n.2 == bad), "{bad} is not offered");
        assert!(read(&sources, &dirs, "claude", "scope", bad).is_none(), "{bad} is not read");
    }

    // The memory folder itself swapped for a link out of the home: nothing.
    let outside = tmp.path().join("outside");
    put(&outside.join("MEMORY.md"), "outside");
    fs::remove_dir_all(&mem).unwrap();
    std::os::unix::fs::symlink(&outside, &mem).unwrap();
    let after = self::list(&sources, &dirs);
    assert!(!names(&after).iter().any(|n| n.0 == "claude"), "a linked memory folder is refused");
    assert!(read(&sources, &dirs, "claude", "scope", "MEMORY.md").is_none());

    // So is a linked `.codex`.
    fs::remove_dir_all(sources[0].home.join(".codex")).unwrap();
    put(&outside.join("memories").join("MEMORY.md"), "codex outside");
    std::os::unix::fs::symlink(&outside, sources[0].home.join(".codex")).unwrap();
    assert!(self::list(&sources, &dirs).is_empty());
}

#[test]
fn the_entry_count_is_capped() {
    let tmp = tempfile::tempdir().unwrap();
    let (sources, dirs) = home_with_memory(tmp.path());
    let mem = sources[0]
        .home
        .join(".claude")
        .join("projects")
        .join(claude_project_dir_name(&dirs[0]).unwrap())
        .join("memory");
    for i in 0..(MAX_ENTRIES_PER_DIR + 50) {
        fs::write(mem.join(format!("m{i:04}.md")), "x").unwrap();
    }
    let listed = list(&sources, &dirs);
    assert!(listed.len() <= MAX_ENTRIES);
    assert!(listed.iter().filter(|e| e.cli == "claude").count() <= MAX_ENTRIES_PER_DIR);
}

fn put_claude_memory(home: &Path, root: &Path) {
    let mem = home
        .join(".claude")
        .join("projects")
        .join(claude_project_dir_name(root).unwrap())
        .join("memory");
    put(&mem.join("MEMORY.md"), "# repo index\n");
}

/// Claude Code keys a project's auto memory by the *canonical git root* of its
/// folder (read from the installed binary, 2.1.321: the working-copy root, else
/// `findCanonicalGitRoot`, else the folder itself): a Tabtivity project that is
/// a subfolder of a repository shares the repository's memory.
#[test]
fn a_project_inside_a_git_repository_lists_the_memory_keyed_by_the_repository_root() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let project = repo.join("sub").join("proj");
    fs::create_dir_all(&project).unwrap();
    fs::create_dir_all(repo.join(".git")).unwrap();
    let home = tmp.path().join("home");
    put_claude_memory(&home, &repo);
    let sources = vec![Source { kind: HOME_SCOPE, home }];

    let listed = list(&sources, &[project.clone()]);
    assert_eq!(names(&listed), [("claude", "scope", "MEMORY.md")]);
    assert_eq!(read(&sources, &[project], "claude", "scope", "MEMORY.md").unwrap(), "# repo index\n");

    // Outside any repository nothing is found by that rule.
    let loose = tmp.path().join("loose");
    fs::create_dir_all(&loose).unwrap();
    assert!(list(&sources, &[loose]).is_empty());
}

/// A linked worktree's canonical root is the main working copy.
#[test]
fn a_linked_worktree_lists_the_memory_keyed_by_the_main_working_copy() {
    let tmp = tempfile::tempdir().unwrap();
    let main = tmp.path().join("main");
    let gitdir = main.join(".git").join("worktrees").join("wt");
    fs::create_dir_all(&gitdir).unwrap();
    fs::write(gitdir.join("commondir"), "../..\n").unwrap();
    let wt = tmp.path().join("wt");
    fs::create_dir_all(&wt).unwrap();
    fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
    let home = tmp.path().join("home");
    put_claude_memory(&home, &main);
    let sources = vec![Source { kind: HOME_SCOPE, home }];

    assert_eq!(names(&list(&sources, &[wt])), [("claude", "scope", "MEMORY.md")]);
}

/// The index is always listed, however many notes sit beside it: the folder
/// listing is cut at a cap in directory order, which says nothing about where
/// `MEMORY.md` falls. (Thousands of names, so it lands past the cap on any
/// filesystem order with near certainty.)
#[test]
fn the_index_is_listed_even_in_a_folder_past_the_cap() {
    let tmp = tempfile::tempdir().unwrap();
    let (sources, dirs) = home_with_memory(tmp.path());
    let mem = sources[0]
        .home
        .join(".claude")
        .join("projects")
        .join(claude_project_dir_name(&dirs[0]).unwrap())
        .join("memory");
    for i in 0..4000 {
        fs::write(mem.join(format!("m{i:04}.md")), "x").unwrap();
    }
    let listed = list(&sources, &dirs);
    assert_eq!(listed[0].name, "MEMORY.md");
    assert_eq!(read(&sources, &dirs, "claude", "scope", "MEMORY.md").unwrap(), "# index\n");
}
