//! Interactive synthetic-project probe. Prints only a device code, account
//! status and result counts; never tokens, protocol payloads or generated code.
use app_lib::services::copilot::{documents::position, process::ManagedProcess, session::{Session, CompletionRequest}};
use std::path::Path;

#[tokio::main]
async fn main() -> Result<(), String> {
    let install = std::env::args().nth(1).ok_or("Pass the isolated CLS installation directory")?;
    let project = tempfile::tempdir().map_err(|_| "temporary project failed")?;
    let root = project.path().canonicalize().map_err(|_| "temporary project failed")?;
    let path = root.join("square.py");
    std::fs::write(&path, "# Synthetic protocol probe\n").map_err(|_| "synthetic file failed")?;
    let (process, output, input) = ManagedProcess::launch_installed(Path::new(&install), &root)?;
    let session = Session::start(output, input, Some(process), &root).await?;
    println!("Pinned server initialized inside the project fence.");
    // Catch namespace/parent-monitor exits before asking for authorization.
    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    if !session.alive() { return Err("server stopped during startup check".into()); }
    if let Some(device) = session.sign_in().await? {
        println!("Open {} and enter {}", device.verification_uri, device.user_code);
        session.finish_sign_in().await?;
    }
    let account = session.account().await?;
    println!("Account status: {}", account.get("status").and_then(serde_json::Value::as_str).unwrap_or("unknown"));
    let uri = url::Url::from_file_path(&path).map_err(|_| "URI failed")?;
    let text = "# Return the square of a number.\ndef square(value):\n    return ";
    let request = |version| CompletionRequest { uri: uri.as_str(), editor: "probe", client_version: version,
        text, language: "python", position: position(text), automatic: false, tab_size: 4, insert_spaces: true };
    let items = session.complete(request(1)).await?;
    println!("Unsaved-document completion candidates: {}", items.len());
    let (cancel, signal) = tokio::sync::watch::channel(false);
    let pending = session.complete_cancellable(request(2), signal);
    let trigger = async {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        drop(cancel);
    };
    let (result, _) = tokio::join!(pending, trigger);
    println!("Cancellation result: {}", result.err().unwrap_or_else(|| "completed before cancellation".into()));
    session.close_editor("probe").await;
    session.sign_out().await?;
    println!("Sign-out acknowledged.");
    session.stop();
    let (process, output, input) = ManagedProcess::launch_installed(Path::new(&install), &root)?;
    let fresh = Session::start(output, input, Some(process), &root).await?;
    let result = fresh.complete(request(1)).await;
    println!("Fresh server without sign-in: {}", result.err().unwrap_or_else(|| "UNEXPECTED completion".into()));
    fresh.stop();
    Ok(())
}
