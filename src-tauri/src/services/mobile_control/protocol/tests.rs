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
            turn_started_at: None,
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
            turn_started_at: None,
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
        tmux_session: None,
    };
    let json = serde_json::to_value(&request).expect("serialize activation request");
    assert_eq!(json["type"], "activate");
    assert_eq!(json["project_id"], "project-1");
    assert!(json.get("tmux_session").is_none(), "the plain activation sends no tab");
    let named: DesktopRequest = serde_json::from_value(
        serde_json::json!({ "type": "activate", "request_id": "r", "project_id": "p", "tmux_session": "tab-1" }),
    )
    .expect("an activation naming its tab");
    assert!(matches!(named, DesktopRequest::Activate { tmux_session: Some(ref tab), .. } if tab == "tab-1"));
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
        device_id: Some("device-1".into()),
    };
    assert_eq!(request.request_id(), "request-prompt");
    let json = serde_json::to_value(&request).expect("serialize prompt report");
    assert_eq!(json["type"], "tab_prompt");
    assert_eq!(json["message"], "fix the tests");
    assert_eq!(json["device_id"], "device-1");
    let mut older = json.clone();
    older.as_object_mut().unwrap().remove("device_id");
    assert!(matches!(serde_json::from_value(older), Ok(DesktopRequest::TabPrompt { device_id: None, .. })), "an older sidecar names no phone");
    let restored: DesktopRequest =
        serde_json::from_value(json).expect("deserialize prompt report");
    assert!(matches!(restored, DesktopRequest::TabPrompt { .. }));
}

#[test]
fn a_tabby_model_switch_names_the_tab_pair_and_a_model_name_only() {
    let switch = DesktopRequest::SwitchAssistantModel {
        request_id: "request-switch".into(),
        project_id: "raw-project".into(),
        tmux_session: "raw-tmux".into(),
        model: "opus".into(),
    };
    assert_eq!(switch.request_id(), "request-switch");
    assert!(switch.is_mutation());
    assert!(switch.desktop_timeout() < switch.response_timeout());
    let json = serde_json::to_value(&switch).expect("serialize switch");
    assert_eq!(json["type"], "switch_assistant_model");
    let mut hostile = json.clone();
    hostile["argv"] = "--evil".into();
    assert!(serde_json::from_value::<DesktopRequest>(hostile).is_err());
    let list = DesktopRequest::AssistantModels {
        request_id: "request-models".into(),
        project_id: "raw-project".into(),
        tmux_session: "raw-tmux".into(),
    };
    assert!(!list.is_mutation());
    assert_eq!(serde_json::to_value(&list).expect("serialize list")["type"], "assistant_models");
    let listed: DesktopResponse = serde_json::from_value(serde_json::json!({
        "status": "assistant_models",
        "models": ["opus", "sonnet"],
        "current": "opus",
    }))
    .expect("deserialize models");
    assert!(matches!(listed, DesktopResponse::AssistantModels { ref models, ref rows, current: Some(_) } if models.len() == 2 && rows.is_empty()));
    let worded: DesktopResponse = serde_json::from_value(serde_json::json!({
        "status": "assistant_models",
        "models": ["default"],
        "rows": [{ "id": "default", "label": "Default (recommended)", "description": "Sonnet 5.5" }],
    }))
    .expect("deserialize rows");
    assert!(matches!(worded, DesktopResponse::AssistantModels { ref rows, current: None, .. }
        if rows[0].label == "Default (recommended)" && rows[0].description.as_deref() == Some("Sonnet 5.5")));
}

#[test]
fn location_moves_name_the_tab_pair_and_a_location_word() {
    let request = DesktopRequest::MoveLocation {
        request_id: "request-locate".into(),
        project_id: "raw-project".into(),
        tmux_session: "raw-tmux".into(),
        location: "host:w1".into(),
    };
    assert_eq!(request.request_id(), "request-locate");
    assert!(request.is_mutation());
    assert!(request.desktop_timeout() < request.response_timeout());
    let json = serde_json::to_value(&request).expect("serialize move");
    assert_eq!(json["type"], "move_location");
    assert_eq!(json["location"], "host:w1");
}

#[test]
fn worktree_moves_name_the_tab_pair_and_an_opaque_worktree_only() {
    let request = DesktopRequest::MoveWorktree {
        request_id: "request-move".into(),
        project_id: "raw-project".into(),
        tmux_session: "raw-tmux".into(),
        worktree: "w-1".into(),
    };
    assert_eq!(request.request_id(), "request-move");
    assert!(request.is_mutation());
    assert!(request.desktop_timeout() < request.response_timeout());
    let json = serde_json::to_value(&request).expect("serialize move");
    assert_eq!(json["type"], "move_worktree");
    let mut hostile = json.clone();
    hostile["path"] = "/must/not/cross".into();
    assert!(serde_json::from_value::<DesktopRequest>(hostile).is_err());
    let list = DesktopRequest::TabWorktrees {
        request_id: "request-list".into(),
        project_id: "raw-project".into(),
        tmux_session: "raw-tmux".into(),
    };
    assert!(!list.is_mutation());
    assert_eq!(serde_json::to_value(&list).expect("serialize list")["type"], "tab_worktrees");

    let listed: DesktopResponse = serde_json::from_value(serde_json::json!({
        "status": "tab_worktrees",
        "worktrees": [{ "id": "w-0", "label": "", "branch": "main", "main": true }],
        "current": "w-0",
        "carries": true,
    }))
    .expect("parse list answer");
    assert!(matches!(listed, DesktopResponse::TabWorktrees { ref worktrees, current: Some(_), carries: true } if worktrees.len() == 1));
    let moved: DesktopResponse = serde_json::from_value(serde_json::json!({ "status": "worktree_moved", "moved": "fresh" }))
        .expect("parse move answer");
    assert!(matches!(moved, DesktopResponse::WorktreeMoved { ref moved } if moved == "fresh"));
}

#[test]
fn held_prompts_carry_the_tab_pair_the_words_and_nothing_else() {
    let request = DesktopRequest::EditHeldPrompt {
        request_id: "request-held".into(),
        project_id: "raw-project".into(),
        tmux_session: concat!(crate::app_slug!(), "-project-0--agent-123456789").into(),
        held_id: "held-1".into(),
        message: "fix the tests, then the docs".into(),
        device_id: Some("device-1".into()),
    };
    assert_eq!(request.request_id(), "request-held");
    let json = serde_json::to_value(&request).expect("serialize held edit");
    assert_eq!(json["type"], "edit_held_prompt");
    assert_eq!(json["held_id"], "held-1");
    assert_eq!(json["device_id"], "device-1");
    // An older sidecar's edit names no phone and still parses (#2348).
    let mut older_edit = json.clone();
    older_edit.as_object_mut().unwrap().remove("device_id");
    assert!(matches!(
        serde_json::from_value::<DesktopRequest>(older_edit),
        Ok(DesktopRequest::EditHeldPrompt { device_id: None, .. })
    ));
    let mut hostile = json.clone();
    hostile["schedule_target_id"] = "must-not-cross".into();
    assert!(serde_json::from_value::<DesktopRequest>(hostile).is_err());
    let hold = serde_json::to_value(DesktopRequest::HoldPrompt {
        request_id: "request-hold".into(),
        project_id: "raw-project".into(),
        tmux_session: "raw-tmux".into(),
        message: "and the lint".into(),
        device_id: Some("device-1".into()),
    })
    .expect("serialize hold");
    assert_eq!(hold["type"], "hold_prompt");
    assert_eq!(hold["device_id"], "device-1");
    // An older sidecar names no phone; the request still parses.
    let mut older = hold.clone();
    older.as_object_mut().unwrap().remove("device_id");
    assert!(matches!(serde_json::from_value::<DesktopRequest>(older), Ok(DesktopRequest::HoldPrompt { device_id: None, .. })));
    let answer = serde_json::to_value(DesktopResponse::Held { held_id: "held-1".into() })
        .expect("serialize held answer");
    assert_eq!(answer["status"], "held");
    assert_eq!(answer["held_id"], "held-1");
}

/// Local models from the phone: list and mutate round-trip, a pull (or
/// any action the enum does not name) cannot even be deserialized, and
/// the mutate is the one write — on the default deadlines, since nothing
/// waits on a load or a start.
#[test]
fn local_model_requests_round_trip_and_a_pull_cannot_cross() {
    use super::{LocalModelAction, MobileLocalModel};
    let list = DesktopRequest::LocalModels { request_id: "r-list".into() };
    let json = serde_json::to_value(&list).expect("serialize list");
    assert_eq!(json, serde_json::json!({ "type": "local_models", "request_id": "r-list" }));
    let restored: DesktopRequest = serde_json::from_value(json).expect("round-trip list");
    assert_eq!(restored.request_id(), "r-list");
    assert!(!restored.is_mutation());

    for (action, wire) in [
        (LocalModelAction::Load { model: "qwen3.5:9b".into() }, serde_json::json!({ "type": "load", "model": "qwen3.5:9b" })),
        (LocalModelAction::Unload { model: "llama3".into() }, serde_json::json!({ "type": "unload", "model": "llama3" })),
        (LocalModelAction::Start, serde_json::json!({ "type": "start" })),
    ] {
        let request = DesktopRequest::LocalModelMutate { request_id: "r-mut".into(), action: action.clone() };
        let json = serde_json::to_value(&request).expect("serialize mutate");
        assert_eq!(json["type"], "local_model_mutate");
        assert_eq!(json["action"], wire);
        let restored: DesktopRequest = serde_json::from_value(json).expect("round-trip mutate");
        assert_eq!(restored.request_id(), "r-mut");
        assert!(restored.is_mutation());
        assert!(matches!(restored, DesktopRequest::LocalModelMutate { action: ref back, .. } if *back == action));
    }

    for request in [
        list,
        DesktopRequest::LocalModelMutate { request_id: "r".into(), action: LocalModelAction::Start },
    ] {
        assert_eq!(request.response_timeout(), std::time::Duration::from_secs(10));
        assert!(request.desktop_timeout() < request.response_timeout());
    }

    for hostile in [
        serde_json::json!({ "type": "local_model_mutate", "request_id": "r", "action": { "type": "pull", "model": "x" } }),
        serde_json::json!({ "type": "local_model_mutate", "request_id": "r", "action": { "type": "delete", "model": "x" } }),
        serde_json::json!({ "type": "local_model_mutate", "request_id": "r", "action": { "type": "load", "model": "x", "insecure": true } }),
        serde_json::json!({ "type": "local_model_mutate", "request_id": "r", "action": { "type": "unload", "model": "x", "device": "gpu" } }),
        serde_json::json!({ "type": "local_model_mutate", "request_id": "r", "action": { "type": "load" } }),
        serde_json::json!({ "type": "local_model_mutate", "request_id": "r", "action": { "type": "start" }, "model": "x" }),
        serde_json::json!({ "type": "local_models", "request_id": "r", "project_id": "p" }),
    ] {
        assert!(serde_json::from_value::<DesktopRequest>(hostile.clone()).is_err(), "accepted {hostile}");
    }
    // The serde gap documented in
    // `terminal_frames_match_the_phones_wire_shapes_exactly`: the unit
    // `start` ignores an extra field. `local_models::parse_action` refuses
    // it before a request is ever built.
    let gap = serde_json::json!({ "type": "local_model_mutate", "request_id": "r", "action": { "type": "start", "model": "x" } });
    assert!(matches!(
        serde_json::from_value::<DesktopRequest>(gap),
        Ok(DesktopRequest::LocalModelMutate { action: LocalModelAction::Start, .. })
    ));

    // The answer: lenient like every response, defaulted field by field.
    let response: DesktopResponse = serde_json::from_value(serde_json::json!({
        "status": "local_models",
        "server": "running",
        "can_start": false,
        "start_failed": false,
        "models": [
            { "name": "qwen3.5:9b", "size": 6594474711u64, "parameter_size": "9B", "quantization": "Q4_K_M",
              "state": "loaded", "loaded_size": 7100000000u64, "vram": 7100000000u64, "pinned": true,
              "expires_in": null, "for_tabs": true, "remote": false, "added_later": 1 },
            { "name": "llama3:latest" },
        ],
        "added_later": "ignored",
    }))
    .expect("local models answer");
    let DesktopResponse::LocalModels { server, models, .. } = &response else { panic!("{response:?}") };
    assert_eq!(server, "running");
    assert_eq!(models[0].vram, Some(7_100_000_000));
    assert_eq!(models[0].pinned, Some(true));
    assert_eq!(models[0].expires_in, None);
    assert_eq!(
        models[1],
        MobileLocalModel {
            name: "llama3:latest".into(),
            size: 0,
            parameter_size: None,
            quantization: None,
            state: String::new(),
            loaded_size: None,
            vram: None,
            pinned: None,
            expires_in: None,
            for_tabs: false,
            remote: false,
        }
    );
    let back = serde_json::to_value(&response).expect("serialize answer");
    assert_eq!(back["status"], "local_models");
    let restored: DesktopResponse = serde_json::from_value(back).expect("round-trip answer");
    assert!(matches!(restored, DesktopResponse::LocalModels { ref models, .. } if models.len() == 2));
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
        device_id: None,
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
    assert_eq!(reencoded["ticks"], serde_json::json!([]), "a window without ticks answers none");
    let empty: DesktopResponse = serde_json::from_value(serde_json::json!({ "status": "markup_questions" })).expect("no asks");
    assert!(matches!(empty, DesktopResponse::MarkupQuestions { ref asks, ref ticks } if asks.is_empty() && ticks.is_empty()));
    // Ticks cross as round, page and mark only.
    let ticked: DesktopResponse = serde_json::from_value(serde_json::json!({
        "status": "markup_questions",
        "ticks": [{ "round": "k3x9a0b1", "page": 2, "mark": 4, "file": "docs/paper/draft.pdf" }],
    }))
    .expect("decode ticks");
    assert_eq!(
        serde_json::to_value(&ticked).expect("re-encode ticks")["ticks"],
        serde_json::json!([{ "round": "k3x9a0b1", "page": 2, "mark": 4 }])
    );
    for bad in [serde_json::json!({ "round": "r", "page": -1, "mark": 1 }), serde_json::json!({ "round": "r", "page": 1 })] {
        let hostile = serde_json::json!({ "status": "markup_questions", "ticks": [bad] });
        assert!(serde_json::from_value::<DesktopResponse>(hostile).is_err());
    }
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
        device_id: Some("device-1".into()),
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
        device_id: Some("device-1".into()),
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
        device_id: None,
    })
    .expect("serialize create");
    create["action"]["prompt"]["id"] = "phone-picked".into();
    assert!(serde_json::from_value::<DesktopRequest>(create).is_err());

    let response = serde_json::to_value(DesktopResponse::Prompts { prompts: vec![] })
        .expect("serialize prompts response");
    assert_eq!(response["status"], "prompts");
}

#[test]
fn mail_folder_syncing_flag_relays_and_defaults_off() {
    let page = |syncing: &str| {
        serde_json::from_str::<MobileMailView>(&format!(
            r#"{{"view":"folder","folder":{{"id":"f","name":"Archive","kind":"archive","unread":0,"total":0}},
                    "messages":[],"total":0,"offset":0{syncing}}}"#
        ))
        .expect("parse folder view")
    };
    // An older desktop sends no flag; the phone sees none either.
    let quiet = serde_json::to_value(page("")).expect("serialize");
    assert!(quiet.get("syncing").is_none());
    let busy = serde_json::to_value(page(r#","syncing":true"#)).expect("serialize");
    assert_eq!(busy["syncing"], true);
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
    assert!(matches!(
        control(r#"{"type":"send_now","family":"claude"}"#),
        Ok(TerminalControl::SendNow { family }) if family == "claude"
    ));
    // A bridge's features from before `send_now` still read.
    assert_eq!(
        serde_json::from_str::<TerminalEvent>(r#"{"type":"features","visibility":true}"#).expect("older features"),
        TerminalEvent::Features { visibility: true, send_now: false }
    );
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
        r#"{"type":"send_now"}"#,
        r#"{"type":"send_now","family":"claude","keys":"\u001b"}"#,
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
        TerminalEvent::Closing {
            reason: "host_offline".into(),
            retry: false,
        },
        TerminalEvent::Features { visibility: true, send_now: true },
        TerminalEvent::SendNow { sent: false },
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
    // A teleport: a cloud tab's session id beside `like_tab`, and nothing else.
    assert!(ok(json!({"project_id": "p", "kind": "agent", "like_tab": "t", "teleport": "session_011SU65r", "idempotency_key": key})));
    assert!(!ok(json!({"project_id": "p", "kind": "shell", "like_tab": "t", "teleport": "session_011SU65r", "idempotency_key": key})));
    assert!(!ok(json!({"project_id": "p", "kind": "agent", "teleport": "session_011SU65r", "idempotency_key": key})));
    for bad in ["", "-rf", "session_1; rm -rf ~", "a b", "s\u{1b}x", &"x".repeat(129)] {
        assert!(!ok(json!({"project_id": "p", "kind": "agent", "like_tab": "t", "teleport": bad, "idempotency_key": key})), "{bad}");
    }
    for extra in [
        json!({"agent_id": "a"}),
        json!({"mode": "plan"}),
        json!({"worktree": "w1"}),
        json!({"cloud": "open"}),
        json!({"sign_in": "default"}),
        json!({"local": "l1"}),
        json!({"assistant": "c1"}),
        json!({"api_key": true}),
    ] {
        let mut body = json!({"project_id": "p", "kind": "agent", "like_tab": "t", "teleport": "session_1", "idempotency_key": key});
        body.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        assert!(!ok(body), "{extra}");
    }
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
        json!({"assistant": "c1"}),
    ] {
        let mut body = json!({"project_id": "p", "kind": "agent", "local": "l1", "idempotency_key": key});
        body.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        assert!(!ok(body), "{extra}");
    }
    // An API-key agent: a named agent, in a worktree at most.
    assert!(ok(json!({"project_id": "p", "kind": "agent", "agent_id": "a", "api_key": true, "idempotency_key": key})));
    assert!(ok(json!({"project_id": "p", "kind": "agent", "agent_id": "a", "worktree": "w1", "api_key": true, "idempotency_key": key})));
    assert!(ok(json!({"project_id": "p", "kind": "agent", "agent_id": "a", "api_key": false, "idempotency_key": key})));
    assert!(!ok(json!({"project_id": "p", "kind": "shell", "api_key": true, "idempotency_key": key})));
    assert!(!ok(json!({"project_id": "p", "kind": "agent", "api_key": true, "idempotency_key": key})));
    for extra in [
        json!({"mode": "plan"}),
        json!({"cloud": "open"}),
        json!({"sign_in": "default"}),
        json!({"local": "l1"}),
        json!({"assistant": "c1"}),
    ] {
        let mut body = json!({"project_id": "p", "kind": "agent", "agent_id": "a", "api_key": true, "idempotency_key": key});
        body.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        assert!(!ok(body), "{extra}");
    }
    // An agent on a remote host: a named agent, a mode at most.
    assert!(ok(json!({"project_id": "p", "kind": "agent", "agent_id": "a", "host": "h1", "idempotency_key": key})));
    assert!(ok(json!({"project_id": "p", "kind": "agent", "agent_id": "a", "mode": "plan", "host": "h1", "idempotency_key": key})));
    assert!(!ok(json!({"project_id": "p", "kind": "shell", "host": "h1", "idempotency_key": key})));
    assert!(!ok(json!({"project_id": "p", "kind": "agent", "host": "h1", "idempotency_key": key})));
    assert!(!ok(json!({"project_id": "p", "kind": "agent", "agent_id": "a", "host": "", "idempotency_key": key})));
    assert!(!ok(json!({"project_id": "p", "kind": "agent", "agent_id": "a", "host": "x".repeat(129), "idempotency_key": key})));
    for extra in [
        json!({"worktree": "w1"}),
        json!({"cloud": "open"}),
        json!({"sign_in": "default"}),
        json!({"local": "l1"}),
        json!({"assistant": "c1"}),
        json!({"api_key": true}),
    ] {
        let mut body = json!({"project_id": "p", "kind": "agent", "agent_id": "a", "host": "h1", "idempotency_key": key});
        body.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        assert!(!ok(body), "{extra}");
    }
    // An assistant chat: agent kind, a bounded id, and nothing else.
    assert!(ok(json!({"project_id": "p", "kind": "agent", "assistant": "c1", "idempotency_key": key})));
    assert!(!ok(json!({"project_id": "p", "kind": "shell", "assistant": "c1", "idempotency_key": key})));
    assert!(!ok(json!({"project_id": "p", "kind": "agent", "assistant": "", "idempotency_key": key})));
    assert!(!ok(json!({"project_id": "p", "kind": "agent", "assistant": "x".repeat(129), "idempotency_key": key})));
    for extra in [
        json!({"agent_id": "a"}),
        json!({"mode": "plan"}),
        json!({"worktree": "w1"}),
        json!({"cloud": "open"}),
        json!({"task": "hi"}),
        json!({"sign_in": "default"}),
        json!({"like_tab": "t"}),
        json!({"local": "l1"}),
    ] {
        let mut body = json!({"project_id": "p", "kind": "agent", "assistant": "c1", "idempotency_key": key});
        body.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        assert!(!ok(body), "{extra}");
    }
}

#[test]
fn launch_options_round_trip_and_default() {
    let response: DesktopResponse = serde_json::from_value(json!({"status": "launch_options"}))
        .expect("empty launch options");
    let DesktopResponse::LaunchOptions { worktrees, cloud, sign_in, local, api_key } = response else {
        panic!("launch options");
    };
    assert!(worktrees.is_empty() && cloud.is_empty() && sign_in.is_empty() && local.is_none() && api_key.is_empty());
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

#[test]
fn an_api_key_row_carries_its_budget_flag_and_nothing_more() {
    let response: DesktopResponse = serde_json::from_value(json!({
        "status": "launch_options",
        "api_key": [{"agent_id": "a1"}, {"agent_id": "a2", "budget_reached": true}]
    }))
    .expect("launch options");
    let DesktopResponse::LaunchOptions { api_key, .. } = response else {
        panic!("launch options");
    };
    assert!(!api_key[0].budget_reached && api_key[1].budget_reached);
    assert_eq!(
        serde_json::to_value(&api_key).expect("serialize"),
        json!([{"agent_id": "a1"}, {"agent_id": "a2", "budget_reached": true}])
    );
}
