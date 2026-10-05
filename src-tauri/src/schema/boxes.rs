use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A directed relation between two members of a box ("a change in `source` may
/// influence `target`"). Manual declaration is the baseline; auto-detection is a
/// deferred stretch goal (Phase 4).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct BoxRelation {
    /// Source project id (the one whose change ripples outward).
    pub source: String,
    /// Dependent project id (affected by a change in `source`).
    pub target: String,
    /// Optional relation kind/label, e.g. "python-lib".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Optional path/package hint, e.g. the local-path dep or package name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// One entry in `~/.local/share/tabtivity/boxes.json`.
///
/// Named `ProjectBox` (not `Box`) to avoid shadowing `std::boxed::Box`; the file
/// and JSON name stay `boxes`. Back-compat: only `id`/`name` are required, so an
/// older or hand-edited record deserializes with everything else defaulted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ProjectBox {
    pub id: String,
    pub name: String,
    /// Ordered project ids that are members of this box. Authoritative — the
    /// per-project `box_id` back-reference is a denormalized inverse and loses to
    /// this on any disagreement (see `reconcile_member_ids`).
    #[serde(default)]
    pub member_ids: Vec<String>,
    /// Ordering position among boxes/pills in the switcher (gap-spaced like
    /// project positions).
    #[serde(default)]
    pub position: i64,
    // ── #41 workspace metadata (Phase 2: stored; Phase 3/4: surfaced) ──
    /// Absolute path to the box folder under `~/tabtivity/boxes/<name>/`. Filled in
    /// lazily on first box open (Phase 2). Absent for grouping-only boxes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// Directed inter-project relations among members (Phase 2: stored;
    /// Phase 4: surfaced + auto-detected).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub relations: Vec<BoxRelation>,
    /// Tabtivity Mobile reach (#31aa): whether this box's `box:<id>` scope is
    /// listed on a paired phone. Off by default and absent from disk while off,
    /// exactly like a project's `tabtivity_mobile_access` — the sidecar reads this
    /// file directly, so the bit lives here and nowhere else.
    // brand-check: allow — a serde key must be a literal; a test pins it to brand::MOBILE_ACCESS_KEY
    #[serde(default, rename = "tabtivity_mobile_access", skip_serializing_if = "std::ops::Not::not")]
    pub app_mobile_access: bool,
    /// Which paired phones the box reaches while `app_mobile_access` is on:
    /// absent is every phone, a list only those device ids. Lenient on read
    /// (malformed → no phone) so one bad value cannot fail `read_boxes` and
    /// with it every box command; absent from disk while unset.
    // brand-check: allow — a serde key must be a literal; a test pins it to brand::MOBILE_DEVICES_KEY
    #[serde(default, rename = "tabtivity_mobile_devices", deserialize_with = "crate::schema::projects::lenient_mobile_devices", skip_serializing_if = "Option::is_none")]
    pub app_mobile_devices: Option<Vec<String>>,
    /// Moved by every write that changed this box (headless owner plan, H1).
    /// `save_boxes` — the whole-list save — is refused for a box whose
    /// revision moved since the caller loaded it, so a second window or the
    /// Mobile sidecar editing in between is never erased. `0` until a
    /// revision-aware Tabtivity first rewrites the box, and not serialized then.
    #[serde(default, skip_serializing_if = "rev_is_zero")]
    pub rev: u64,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

fn rev_is_zero(rev: &u64) -> bool {
    *rev == 0
}

/// Full `boxes.json` — an unordered list of project boxes (ordering is by each
/// box's `position`).
pub type BoxesList = Vec<ProjectBox>;

#[cfg(test)]
mod tests {
    use super::*;

    /// The serde key is a literal in the attribute; this ties it to the brand
    /// module so the two cannot drift.
    #[test]
    fn the_mobile_access_key_is_the_brand_constant() {
        let json = format!(r#"{{"id":"b","name":"B","{}":true}}"#, crate::brand::MOBILE_ACCESS_KEY);
        let b: ProjectBox = serde_json::from_str(&json).unwrap();
        assert!(b.app_mobile_access);
        let back = serde_json::to_value(&b).unwrap();
        assert_eq!(back[crate::brand::MOBILE_ACCESS_KEY], true);
    }

    /// The per-phone list: pinned to the brand constant, written only when
    /// set, and a malformed value still reads (as no phone) instead of
    /// failing the box — or the whole file.
    #[test]
    fn the_mobile_devices_key_is_the_brand_constant_and_malformed_still_reads() {
        let key = crate::brand::MOBILE_DEVICES_KEY;
        let b: ProjectBox = serde_json::from_str(&format!(r#"{{"id":"b","name":"B","{key}":["d1"]}}"#)).unwrap();
        assert_eq!(b.app_mobile_devices, Some(vec!["d1".to_string()]));
        assert_eq!(json(&b)[key], serde_json::json!(["d1"]));
        let list: BoxesList =
            serde_json::from_str(&format!(r#"[{{"id":"a","name":"A","{key}":"d1"}},{{"id":"b","name":"B"}}]"#)).unwrap();
        assert_eq!(list[0].app_mobile_devices, Some(vec![]));
        assert_eq!(list[1].app_mobile_devices, None);
        assert!(json(&list[1]).get(key).is_none(), "absent stays absent");
    }

    fn json<T: Serialize>(value: &T) -> Value {
        serde_json::to_value(value).expect("serialize")
    }

    /// Only `id` and `name` are required: a hand-edited or pre-#41 record
    /// loads with everything else defaulted.
    #[test]
    fn a_minimal_box_record_defaults_everything_else() {
        let b: ProjectBox = serde_json::from_str(r#"{"id":"b1","name":"Thesis"}"#).unwrap();
        assert!(b.member_ids.is_empty());
        assert_eq!(b.position, 0);
        assert!(b.folder.is_none());
        assert!(b.relations.is_empty());
        assert!(!b.app_mobile_access);
        assert!(b.extra.is_empty());
    }

    /// The phone-reach bit is absent from disk while off and present only
    /// when on — the sidecar reads this file directly and keys on presence.
    #[test]
    fn mobile_access_is_written_only_while_on() {
        let off = ProjectBox {
            id: "b".into(),
            name: "n".into(),
            ..Default::default()
        };
        let out = json(&off);
        assert!(out.get(concat!(crate::app_slug!(), "_mobile_access")).is_none(), "{out}");
        assert!(out.get("relations").is_none(), "empty relations are omitted");
        assert!(out.get("folder").is_none());
        assert_eq!(out["member_ids"], serde_json::json!([]));
        assert_eq!(out["position"], 0);

        let on = ProjectBox {
            app_mobile_access: true,
            ..off
        };
        assert_eq!(json(&on)[concat!(crate::app_slug!(), "_mobile_access")], true);
        let back: ProjectBox = serde_json::from_value(json(&on)).unwrap();
        assert!(back.app_mobile_access);
    }

    /// Relations keep their optional labels only when set, and unknown keys on
    /// both the box and a relation ride through `extra`.
    #[test]
    fn relations_and_unknown_keys_round_trip() {
        let raw = r##"{"id":"b","name":"n","member_ids":["p1","p2"],"position":150,
            "relations":[{"source":"p1","target":"p2","kind":"python-lib","weight":2}],
            "color":"#fff"}"##;
        let b: ProjectBox = serde_json::from_str(raw).unwrap();
        let rel = &b.relations[0];
        assert_eq!(rel.kind.as_deref(), Some("python-lib"));
        assert!(rel.hint.is_none());
        assert_eq!(rel.extra["weight"], 2);
        assert_eq!(b.extra["color"], "#fff");
        let out = json(&b);
        assert!(out["relations"][0].get("hint").is_none());
        assert_eq!(out["relations"][0]["weight"], 2);
        let back: ProjectBox = serde_json::from_value(out).unwrap();
        assert_eq!(back, b);
        let list: BoxesList = serde_json::from_str(&format!("[{raw}]")).unwrap();
        assert_eq!(list[0].member_ids, vec!["p1", "p2"]);
    }
}
