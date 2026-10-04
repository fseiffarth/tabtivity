use crate::schema::{
    agent_prompts::ProjectAgentPrompt, AgentScheduleLastRun, AgentScheduleRule,
    ScheduledAgentPrompt,
};
use serde::{Deserialize, Serialize};

/// The cap on one control frame: every request on both local planes, every
/// admin answer, and anything read from a peer that has not yet been answered.
pub const MAX_CONTROL_MESSAGE: usize = 64 * 1024;
/// The cap on one desktop → sidecar *answer*, the only direction that carries
/// content rather than an instruction. At 64 KiB an ordinary answer did not
/// fit — a default 120-entry transcript, a board with long notes, a busy
/// calendar month — and the dropped frame read as a closed desktop. 16 MiB
/// holds the largest transcript the desktop will build (`MAX_LIMIT` 1000
/// entries of up to 12,000 characters, about 12 MB as ASCII) with room for the
/// JSON around it. The sidecar reads this much only from the desktop's own
/// same-user socket, on a connection it opened itself.
pub const MAX_DESKTOP_RESPONSE: usize = 16 * 1024 * 1024;
pub const MIN_COLS: u16 = 20;
pub const MAX_COLS: u16 = 400;
pub const MIN_ROWS: u16 = 5;
pub const MAX_ROWS: u16 = 200;
pub const MAX_INPUT_FRAME: usize = 64 * 1024;
pub const MAX_OUTPUT_QUEUE: usize = 1024 * 1024;
pub const TERMINAL_PROTOCOL: &str = crate::brand::TERMINAL_PROTOCOL;
/// The catalog truncates a tab label to this many characters when it
/// publishes one, so a rename that came back longer would silently disagree
/// with the row the phone is looking at. Rejected at the edge instead.
pub const MAX_TAB_LABEL: usize = 120;

/// The closed palette a tab colour comes from (#264), mirroring
/// `src/lib/theme/tabColors.ts` and `mobile-web/src/tabColors.ts` — both surfaces
/// resolve these ids to the same hex, and the sidecar validates against the
/// list rather than accepting a colour.
///
/// A named id, not a CSS value, is the whole point of the boundary here: what
/// crosses is one of nine words, so nothing a phone sends can reach a style
/// attribute as anything but a hue this build already knows.
pub const TAB_COLORS: [&str; 8] = [
    "blue", "orange", "green", "purple", "yellow", "red", "teal", "indigo",
];

/// A colour a phone named that is not in [`TAB_COLORS`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnknownTabColor;

/// Which side of the anchor tab a reordered tab lands on. A side rather than
/// an index: the phone lists a scope's tabs in whatever order it is sorting by
/// and never sees the layout groups underneath, so "before that one" is the
/// only instruction it can give that means the same thing on both screens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TabPlace {
    Before,
    After,
}

/// A phone-supplied tab colour, resolved to what may be stored: `Ok(Some(id))`
/// for a palette colour, `Ok(None)` for "clear it" (a `null` or empty body
/// field), and an error for anything else. Unknown ids are refused rather than
/// silently cleared: a phone asking for a colour this build does not have is a
/// version seam worth reporting, not a request to remove one.
pub fn clean_tab_color(raw: Option<&str>) -> Result<Option<String>, UnknownTabColor> {
    match raw.map(str::trim) {
        None | Some("") => Ok(None),
        Some(id) if TAB_COLORS.contains(&id) => Ok(Some(id.to_string())),
        Some(_) => Err(UnknownTabColor),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum CreateTabKind {
    Shell,
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateTabRequest {
    pub project_id: String,
    pub kind: CreateTabKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// An agent started in a linked worktree: the opaque id a
    /// [`DesktopResponse::LaunchOptions`] listed. The path never crosses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    /// A cloud session instead of a local agent: `"new"` or `"open"`
    /// (`src/lib/agents/cloudSessions.ts`). Never together with `worktree`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud: Option<String>,
    /// The task a `"new"` cloud session starts on, for CLIs that take it on
    /// their command line. Bounded by [`MAX_CLOUD_TASK`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    /// A sign-in tab instead of a session: the CLI's own login command, in
    /// the flow a phone can finish (`src/lib/agents/signInLaunch.ts`).
    /// `"default"`, or `"alternate"` for the CLI's other way in (Claude's
    /// Console account, Codex's browser redirect). Never with a worktree,
    /// cloud or task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sign_in: Option<String>,
    /// The agent tab whose CLI a sign-in is for, by tmux name, in place of
    /// `agent_id`. Set by the sidecar alone (`POST /api/v1/tabs/{id}/sign-in`);
    /// the phone's create route refuses a body carrying it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub like_tab: Option<String>,
    /// A local-model agent (#31bl): the opaque id [`MobileLocalLaunch`]
    /// listed, in place of `agent_id`. Alone — no mode, worktree, cloud or
    /// sign-in rides with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local: Option<String>,
    pub idempotency_key: String,
}

/// Longest cloud-session task a phone may send (characters) — the desktop's
/// `MAX_CLOUD_TASK` in `src/lib/agents/cloudSessions.ts`.
pub const MAX_CLOUD_TASK: usize = 4000;

impl CreateTabRequest {
    /// The shape rules the sidecar can check without the desktop: worktree
    /// and cloud are agent-only and exclusive, the action is a known one, and
    /// a task is plain text of bounded length that only a cloud launch carries.
    /// Whether the agent *has* that launch, and whether the worktree id is
    /// one the desktop listed, stays the desktop's to answer.
    pub fn launch_shape_ok(&self) -> bool {
        let agent = matches!(self.kind, CreateTabKind::Agent);
        if (self.worktree.is_some() || self.cloud.is_some()) && !agent {
            return false;
        }
        if self.worktree.is_some() && self.cloud.is_some() {
            return false;
        }
        if let Some(way) = &self.sign_in {
            if !agent
                || (way != "default" && way != "alternate")
                || self.worktree.is_some()
                || self.cloud.is_some()
                || self.task.is_some()
            {
                return false;
            }
        }
        if self.like_tab.is_some() && (self.sign_in.is_none() || self.agent_id.is_some()) {
            return false;
        }
        if let Some(id) = &self.local {
            if !agent
                || id.is_empty()
                || id.len() > 128
                || self.agent_id.is_some()
                || self.mode.is_some()
                || self.worktree.is_some()
                || self.cloud.is_some()
                || self.task.is_some()
                || self.sign_in.is_some()
                || self.like_tab.is_some()
            {
                return false;
            }
        }
        if let Some(id) = &self.worktree {
            if id.is_empty() || id.len() > 128 {
                return false;
            }
        }
        if let Some(action) = &self.cloud {
            if action != "new" && action != "open" {
                return false;
            }
        }
        if let Some(task) = &self.task {
            if self.cloud.is_none()
                || task.trim().is_empty()
                || task.chars().count() > MAX_CLOUD_TASK
                || task
                    .chars()
                    .any(|c| (c.is_control() && c != '\n' && c != '\t') || c == '\u{7f}')
            {
                return false;
            }
        }
        true
    }
}

/// One place an agent can start on the phone's ＋: a linked worktree, named
/// by its directory and branch. `id` is opaque; the path stays on the desktop.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MobileWorktree {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default)]
    pub main: bool,
}

/// One cloud launch an agent offers on the phone's ＋ (`agent_id` is the
/// catalog's opaque agent id). `task` → the phone asks for the task first.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MobileCloudLaunch {
    pub agent_id: String,
    pub action: String,
    #[serde(default)]
    pub task: bool,
}

/// The ＋ sheet's local-model group (#31bl): the model the desktop's "+"
/// drives and the agents it offers for it, under opaque ids. `ready` is false
/// until the model sits on the GPU; a start then loads it first. `caution`
/// marks an agent built for frontier models (`LocalDriverInfo::heavy_harness`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MobileLocalLaunch {
    pub model: String,
    #[serde(default)]
    pub ready: bool,
    #[serde(default)]
    pub agents: Vec<MobileLocalAgent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MobileLocalAgent {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub caution: bool,
}

/// One agent the phone's ＋ can sign in to (`agent_id` is the catalog's
/// opaque agent id). `signed_in` is `None` where Tabtivity cannot tell (a CLI
/// whose login it does not keep); `account` is the account the shared login
/// names, when it names one; `alternate` names the CLI's other way in
/// (`"console"`, `"browser"`) when it has one. `api_key` says the CLI starts
/// on a provider API key the desktop keeps (`agent_api_keys`) — a flag only:
/// no key and no provider name ever crosses. `api_budget_reached` says that
/// key's monthly budget is spent (or unset), so a new tab would be refused —
/// a flag only, no amount.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MobileSignInOption {
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signed_in: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alternate: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_budget_reached: Option<bool>,
}

/// Phone-editable schedule fields. Receipts and prefix commands are desktop-owned
/// and therefore are not accepted in a mutation body. The desktop bridge keeps
/// existing prefix commands when applying a phone update.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MobileScheduleInput {
    pub enabled: bool,
    pub message: String,
    pub rule: AgentScheduleRule,
}

/// Only the schedule fields the phone uses. The stored row's prefix commands
/// and agent session attribution stay in the desktop-control protocol.
#[derive(Debug, Clone, Serialize)]
pub struct MobileSchedule {
    pub id: String,
    pub enabled: bool,
    pub message: String,
    pub rule: AgentScheduleRule,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last: Option<AgentScheduleLastRun>,
}

impl From<ScheduledAgentPrompt> for MobileSchedule {
    fn from(schedule: ScheduledAgentPrompt) -> Self {
        Self {
            id: schedule.id,
            enabled: schedule.enabled,
            message: schedule.message,
            rule: schedule.rule,
            last: schedule.last,
        }
    }
}

/// A collected prompt's public fields. Its target is a desktop schedule
/// handle, never an id the browser API needs or accepts.
#[derive(Debug, Clone, Serialize)]
pub struct MobileCollectedPrompt {
    pub id: String,
    pub message: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

impl From<ProjectAgentPrompt> for MobileCollectedPrompt {
    fn from(prompt: ProjectAgentPrompt) -> Self {
        Self {
            id: prompt.id,
            message: prompt.message,
            created_at: prompt.created_at,
            updated_at: prompt.updated_at,
            tags: prompt.tags,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ScheduleMutation {
    Create {
        schedule: MobileScheduleInput,
    },
    Update {
        schedule_id: String,
        schedule: MobileScheduleInput,
    },
    Delete {
        schedule_id: String,
    },
}

/// Phone-editable fields of a project-collected prompt. Ids and timestamps are
/// desktop-owned.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MobilePromptInput {
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum PromptMutation {
    Create {
        prompt: MobilePromptInput,
    },
    Update {
        prompt_id: String,
        prompt: MobilePromptInput,
    },
    Delete {
        prompt_id: String,
    },
    /// Aim a collected prompt at one agent tab now. The desktop turns it into a
    /// one-time schedule at its *own* current minute, so the phone never has to
    /// reason about the desktop's clock, and delivery keeps the scheduler's
    /// idle gate, claim and receipt.
    Send {
        prompt_id: String,
        tmux_session: String,
    },
}

/// The deliberately small task surface exposed to a paired Mobile device.
/// Calendar/task ids remain host-generated opaque values; the phone never sees
/// ids from `calendar.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoCard {
    pub id: String,
    pub title: String,
    pub column: String,
    pub done: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub priority: u8,
    pub percent: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rank: Option<f64>,
    pub calendar_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub subtasks: Vec<TodoSubtask>,
}

/// A checklist row deliberately carries only the editable fields. Its id is
/// opaque exactly like the containing card's; the desktop resolves it against
/// the current task before writing calendar.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoSubtask {
    pub id: String,
    pub title: String,
    pub done: bool,
}

/// The editable half of a card. This is separate from [`TodoCard`] so derived
/// fields such as `done` cannot be forged by a phone request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TodoTaskInput {
    pub title: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
    pub priority: u8,
    pub percent: u8,
    pub column: String,
    pub calendar_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub subtasks: Vec<TodoSubtask>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoCalendar {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoProject {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoColumn {
    pub id: String,
    pub name: String,
    pub position: i64,
    pub done: bool,
    /// An archive column (`schema::calendar::TaskColumn::archived`): a resting
    /// place a card is filed into and left in. The phone's board carries its own
    /// "hide archived" switch, so it needs the flag rather than the column's
    /// *name* — the label is renameable and a rename must not change what a
    /// filter hides. `default` because the desktop bridge is the writer here and
    /// a desktop older than this field simply never sends it; the struct denies
    /// unknown fields, so a newer desktop's snapshot would be rejected wholesale
    /// without it.
    #[serde(default)]
    pub archived: bool,
    /// The intake column (`schema::calendar::TaskColumn::intake`): where a card
    /// with no home lands. The phone needs it for the same two things the desktop
    /// does — the column a new card is composed into, and where un-ticking a done
    /// card sends it — and it cannot be inferred from this list, because the board
    /// leads with the date columns and the intake one sits behind Doing. `default`
    /// for the reason `archived` documents above.
    #[serde(default)]
    pub intake: bool,
    /// The two columns a card's *deadline* decides
    /// (`schema::calendar::TaskColumn::{overdue,due_today}`). The phone needs
    /// them for the reason the desktop board does: between these two and the
    /// intake column a card's place is what its `due` says, so a move into one
    /// of them is refused rather than written and undone by the next snapshot.
    /// Without the flags the phone can only offer the move and then report the
    /// refusal as an error. `default` for the reason `archived` documents above.
    #[serde(default)]
    pub overdue: bool,
    #[serde(default)]
    pub due_today: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoBoardSnapshot {
    pub columns: Vec<TodoColumn>,
    pub tasks: Vec<TodoCard>,
    #[serde(default)]
    pub calendars: Vec<TodoCalendar>,
    #[serde(default)]
    pub projects: Vec<TodoProject>,
}

/// One alert row for Mobile: the same bounded timeline of urgent mail, upcoming
/// events and due tasks the desktop renders. Source ids stay desktop-side — the
/// only handles here are opaque and derived, and the one write they enable is
/// the strip's own ✓ (`AlertResolve`), which resolves a row and can delete
/// nothing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileAlertItem {
    pub kind: String,
    pub severity: String,
    pub title: String,
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    pub all_day: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minutes_away: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub days_away: Option<i64>,
    /// A card row's **opaque** task id — the same derived value the to-do board
    /// snapshot already hands this device, never `calendar.json`'s own id. It is
    /// here so a tapped card alert can open that card instead of dropping the
    /// reader at a board of forty, which is exactly the search the alert existed
    /// to save. Absent for every other kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// The row's **opaque** handle, minted by the desktop for this snapshot and
    /// resolvable only by it. It is what a phone hands back to press the strip's
    /// ✓ (`AlertResolve`) and it is not a widening of the boundary: it names a
    /// *row of this feed*, never the mail, event or card behind it, and the
    /// desktop resolves it by re-deriving the same handles over its own live
    /// feed — the pattern the mail routes already use with their page offset.
    /// Absent for a row the desktop could not mint one for, and such a row
    /// simply has no ✓ on the phone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alert_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileAlertsSnapshot {
    /// Mirrors the desktop Alerts switch. A disabled desktop feed is distinct
    /// from an enabled feed that simply has no current rows.
    pub enabled: bool,
    pub items: Vec<MobileAlertItem>,
}

/// One already-expanded calendar occurrence.  IDs are opaque, scoped to the
/// paired-device protocol, and are resolved only by the running desktop.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileCalendarEvent {
    pub id: String,
    pub calendar_id: String,
    pub occurrence_start: String,
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conference: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub recurring: bool,
}

/// A calendar row with an opaque id.  Sync/account metadata remains in the
/// desktop process; the mobile client can manage the same ordinary calendar
/// properties as the desktop sidebar.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileCalendarInfo {
    pub id: String,
    pub name: String,
    pub color: String,
    pub visible: bool,
    pub readonly: bool,
    /// A subscribed (ICS feed) calendar. Only the fact crosses: the feed URL
    /// routinely embeds a private token, and the phone only ever asked whether
    /// there was one.
    #[serde(default)]
    pub subscribed: bool,
    pub caldav: bool,
}

/// The editable event fields. Identity and CalDAV bookkeeping never cross the
/// mobile boundary; the desktop preserves them while applying an edit.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MobileCalendarEventInput {
    pub calendar_id: String,
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub title: String,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub conference: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum CalendarAction {
    CreateEvent {
        event: MobileCalendarEventInput,
    },
    UpdateEvent {
        event_id: String,
        event: MobileCalendarEventInput,
    },
    DeleteEvent {
        event_id: String,
    },
    CreateCalendar {
        name: String,
        color: String,
    },
    UpdateCalendar {
        calendar_id: String,
        name: String,
        color: String,
        visible: bool,
    },
    DeleteCalendar {
        calendar_id: String,
    },
}

/// A bounded month snapshot. `truncated` is explicit so a very busy month never
/// silently looks complete after the desktop-control message cap.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileCalendarSnapshot {
    /// `YYYY-MM`, echoed from the validated request.
    pub month: String,
    /// 0 = Sunday, 1 = Monday; mirrors the user's desktop calendar preference.
    pub week_start: u8,
    pub calendars: Vec<MobileCalendarInfo>,
    pub events: Vec<MobileCalendarEvent>,
    pub truncated: bool,
}

/// A deliberately narrower mail contract than the desktop client uses. Mobile
/// may browse the local index and read one message, but it receives no server
/// paths, link targets, attachment bytes, or mutation controls.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileMailFolder {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub unread: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileMailAccount {
    pub id: String,
    pub label: String,
    pub address: String,
    pub folders: Vec<MobileMailFolder>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileMailSender {
    pub name: Option<String>,
    pub address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileMailHeader {
    pub id: String,
    pub subject: String,
    pub sender: MobileMailSender,
    pub date: String,
    pub seen: bool,
    /// The IMAP `\\Flagged` star and `\\Answered` mark. Defaulted so a desktop
    /// that predates them still answers a folder request.
    #[serde(default)]
    pub flagged: bool,
    #[serde(default)]
    pub answered: bool,
    pub has_attachments: bool,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileMailAttachment {
    pub filename: String,
    pub mime: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "view", rename_all = "snake_case")]
pub enum MobileMailView {
    Overview {
        accounts: Vec<MobileMailAccount>,
        /// Whether the desktop currently accepts [`DesktopRequest::MailMark`]
        /// and [`DesktopRequest::MailReply`] from a phone. Both are desktop
        /// settings the sidecar cannot read; it only relays the answer so the
        /// phone can hide the controls instead of discovering a refusal.
        #[serde(default)]
        actions: bool,
        #[serde(default)]
        reply: bool,
    },
    Folder {
        folder: MobileMailFolder,
        messages: Vec<MobileMailHeader>,
        total: u32,
        offset: u32,
    },
    Message {
        message: MobileMailHeader,
        body: String,
        truncated: bool,
        attachments: Vec<MobileMailAttachment>,
    },
}

/// The only flag writes a phone may ask for. Delete and move are deliberately
/// absent: destructive from a pocketable device, and the desktop has undo
/// surfaces the phone lacks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MailMarkAction {
    Seen,
    Unseen,
    Flag,
    Unflag,
}

/// Longest reply body a phone may submit, in bytes. A phone reply is a short
/// answer typed on a small keyboard; anything longer belongs on the desktop.
pub const MAX_MAIL_REPLY_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum TodoAction {
    Create {
        task: TodoTaskInput,
    },
    Move {
        task_id: String,
        column: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<usize>,
    },
    Update {
        task_id: String,
        task: TodoTaskInput,
    },
    /// Tick or untick one card — completion *and* placement in a single edit,
    /// the desktop's `toggleTaskDone`. It is its own action rather than a `Move`
    /// into the Done column because a move is a placement and completion is not:
    /// the board refuses a placement its rules would immediately undo, so the
    /// phone's checkbox spoke the one dialect the board could not accept.
    Toggle {
        task_id: String,
    },
    Delete {
        task_id: String,
    },
    ColumnCreate {
        name: String,
    },
    ColumnRename {
        column_id: String,
        name: String,
    },
    ColumnMove {
        column_id: String,
        delta: i8,
    },
    ColumnDelete {
        column_id: String,
    },
}

/// One option of an agent's markup question (`services::markup_mcp::Choice`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MobileMarkupChoice {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// One question of an agent's markup ask, as the phone's markup card shows it
/// (`services::markup_mcp::Question`). `page` is 1-based; `quote` is words on
/// that page the phone's sealed frame looks for to pin the question.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MobileMarkupQuestion {
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    pub options: Vec<MobileMarkupChoice>,
    #[serde(default)]
    pub multi_select: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
}

/// An open ask of the markup questions MCP (`services::markup_mcp`). The
/// phone is told the file's leaf name, which the sidecar strips to a bare
/// leaf once more before it crosses, and — for the Focus banner — a sealed
/// listing row of a project file (`file_row`). `path` goes from the window to the
/// sidecar only: the sidecar always takes it out before the ask crosses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MobileMarkupAsk {
    /// The ask's random id (`ask-<hex>`), what an answer names.
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    /// Window → sidecar only: the project-relative path the ask is bound to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Sidecar → phone: the asked-about project file as the files drawer
    /// would row it, so the Focus banner can open it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_row: Option<MobileMarkupFile>,
    pub questions: Vec<MobileMarkupQuestion>,
}

/// A project file an ask is about, sealed as the files drawer seals its rows
/// (`files::entry`): its token, its folder's token (none at the root) and
/// the folder trail of names the phone keys its markup layer by.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MobileMarkupFile {
    pub token: String,
    pub name: String,
    pub kind: String,
    pub size: u64,
    pub modified: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    pub place: String,
}

/// One question's answer from the phone: option indices (0-based) and/or a
/// typed **Other…** text. The desktop checks it against the ask and builds the
/// prompt; the phone never does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MobileMarkupAnswer {
    #[serde(default)]
    pub options: Vec<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub other: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum DesktopRequest {
    Catalog {
        request_id: String,
        /// When supplied, include the desktop-derived status of this project's
        /// agent tabs. Tmux names stay inside the trusted desktop/sidecar link;
        /// the sidecar resolves them back onto its opaque public tab ids.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project_id: Option<String>,
    },
    /// Every mobile-eligible project's agent-tab statuses in one answer, for
    /// the phone's cross-project activity list. A `Catalog` per project would be
    /// one desktop round trip per project on every poll, and the phone's flat
    /// list has no use for the rest of a catalog: no agent menu, and no
    /// schedule summaries, which cost a backend call per agent tab.
    Activity {
        request_id: String,
    },
    /// The desktop's git dot for every mobile-eligible project — unstaged,
    /// staged-not-committed, committed-not-pushed — for the phone's project
    /// list. Read from what the desktop's own pills already probed, so the
    /// answer costs no git spawn; a project the desktop has not probed is left
    /// out and the phone shows no dot, as the desktop does.
    GitStates {
        request_id: String,
    },
    Activate {
        request_id: String,
        project_id: String,
    },
    Create {
        request_id: String,
        request: CreateTabRequest,
    },
    /// What the phone's ＋ can start an agent *in* for one project: its
    /// linked worktrees and its agents' cloud launches. Asked when the sheet
    /// opens rather than carried on every catalog poll — listing worktrees is
    /// a git call.
    LaunchOptions {
        request_id: String,
        project_id: String,
    },
    Todo {
        request_id: String,
    },
    Alerts {
        request_id: String,
    },
    /// Press one alert row's ✓. The phone carries no source ids, so the row is
    /// named by the opaque `alert_id` the snapshot published; the desktop
    /// resolves it against its own live feed and resolves the row the way that
    /// kind supports — a card is completed, a mail's local priority mark is
    /// cleared, a meeting is muted in the strip. Nothing here can delete a
    /// message, an appointment or a card (`lib/alertDone`).
    AlertResolve {
        request_id: String,
        alert_id: String,
    },
    Calendar {
        request_id: String,
        /// A validated `YYYY-MM` civil month. The desktop expands recurrence
        /// only across this month's six-week grid.
        month: String,
    },
    CalendarMutate {
        request_id: String,
        month: String,
        action: CalendarAction,
    },
    TodoMutate {
        request_id: String,
        action: TodoAction,
    },
    MailOverview {
        request_id: String,
    },
    MailFolder {
        request_id: String,
        folder_id: String,
        offset: u32,
    },
    MailMessage {
        request_id: String,
        folder_id: String,
        message_id: String,
        offset: u32,
    },
    /// Set or clear one flag on one message. Carries the same `offset` the
    /// read requests do, because the desktop resolves an opaque message id by
    /// re-reading exactly the page that issued it.
    MailMark {
        request_id: String,
        folder_id: String,
        message_id: String,
        offset: u32,
        action: MailMarkAction,
    },
    /// Reply to one message with plain text. The phone supplies **only** the
    /// body: the recipient, subject, and threading headers are derived by the
    /// desktop from its own copy of the original, so a paired phone can answer
    /// people who already wrote to the user and nobody else.
    MailReply {
        request_id: String,
        folder_id: String,
        message_id: String,
        offset: u32,
        body: String,
    },
    Schedules {
        request_id: String,
        project_id: String,
        tmux_session: String,
    },
    ScheduleMutate {
        request_id: String,
        project_id: String,
        tmux_session: String,
        action: ScheduleMutation,
    },
    /// Rename one agent tab. The label is the only thing the phone supplies;
    /// the tab is named by the same `project_id` + `tmux_session` pair the
    /// schedule requests use, so no key or path crosses the boundary.
    RenameTab {
        request_id: String,
        project_id: String,
        tmux_session: String,
        label: String,
    },
    /// Paint one tab — agent or shell — with a palette colour, or clear it with
    /// `None` (#264). Named by the same `project_id` + `tmux_session` pair the
    /// rename uses, and carrying a palette id rather than a colour, so nothing
    /// the phone sends can reach the window as raw CSS.
    ColorTab {
        request_id: String,
        project_id: String,
        tmux_session: String,
        #[serde(default)]
        color: Option<String>,
    },
    /// Move one tab — agent or shell — next to another inside the same scope,
    /// as the desktop Agents view's own drag reorder does. Both tabs are named
    /// by the `project_id` + `tmux_session` pair every other tab request uses,
    /// so what crosses is two tmux names and a side, never an index into a
    /// layout the phone cannot see. The order this permutes is the one the
    /// catalog publishes and the "native" sort reads.
    ReorderTab {
        request_id: String,
        project_id: String,
        tmux_session: String,
        anchor_tmux_session: String,
        place: TabPlace,
    },
    /// Close one tab — agent or shell — exactly as the desktop's own × does:
    /// non-destructively. The tab leaves the desktop's layout and its viewer
    /// dies; the tmux session behind it keeps running and stays reattachable
    /// from the desktop's Sessions view. Named by the same `project_id` +
    /// `tmux_session` pair the rename request uses, so no key or path crosses.
    CloseTab {
        request_id: String,
        project_id: String,
        tmux_session: String,
    },
    /// Reopen an agent tab closed in this project — the newest, or the one
    /// `closed_id` names (an opaque id from `Catalog::closed`) — on the resume
    /// args a restart would give it. Answered with `Created`, like a create;
    /// `nothing_to_reopen` when the desktop no longer holds it.
    ReopenTab {
        request_id: String,
        project_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        closed_id: Option<String>,
    },
    Prompts {
        request_id: String,
        project_id: String,
    },
    PromptMutate {
        request_id: String,
        project_id: String,
        action: PromptMutation,
    },
    /// The phone put this agent tab on screen (or took it off again). Nothing
    /// is read back: it stamps the desktop's "this output has been seen" mark
    /// for the tab, so a turn the user already watched on the phone stops
    /// being reported as `done` by the next catalog read. Addressed by the
    /// same `project_id` + `tmux_session` pair the other tab requests use.
    TabSeen {
        request_id: String,
        project_id: String,
        tmux_session: String,
    },
    /// The phone typed into this agent tab. Nothing is read back: it stamps the
    /// desktop's "this session was commanded" mark, which is what licenses the
    /// tab's later output to be classified as working or finished at all. The
    /// phone's keystrokes reach tmux through a client of the sidecar's own, so
    /// the desktop window never sees them and cannot stamp it itself. Carries no
    /// input — only that there *was* some — and is sent on the leading edge of a
    /// burst of typing rather than per keystroke.
    TabInput {
        request_id: String,
        project_id: String,
        tmux_session: String,
    },
    /// The phone's composer sent `message` to this agent tab. Keystrokes reach
    /// tmux through the sidecar's own client, so the desktop never sees the
    /// words; the phone knows them before they leave, and the desktop records
    /// them in the tab's prompt history — the one list of what a session was
    /// asked for an agent whose transcript Tabtivity does not read (OpenCode).
    TabPrompt {
        request_id: String,
        project_id: String,
        tmux_session: String,
        message: String,
    },
    /// The phone's composer sent `message` while this agent tab was at work.
    /// Instead of the words going into the CLI's own queue, the desktop holds
    /// them as a send-now schedule — delivered at the tab's next safe idle
    /// point, like the desktop's own Send now — so the phone can still edit
    /// them until then. Answered with `Held` and the rule's id.
    HoldPrompt {
        request_id: String,
        project_id: String,
        tmux_session: String,
        message: String,
    },
    /// Rewrite a prompt `HoldPrompt` holds. Refused with `held_gone` once the
    /// scheduler delivered it (or it is no longer this tab's), `held_busy`
    /// while a delivery of it is under way — an edit never re-creates a rule
    /// the agent already has.
    EditHeldPrompt {
        request_id: String,
        project_id: String,
        tmux_session: String,
        held_id: String,
        message: String,
    },
    /// Take back the last `/clear` of this agent tab: the desktop types the
    /// CLI's resume of the conversation that clear ended into the tab
    /// (`agent_tab_undo_clear`). The session id stays on the desktop; the
    /// answer is `Seen`, or `nothing_to_undo` once the session has moved on.
    UndoClear {
        request_id: String,
        project_id: String,
        tmux_session: String,
    },
    /// What one agent tab is doing, and what its CLI says about its own quota.
    /// Addressed by the same `project_id` + `tmux_session` pair the schedule and
    /// rename requests use, so no key, path or command crosses the boundary.
    /// `refresh` asks the desktop to run the CLI again instead of answering
    /// from its short-lived cache.
    AgentStatus {
        request_id: String,
        project_id: String,
        tmux_session: String,
        #[serde(default)]
        refresh: bool,
    },
    /// The stored conversation behind one agent tab — the CLI's own
    /// transcript, read by the desktop (`services::agent_transcript`) — for
    /// the phone's Focus view. Addressed like `AgentStatus`. `version` is the
    /// fingerprint the phone last saw, answered `unchanged` while the file has
    /// not moved; `limit` is how many of the newest turns to carry.
    /// `subagent` is the handle on one of its `agent` entries: that
    /// subagent's conversation is read instead.
    AgentTranscript {
        request_id: String,
        project_id: String,
        tmux_session: String,
        #[serde(default)]
        subagent: Option<String>,
        #[serde(default)]
        version: Option<String>,
        #[serde(default)]
        limit: Option<usize>,
    },
    /// What the desktop can hand the phone's composer as an image: the
    /// clipboard's image and the recent files of the screenshot and picture
    /// folders (`services::desktop_images`). Only opaque ids and labels come
    /// back; the project is named so an ineligible one is refused before
    /// anything is read.
    DesktopImages {
        request_id: String,
        project_id: String,
    },
    /// Copy one of those images into the project's inbox — the same
    /// `.tabtivity/inbox/` drop box a file sent from the phone lands in — and
    /// answer with the project-relative reference. `image_id` is one the
    /// desktop listed; a path never crosses.
    AttachDesktopImage {
        request_id: String,
        project_id: String,
        image_id: String,
    },
    /// The agent tab's open markup question (`services::markup_mcp`), for the
    /// phone's markup card and Focus banner. `path` is the project-relative
    /// path of the file the phone's markup view shows — the sidecar resolved
    /// it from the view's files token or outbox leaf — and absent asks for
    /// every open ask of the tab. Answered `MarkupQuestions`; asks carry the
    /// file's leaf name, never its path.
    MarkupQuestions {
        request_id: String,
        project_id: String,
        tmux_session: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    /// Answer that ask: the desktop checks the answers, closes the ask, builds
    /// the prompt and queues it into the tab as a phone hold does. Answered
    /// `Seen`; `superseded`, `answered`, `gone` or `invalid_answer` when the
    /// ask does not take it, `delivery_failed` when the prompt could not be
    /// queued and the ask is open again, `not_delivered` when it could not be
    /// reopened either.
    MarkupAnswer {
        request_id: String,
        project_id: String,
        tmux_session: String,
        ask_id: String,
        answers: Vec<MobileMarkupAnswer>,
    },
    /// **Answer in chat instead**: close the ask without an answer. Answered
    /// `Seen`; idempotent.
    MarkupDismiss {
        request_id: String,
        project_id: String,
        tmux_session: String,
        ask_id: String,
    },
    /// The owner wrote a slice with no window answering (headless owner
    /// plan, H3) and a window is open after all: re-read it. `slices` names
    /// what moved — `workspace` (the scope's tab set; `project_id` is the raw
    /// scope id), `projects` (the registry), `calendar` (the board and the
    /// month), `schedules`, `prompts`. Answered `Seen`; never awaited by the
    /// phone.
    Refresh {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project_id: Option<String>,
        #[serde(default)]
        slices: Vec<String>,
    },
}

impl DesktopRequest {
    pub fn request_id(&self) -> &str {
        match self {
            Self::Catalog { request_id, .. }
            | Self::Activity { request_id }
            | Self::GitStates { request_id }
            | Self::Activate { request_id, .. }
            | Self::Create { request_id, .. }
            | Self::LaunchOptions { request_id, .. }
            | Self::Todo { request_id }
            | Self::Alerts { request_id }
            | Self::AlertResolve { request_id, .. }
            | Self::Calendar { request_id, .. }
            | Self::CalendarMutate { request_id, .. }
            | Self::TodoMutate { request_id, .. }
            | Self::MailOverview { request_id }
            | Self::MailFolder { request_id, .. }
            | Self::MailMessage { request_id, .. }
            | Self::MailMark { request_id, .. }
            | Self::MailReply { request_id, .. }
            | Self::Schedules { request_id, .. }
            | Self::ScheduleMutate { request_id, .. }
            | Self::RenameTab { request_id, .. }
            | Self::ColorTab { request_id, .. }
            | Self::ReorderTab { request_id, .. }
            | Self::CloseTab { request_id, .. }
            | Self::ReopenTab { request_id, .. }
            | Self::Prompts { request_id, .. }
            | Self::PromptMutate { request_id, .. }
            | Self::TabSeen { request_id, .. }
            | Self::TabInput { request_id, .. }
            | Self::TabPrompt { request_id, .. }
            | Self::HoldPrompt { request_id, .. }
            | Self::EditHeldPrompt { request_id, .. }
            | Self::UndoClear { request_id, .. }
            | Self::AgentStatus { request_id, .. }
            | Self::AgentTranscript { request_id, .. }
            | Self::DesktopImages { request_id, .. }
            | Self::AttachDesktopImage { request_id, .. }
            | Self::MarkupQuestions { request_id, .. }
            | Self::MarkupAnswer { request_id, .. }
            | Self::MarkupDismiss { request_id, .. }
            | Self::Refresh { request_id, .. } => request_id,
        }
    }

    /// How long the sidecar waits for the desktop's answer to this request.
    ///
    /// A few requests outlive the control-message SLA for reasons of their
    /// own: a first message open may perform a bounded IMAP `BODY.PEEK`, a
    /// flag write or a reply talks to the IMAP/SMTP server before answering,
    /// and an agent status may spawn the agent's CLI in print mode to read its
    /// usage panel (`services::agent_usage::USAGE_TIMEOUT`). Everything else
    /// should still fail fast when the desktop is wedged.
    pub fn response_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(match self {
            Self::MailMessage { .. } | Self::MailMark { .. } => 35,
            Self::MailReply { .. } => 65,
            Self::AgentStatus { .. } => 25,
            // Rides on the project list, which answers without the desktop:
            // a wedged window must not hold that list up for long.
            Self::GitStates { .. } => 3,
            // Polled every few seconds while a markup view or the Focus chat
            // is on screen; a wedged window just shows no card.
            Self::MarkupQuestions { .. } => 3,
            _ => 10,
        })
    }

    /// The desktop's own deadline for producing that answer. Always below
    /// [`Self::response_timeout`], so a handler that overruns is reported as a
    /// stated failure rather than as a socket that died under the sidecar.
    pub fn desktop_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(match self {
            Self::MailMessage { .. } | Self::MailMark { .. } => 30,
            Self::MailReply { .. } => 60,
            Self::AgentStatus { .. } => 20,
            Self::GitStates { .. } | Self::MarkupQuestions { .. } => 2,
            _ => 8,
        })
    }

    /// Whether the desktop changes its own state to answer this — the requests
    /// the window queues per domain (`mutationDomain` in
    /// `MobileBridgeHost.tsx`; `MobileMutationList.test.ts` holds the two
    /// lists in step). Once the window has answered one of these the change is
    /// made, so an answer that cannot be relayed must not read as a failed
    /// write (`admin::write_desktop_response`). No wildcard arm: a new request
    /// has to be placed on one side or the other.
    pub fn is_mutation(&self) -> bool {
        match self {
            Self::Activate { .. }
            | Self::Create { .. }
            | Self::AlertResolve { .. }
            | Self::CalendarMutate { .. }
            | Self::TodoMutate { .. }
            | Self::MailMark { .. }
            | Self::MailReply { .. }
            | Self::ScheduleMutate { .. }
            | Self::RenameTab { .. }
            | Self::ColorTab { .. }
            | Self::ReorderTab { .. }
            | Self::CloseTab { .. }
            | Self::ReopenTab { .. }
            | Self::PromptMutate { .. }
            | Self::HoldPrompt { .. }
            | Self::EditHeldPrompt { .. }
            | Self::MarkupAnswer { .. }
            | Self::MarkupDismiss { .. } => true,
            Self::Catalog { .. }
            | Self::Activity { .. }
            | Self::GitStates { .. }
            | Self::LaunchOptions { .. }
            | Self::Todo { .. }
            | Self::Alerts { .. }
            | Self::Calendar { .. }
            | Self::MailOverview { .. }
            | Self::MailFolder { .. }
            | Self::MailMessage { .. }
            | Self::Schedules { .. }
            | Self::Prompts { .. }
            | Self::TabSeen { .. }
            | Self::TabInput { .. }
            | Self::TabPrompt { .. }
            | Self::UndoClear { .. }
            | Self::AgentStatus { .. }
            | Self::AgentTranscript { .. }
            | Self::DesktopImages { .. }
            | Self::AttachDesktopImage { .. }
            | Self::MarkupQuestions { .. }
            | Self::Refresh { .. } => false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCatalogEntry {
    pub id: String,
    pub label: String,
    pub modes: Vec<String>,
    /// The agent `default_agent_cmd` names ("claude" when unset): what the
    /// phone starts when it needs one agent on its own, as Mark up's Submit
    /// does from a screen with no agent tab. Sent only when true; an older
    /// desktop flags none and the phone takes the first.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub default: bool,
}

/// A status already classified by the desktop activity store. This is an
/// internal desktop-control response, not the phone-facing API: the sidecar
/// maps `tmux_session` to an opaque tab id before serializing it to a client.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTabStatus {
    pub tmux_session: String,
    /// `working`, `question`, `interrupted`, or `done`.
    pub status: String,
    /// The model this tab's session shows on its own status line, read off
    /// the pane by the desktop and already composed for display
    /// (`lib/agents/agentModel`): the model, and the reasoning effort beside
    /// it where the session prints one. Falls back to the shortened id of the
    /// model the tab last answered with when no pane here has its screen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The session's own status line reads plan mode / a running `/goal`, as
    /// the desktop's PLAN and GOAL tab pills read it
    /// (`lib/agents/agentModel.screenModeMarks`). Sticky across an unreadable
    /// screen, like the model; absent means "not seen", not "off".
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub plan: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub goal: bool,
    /// Desktop wall clock (ms since the epoch) of the tab's last output while
    /// working, and of the last turn it finished. Both are session-only on the
    /// desktop and absent until the tab has done the thing they name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done_at: Option<u64>,
    /// How many subagents the tab's session has at work right now, as its
    /// transcript says (`AgentTranscript::running_agents`); zero when none
    /// or when its CLI does not record it.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub subagents: u32,
}

pub(crate) fn is_zero(value: &u32) -> bool {
    *value == 0
}

/// The same two readings for an agent tab with no status to report — one whose
/// finished turn has since been read. Without them the phone's "last working"
/// sort had nothing to order that tab by, and a turn just opened fell back to
/// its tab-bar place instead of keeping its spot among the finished ones.
/// Another internal desktop-control row keyed by tmux name.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTabTiming {
    pub tmux_session: String,
    /// The quiet tab's model, composed as `AgentTabStatus::model`: a session
    /// with no status still shows which model it will answer with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The quiet tab's plan / goal marks, as `AgentTabStatus::plan`/`goal`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub plan: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub goal: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done_at: Option<u64>,
    /// The quiet tab's subagents still at work, as `AgentTabStatus::subagents`:
    /// a background one runs on after the turn is over.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub subagents: u32,
}

/// An agent tab closed in the project, as the desktop remembers it for a
/// reopen: an opaque id minted at close (never the session id), the tab's label
/// and its agent CLI, and when it closed (desktop ms since the epoch).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClosedAgentTab {
    pub id: String,
    pub label: String,
    pub agent: String,
    #[serde(default)]
    pub closed_at: u64,
}

/// One agent tab's scheduled-prompt summary, already computed by the desktop
/// against its own clock and time zone. Like `AgentTabStatus` this is an
/// internal desktop-control row keyed by tmux name; the sidecar folds it onto
/// the opaque public tab before anything reaches the phone.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTabSchedules {
    pub tmux_session: String,
    pub total: u32,
    pub enabled: u32,
    /// Desktop-local `YYYY-MM-DDTHH:MM` of the next run, when one is due.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
    /// The soonest enabled schedules still to fire: their message, and `at`
    /// as the same desktop-local key as `next`. Absent from an older desktop.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub upcoming: Vec<AgentTabPrompt>,
}

/// One prompt an agent tab was given, read off the agent's own transcript by
/// the desktop (`agent_session::agent_session_recent_prompts`) — typed into the
/// terminal, pasted, sent from the phone or delivered by a schedule alike.
/// `at` is the transcript record's own ISO instant, absent when it carried none.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTabPrompt {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

/// One agent tab's newest prompts, newest last, bounded by the desktop before
/// they are sent. Another internal desktop-control row keyed by tmux name, like
/// `AgentTabStatus` and `AgentTabSchedules`: the sidecar folds it onto the
/// opaque public tab, and unlike a status it is published for a quiet tab too —
/// what a session was last asked is what the phone's list is read for.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTabPrompts {
    pub tmux_session: String,
    pub prompts: Vec<AgentTabPrompt>,
}

/// What one agent CLI answered when asked about its own quota.
///
/// The panel text travels **as the CLI printed it** and is parsed by the
/// reader (`mobile-web/src/terminal/usageReport.ts`). That is deliberate: the
/// format belongs to somebody else's CLI, so a change to it must degrade to a
/// block a person can still read rather than to an empty card. The phone's
/// "Terminal" half of the sheet shows exactly this text.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileAgentUsage {
    /// Display label of the CLI the panel came from ("Claude Code").
    pub label: String,
    /// False when this CLI has no usage readout reachable without a tab. The
    /// sheet then says so instead of showing an empty panel.
    pub supported: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
    /// Why there is no panel, in the CLI's own words where it had any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// True when this came from the desktop's short-lived cache rather than
    /// from a fresh run, so the reader can tell a stale figure from a live one.
    pub cached: bool,
}

/// Today's counters out of the desktop's own local rolling stats
/// (`usage_stats.json`), for the project the tab is in.
///
/// The grain is the store's, not the tab's, and the two fields differ in it:
/// `prompts` is counted per agent (`agent.prompt.<cmd>`), while the other three
/// are recorded for the project as a whole — one figure covering every agent tab
/// in it. Passed on as they are recorded and labelled that way on the phone,
/// rather than being silently attributed to the one agent the sheet is about.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MobileAgentTally {
    /// Prompts sent to *this agent* in this project today.
    pub prompts: u64,
    /// Seconds *any* agent tab in this project spent working today.
    pub worked_s: u64,
    /// Times any of them stopped to ask a decision.
    pub decisions: u64,
    /// Times any of them finished a turn.
    pub done: u64,
}

/// The agent-tab status sheet's whole payload: what the desktop knows about the
/// session, plus what its CLI says about the account behind it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileAgentStatus {
    /// `working`, `question`, `done` or `idle` — the same classification the
    /// catalog publishes, derived desktop-side from the tab's own output.
    pub state: String,
    /// The tab's label, and the agent behind it. Both are display strings the
    /// desktop already shows; neither is a command line.
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// The desktop's own name for the project, for the line the tally is about.
    pub project: String,
    pub today: MobileAgentTally,
    pub usage: MobileAgentUsage,
}

/// A file that landed in a project's `.tabtivity/inbox/`, as the phone sees it:
/// the stored name, the project-relative reference it puts after an `@`, and
/// the size. Mirrors `inbox::Stored` on the wire.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MobileInboxAttachment {
    pub name: String,
    pub reference: String,
    pub size: u64,
}

/// One project's git dot (`stores/gitDirty.ts`). `state` stays a string on
/// the wire so a desktop that learns another level cannot fail the whole
/// answer; [`git_dot`] keeps only the levels the phone knows.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectGitState {
    pub project_id: String,
    pub state: String,
}

/// The phone-facing spelling of a desktop git dot: untracked or unstaged
/// changes ▸ staged, not committed ▸ committed, not pushed ▸ a repo whose
/// `.git` went missing. Clean and anything unknown read as no dot.
pub fn git_dot(state: &str) -> Option<&'static str> {
    match state {
        "dirty" => Some("dirty"),
        "staged" => Some("staged"),
        "unpushed" => Some("unpushed"),
        "broken" => Some("broken"),
        _ => None,
    }
}

/// What the desktop answers a [`DesktopRequest`] with.
///
/// **This enum and everything it carries are deliberately NOT
/// `deny_unknown_fields`.** Strictness here guards nothing — the peer is Tabtivity
/// itself over a private socket in the state dir, not the paired browser, whose
/// every input type above stays strict — and it made the two halves of one app
/// version-fragile in exactly the direction this repo's dev workflow produces
/// daily: `src/` hot-reloads into a running window while the sidecar stays the
/// one compiled into the binary (`tauri dev` runs `--no-watch`; see AGENTS.md
/// and `npm run backend:stale`). A frontend that had learned to send one more
/// optional status field therefore handed the older sidecar a response it
/// refused *whole*, and the refusal is indistinguishable from a closed desktop:
/// the phone lost every agent tab from its Activity list and every "new agent
/// tab" button from a project — silently, and only for the projects whose tabs
/// happened to carry the new field.
///
/// The `#[serde(default)]`s below already buy the other direction (an older
/// desktop that does not send a field yet). Accepting fields we do not know is
/// the same bargain read forwards, and it costs nothing: an unknown field is
/// dropped, and the phone simply does without the column it names.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DesktopResponse {
    Catalog {
        agents: Vec<AgentCatalogEntry>,
        #[serde(default)]
        statuses: Vec<AgentTabStatus>,
        /// Per-tab scheduled-prompt summaries, in the same shape and for the
        /// same reason as `statuses`. Defaulted so a desktop that predates the
        /// field still answers a catalog request.
        #[serde(default)]
        schedules: Vec<AgentTabSchedules>,
        /// Per-tab recent prompts, same shape again. Defaulted like the two
        /// above, so an older desktop answers a catalog request with none and
        /// the phone's cards simply carry no prompt line.
        #[serde(default)]
        prompts: Vec<AgentTabPrompts>,
        /// Timings of the agent tabs `statuses` leaves out, so the phone keeps
        /// ordering them. Defaulted like the rest.
        #[serde(default)]
        timings: Vec<AgentTabTiming>,
        /// The project's agent tabs closed this desktop session, newest first,
        /// for the phone's "Recently closed" row. Defaulted like the rest.
        #[serde(default)]
        closed: Vec<ClosedAgentTab>,
        /// The project's git dot, as [`ProjectGitState::state`] spells it;
        /// absent when clean, not a repo, or never probed. Defaulted like the
        /// rest.
        #[serde(default)]
        git: Option<String>,
    },
    /// Answer to [`DesktopRequest::Activity`]: the agent tabs of every eligible
    /// project that are working, waiting on a decision, or done. Keyed by tmux
    /// name like `Catalog`'s `statuses`, and mapped onto opaque tab ids by the
    /// sidecar before anything reaches the phone.
    Activity {
        #[serde(default)]
        statuses: Vec<AgentTabStatus>,
        /// The same per-tab prompt rows the catalog carries, for the tabs this
        /// answer lists.
        #[serde(default)]
        prompts: Vec<AgentTabPrompts>,
    },
    /// Answer to [`DesktopRequest::GitStates`], keyed by the desktop's raw
    /// project id; the sidecar maps each onto its opaque public id.
    GitStates {
        #[serde(default)]
        states: Vec<ProjectGitState>,
    },
    Activated,
    Created {
        tmux_session: String,
    },
    /// Answers [`DesktopRequest::LaunchOptions`]. Both lists default, so an
    /// empty answer reads as "project folder only, no cloud".
    LaunchOptions {
        #[serde(default)]
        worktrees: Vec<MobileWorktree>,
        #[serde(default)]
        cloud: Vec<MobileCloudLaunch>,
        #[serde(default)]
        sign_in: Vec<MobileSignInOption>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        local: Option<MobileLocalLaunch>,
    },
    Todo {
        board: TodoBoardSnapshot,
    },
    Alerts {
        alerts: MobileAlertsSnapshot,
    },
    Calendar {
        calendar: MobileCalendarSnapshot,
    },
    Mail {
        mail: MobileMailView,
    },
    Schedules {
        schedules: Vec<ScheduledAgentPrompt>,
        time_zone: String,
        next_runs: std::collections::BTreeMap<String, String>,
    },
    /// The label the desktop actually stored, after its own trim — the phone
    /// renders that rather than the text it typed.
    Renamed {
        label: String,
    },
    /// The colour the desktop actually stored — `None` when the tab was cleared.
    /// Answered rather than assumed, so the phone's swatch ring follows the
    /// window instead of the tap.
    Colored {
        #[serde(default)]
        color: Option<String>,
    },
    /// Acknowledges a [`DesktopRequest::ReorderTab`]. Carries nothing: the
    /// desktop has already persisted its layout by the time it answers, so the
    /// order the phone reconciles against is the one the route reads back out
    /// of the catalog — the same authority every other tab row comes from.
    Reordered,
    /// Acknowledges a [`DesktopRequest::CloseTab`]. Carries nothing: the tab is
    /// simply gone from the desktop's layout, and the phone drops the row it
    /// just closed rather than waiting for the catalog to agree.
    Closed,
    Prompts {
        prompts: Vec<ProjectAgentPrompt>,
    },
    AgentStatus {
        report: MobileAgentStatus,
    },
    AgentTranscript {
        transcript: crate::services::agent_transcript::AgentTranscript,
    },
    /// Acknowledges a [`DesktopRequest::TabSeen`], [`DesktopRequest::TabInput`]
    /// or [`DesktopRequest::TabPrompt`] — and a delivered
    /// [`DesktopRequest::MarkupAnswer`] or a [`DesktopRequest::MarkupDismiss`].
    /// Carries nothing: the phone never waits on either, and the sidecar only
    /// needs to know the desktop took the report.
    Seen,
    /// A prompt the desktop holds for an agent tab (`HoldPrompt`,
    /// `EditHeldPrompt`): the id the phone edits it by.
    Held {
        held_id: String,
    },
    DesktopImages {
        images: Vec<crate::services::desktop_images::DesktopImage>,
    },
    /// A desktop image copied into the project inbox: the same three fields
    /// the phone's own upload gets back.
    Attached {
        attachment: MobileInboxAttachment,
    },
    /// Answers [`DesktopRequest::MarkupQuestions`]: the tab's open asks for
    /// the file shown (at most one today). A markup answer or dismissal is
    /// acknowledged with `Seen`.
    MarkupQuestions {
        #[serde(default)]
        asks: Vec<MobileMarkupAsk>,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AdminRequest {
    Status,
    PairingCode,
    Devices,
    Revoke { device_id: String },
    ForgetAll,
    Shutdown,
    /// A calendar reminder for every subscribed phone (`push.rs`). Answered
    /// `Ok` as soon as it is queued; delivery happens after, off the admin
    /// plane.
    Notify {
        kind: super::push::NoticeKind,
        title: String,
        body: String,
        tag: String,
    },
    /// An agent tab's turn edge, seen by the desktop. The sidecar resolves the
    /// tmux name through its own catalog — the name never reaches a phone —
    /// and stays quiet for a tab a phone is attached to.
    AgentTurn {
        tmux_session: String,
        status: super::push::AgentTurn,
        /// The prompt a finished turn answered, when the desktop could read
        /// it. Left out when absent, so a sidecar predating it still takes the
        /// edge.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum AdminResponse {
    Ok,
    Host {
        running: bool,
        port: u16,
        origin: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
    },
    PairingCode {
        code: String,
        expires_at: u64,
    },
    Devices {
        devices: Vec<AdminDevice>,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdminDevice {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub last_seen_at: Option<u64>,
    /// It holds a live session right now: signed in, not locked or timed out.
    /// Defaulted, so a sidecar from before the field still answers.
    #[serde(default)]
    pub online: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum TerminalControl {
    Ready,
    Resize { cols: u16, rows: u16 },
    Ping,
    Detached,
    /// Whether the phone's page is in front of someone. A pocketed phone keeps
    /// its socket — closing it would cost a full history replay on every app
    /// switch — so the socket being open says nothing about anyone watching;
    /// this does, and agent notices are held back only for a viewer that is
    /// (`TerminalRegistry::is_watched`). Sent only to a bridge that announced
    /// it (`TerminalEvent::Features`): an older one closes the socket on a
    /// control it does not know.
    Visibility { visible: bool },
}

/// Server → client control frames. The phone needs four things it cannot infer
/// from the byte stream: the tmux window geometry it must adopt (otherwise tmux
/// pans a narrow client across a wide window and silently crops every line),
/// an explicit replay boundary (so a reattach replaces the screen instead of
/// appending a second copy of it), the reason a socket is closing (so a
/// revoked device is told that, not "reconnecting…"), and an acknowledgement
/// per input frame: `Ack { seq }` says the phone's `seq`-th binary frame on
/// this socket has been written to the session's PTY. A half-open cellular
/// link keeps a socket OPEN while every byte sent into it is lost; the phone
/// marks a prompt whose frames were never acked as not delivered instead of
/// showing it as sent forever.
///
/// `Features` is how the vocabulary grows without breaking a phone bundle of
/// another age (in dev the bundle can be newer than the installed sidecar, and
/// a cached one older): the bridge says which optional controls it accepts in
/// its opening frames, and the phone sends one only after reading its name
/// there. A phone ignores an event type it does not know.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum TerminalEvent {
    Pong,
    Window { cols: u16, rows: u16 },
    Replay,
    Closing { reason: String, retry: bool },
    Ack { seq: u64 },
    /// `visibility`: this bridge accepts `TerminalControl::Visibility`.
    Features { visibility: bool },
}

impl TerminalEvent {
    pub fn to_frame(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{\"type\":\"pong\"}".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AgentTabPrompt, AgentTabPrompts, AgentTabSchedules, AgentTabStatus, AgentTabTiming, ClosedAgentTab, DesktopRequest,
        DesktopResponse, git_dot, MobileAlertItem,
        MobileAlertsSnapshot, MobileMarkupAnswer,
        MobileMailView, MobilePromptInput, MobileScheduleInput, PromptMutation, ScheduleMutation,
    };
    use crate::schema::AgentScheduleRule;
    use serde_json::json;

    #[test]
    fn catalog_statuses_stay_on_the_internal_control_plane() {
        let request = DesktopRequest::Catalog {
            request_id: "request-0".into(),
            project_id: Some("project-0".into()),
        };
        let request_json = serde_json::to_value(request).expect("serialize catalog request");
        assert_eq!(request_json["project_id"], "project-0");

        let response = DesktopResponse::Catalog {
            agents: vec![],
            statuses: vec![AgentTabStatus {
                tmux_session: concat!(crate::app_slug!(), "-project-0--agent-123456789").into(),
                status: "question".into(),
                model: Some("opus-4-1".into()),
                plan: true,
                goal: false,
                working_at: Some(1_700_000_000_000),
                done_at: None,
                subagents: 2,
            }],
            schedules: vec![AgentTabSchedules {
                tmux_session: concat!(crate::app_slug!(), "-project-0--agent-123456789").into(),
                total: 3,
                enabled: 2,
                next: Some("2026-09-03T09:00".into()),
                upcoming: vec![AgentTabPrompt {
                    text: "run the nightly benchmark".into(),
                    at: Some("2026-09-03T09:00".into()),
                }],
            }],
            prompts: vec![AgentTabPrompts {
                tmux_session: concat!(crate::app_slug!(), "-project-0--agent-123456789").into(),
                prompts: vec![AgentTabPrompt {
                    text: "fix the failing tests".into(),
                    at: Some("2026-09-17T08:12:00Z".into()),
                }],
            }],
            timings: vec![AgentTabTiming {
                tmux_session: concat!(crate::app_slug!(), "-project-0--agent-987654321").into(),
                model: None,
                plan: false,
                goal: true,
                working_at: None,
                done_at: Some(1_700_000_100_000),
                subagents: 0,
            }],
            closed: vec![ClosedAgentTab {
                id: "0b8f6c1e-closed".into(),
                label: "claude 2".into(),
                agent: "claude".into(),
                closed_at: 1_700_000_200_000,
            }],
            git: Some("unpushed".into()),
        };
        let response_json = serde_json::to_value(response).expect("serialize catalog response");
        assert_eq!(response_json["git"], "unpushed");
        // A closed tab crosses by its opaque id and label only.
        assert_eq!(response_json["closed"][0]["id"], "0b8f6c1e-closed");
        assert_eq!(response_json["closed"][0]["label"], "claude 2");
        assert_eq!(response_json["statuses"][0]["status"], "question");
        assert_eq!(response_json["statuses"][0]["model"], "opus-4-1");
        assert_eq!(response_json["statuses"][0]["working_at"], 1_700_000_000_000u64);
        assert!(response_json["statuses"][0].get("done_at").is_none());
        assert_eq!(response_json["schedules"][0]["enabled"], 2);
        assert_eq!(response_json["schedules"][0]["next"], "2026-09-03T09:00");
        assert_eq!(response_json["schedules"][0]["upcoming"][0]["text"], "run the nightly benchmark");
        // The prompt rows are keyed the same way and carry no id of their own:
        // the sidecar is what turns the tmux name into the phone's tab id.
        assert_eq!(
            response_json["prompts"][0]["tmux_session"],
            concat!(crate::app_slug!(), "-project-0--agent-123456789")
        );
        assert_eq!(
            response_json["prompts"][0]["prompts"][0]["text"],
            "fix the failing tests"
        );
        assert_eq!(response_json["timings"][0]["done_at"], 1_700_000_100_000u64);
        assert!(response_json["timings"][0].get("working_at").is_none());
        // The plan / goal marks ride only while on.
        assert_eq!(response_json["statuses"][0]["plan"], true);
        assert!(response_json["statuses"][0].get("goal").is_none());
        assert_eq!(response_json["timings"][0]["goal"], true);
        assert!(response_json["timings"][0].get("plan").is_none());
        // So does the count of subagents at work.
        assert_eq!(response_json["statuses"][0]["subagents"], 2);
        assert!(response_json["timings"][0].get("subagents").is_none());
    }

    /// A desktop one build ahead of this sidecar must cost the phone the field
    /// it does not know and nothing else. This used to cost it everything: the
    /// response was `deny_unknown_fields`, so one unrecognized status key made
    /// the whole frame unparseable, `desktop_call` returned an error the caller
    /// could not tell from a closed desktop, and a project's agent tabs and its
    /// "new agent tab" buttons both vanished from the phone with nothing said.
    #[test]
    fn a_newer_desktop_costs_the_phone_only_the_field_this_build_lacks() {
        let from_a_newer_desktop = serde_json::json!({
            "status": "catalog",
            "agents": [{ "id": "agent-0", "label": "Claude", "modes": [] }],
            "statuses": [{
                "tmux_session": concat!(crate::app_slug!(), "-project-0--agent-123456789"),
                "status": "working",
                "working_at": 1_700_000_000_000u64,
                "a_field_this_build_has_never_heard_of": "…",
            }],
            "schedules": [],
            "one_more_unknown_key": true,
        });
        let response: DesktopResponse =
            serde_json::from_value(from_a_newer_desktop).expect("decode a newer desktop's catalog");
        let DesktopResponse::Catalog {
            agents, statuses, ..
        } = response
        else {
            panic!("a catalog response must still decode as one");
        };
        assert_eq!(agents.len(), 1, "the agent menu survives the unknown field");
        assert_eq!(statuses[0].status, "working");
        assert_eq!(statuses[0].working_at, Some(1_700_000_000_000));
    }

    #[test]
    fn git_states_keep_only_the_levels_the_phone_knows() {
        let request = serde_json::to_value(DesktopRequest::GitStates {
            request_id: "request-2".into(),
        })
        .expect("serialize git states request");
        assert_eq!(request["type"], "git_states");
        // A newer desktop may name a level this sidecar never heard of; the
        // answer still decodes, and the phone gets no dot for that row.
        let response: DesktopResponse = serde_json::from_value(serde_json::json!({
            "status": "git_states",
            "states": [
                { "project_id": "a", "state": "dirty" },
                { "project_id": "b", "state": "diverged" },
                { "project_id": "c", "state": "clean" },
            ],
        }))
        .expect("decode git states");
        let DesktopResponse::GitStates { states } = response else {
            panic!("git states must decode as such");
        };
        let dots = states
            .iter()
            .map(|row| git_dot(&row.state))
            .collect::<Vec<_>>();
        assert_eq!(dots, vec![Some("dirty"), None, None]);
        for level in ["dirty", "staged", "unpushed", "broken"] {
            assert_eq!(git_dot(level), Some(level));
        }
        // A catalog from a desktop that predates the field has no dot.
        let older: DesktopResponse =
            serde_json::from_value(serde_json::json!({ "status": "catalog", "agents": [] }))
                .expect("decode an older catalog");
        assert!(matches!(older, DesktopResponse::Catalog { git: None, .. }));
    }

    #[test]
    fn a_reopen_names_its_closed_tab_or_takes_the_newest() {
        let newest = DesktopRequest::ReopenTab {
            request_id: "request-1".into(),
            project_id: "project-0".into(),
            closed_id: None,
        };
        let json = serde_json::to_value(&newest).expect("serialize reopen");
        assert_eq!(json["type"], "reopen_tab");
        assert!(json.get("closed_id").is_none());
        assert_eq!(newest.request_id(), "request-1");
        let named: DesktopRequest = serde_json::from_value(json!({
            "type": "reopen_tab",
            "request_id": "request-2",
            "project_id": "project-0",
            "closed_id": "0b8f6c1e-closed",
        }))
        .expect("decode a named reopen");
        let DesktopRequest::ReopenTab { closed_id, .. } = named else {
            panic!("a reopen decodes as one");
        };
        assert_eq!(closed_id.as_deref(), Some("0b8f6c1e-closed"));
    }

    /// The other half of the bargain: what the *phone* sends stays strict, so
    /// relaxing the desktop's side widened nothing at the browser boundary.
    #[test]
    fn what_the_phone_sends_is_still_refused_when_it_carries_unknown_fields() {
        let mut from_a_phone = serde_json::json!({
            "message": "hello",
            "rule": { "type": "once", "at": "2026-09-05T09:00" },
            "enabled": true,
        });
        serde_json::from_value::<MobileScheduleInput>(from_a_phone.clone())
            .expect("the body without the extra key is otherwise valid");
        from_a_phone["cwd"] = serde_json::json!("/home/someone");
        assert!(
            serde_json::from_value::<MobileScheduleInput>(from_a_phone).is_err(),
            "an unknown key from the paired browser must still be refused"
        );
    }

    #[test]
    fn activate_message_round_trips() {
        let request = DesktopRequest::Activate {
            request_id: "request-1".into(),
            project_id: "project-1".into(),
        };
        let json = serde_json::to_value(&request).expect("serialize activation request");
        assert_eq!(json["type"], "activate");
        assert_eq!(json["project_id"], "project-1");
        let restored: DesktopRequest =
            serde_json::from_value(json).expect("deserialize activation request");
        assert_eq!(restored.request_id(), "request-1");

        let response = serde_json::to_value(DesktopResponse::Activated)
            .expect("serialize activation response");
        assert_eq!(response["status"], "activated");
    }

    #[test]
    fn a_sent_prompt_carries_the_tab_pair_and_the_words() {
        let request = DesktopRequest::TabPrompt {
            request_id: "request-prompt".into(),
            project_id: "raw-project".into(),
            tmux_session: concat!(crate::app_slug!(), "-project-0--agent-123456789").into(),
            message: "fix the tests".into(),
        };
        assert_eq!(request.request_id(), "request-prompt");
        let json = serde_json::to_value(&request).expect("serialize prompt report");
        assert_eq!(json["type"], "tab_prompt");
        assert_eq!(json["message"], "fix the tests");
        let restored: DesktopRequest =
            serde_json::from_value(json).expect("deserialize prompt report");
        assert!(matches!(restored, DesktopRequest::TabPrompt { .. }));
    }

    #[test]
    fn held_prompts_carry_the_tab_pair_the_words_and_nothing_else() {
        let request = DesktopRequest::EditHeldPrompt {
            request_id: "request-held".into(),
            project_id: "raw-project".into(),
            tmux_session: concat!(crate::app_slug!(), "-project-0--agent-123456789").into(),
            held_id: "held-1".into(),
            message: "fix the tests, then the docs".into(),
        };
        assert_eq!(request.request_id(), "request-held");
        let json = serde_json::to_value(&request).expect("serialize held edit");
        assert_eq!(json["type"], "edit_held_prompt");
        assert_eq!(json["held_id"], "held-1");
        let mut hostile = json.clone();
        hostile["schedule_target_id"] = "must-not-cross".into();
        assert!(serde_json::from_value::<DesktopRequest>(hostile).is_err());
        let hold = serde_json::to_value(DesktopRequest::HoldPrompt {
            request_id: "request-hold".into(),
            project_id: "raw-project".into(),
            tmux_session: "raw-tmux".into(),
            message: "and the lint".into(),
        })
        .expect("serialize hold");
        assert_eq!(hold["type"], "hold_prompt");
        let answer = serde_json::to_value(DesktopResponse::Held { held_id: "held-1".into() })
            .expect("serialize held answer");
        assert_eq!(answer["status"], "held");
        assert_eq!(answer["held_id"], "held-1");
    }

    #[test]
    fn markup_questions_cross_by_tab_pair_and_answers_stay_strict() {
        let list = DesktopRequest::MarkupQuestions {
            request_id: "request-markup".into(),
            project_id: "raw-project".into(),
            tmux_session: "raw-tmux".into(),
            path: None,
        };
        assert_eq!(list.request_id(), "request-markup");
        let json = serde_json::to_value(&list).expect("serialize markup list");
        assert_eq!(json["type"], "markup_questions");
        // No path: the key is left out, not sent as null.
        assert_eq!(json.as_object().expect("object").len(), 4, "{json}");
        let shown = serde_json::to_value(DesktopRequest::MarkupQuestions {
            request_id: "r".into(),
            project_id: "p".into(),
            tmux_session: "t".into(),
            path: Some("docs/draft.pdf".into()),
        })
        .expect("serialize shown");
        assert_eq!(shown["path"], "docs/draft.pdf");
        // A read, polled: the short deadlines the project list's git dots use.
        assert!(!list.is_mutation());
        assert_eq!(list.response_timeout(), std::time::Duration::from_secs(3));
        assert_eq!(list.desktop_timeout(), std::time::Duration::from_secs(2));

        let answer = DesktopRequest::MarkupAnswer {
            request_id: "request-answer".into(),
            project_id: "raw-project".into(),
            tmux_session: "raw-tmux".into(),
            ask_id: "ask-0123456789abcdef".into(),
            answers: vec![
                MobileMarkupAnswer { options: vec![1], other: None },
                MobileMarkupAnswer { options: vec![], other: Some("colour".into()) },
            ],
        };
        assert!(answer.is_mutation());
        assert_eq!(answer.response_timeout(), std::time::Duration::from_secs(10));
        let json = serde_json::to_value(&answer).expect("serialize answer");
        assert_eq!(json["type"], "markup_answer");
        assert_eq!(json["answers"], serde_json::json!([{ "options": [1] }, { "options": [], "other": "colour" }]));
        let restored: DesktopRequest = serde_json::from_value(json.clone()).expect("round-trip answer");
        assert!(matches!(restored, DesktopRequest::MarkupAnswer { ref answers, .. } if answers.len() == 2));
        // Anything but the two fields is refused, as is a negative index.
        for bad in [
            serde_json::json!([{ "options": [1], "prompt": "typed by the phone" }]),
            serde_json::json!([{ "options": [-1] }]),
        ] {
            let mut hostile = json.clone();
            hostile["answers"] = bad;
            assert!(serde_json::from_value::<DesktopRequest>(hostile).is_err());
        }
        let mut hostile = json;
        hostile["schedule_target_id"] = "must-not-cross".into();
        assert!(serde_json::from_value::<DesktopRequest>(hostile).is_err());

        let dismiss = DesktopRequest::MarkupDismiss {
            request_id: "request-dismiss".into(),
            project_id: "raw-project".into(),
            tmux_session: "raw-tmux".into(),
            ask_id: "ask-0123456789abcdef".into(),
        };
        assert!(dismiss.is_mutation());
        assert_eq!(serde_json::to_value(&dismiss).expect("dismiss")["type"], "markup_dismiss");

        // The answer: a desktop that sent the view's `file` loses it here;
        // `path` reaches the sidecar only, which takes it out (host.rs).
        let response: DesktopResponse = serde_json::from_value(serde_json::json!({
            "status": "markup_questions",
            "asks": [{
                "id": "ask-0123456789abcdef",
                "file": "docs/paper/draft.pdf",
                "file_name": "draft.pdf",
                "questions": [{
                    "question": "Move the paragraph or the figure?",
                    "options": [{ "label": "The figure" }, { "label": "The paragraph", "description": "Above it" }],
                    "multi_select": true,
                    "page": 3,
                    "quote": "as shown in Figure 2",
                }],
            }],
        }))
        .expect("decode markup questions");
        let reencoded = serde_json::to_value(&response).expect("re-encode");
        assert_eq!(reencoded["asks"][0]["file_name"], "draft.pdf");
        assert!(reencoded["asks"][0].get("file").is_none(), "{reencoded}");
        assert_eq!(reencoded["asks"][0]["questions"][0]["multi_select"], true);
        assert_eq!(reencoded["asks"][0]["questions"][0]["page"], 3);
        let empty: DesktopResponse = serde_json::from_value(serde_json::json!({ "status": "markup_questions" })).expect("no asks");
        assert!(matches!(empty, DesktopResponse::MarkupQuestions { ref asks } if asks.is_empty()));
    }

    #[test]
    fn tab_seen_names_the_tab_the_way_every_other_tab_request_does() {
        let request = DesktopRequest::TabSeen {
            request_id: "request-seen".into(),
            project_id: "raw-project".into(),
            tmux_session: concat!(crate::app_slug!(), "-project-0--agent-123456789").into(),
        };
        assert_eq!(request.request_id(), "request-seen");
        let json = serde_json::to_value(&request).expect("serialize seen request");
        assert_eq!(json["type"], "tab_seen");
        // The pair the desktop resolves the tab by — and nothing else. No key,
        // path or command rides along on the "I looked at it" report.
        assert_eq!(json["project_id"], "raw-project");
        assert_eq!(json.as_object().expect("object").len(), 4);
        let restored: DesktopRequest =
            serde_json::from_value(json).expect("deserialize seen request");
        assert!(matches!(restored, DesktopRequest::TabSeen { .. }));

        let response = serde_json::to_value(DesktopResponse::Seen).expect("serialize seen response");
        assert_eq!(response["status"], "seen");
    }

    #[test]
    fn schedule_mutations_are_strict_and_keep_target_identity_internal() {
        let request = DesktopRequest::ScheduleMutate {
            request_id: "request-schedule".into(),
            project_id: "raw-project".into(),
            tmux_session: "raw-tmux".into(),
            action: ScheduleMutation::Create {
                schedule: MobileScheduleInput {
                    enabled: true,
                    message: "Review the build".into(),
                    rule: AgentScheduleRule::Daily {
                        time: "09:30".into(),
                    },
                },
            },
        };
        let value = serde_json::to_value(&request).expect("serialize schedule mutation");
        assert_eq!(value["type"], "schedule_mutate");
        assert_eq!(request.request_id(), "request-schedule");

        let mut hostile = value;
        hostile["action"]["schedule"]["schedule_target_id"] = "must-not-cross".into();
        assert!(serde_json::from_value::<DesktopRequest>(hostile).is_err());

        let response = serde_json::to_value(DesktopResponse::Schedules {
            schedules: vec![],
            time_zone: "Europe/Berlin".into(),
            next_runs: std::collections::BTreeMap::new(),
        })
        .expect("serialize schedules response");
        let encoded = response.to_string();
        assert!(!encoded.contains("raw-project"));
        assert!(!encoded.contains("raw-tmux"));
        assert!(!encoded.contains("schedule_target"));
    }

    #[test]
    fn prompt_mutations_are_strict_and_send_names_only_the_tmux_session() {
        let request = DesktopRequest::PromptMutate {
            request_id: "request-prompt".into(),
            project_id: "raw-project".into(),
            action: PromptMutation::Send {
                prompt_id: "prompt-1".into(),
                tmux_session: "raw-tmux".into(),
            },
        };
        let value = serde_json::to_value(&request).expect("serialize prompt mutation");
        assert_eq!(value["type"], "prompt_mutate");
        assert_eq!(value["action"]["type"], "send");
        assert_eq!(request.request_id(), "request-prompt");

        // A phone body may not smuggle a rule or a target onto a send/create.
        let mut hostile = value.clone();
        hostile["action"]["schedule_target_id"] = "must-not-cross".into();
        assert!(serde_json::from_value::<DesktopRequest>(hostile).is_err());
        let mut create = serde_json::to_value(&DesktopRequest::PromptMutate {
            request_id: "request-create".into(),
            project_id: "raw-project".into(),
            action: PromptMutation::Create {
                prompt: MobilePromptInput {
                    message: "Review the build".into(),
                },
            },
        })
        .expect("serialize create");
        create["action"]["prompt"]["id"] = "phone-picked".into();
        assert!(serde_json::from_value::<DesktopRequest>(create).is_err());

        let response = serde_json::to_value(DesktopResponse::Prompts { prompts: vec![] })
            .expect("serialize prompts response");
        assert_eq!(response["status"], "prompts");
    }

    #[test]
    fn mail_message_request_and_response_are_tagged() {
        let request = DesktopRequest::MailMessage {
            request_id: "request-2".into(),
            folder_id: "opaque-folder".into(),
            message_id: "opaque-message".into(),
            offset: 25,
        };
        let json = serde_json::to_value(&request).expect("serialize mail request");
        assert_eq!(json["type"], "mail_message");
        assert_eq!(json["offset"], 25);
        assert_eq!(request.request_id(), "request-2");

        let response = DesktopResponse::Mail {
            mail: MobileMailView::Message {
                message: super::MobileMailHeader {
                    id: "opaque-message".into(),
                    subject: "Hello".into(),
                    sender: super::MobileMailSender {
                        name: Some("Ada".into()),
                        address: "ada@example.test".into(),
                    },
                    date: "2026-08-25T12:00:00Z".into(),
                    seen: true,
                    flagged: false,
                    answered: false,
                    has_attachments: false,
                    preview: "Preview".into(),
                },
                body: "Body".into(),
                truncated: false,
                attachments: vec![],
            },
        };
        let json = serde_json::to_value(response).expect("serialize mail response");
        assert_eq!(json["status"], "mail");
        assert_eq!(json["mail"]["view"], "message");
    }

    #[test]
    fn alerts_are_a_display_only_snapshot() {
        let request = DesktopRequest::Alerts {
            request_id: "request-3".into(),
        };
        let json = serde_json::to_value(request).expect("serialize alerts request");
        assert_eq!(json["type"], "alerts");

        let response = DesktopResponse::Alerts {
            alerts: MobileAlertsSnapshot {
                enabled: true,
                items: vec![MobileAlertItem {
                    kind: "task".into(),
                    severity: "soon".into(),
                    title: "Ship mobile alerts".into(),
                    detail: crate::brand::DISPLAY.into(),
                    at: Some("2026-08-25T17:00".into()),
                    all_day: false,
                    minutes_away: Some(30),
                    days_away: Some(0),
                    task_id: Some("opaque-task".into()),
                    alert_id: Some("opaque-row".into()),
                }],
            },
        };
        let json = serde_json::to_value(response).expect("serialize alerts response");
        assert_eq!(json["status"], "alerts");
        assert_eq!(json["alerts"]["items"][0]["kind"], "task");
        assert!(json["alerts"]["items"][0].get("source").is_none());
        // The card reference that lets a tapped alert open its own card is the
        // board's own opaque id, so it stays the only task identity this device
        // ever holds.
        assert_eq!(json["alerts"]["items"][0]["task_id"], "opaque-task");
        // The row handle is the same kind of thing: derived, resolvable only by
        // the desktop, and the whole of what a phone sends back to press ✓.
        assert_eq!(json["alerts"]["items"][0]["alert_id"], "opaque-row");
    }

    #[test]
    fn an_alert_is_resolved_by_its_row_handle_and_nothing_else() {
        let request = DesktopRequest::AlertResolve {
            request_id: "request-3b".into(),
            alert_id: "opaque-row".into(),
        };
        let json = serde_json::to_value(request).expect("serialize alert resolve request");
        assert_eq!(json["type"], "alert_resolve");
        assert_eq!(json["alert_id"], "opaque-row");
        // No kind, no action, no source: what the ✓ does to a mail, a meeting or
        // a card is decided by the desktop from the row it resolves.
        assert!(json.get("kind").is_none());
        assert!(json.get("action").is_none());
    }

    #[test]
    fn calendar_snapshot_carries_opaque_event_identity() {
        let request = DesktopRequest::Calendar {
            request_id: "request-4".into(),
            month: "2026-08".into(),
        };
        let request_json = serde_json::to_value(request).expect("serialize calendar request");
        assert_eq!(request_json["type"], "calendar");
        assert_eq!(request_json["month"], "2026-08");

        let response = DesktopResponse::Calendar {
            calendar: super::MobileCalendarSnapshot {
                month: "2026-08".into(),
                week_start: 1,
                calendars: vec![super::MobileCalendarInfo {
                    id: "opaque-calendar".into(),
                    name: "Personal".into(),
                    color: "#7c6cff".into(),
                    visible: true,
                    readonly: false,
                    subscribed: false,
                    caldav: false,
                }],
                events: vec![super::MobileCalendarEvent {
                    id: "opaque-event".into(),
                    calendar_id: "opaque-calendar".into(),
                    occurrence_start: "2026-08-26T09:00".into(),
                    start: "2026-08-26T09:00".into(),
                    end: "2026-08-26T10:00".into(),
                    all_day: false,
                    title: "Planning".into(),
                    location: Some("Studio".into()),
                    color: "#7c6cff".into(),
                    status: None,
                    notes: None,
                    conference: None,
                    category: None,
                    recurring: false,
                }],
                truncated: false,
            },
        };
        let response_json = serde_json::to_value(response).expect("serialize calendar response");
        assert_eq!(response_json["status"], "calendar");
        assert_eq!(response_json["calendar"]["events"][0]["title"], "Planning");
        assert_eq!(response_json["calendar"]["events"][0]["id"], "opaque-event");
    }

    /// The terminal control plane, byte for byte as `mobile-web/src/terminal/
    /// protocol.ts` shapes it: every frame the phone sends decodes, nothing it
    /// does not name is accepted, and every server frame survives a round trip.
    #[test]
    fn a_calendar_row_says_subscribed_and_never_carries_its_feed_url() {
        let row = super::MobileCalendarInfo {
            id: "opaque-calendar".into(),
            name: "Holidays".into(),
            color: "#00aa88".into(),
            visible: true,
            readonly: true,
            subscribed: true,
            caldav: false,
        };
        let json = serde_json::to_string(&row).expect("serialize");
        assert!(json.contains("\"subscribed\":true"));
        assert!(!json.contains("source_url"));
        // A bridge that predates the flag still parses: the flag defaults off.
        let older: super::MobileCalendarInfo = serde_json::from_str(
            r##"{"id":"x","name":"Local","color":"#000","visible":true,"readonly":false,"caldav":false}"##,
        )
        .expect("older row");
        assert!(!older.subscribed);
    }

    #[test]
    fn terminal_frames_match_the_phones_wire_shapes_exactly() {
        use super::{TerminalControl, TerminalEvent};
        let control = |raw: &str| serde_json::from_str::<TerminalControl>(raw);
        assert!(matches!(control(r#"{"type":"ready"}"#), Ok(TerminalControl::Ready)));
        assert!(matches!(control(r#"{"type":"ping"}"#), Ok(TerminalControl::Ping)));
        assert!(matches!(
            control(r#"{"type":"detached"}"#),
            Ok(TerminalControl::Detached)
        ));
        assert!(matches!(
            control(r#"{"type":"resize","cols":80,"rows":24}"#),
            Ok(TerminalControl::Resize { cols: 80, rows: 24 })
        ));
        assert!(matches!(
            control(r#"{"type":"visibility","visible":false}"#),
            Ok(TerminalControl::Visibility { visible: false })
        ));
        // Anything the protocol does not name is refused, never guessed at.
        // The one gap is serde's, and documented here so nobody relies on the
        // `deny_unknown_fields` on the enum for it: an internally tagged enum
        // enforces the attribute on its struct variants (`resize` above) but
        // not on its unit variants, whose extra fields are ignored — harmless,
        // since a unit variant carries nothing an extra field could reach.
        assert!(matches!(
            control(r#"{"type":"ping","extra":1}"#),
            Ok(TerminalControl::Ping)
        ));
        for bad in [
            r#"{"type":"resize","cols":80}"#,
            r#"{"type":"resize","cols":-1,"rows":24}"#,
            r#"{"type":"resize","cols":80,"rows":24,"pixel_width":1}"#,
            r#"{"type":"exec","cmd":"id"}"#,
            r#"{"type":"visibility"}"#,
            r#"{"type":"visibility","visible":"no"}"#,
            r#"{}"#,
            "[]",
            "",
        ] {
            assert!(control(bad).is_err(), "accepted {bad:?}");
        }
        for event in [
            TerminalEvent::Pong,
            TerminalEvent::Replay,
            TerminalEvent::Window {
                cols: 180,
                rows: 48,
            },
            TerminalEvent::Closing {
                reason: "replaced".into(),
                retry: false,
            },
            TerminalEvent::Features { visibility: true },
        ] {
            let restored: TerminalEvent =
                serde_json::from_str(&event.to_frame()).expect("server frame round trip");
            assert_eq!(restored, event);
        }
    }

    fn create(body: serde_json::Value) -> super::CreateTabRequest {
        serde_json::from_value(body).expect("create request")
    }

    #[test]
    fn create_request_launch_shape() {
        let key = "0123456789abcdef";
        let ok = |body: serde_json::Value| create(body).launch_shape_ok();
        // Older phones send none of the new fields.
        assert!(ok(json!({"project_id": "p", "kind": "agent", "agent_id": "a", "idempotency_key": key})));
        assert!(ok(json!({"project_id": "p", "kind": "agent", "agent_id": "a", "worktree": "w1", "idempotency_key": key})));
        assert!(ok(json!({"project_id": "p", "kind": "agent", "agent_id": "a", "cloud": "open", "idempotency_key": key})));
        assert!(ok(json!({"project_id": "p", "kind": "agent", "agent_id": "a", "cloud": "new", "task": "fix the\nbuild\tnow", "idempotency_key": key})));
        // A shell has no worktree or cloud; the two are exclusive.
        assert!(!ok(json!({"project_id": "p", "kind": "shell", "cloud": "new", "idempotency_key": key})));
        assert!(!ok(json!({"project_id": "p", "kind": "shell", "worktree": "w1", "idempotency_key": key})));
        assert!(!ok(json!({"project_id": "p", "kind": "agent", "agent_id": "a", "cloud": "open", "worktree": "w1", "idempotency_key": key})));
        // Unknown action, a stray task, a blank, control-laden or overlong one.
        assert!(!ok(json!({"project_id": "p", "kind": "agent", "agent_id": "a", "cloud": "rm", "idempotency_key": key})));
        assert!(!ok(json!({"project_id": "p", "kind": "agent", "agent_id": "a", "task": "hi", "idempotency_key": key})));
        assert!(!ok(json!({"project_id": "p", "kind": "agent", "agent_id": "a", "cloud": "new", "task": "  ", "idempotency_key": key})));
        assert!(!ok(json!({"project_id": "p", "kind": "agent", "agent_id": "a", "cloud": "new", "task": "a\u{1b}[2Jb", "idempotency_key": key})));
        let long = "x".repeat(super::MAX_CLOUD_TASK + 1);
        assert!(!ok(json!({"project_id": "p", "kind": "agent", "agent_id": "a", "cloud": "new", "task": long, "idempotency_key": key})));
        assert!(!ok(json!({"project_id": "p", "kind": "agent", "agent_id": "a", "worktree": "", "idempotency_key": key})));
        // A sign-in tab: agent only, a known way, alone; `like_tab` only with it
        // and in place of `agent_id`.
        assert!(ok(json!({"project_id": "p", "kind": "agent", "agent_id": "a", "sign_in": "default", "idempotency_key": key})));
        assert!(ok(json!({"project_id": "p", "kind": "agent", "agent_id": "a", "sign_in": "alternate", "idempotency_key": key})));
        assert!(ok(json!({"project_id": "p", "kind": "agent", "like_tab": "t", "sign_in": "default", "idempotency_key": key})));
        assert!(!ok(json!({"project_id": "p", "kind": "shell", "sign_in": "default", "idempotency_key": key})));
        assert!(!ok(json!({"project_id": "p", "kind": "agent", "agent_id": "a", "sign_in": "token", "idempotency_key": key})));
        assert!(!ok(json!({"project_id": "p", "kind": "agent", "agent_id": "a", "sign_in": "default", "cloud": "open", "idempotency_key": key})));
        assert!(!ok(json!({"project_id": "p", "kind": "agent", "agent_id": "a", "sign_in": "default", "worktree": "w1", "idempotency_key": key})));
        assert!(!ok(json!({"project_id": "p", "kind": "agent", "like_tab": "t", "idempotency_key": key})));
        assert!(!ok(json!({"project_id": "p", "kind": "agent", "agent_id": "a", "like_tab": "t", "sign_in": "default", "idempotency_key": key})));
        // A local-model agent: agent kind, a bounded id, and nothing else.
        assert!(ok(json!({"project_id": "p", "kind": "agent", "local": "l1", "idempotency_key": key})));
        assert!(!ok(json!({"project_id": "p", "kind": "shell", "local": "l1", "idempotency_key": key})));
        assert!(!ok(json!({"project_id": "p", "kind": "agent", "local": "", "idempotency_key": key})));
        assert!(!ok(json!({"project_id": "p", "kind": "agent", "local": "x".repeat(129), "idempotency_key": key})));
        for extra in [
            json!({"agent_id": "a"}),
            json!({"mode": "plan"}),
            json!({"worktree": "w1"}),
            json!({"cloud": "open"}),
            json!({"sign_in": "default"}),
        ] {
            let mut body = json!({"project_id": "p", "kind": "agent", "local": "l1", "idempotency_key": key});
            body.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            assert!(!ok(body), "{extra}");
        }
    }

    #[test]
    fn launch_options_round_trip_and_default() {
        let response: DesktopResponse = serde_json::from_value(json!({"status": "launch_options"}))
            .expect("empty launch options");
        let DesktopResponse::LaunchOptions { worktrees, cloud, sign_in, local } = response else {
            panic!("launch options");
        };
        assert!(worktrees.is_empty() && cloud.is_empty() && sign_in.is_empty() && local.is_none());
        let request = DesktopRequest::LaunchOptions {
            request_id: "r".into(),
            project_id: "p".into(),
        };
        let value = serde_json::to_value(&request).expect("serialize");
        assert_eq!(value, json!({"type": "launch_options", "request_id": "r", "project_id": "p"}));
        assert_eq!(request.request_id(), "r");
    }

    #[test]
    fn a_sign_in_row_carries_the_api_key_flag_and_nothing_more() {
        let response: DesktopResponse = serde_json::from_value(json!({
            "status": "launch_options",
            "sign_in": [
                {"agent_id": "a1", "signed_in": true, "api_key": true},
                {"agent_id": "a2", "signed_in": false},
                {"agent_id": "a3", "signed_in": true, "api_key": true, "api_budget_reached": true}
            ]
        }))
        .expect("launch options");
        let DesktopResponse::LaunchOptions { sign_in, .. } = response else {
            panic!("launch options");
        };
        assert_eq!(sign_in[0].api_key, Some(true));
        assert_eq!(sign_in[1].api_key, None);
        assert_eq!(sign_in[0].api_budget_reached, None);
        assert_eq!(sign_in[2].api_budget_reached, Some(true));
        assert_eq!(
            serde_json::to_value(&sign_in).expect("serialize"),
            json!([
                {"agent_id": "a1", "signed_in": true, "api_key": true},
                {"agent_id": "a2", "signed_in": false},
                {"agent_id": "a3", "signed_in": true, "api_key": true, "api_budget_reached": true}
            ])
        );
    }
}
