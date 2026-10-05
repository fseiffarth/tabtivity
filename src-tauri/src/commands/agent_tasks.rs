use tauri::{AppHandle, Emitter};

use crate::{
    schema::{AgentScheduleResult, AgentScheduleTargetBinding, ScheduledAgentPrompt},
    services::agent_tasks,
};

const CHANGED_EVENT: &str = "agent-schedules-changed";

fn changed(app: &AppHandle) {
    let _ = app.emit(CHANGED_EVENT, ());
}

/// Cancel the prompts and schedules paired phones made that their phone no
/// longer reaches — after a revoke, Lock down or a narrowed Mobile access
/// (`mobile_control::phone_origin`, #2348) — and reload the lists that
/// showed them. Best effort: a failure is logged, and the claim's own check
/// still stops each of them before it is typed.
pub(crate) fn cancel_lost_phone_rules(app: &AppHandle, why: &str) {
    match crate::services::mobile_control::phone_origin::sweep(&crate::storage::state_dir(), why) {
        Ok(cancelled) if !cancelled.is_empty() => changed(app),
        Ok(_) => {}
        Err(error) => eprintln!("{}: phone prompts and schedules not checked {why}: {error}", crate::app_slug!()),
    }
}

/// Take or renew the single-client timer lease for this window
/// (`services::timer_lease`, headless owner plan H2): the timer hosts run
/// only while it answers `held`. Called on a heartbeat.
#[tauri::command]
pub fn timer_lease_acquire(client_id: String) -> Result<crate::services::timer_lease::LeaseState, String> {
    crate::services::timer_lease::acquire(&client_id)
}

/// Give the timer lease up on the way out, so another window takes over at
/// once rather than after the TTL.
#[tauri::command]
pub fn timer_lease_release(client_id: String) -> Result<(), String> {
    crate::services::timer_lease::release(&client_id)
}

#[tauri::command]
pub fn agent_schedules_list(
    project_id: String,
    schedule_target_id: String,
) -> Result<Vec<ScheduledAgentPrompt>, String> {
    agent_tasks::list(&project_id, &schedule_target_id)
}

#[tauri::command]
pub fn agent_schedule_upsert(
    app: AppHandle,
    project_id: String,
    schedule_target_id: String,
    schedule: ScheduledAgentPrompt,
    // Set by an editor moving or editing a rule it already holds: the target
    // the rule must still be live on. Omitted (the phone, a plain create), the
    // write behaves as it always has.
    expect_existing_on: Option<String>,
) -> Result<Vec<ScheduledAgentPrompt>, String> {
    let result = agent_tasks::upsert(
        &project_id,
        &schedule_target_id,
        schedule,
        expect_existing_on.as_deref(),
    )?;
    changed(&app);
    Ok(result)
}

#[tauri::command]
pub fn agent_schedule_delete(
    app: AppHandle,
    project_id: String,
    schedule_target_id: String,
    schedule_id: String,
    expect_undelivered: Option<bool>,
) -> Result<(), String> {
    agent_tasks::delete(
        &project_id,
        &schedule_target_id,
        &schedule_id,
        expect_undelivered.unwrap_or(false),
    )?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub fn agent_schedules_delete_target(
    app: AppHandle,
    project_id: String,
    schedule_target_id: String,
) -> Result<(), String> {
    agent_tasks::delete_target(&project_id, &schedule_target_id)?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub fn agent_schedule_claim(
    app: AppHandle,
    project_id: String,
    schedule_target_id: String,
    schedule_id: String,
    occurrence: String,
) -> Result<bool, String> {
    let outcome = agent_tasks::claim(&project_id, &schedule_target_id, &schedule_id, &occurrence)?;
    // A phone's rule its phone can no longer reach was taken out instead: the
    // lists that still show it reload.
    if outcome == agent_tasks::ClaimOutcome::Cancelled {
        changed(&app);
    }
    Ok(outcome == agent_tasks::ClaimOutcome::Claimed)
}

#[tauri::command]
pub fn agent_schedule_complete(
    app: AppHandle,
    project_id: String,
    schedule_target_id: String,
    schedule_id: String,
    occurrence: String,
    result: AgentScheduleResult,
) -> Result<Vec<ScheduledAgentPrompt>, String> {
    let schedules = agent_tasks::complete(
        &project_id,
        &schedule_target_id,
        &schedule_id,
        &occurrence,
        result,
    )?;
    changed(&app);
    Ok(schedules)
}

#[tauri::command]
pub fn agent_schedules_cleanup_orphans(
    app: AppHandle,
    live: Vec<AgentScheduleTargetBinding>,
) -> Result<usize, String> {
    let removed = agent_tasks::cleanup_orphans(&live)?;
    if removed > 0 {
        changed(&app);
    }
    Ok(removed)
}
