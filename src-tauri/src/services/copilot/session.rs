//! One language server per consented project: handshake, document sync,
//! completion, feedback and teardown. Transport-generic so tests drive a duplex
//! instead of a process. Tokens and protocol payloads never leave this module:
//! callers see opaque candidate ids, a device code and coarse error codes.
use super::documents::{DocumentTicket, Documents, Position};
use super::process::ManagedProcess;
use super::rpc::{RpcClient, RpcError};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::Mutex as AsyncMutex;

const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(30);
const COMPLETION_TIMEOUT: Duration = Duration::from_secs(15);
const ACCOUNT_TIMEOUT: Duration = Duration::from_secs(30);
/// The device flow waits for the user's browser; GitHub expires the code itself.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_ITEMS: usize = 8;
const MAX_STARTS: usize = 3;
const START_WINDOW: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The server's own `didChangeStatus` kind (Normal/Warning/Error/Inactive).
    pub kind: String,
    /// Account, quota and billing text is the server's to word; shown verbatim.
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    pub user_code: String,
    pub verification_uri: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountMessage { pub id: u64, pub message: String, pub actions: Vec<String> }
struct MessageRequest { public: AccountMessage, rpc_id: Value, actions: Vec<Value> }

pub struct CompletionRequest<'a> {
    pub uri: &'a str,
    pub editor: &'a str,
    pub client_version: u64,
    pub text: &'a str,
    pub language: &'a str,
    /// The project's text-file consent, read with the rest of the policy.
    pub allow_text: bool,
    pub position: Position,
    pub automatic: bool,
    pub tab_size: u32,
    pub insert_spaces: bool,
}

pub fn error_code(error: RpcError) -> String {
    match error {
        RpcError::Server(1000) => "copilot_not_signed_in",
        RpcError::Cancelled | RpcError::Server(-32800) => "copilot_cancelled",
        RpcError::Timeout => "copilot_timeout",
        RpcError::Closed | RpcError::InvalidFrame => "copilot_server_closed",
        RpcError::Server(_) => "copilot_server_error",
    }
    .into()
}

/// The caret must name a real UTF-16 boundary of the text being synchronized;
/// a position past a line's end would let the server complete unrelated text.
fn position_in(text: &str, position: Position) -> bool {
    let Some(line) = text.split('\n').nth(position.line as usize) else {
        return false;
    };
    let line = line.strip_suffix('\r').unwrap_or(line);
    let mut units = 0u32;
    if position.character == 0 {
        return true;
    }
    for char in line.chars() {
        units += char.len_utf16() as u32;
        if units == position.character {
            return true;
        }
        if units > position.character {
            return false;
        }
    }
    false
}

struct Offer {
    editor: String,
    ticket: DocumentTicket,
    item: Value,
    shown: bool,
    accepted_length: u32,
    accepted: bool,
}

pub struct Session {
    id: u64,
    rpc: Arc<RpcClient>,
    root: PathBuf,
    documents: AsyncMutex<Documents>,
    inflight: Mutex<HashMap<String, u64>>,
    offers: Mutex<HashMap<String, Offer>>,
    status: Arc<Mutex<Status>>,
    messages: Arc<Mutex<VecDeque<MessageRequest>>>,
    pending_sign_in: Mutex<Option<Value>>,
    /// `checkStatus` answer and the status generation it was read under. The
    /// settings card polls; only a status change or a sign-in step asks again.
    account: Mutex<Option<(u64, Value)>>,
    account_generation: Arc<std::sync::atomic::AtomicU64>,
    browser_sign_in: Arc<std::sync::atomic::AtomicBool>,
    process: Option<ManagedProcess>,
    events: tokio::task::JoinHandle<()>,
}

impl Session {
    pub async fn start<R, W>(
        reader: R,
        writer: W,
        process: Option<ManagedProcess>,
        root: &Path,
    ) -> Result<Self, String>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        static NEXT_SESSION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let session_id = NEXT_SESSION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (rpc, mut receive) = RpcClient::connect(reader, writer);
        let rpc = Arc::new(rpc);
        let status = Arc::new(Mutex::new(Status::default()));
        let messages = Arc::new(Mutex::new(VecDeque::<MessageRequest>::new()));
        let browser_sign_in = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let browser_request = browser_sign_in.clone();
        let server_messages = messages.clone();
        let account_generation = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let account_changed = account_generation.clone();
        let (replies, seen) = (rpc.clone(), status.clone());
        let events = tokio::spawn(async move {
            static NEXT_MESSAGE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
            while let Some(message) = receive.recv().await {
                let method = message.get("method").and_then(Value::as_str).unwrap_or("");
                let params = message.get("params");
                if method == "didChangeStatus" {
                    account_changed.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                    let text = |key: &str| params.and_then(|p| p.get(key)).and_then(Value::as_str);
                    *seen.lock().unwrap() = Status {
                        kind: text("kind").unwrap_or("").chars().take(32).collect(),
                        message: text("message").map(|m| m.chars().take(500).collect()),
                    };
                }
                // The server blocks on its own requests. Answer every one, and
                // grant no editor settings or document access. The device URL
                // is already handled by the caller before finishing sign-in.
                if let Some(id) = message.get("id").cloned() {
                    if method == "window/showMessageRequest" {
                        let params = params.unwrap_or(&Value::Null);
                        let actions: Vec<Value> = params.get("actions").and_then(Value::as_array)
                            .into_iter().flatten().filter(|a| a.get("title").and_then(Value::as_str).is_some())
                            .take(8).cloned().collect();
                        let public = AccountMessage { id: NEXT_MESSAGE.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                            message: params.get("message").and_then(Value::as_str).unwrap_or("").chars().take(2000).collect(),
                            actions: actions.iter().map(|a| a["title"].as_str().unwrap().chars().take(200).collect()).collect() };
                        let evicted = {
                            let mut queue = server_messages.lock().unwrap();
                            let evicted = if queue.len() >= 16 { queue.pop_front() } else { None };
                            queue.push_back(MessageRequest { public, rpc_id: id, actions });
                            evicted
                        };
                        if let Some(evicted) = evicted { let _ = replies.reply(evicted.rpc_id, Value::Null).await; }
                        continue;
                    }
                    let result = match method {
                        "workspace/configuration" => {
                            let items = params.and_then(|p| p.get("items")).and_then(Value::as_array);
                            json!(vec![Value::Null; items.map_or(0, Vec::len)])
                        }
                        "window/showDocument" => json!({"success":
                            params.and_then(|p| p.get("uri")).and_then(Value::as_str)
                                == Some("https://github.com/login/device")
                            && browser_request.swap(false, std::sync::atomic::Ordering::AcqRel)
                        }),
                        _ => Value::Null,
                    };
                    if replies.reply(id, result).await.is_err() {
                        break;
                    }
                }
            }
        });
        let session = Self {
            id: session_id,
            rpc,
            root: root.to_owned(),
            documents: AsyncMutex::default(),
            inflight: Mutex::default(),
            offers: Mutex::default(),
            status,
            messages,
            pending_sign_in: Mutex::default(),
            account: Mutex::default(),
            account_generation,
            browser_sign_in,
            process,
            events,
        };
        let uri = url::Url::from_directory_path(root).map_err(|_| "copilot_invalid_project")?;
        let version = env!("CARGO_PKG_VERSION");
        let initialized = session
            .request("initialize", json!({
                // The server has its own PID namespace. A host PID is not a
                // client there and makes LSP's parent monitor terminate it.
                // The pipe and ManagedProcess own lifetime instead.
                "processId": null,
                "workspaceFolders": [{"uri": uri.as_str(), "name": "project"}],
                "capabilities": {"workspace": {"workspaceFolders": true}, "window":{"showDocument":{"support":true}}},
                "initializationOptions": {
                    "editorInfo": {"name": crate::brand::DISPLAY, "version": version},
                    "editorPluginInfo": {"name": concat!(crate::app_name!(), " autocomplete"), "version": version},
                },
            }), INITIALIZE_TIMEOUT)
            .await?;
        if initialized.pointer("/serverInfo/version").and_then(Value::as_str) != Some(super::process::SERVER_VERSION) {
            return Err("copilot_version_mismatch".into());
        }
        session.notify("initialized", json!({})).await?;
        session
            .notify("workspace/didChangeConfiguration", json!({
                "settings": {"telemetry": {"telemetryLevel": "off"}},
            }))
            .await?;
        Ok(session)
    }

    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.rpc.next_id();
        self.rpc.request(id, method, params, timeout).await.map_err(error_code)
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.rpc.notify(method, params).await.map_err(error_code)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn alive(&self) -> bool {
        !self.rpc.is_closed() && self.process.as_ref().is_none_or(ManagedProcess::alive)
    }

    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }

    /// Returns `{id, insertText, range}` per candidate. The untouched server
    /// item stays here, keyed by that id, for shown/accepted feedback.
    pub async fn complete(&self, request: CompletionRequest<'_>) -> Result<Vec<Value>, String> {
        let (_sender, signal) = tokio::sync::watch::channel(false);
        self.complete_cancellable(request, signal).await
    }

    pub async fn complete_cancellable(&self, request: CompletionRequest<'_>, mut signal: tokio::sync::watch::Receiver<bool>) -> Result<Vec<Value>, String> {
        if !position_in(request.text, request.position) {
            return Err("copilot_invalid_position".into());
        }
        let (ticket, id) = {
            // Hold the lock across the writes: two editors' notifications must
            // reach the server in the order their versions were allocated.
            let mut documents = tokio::select! {
                biased;
                _ = super::requests::cancelled(&mut signal) => return Err("copilot_cancelled".into()),
                documents = self.documents.lock() => documents,
            };
            // Only the wait for the lock is cancellable. Abandoning the writes
            // would leave `Documents` ahead of the server, or tear a frame and
            // close the connection along with its RAM-only sign-in.
            let (ticket, notifications) = documents.synchronize(
                request.uri, request.editor, request.client_version, request.text, request.language, request.allow_text)?;
            for (method, params) in notifications {
                self.notify(method, params).await?;
            }
            (ticket, self.rpc.next_id())
        };
        if super::requests::is_cancelled(&signal) {
            return Err("copilot_cancelled".into());
        }
        let previous = self.inflight.lock().unwrap().insert(request.editor.to_owned(), id);
        if let Some(previous) = previous {
            let _ = self.rpc.cancel(previous).await;
        }
        self.offers.lock().unwrap().retain(|_, offer| offer.editor != request.editor);
        let params = json!({
            "textDocument": {"uri": ticket.uri, "version": ticket.server_version},
            "position": request.position,
            "context": {"triggerKind": if request.automatic { 2 } else { 1 }},
            "formattingOptions": {"tabSize": request.tab_size, "insertSpaces": request.insert_spaces},
        });
        // The request is polled first so it is registered and written before a
        // cancellation can name it, and it is never dropped: a frame abandoned
        // mid-write closes the connection. `cancel` resolves it instead.
        let pending = self.rpc.request(id, "textDocument/inlineCompletion", params, COMPLETION_TIMEOUT);
        tokio::pin!(pending);
        let reply = tokio::select! {
            biased;
            reply = &mut pending => reply,
            _ = super::requests::cancelled(&mut signal) => {
                let (_, reply) = tokio::join!(self.rpc.cancel(id), &mut pending);
                reply.and(Err(RpcError::Cancelled))
            }
        };
        {
            let mut inflight = self.inflight.lock().unwrap();
            if inflight.get(request.editor) == Some(&id) {
                inflight.remove(request.editor);
            }
        }
        let reply = reply.map_err(error_code)?;
        if !self.documents.lock().await.current(&ticket) {
            return Err("copilot_stale_document".into());
        }
        let items = reply.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut offers = self.offers.lock().unwrap();
        Ok(items.into_iter().take(MAX_ITEMS).enumerate().filter_map(|(index, item)| {
            let text = item.get("insertText")?.as_str()?.to_owned();
            let candidate = format!("{}:{id}:{index}", self.id);
            let result = json!({"id": candidate, "insertText": text, "range": item.get("range")});
            offers.insert(candidate, Offer { editor: request.editor.to_owned(), ticket: ticket.clone(), item,
                shown: false, accepted_length: 0, accepted: false });
            Some(result)
        }).collect())
    }

    pub async fn cancel(&self, editor: &str) {
        let id = self.inflight.lock().unwrap().remove(editor);
        if let Some(id) = id {
            let _ = self.rpc.cancel(id).await;
        }
    }

    /// Hidden pane, closed tab, provider change: the server forgets the text.
    pub async fn close_editor(&self, editor: &str) {
        self.cancel(editor).await;
        self.offers.lock().unwrap().retain(|_, offer| offer.editor != editor);
        let closed = self.documents.lock().await.close_editor(editor);
        for params in closed {
            let _ = self.notify("textDocument/didClose", params).await;
        }
    }

    async fn offered(&self, editor: &str, candidate: &str) -> Option<Value> {
        let (ticket, item) = {
            let offers = self.offers.lock().unwrap();
            let offer = offers.get(candidate).filter(|offer| offer.editor == editor)?;
            (offer.ticket.clone(), offer.item.clone())
        };
        self.documents.lock().await.current(&ticket).then_some(item)
    }

    pub async fn shown(&self, editor: &str, candidate: &str) -> Result<(), String> {
        let Some(item) = self.offered(editor, candidate).await else { return Ok(()); };
        {
            let mut offers = self.offers.lock().unwrap();
            let Some(offer) = offers.get_mut(candidate) else { return Ok(()); };
            if offer.shown || offer.accepted { return Ok(()); }
            offer.shown = true;
        }
        self.notify("textDocument/didShowCompletion", json!({"item": item})).await
    }

    /// `accepted_length` counts UTF-16 units of the original `insertText`;
    /// `None` is the full acceptance, reported once through the item's command.
    pub async fn accepted(&self, editor: &str, candidate: &str, accepted_length: Option<u32>) -> Result<(), String> {
        let Some(item) = self.offered(editor, candidate).await else { return Ok(()); };
        {
            let mut offers = self.offers.lock().unwrap();
            let Some(offer) = offers.get_mut(candidate) else { return Ok(()); };
            if offer.accepted { return Ok(()); }
            if let Some(length) = accepted_length {
                let text = item.get("insertText").and_then(Value::as_str).unwrap_or("");
                let mut boundary = 0;
                let valid = length == 0 || text.chars().any(|ch| { boundary += ch.len_utf16() as u32; boundary == length });
                if length <= offer.accepted_length || !valid { return Ok(()); }
                offer.accepted_length = length;
            } else { offer.accepted = true; }
        }
        if let Some(accepted_length) = accepted_length {
            return self.notify("textDocument/didPartiallyAcceptCompletion",
                json!({"item": item, "acceptedLength": accepted_length})).await;
        }
        self.offers.lock().unwrap().remove(candidate);
        let Some(command) = item.get("command") else { return Ok(()); };
        self.request("workspace/executeCommand", json!({
            "command": command.get("command"), "arguments": command.get("arguments"),
        }), ACCOUNT_TIMEOUT).await.map(|_| ())
    }

    pub async fn account(&self) -> Result<Value, String> {
        let generation = self.account_generation.load(std::sync::atomic::Ordering::Acquire);
        if let Some((_, account)) = self.account.lock().unwrap().as_ref().filter(|(seen, _)| *seen == generation) {
            return Ok(account.clone());
        }
        let reply = self.request("checkStatus", json!({}), ACCOUNT_TIMEOUT).await?;
        let account = json!({"status": reply.get("status"), "user": reply.get("user")});
        // Filed under the generation it was asked in: a change that raced the
        // reply makes the next poll ask again.
        *self.account.lock().unwrap() = Some((generation, account.clone()));
        Ok(account)
    }

    fn account_changed(&self) {
        self.account_generation.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    }

    /// Step one of the device flow. The finishing command stays in the backend.
    pub async fn sign_in(&self) -> Result<Option<DeviceCode>, String> {
        self.browser_sign_in.store(false, std::sync::atomic::Ordering::Release);
        *self.pending_sign_in.lock().unwrap() = None;
        let reply = self.request("signIn", json!({}), ACCOUNT_TIMEOUT).await?;
        let text = |key: &str| reply.get(key).and_then(Value::as_str).map(str::to_owned);
        let Some(user_code) = text("userCode") else {
            return if matches!(reply.get("status").and_then(Value::as_str), Some("OK" | "AlreadySignedIn")) {
                Ok(None)
            } else { Err("copilot_server_error".into()) };
        };
        // Upstream's documented response need not contain verificationUri.
        let verification_uri = text("verificationUri").unwrap_or_else(|| "https://github.com/login/device".into());
        if verification_uri != "https://github.com/login/device" || user_code.len() > 64 || user_code.is_empty()
            || reply.pointer("/command/command").and_then(Value::as_str) != Some("github.copilot.finishDeviceFlow") {
            return Err("copilot_server_error".into());
        }
        *self.pending_sign_in.lock().unwrap() = reply.get("command").cloned();
        Ok(Some(DeviceCode { user_code, verification_uri }))
    }

    /// Step two: resolves once the user approved the code in their browser.
    pub async fn finish_sign_in(&self) -> Result<(), String> {
        let command = self.pending_sign_in.lock().unwrap().take().ok_or("copilot_no_sign_in")?;
        self.browser_sign_in.store(true, std::sync::atomic::Ordering::Release);
        let result = self.request("workspace/executeCommand", json!({
            "command": command.get("command"), "arguments": command.get("arguments"),
        }), SIGN_IN_TIMEOUT).await.map(|_| ());
        self.browser_sign_in.store(false, std::sync::atomic::Ordering::Release);
        self.account_changed();
        result
    }

    pub async fn sign_out(&self) -> Result<(), String> {
        let result = self.request("signOut", json!({}), ACCOUNT_TIMEOUT).await.map(|_| ());
        self.account_changed();
        result
    }

    pub fn account_messages(&self) -> Vec<AccountMessage> {
        self.messages.lock().unwrap().iter().map(|message| message.public.clone()).collect()
    }

    pub async fn answer_message(&self, id: u64, action: Option<usize>) -> Result<(), String> {
        let message = {
            let mut messages = self.messages.lock().unwrap();
            let Some(index) = messages.iter().position(|m| m.public.id == id) else { return Ok(()); };
            messages.remove(index).unwrap()
        };
        let result = action.and_then(|index| message.actions.get(index)).cloned().unwrap_or(Value::Null);
        self.rpc.reply(message.rpc_id, result).await.map_err(error_code)
    }

    pub fn stop(&self) {
        self.rpc.close();
        self.events.abort();
        if let Some(process) = &self.process {
            process.stop();
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Project id → running session. Revoked consent and app exit stop processes
/// here; a server that keeps dying is not restarted forever.
pub struct Sessions {
    entries: Mutex<HashMap<String, Arc<Session>>>,
    starts: Mutex<HashMap<String, VecDeque<Instant>>>,
    launching: AsyncMutex<()>,
    invalidated: tokio::sync::watch::Sender<Invalidations>,
}

/// One project's revocation must not cancel another project's launch.
#[derive(Default)]
struct Invalidations { all: u64, projects: HashMap<String, u64> }

impl Default for Sessions {
    fn default() -> Self {
        let (invalidated, _) = tokio::sync::watch::channel(Invalidations::default());
        Self { entries: Mutex::default(), starts: Mutex::default(), launching: AsyncMutex::default(), invalidated }
    }
}

pub fn sessions() -> &'static Sessions {
    static SESSIONS: OnceLock<Sessions> = OnceLock::new();
    SESSIONS.get_or_init(Sessions::default)
}

impl Sessions {
    fn allow_start(&self, project_id: &str, now: Instant) -> bool {
        let mut starts = self.starts.lock().unwrap();
        let recent = starts.entry(project_id.to_owned()).or_default();
        while recent.front().is_some_and(|at| now.duration_since(*at) > START_WINDOW) {
            recent.pop_front();
        }
        if recent.len() >= MAX_STARTS {
            return false;
        }
        recent.push_back(now);
        true
    }

    fn epoch(&self, project_id: &str) -> (u64, u64) {
        let seen = self.invalidated.borrow();
        (seen.all, seen.projects.get(project_id).copied().unwrap_or(0))
    }

    /// Resolves once this project, or everything, was stopped after `epoch`.
    async fn invalidated_since(&self, changes: &mut tokio::sync::watch::Receiver<Invalidations>, project_id: &str, epoch: (u64, u64)) {
        while changes.changed().await.is_ok() && self.epoch(project_id) == epoch {}
    }

    fn running(&self, project_id: &str, root: &Path) -> Option<Arc<Session>> {
        let mut entries = self.entries.lock().unwrap();
        let session = entries.get(project_id)?;
        if session.alive() && session.root() == root {
            return Some(session.clone());
        }
        session.stop();
        entries.remove(project_id);
        None
    }

    /// `root` is the directory `policy::authorize_project` just returned.
    pub async fn get_or_start(&self, project_id: &str, root: &Path) -> Result<Arc<Session>, String> {
        // A running project never queues behind another project's launch.
        if let Some(session) = self.running(project_id, root) {
            return Ok(session);
        }
        let mut changes = self.invalidated.subscribe();
        let epoch = self.epoch(project_id);
        let _launch = tokio::select! {
            biased;
            _ = self.invalidated_since(&mut changes, project_id, epoch) => return Err("copilot_cancelled".into()),
            guard = self.launching.lock() => guard,
        };
        if let Some(session) = self.running(project_id, root) {
            return Ok(session);
        }
        if !self.allow_start(project_id, Instant::now()) {
            return Err("copilot_restart_limit".into());
        }
        let (process, output, input) = ManagedProcess::launch(root)?;
        let session = tokio::select! {
            biased;
            _ = self.invalidated_since(&mut changes, project_id, epoch) => return Err("copilot_cancelled".into()),
            session = Session::start(output, input, Some(process), root) => Arc::new(session?),
        };
        // The settings command may invalidate just as initialization finishes.
        let mut entries = self.entries.lock().unwrap();
        if self.epoch(project_id) != epoch {
            session.stop();
            return Err("copilot_cancelled".into());
        }
        entries.insert(project_id.to_owned(), session.clone());
        Ok(session)
    }

    pub async fn existing(&self, project_id: &str) -> Option<Arc<Session>> {
        self.entries.lock().unwrap().get(project_id).cloned()
    }

    /// Consent withdrawn, provider changed, project closed or made remote.
    pub async fn stop(&self, project_id: &str) {
        let mut entries = self.entries.lock().unwrap();
        self.invalidated.send_modify(|seen| *seen.projects.entry(project_id.to_owned()).or_default() += 1);
        if let Some(session) = entries.remove(project_id) {
            session.stop();
        }
        self.starts.lock().unwrap().remove(project_id);
    }

    pub async fn stop_all(&self) {
        self.stop_all_now();
    }

    /// Called synchronously after a settings commit. No initialization lock or
    /// server reply can delay revocation; pending launches are cancelled too.
    pub fn stop_all_now(&self) {
        let mut entries = self.entries.lock().unwrap();
        self.invalidated.send_modify(|seen| seen.all += 1);
        super::requests::cancel_all();
        for (_, session) in entries.drain() {
            session.stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::rpc::{read_frame, write_frame};
    use super::*;
    use tokio::io::{duplex, split, BufReader, DuplexStream, ReadHalf, WriteHalf};

    struct Server {
        read: BufReader<ReadHalf<DuplexStream>>,
        write: WriteHalf<DuplexStream>,
    }

    impl Server {
        async fn next(&mut self) -> Value {
            read_frame(&mut self.read).await.unwrap()
        }
        async fn expect(&mut self, method: &str) -> Value {
            let message = self.next().await;
            assert_eq!(message["method"], method);
            message
        }
        async fn result(&mut self, id: &Value, result: Value) {
            write_frame(&mut self.write, &json!({"jsonrpc":"2.0", "id":id, "result":result})).await.unwrap();
        }
    }

    async fn connected() -> (Arc<Session>, Server) {
        let (client, server) = duplex(64 * 1024);
        let (read, write) = split(server);
        let mut server = Server { read: BufReader::new(read), write };
        let (read, write) = split(client);
        let root = std::env::temp_dir();
        let start = tokio::spawn(async move { Session::start(read, write, None, &root).await });
        let initialize = server.expect("initialize").await;
        assert_eq!(initialize["params"]["processId"], Value::Null);
        assert!(initialize["params"]["workspaceFolders"][0]["uri"].as_str().unwrap().starts_with("file:///"));
        server.result(&initialize["id"], json!({"capabilities": {}, "serverInfo":{"version":super::super::process::SERVER_VERSION}})).await;
        server.expect("initialized").await;
        server.expect("workspace/didChangeConfiguration").await;
        (Arc::new(start.await.unwrap().unwrap()), server)
    }

    fn request<'a>(editor: &'a str, version: u64, text: &'a str) -> CompletionRequest<'a> {
        CompletionRequest {
            uri: "file:///project/a.rs", editor, client_version: version, text, language: "rust", allow_text: false,
            position: super::super::documents::position(text), automatic: true, tab_size: 4, insert_spaces: true,
        }
    }

    #[test]
    fn caret_must_be_a_utf16_boundary_inside_its_line() {
        let at = |line, character| position_in("a😀\r\nxy", Position { line, character });
        assert!(at(0, 0) && at(0, 1) && at(0, 3) && at(1, 2));
        assert!(!at(0, 2), "inside the surrogate pair");
        assert!(!at(0, 4), "on the carriage return");
        assert!(!at(1, 3) && !at(2, 0));
    }

    #[tokio::test]
    async fn completion_keeps_server_items_behind_opaque_ids() {
        let (session, mut server) = connected().await;
        let worker = session.clone();
        let work = tokio::spawn(async move { worker.complete(request("main:1", 1, "fn a")).await });
        assert_eq!(server.expect("textDocument/didOpen").await["params"]["textDocument"]["text"], "fn a");
        server.expect("textDocument/didFocus").await;
        let call = server.expect("textDocument/inlineCompletion").await;
        assert_eq!(call["params"]["position"], json!({"line":0, "character":4}));
        assert_eq!(call["params"]["context"]["triggerKind"], 2);
        let command = json!({"command":"accept", "arguments":["secret-uuid"]});
        server.result(&call["id"], json!({"items":[{"insertText":"fn add()", "command":command}]})).await;
        let items = work.await.unwrap().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["insertText"], "fn add()");
        assert!(items[0].get("command").is_none());
        let id = items[0]["id"].as_str().unwrap().to_owned();

        session.shown("other:1", &id).await.unwrap(); // not this editor's offer
        session.shown("main:1", &id).await.unwrap();
        let shown = server.expect("textDocument/didShowCompletion").await;
        assert_eq!(shown["params"]["item"]["command"], command);
        session.accepted("main:1", &id, Some(3)).await.unwrap();
        assert_eq!(server.expect("textDocument/didPartiallyAcceptCompletion").await["params"]["acceptedLength"], 3);
        let worker = session.clone();
        let accepted = id.clone();
        let work = tokio::spawn(async move { worker.accepted("main:1", &accepted, None).await });
        let call = server.expect("workspace/executeCommand").await;
        assert_eq!(call["params"]["arguments"][0], "secret-uuid");
        server.result(&call["id"], Value::Null).await;
        work.await.unwrap().unwrap();
        session.accepted("main:1", &id, None).await.unwrap(); // reported once
        session.close_editor("main:1").await;
        server.expect("textDocument/didClose").await;
    }

    #[tokio::test]
    async fn newer_request_cancels_older_and_closing_makes_a_reply_stale() {
        let (session, mut server) = connected().await;
        let worker = session.clone();
        let first = tokio::spawn(async move { worker.complete(request("main:1", 1, "a")).await });
        server.expect("textDocument/didOpen").await;
        server.expect("textDocument/didFocus").await;
        let first_call = server.expect("textDocument/inlineCompletion").await;
        let worker = session.clone();
        let second = tokio::spawn(async move { worker.complete(request("main:1", 2, "ab")).await });
        server.expect("textDocument/didChange").await;
        server.expect("textDocument/didFocus").await;
        assert_eq!(server.expect("$/cancelRequest").await["params"]["id"], first_call["id"]);
        assert_eq!(first.await.unwrap(), Err("copilot_cancelled".into()));
        let second_call = server.expect("textDocument/inlineCompletion").await;
        session.close_editor("main:1").await;
        assert_eq!(second.await.unwrap(), Err("copilot_cancelled".into()));
        server.expect("$/cancelRequest").await;
        server.expect("textDocument/didClose").await;
        server.result(&second_call["id"], json!({"items":[{"insertText":"late"}]})).await;
    }

    #[tokio::test]
    async fn server_requests_are_answered_without_granting_anything() {
        let (session, mut server) = connected().await;
        write_frame(&mut server.write, &json!({"jsonrpc":"2.0", "id":"s1", "method":"workspace/configuration",
            "params":{"items":[{}, {}]}})).await.unwrap();
        let reply = server.next().await;
        assert_eq!((&reply["id"], &reply["result"]), (&json!("s1"), &json!([null, null])));
        write_frame(&mut server.write, &json!({"jsonrpc":"2.0", "id":7, "method":"window/showDocument",
            "params":{"uri":"https://example.invalid"}})).await.unwrap();
        assert_eq!(server.next().await["result"], json!({"success": false}));
        write_frame(&mut server.write, &json!({"jsonrpc":"2.0", "method":"didChangeStatus",
            "params":{"kind":"Warning", "message":"quota"}})).await.unwrap();
        write_frame(&mut server.write, &json!({"jsonrpc":"2.0", "id":8, "method":"unknown/request"})).await.unwrap();
        assert_eq!(server.next().await["result"], Value::Null);
        assert_eq!(session.status(), Status { kind: "Warning".into(), message: Some("quota".into()) });
    }

    #[tokio::test]
    async fn device_flow_keeps_its_finishing_command_in_the_backend() {
        let (session, mut server) = connected().await;
        assert_eq!(session.finish_sign_in().await, Err("copilot_no_sign_in".into()));
        let worker = session.clone();
        let work = tokio::spawn(async move { worker.sign_in().await });
        let call = server.expect("signIn").await;
        server.result(&call["id"], json!({"userCode":"AB-12",
            "command":{"command":"github.copilot.finishDeviceFlow", "arguments":[]}})).await;
        assert_eq!(work.await.unwrap().unwrap().unwrap().user_code, "AB-12");
        let worker = session.clone();
        let work = tokio::spawn(async move { worker.finish_sign_in().await });
        let call = server.expect("workspace/executeCommand").await;
        assert_eq!(call["params"]["command"], "github.copilot.finishDeviceFlow");
        write_frame(&mut server.write, &json!({"jsonrpc":"2.0", "id":"browser", "method":"window/showDocument",
            "params":{"uri":"https://github.com/login/device", "external":true}})).await.unwrap();
        assert_eq!(server.next().await["result"], json!({"success":true}));
        server.result(&call["id"], json!({"status":"OK"})).await;
        work.await.unwrap().unwrap();

        let worker = session.clone();
        let work = tokio::spawn(async move { worker.sign_in().await });
        let call = server.expect("signIn").await;
        server.result(&call["id"], json!({"userCode":"AB-12", "verificationUri":"https://example.invalid/x"})).await;
        assert_eq!(work.await.unwrap(), Err("copilot_server_error".into()));
    }

    #[tokio::test]
    async fn unauthenticated_and_dead_servers_report_coarse_codes() {
        let (session, mut server) = connected().await;
        let worker = session.clone();
        let work = tokio::spawn(async move { worker.complete(request("main:1", 1, "a")).await });
        server.expect("textDocument/didOpen").await;
        server.expect("textDocument/didFocus").await;
        let call = server.expect("textDocument/inlineCompletion").await;
        write_frame(&mut server.write, &json!({"jsonrpc":"2.0", "id":call["id"],
            "error":{"code":1000, "message":"token detail that must not travel"}})).await.unwrap();
        assert_eq!(work.await.unwrap(), Err("copilot_not_signed_in".into()));
        drop(server);
        assert_eq!(session.complete(request("main:1", 2, "ab")).await, Err("copilot_server_closed".into()));
        assert!(!session.alive());
    }

    #[tokio::test]
    async fn cancellation_while_waiting_to_sync_never_sends_a_document() {
        let (session, mut server) = connected().await;
        let guard = session.documents.lock().await;
        let (cancel, signal) = tokio::sync::watch::channel(false);
        let worker = session.clone();
        let work = tokio::spawn(async move { worker.complete_cancellable(request("window:1", 1, "private"), signal).await });
        drop(cancel);
        assert_eq!(work.await.unwrap(), Err("copilot_cancelled".into()));
        drop(guard);
        assert!(tokio::time::timeout(Duration::from_millis(20), server.next()).await.is_err());
    }

    #[tokio::test]
    async fn policy_invalidation_cancels_inflight_work_and_clears_sessions_immediately() {
        let (session, mut server) = connected().await;
        let registry = Sessions::default();
        registry.entries.lock().unwrap().insert("project".into(), session.clone());
        let worker = session.clone();
        let work = tokio::spawn(async move { worker.complete(request("window:1", 1, "private")).await });
        server.expect("textDocument/didOpen").await;
        server.expect("textDocument/didFocus").await;
        server.expect("textDocument/inlineCompletion").await;
        registry.stop_all_now();
        assert!(!session.alive());
        assert!(registry.existing("project").await.is_none());
        assert_eq!(work.await.unwrap(), Err("copilot_server_closed".into()));
    }

    #[tokio::test]
    async fn billing_message_waits_for_the_users_chosen_action() {
        let (session, mut server) = connected().await;
        write_frame(&mut server.write, &json!({"jsonrpc":"2.0", "id":"billing", "method":"window/showMessageRequest",
            "params":{"message":"Quota reached", "actions":[{"title":"Manage plan", "opaque":17}]}})).await.unwrap();
        // A later request confirms the event loop has processed the billing one.
        write_frame(&mut server.write, &json!({"jsonrpc":"2.0", "id":"barrier", "method":"unknown/request"})).await.unwrap();
        assert_eq!(server.next().await["id"], "barrier");
        let messages = session.account_messages();
        assert_eq!(messages[0].message, "Quota reached");
        assert_eq!(messages[0].actions, vec!["Manage plan"]);
        session.answer_message(messages[0].id, Some(0)).await.unwrap();
        let answer = server.next().await;
        assert_eq!(answer["id"], "billing");
        assert_eq!(answer["result"], json!({"title":"Manage plan","opaque":17}));
        assert!(session.account_messages().is_empty());
    }

    #[tokio::test]
    async fn wrong_server_version_fails_before_opening_any_document() {
        let (client, server) = duplex(4096);
        let (read, write) = split(client);
        let (read_server, write_server) = split(server);
        let mut server = Server { read: BufReader::new(read_server), write: write_server };
        let work = tokio::spawn(async move { Session::start(read, write, None, &std::env::temp_dir()).await });
        let initialize = server.expect("initialize").await;
        server.result(&initialize["id"], json!({"serverInfo":{"version":"0.0.1"}})).await;
        assert!(matches!(work.await.unwrap(), Err(error) if error == "copilot_version_mismatch"));
    }

    /// The real pinned server inside the real fence; needs an installation:
    /// `TABTIVITY_COPILOT_INSTALL=/dir cargo test --lib copilot -- --ignored`.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore]
    async fn fenced_server_initializes_and_refuses_unauthenticated_completion() {
        let install = std::env::var(crate::app_env!("COPILOT_INSTALL")).expect(crate::app_env!("COPILOT_INSTALL"));
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        std::fs::write(root.join("a.py"), "def square(x):\n    return ").unwrap();
        let (process, output, input) = ManagedProcess::launch_installed(Path::new(&install), &root).unwrap();
        let session = Session::start(output, input, Some(process), &root).await.unwrap();
        assert!(session.alive());
        let uri = url::Url::from_file_path(root.join("a.py")).unwrap();
        let text = "def square(x):\n    return ";
        let result = session.complete(CompletionRequest {
            uri: uri.as_str(), editor: "main:1", client_version: 1, text, language: "python", allow_text: false,
            position: super::super::documents::position(text), automatic: false, tab_size: 4, insert_spaces: true,
        }).await;
        assert_eq!(result, Err("copilot_not_signed_in".into()));
        session.stop();
        assert!(!session.alive());
    }

    #[tokio::test]
    async fn polling_the_account_asks_the_server_only_after_a_status_change() {
        let (session, mut server) = connected().await;
        let worker = session.clone();
        let work = tokio::spawn(async move { worker.account().await });
        let call = server.expect("checkStatus").await;
        server.result(&call["id"], json!({"status":"OK", "user":"octo"})).await;
        assert_eq!(work.await.unwrap().unwrap()["user"], "octo");
        assert_eq!(session.account().await.unwrap()["user"], "octo"); // no second call
        write_frame(&mut server.write, &json!({"jsonrpc":"2.0", "method":"didChangeStatus",
            "params":{"kind":"Error"}})).await.unwrap();
        write_frame(&mut server.write, &json!({"jsonrpc":"2.0", "id":"barrier", "method":"unknown/request"})).await.unwrap();
        assert_eq!(server.next().await["id"], "barrier");
        let worker = session.clone();
        let work = tokio::spawn(async move { worker.account().await });
        let call = server.expect("checkStatus").await;
        server.result(&call["id"], json!({"status":"NotSignedIn"})).await;
        assert_eq!(work.await.unwrap().unwrap()["status"], "NotSignedIn");
    }

    #[tokio::test]
    async fn stopping_one_project_leaves_another_projects_launch_alone() {
        let sessions = Sessions::default();
        let mut changes = sessions.invalidated.subscribe();
        let epoch = sessions.epoch("two");
        sessions.stop("one").await;
        let wait = sessions.invalidated_since(&mut changes, "two", epoch);
        tokio::pin!(wait);
        assert!(tokio::time::timeout(Duration::from_millis(20), &mut wait).await.is_err());
        sessions.stop("two").await;
        tokio::time::timeout(Duration::from_millis(100), &mut wait).await.unwrap();
        let mut changes = sessions.invalidated.subscribe();
        let epoch = sessions.epoch("one");
        sessions.stop_all_now();
        tokio::time::timeout(Duration::from_millis(100), sessions.invalidated_since(&mut changes, "one", epoch)).await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_resolves_the_request_without_abandoning_its_frame() {
        let (session, mut server) = connected().await;
        let (cancel, signal) = tokio::sync::watch::channel(false);
        let worker = session.clone();
        let work = tokio::spawn(async move { worker.complete_cancellable(request("window:1", 1, "a"), signal).await });
        server.expect("textDocument/didOpen").await;
        server.expect("textDocument/didFocus").await;
        let call = server.expect("textDocument/inlineCompletion").await;
        drop(cancel);
        assert_eq!(server.expect("$/cancelRequest").await["params"]["id"], call["id"]);
        assert_eq!(work.await.unwrap(), Err("copilot_cancelled".into()));
        assert!(session.alive());
    }

    #[test]
    fn a_crashing_server_is_not_restarted_forever() {
        let sessions = Sessions::default();
        let now = Instant::now();
        for _ in 0..MAX_STARTS {
            assert!(sessions.allow_start("one", now));
        }
        assert!(!sessions.allow_start("one", now));
        assert!(sessions.allow_start("two", now));
        assert!(sessions.allow_start("one", now + START_WINDOW + Duration::from_secs(1)));
    }
}
