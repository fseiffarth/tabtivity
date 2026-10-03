//! The per-user server daemon's binary (hosted plan §3.1, §8.1): the
//! daemon behind `tabtivity-serverd@<user>.service`. One entry, shared with
//! `tabtivity --serverd`; Linux only.

fn main() {
    #[cfg(unix)]
    app_lib::services::server::daemon::main();
    #[cfg(not(unix))]
    {
        eprintln!("the per-user server daemon runs on Linux only");
        std::process::exit(2);
    }
}
