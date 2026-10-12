//! The per-user server daemon's binary (hosted plan §3.1, §8.1): the daemon
//! behind `<slug>-serverd@<user>.service`. The library is the desktop's,
//! built without its `desktop` feature, so this binary links no window
//! toolkit (`ldd` shows no GTK, X11 or libdbus); `<app> --serverd` is the
//! same entry inside the desktop binary.

fn main() {
    #[cfg(unix)]
    app_lib::services::server::daemon::main();
    #[cfg(not(unix))]
    {
        eprintln!("the per-user server daemon runs on Linux only");
        std::process::exit(2);
    }
}
