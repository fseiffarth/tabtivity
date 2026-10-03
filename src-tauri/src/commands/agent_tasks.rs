use crate::tauri_host::Ctx;
use app_core::CoreCtx;

use crate::{
    schema::{AgentScheduleResult, AgentScheduleTargetBinding, ScheduledAgentPrompt},
    services::agent_tasks,
};

const CHANGED_EVENT: &str = "agent-schedules-changed";

fn changed(ctx: &CoreCtx) {
    ctx.emit(CHANGED_EVENT, ());
}

/// Take or renew the single-client timer lease for this window
/// (`services::timer_lease`, headless owner plan H2): the timer hosts run
/// only while it answers `held`. Called on a heartbeat.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn timer_lease_acquire(client_id: String) -> Result<crate::services::timer_lease::LeaseState, String> {
    crate::services::timer_lease::acquire(&client_id)
}

/// Give the timer lease up on the way out, so another window takes over at
/// once rather than after the TTL.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn timer_lease_release(client_id: String) -> Result<(), String> {
    crate::services::timer_lease::release(&client_id)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn agent_schedules_list(
    project_id: String,
    schedule_target_id: String,
) -> Result<Vec<ScheduledAgentPrompt>, String> {
    agent_tasks::list(&project_id, &schedule_target_id)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn agent_schedule_upsert(
    ctx: Ctx,
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
    changed(&ctx);
    Ok(result)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn agent_schedule_delete(
    ctx: Ctx,
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
    changed(&ctx);
    Ok(())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn agent_schedules_delete_target(
    ctx: Ctx,
    project_id: String,
    schedule_target_id: String,
) -> Result<(), String> {
    agent_tasks::delete_target(&project_id, &schedule_target_id)?;
    changed(&ctx);
    Ok(())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn agent_schedule_claim(
    project_id: String,
    schedule_target_id: String,
    schedule_id: String,
    occurrence: String,
) -> Result<bool, String> {
    agent_tasks::claim(&project_id, &schedule_target_id, &schedule_id, &occurrence)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn agent_schedule_complete(
    ctx: Ctx,
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
    changed(&ctx);
    Ok(schedules)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn agent_schedules_cleanup_orphans(
    ctx: Ctx,
    live: Vec<AgentScheduleTargetBinding>,
) -> Result<usize, String> {
    let removed = agent_tasks::cleanup_orphans(&live)?;
    if removed > 0 {
        changed(&ctx);
    }
    Ok(removed)
}
