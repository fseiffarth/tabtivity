//! **Keyword rules that file a new message into the alert lists.**
//!
//! The whole module is one pure question — *does this rule match this header,
//! and on which word?* — with no I/O, no clock and no `AppHandle`, so the
//! behaviour every user complaint will be about ("why did this get marked?",
//! "why didn't this?") is answerable by a unit test rather than by a sync.
//!
//! # What a rule may look at, and why that is a short list
//!
//! Subject, sender, recipients, and the body **snippet** the sync already
//! stores. Not the body. A sync fetches headers only — the body of a message is
//! downloaded when it is opened — so matching on full text would mean pulling
//! every message of every folder on every check, over IMAP, to decide whether to
//! set a local column. The preview is the part of the body that is *already
//! here*, and the UI says so in as many words rather than letting "body" imply a
//! search that does not happen.
//!
//! # The three rules of matching
//!
//! 1. **An empty rule never matches.** No terms, or no fields, means the rule
//!    fires on nothing — never on everything. Both degenerate cases are one
//!    typo away in a dialog, and the failure mode of the other reading is every
//!    message in the mailbox landing in the alert list on one tick.
//! 2. **Comparison is case-insensitive, on `to_lowercase`d text.** Not
//!    `eq_ignore_ascii_case`: the terms are ordinary words in whatever language
//!    the user writes their mail in, and `Rechnung` must match `RECHNUNG`.
//! 3. **First matching rule wins**, in list order. A message gets one mark, so
//!    two rules disagreeing has to resolve somewhere, and the order the user can
//!    see and drag is the only resolution that is explainable. That is why
//!    `filters.json` is saved wholesale — the order is data.
//!
//! Everything here works on a `MailHeader`, which is what both call sites hold:
//! the sync loop (for a message that was *just* added) and the "apply to mail I
//! already have" command. One matcher, so a rule cannot behave one way live and
//! another way on a re-run.

use crate::schema::mail::{
    MailFilterField, MailFilterHit, MailFilterRule, MailHeader, MailPriority,
};

/// Longest term we will compare. A pathological rule (a pasted email body as a
/// "word") would otherwise be scanned against every message.
const MAX_TERM_LEN: usize = 200;

/// Is `term` present in `hay`? Both are already lowercased by the caller.
///
/// With `whole_word`, a hit must sit between non-alphanumeric characters — the
/// boundary is defined on `char::is_alphanumeric` rather than on ASCII, so
/// `Grüße` is one word and not two. Note that the boundary is *not* applied to a
/// term that ends in punctuation (`@acme.`): its own last character is already a
/// boundary, so the check reduces to "the text after it does not continue the
/// word", which is exactly what the user meant by typing the dot.
pub fn contains_term(hay: &str, term: &str, whole_word: bool) -> bool {
    if term.is_empty() || term.len() > MAX_TERM_LEN {
        return false;
    }
    if !whole_word {
        return hay.contains(term);
    }
    let bytes_before_ok = |idx: usize| -> bool {
        hay[..idx]
            .chars()
            .next_back()
            .map(|c| !c.is_alphanumeric())
            .unwrap_or(true)
    };
    let bytes_after_ok = |idx: usize| -> bool {
        hay[idx..]
            .chars()
            .next()
            .map(|c| !c.is_alphanumeric())
            .unwrap_or(true)
    };
    let mut from = 0usize;
    while let Some(rel) = hay[from..].find(term) {
        let start = from + rel;
        let end = start + term.len();
        // A term whose own edge is already punctuation carries its boundary with
        // it; requiring one on the text side too would refuse `@acme.` in
        // `@acme.example`, which is the shape people actually type.
        let left_ok = term
            .chars()
            .next()
            .map(|c| !c.is_alphanumeric())
            .unwrap_or(false)
            || bytes_before_ok(start);
        let right_ok = term
            .chars()
            .next_back()
            .map(|c| !c.is_alphanumeric())
            .unwrap_or(false)
            || bytes_after_ok(end);
        if left_ok && right_ok {
            return true;
        }
        // Advance past this occurrence's first char, not past the whole match:
        // overlapping occurrences are rare but real, and skipping them would
        // make a match depend on where an earlier non-match happened to be.
        from = start + hay[start..].chars().next().map(char::len_utf8).unwrap_or(1);
    }
    false
}

/// The lowercased text of one field of a message.
///
/// The sender and recipient fields fold the display **name** in beside the
/// address on purpose. A display name is attacker-chosen and is never identity
/// (`MailList` refuses to show one without its addr-spec for exactly that
/// reason) — but a *filter term* is not an identity claim: the user asking for
/// mail "from Acme" wants the name matched, and the mark it sets is a local list
/// they can see, not a trust decision.
pub fn field_text(header: &MailHeader, field: MailFilterField) -> String {
    match field {
        MailFilterField::Subject => header.subject.to_lowercase(),
        MailFilterField::Sender => {
            let mut s = header.from.address.clone();
            if let Some(name) = &header.from.name {
                s.push(' ');
                s.push_str(name);
            }
            s.to_lowercase()
        }
        MailFilterField::Recipients => {
            let mut s = String::new();
            for addr in header.to.iter().chain(header.cc.iter()) {
                s.push_str(&addr.address);
                s.push(' ');
                if let Some(name) = &addr.name {
                    s.push_str(name);
                    s.push(' ');
                }
            }
            s.to_lowercase()
        }
        MailFilterField::Preview => header.preview.to_lowercase(),
    }
}

/// Does this one rule match, and on which term/field?
///
/// Returns the **first** term/field pair that hit, which is what the UI quotes
/// back. With `match_all` every term must be found *somewhere* in the rule's
/// fields — not all in the same one, since "invoice" in the subject and the
/// sender's domain in the address is precisely the combination people write.
pub fn rule_hit(rule: &MailFilterRule, header: &MailHeader) -> Option<MailFilterHit> {
    if !rule.enabled {
        return None;
    }
    if let Some(want) = rule.account_id.as_deref() {
        if want != header.account_id {
            return None;
        }
    }
    // Both empties mean "matches nothing" — see the module header.
    if rule.terms.is_empty() || rule.fields.is_empty() {
        return None;
    }

    let texts: Vec<(MailFilterField, String)> = rule
        .fields
        .iter()
        .map(|f| (*f, field_text(header, *f)))
        .collect();

    let mut first: Option<MailFilterHit> = None;
    for raw in &rule.terms {
        let term = raw.trim().to_lowercase();
        if term.is_empty() {
            // A blank entry is a UI artefact, not a wildcard. Under `any` it
            // must not match; under `all` it must not veto the whole rule.
            continue;
        }
        let found = texts
            .iter()
            .find(|(_, text)| contains_term(text, &term, rule.whole_word));
        match found {
            Some((field, _)) => {
                if first.is_none() {
                    first = Some(MailFilterHit {
                        rule_id: rule.id.clone(),
                        rule_name: rule.name.clone(),
                        mark: rule.mark,
                        term: raw.trim().to_string(),
                        field: *field,
                    });
                }
                if !rule.match_all {
                    return first;
                }
            }
            None if rule.match_all => return None,
            None => {}
        }
    }
    first
}

/// The first rule in `rules` that matches — the mark a new message gets.
pub fn first_hit(rules: &[MailFilterRule], header: &MailHeader) -> Option<MailFilterHit> {
    rules.iter().find_map(|r| rule_hit(r, header))
}

/// Would a mark be *set* here? Separated from [`first_hit`] because both call
/// sites share the same refusal: **a message that already carries a mark is left
/// alone**. The user's own right-click always outranks a rule, and on a re-run
/// (apply-to-existing, or a re-sync that re-adds a message) a rule that
/// overwrote would keep resurrecting a filing the user had corrected.
pub fn mark_for(
    rules: &[MailFilterRule],
    header: &MailHeader,
) -> Option<(MailPriority, MailFilterHit)> {
    if header.priority.is_some() {
        return None;
    }
    first_hit(rules, header).map(|hit| (hit.mark, hit))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::mail::MailAddress;

    fn header(subject: &str, from: &str, name: Option<&str>, preview: &str) -> MailHeader {
        MailHeader {
            id: "f-1".into(),
            account_id: "acct".into(),
            folder_id: "f".into(),
            uid: 1,
            rfc_message_id: None,
            subject: subject.into(),
            from: MailAddress {
                name: name.map(str::to_string),
                address: from.into(),
            },
            to: vec![MailAddress {
                name: None,
                address: "me@example.org".into(),
            }],
            cc: Vec::new(),
            date: "2026-07-29T10:00:00Z".into(),
            seen: false,
            flagged: false,
            answered: false,
            has_attachments: false,
            size: 10,
            preview: preview.into(),
            malformed_headers: None,
            auth: None,
            priority: None,
            priority_source: None,
            priority_reason: None,
        }
    }

    fn rule(terms: &[&str], fields: &[MailFilterField]) -> MailFilterRule {
        MailFilterRule {
            id: "r1".into(),
            name: "Rule".into(),
            terms: terms.iter().map(|s| s.to_string()).collect(),
            fields: fields.to_vec(),
            mark: MailPriority::Urgent,
            match_all: false,
            whole_word: false,
            account_id: None,
            enabled: true,
            extra: Default::default(),
        }
    }

    #[test]
    fn matches_subject_case_insensitively() {
        let h = header("Your INVOICE is ready", "billing@acme.example", None, "");
        let r = rule(&["invoice"], &[MailFilterField::Subject]);
        let hit = rule_hit(&r, &h).expect("should match");
        assert_eq!(hit.term, "invoice");
        assert_eq!(hit.field, MailFilterField::Subject);
        assert_eq!(hit.mark, MailPriority::Urgent);
    }

    #[test]
    fn matches_non_ascii_case() {
        let h = header("RECHNUNG für Juli", "b@acme.example", None, "");
        let r = rule(&["rechnung"], &[MailFilterField::Subject]);
        assert!(rule_hit(&r, &h).is_some());
    }

    #[test]
    fn sender_covers_address_and_display_name() {
        let h = header("hi", "noreply@acme.example", Some("Acme Billing"), "");
        assert!(rule_hit(&rule(&["@acme.example"], &[MailFilterField::Sender]), &h).is_some());
        assert!(rule_hit(&rule(&["acme billing"], &[MailFilterField::Sender]), &h).is_some());
        // …and does not leak into a field the rule did not ask for.
        assert!(rule_hit(&rule(&["acme"], &[MailFilterField::Subject]), &h).is_none());
    }

    #[test]
    fn recipients_cover_to_and_cc() {
        let mut h = header("hi", "a@b.example", None, "");
        h.cc = vec![MailAddress {
            name: None,
            address: "oncall@team.example".into(),
        }];
        assert!(rule_hit(&rule(&["oncall@"], &[MailFilterField::Recipients]), &h).is_some());
    }

    #[test]
    fn preview_is_searchable() {
        let h = header("hi", "a@b.example", None, "The server room is on fire");
        assert!(rule_hit(&rule(&["fire"], &[MailFilterField::Preview]), &h).is_some());
    }

    #[test]
    fn empty_terms_or_fields_match_nothing() {
        let h = header("anything at all", "a@b.example", None, "body");
        assert!(rule_hit(&rule(&[], &[MailFilterField::Subject]), &h).is_none());
        assert!(rule_hit(&rule(&["anything"], &[]), &h).is_none());
        // A blank entry is not a wildcard either.
        assert!(rule_hit(&rule(&["   "], &[MailFilterField::Subject]), &h).is_none());
    }

    #[test]
    fn disabled_rule_never_matches() {
        let h = header("invoice", "a@b.example", None, "");
        let mut r = rule(&["invoice"], &[MailFilterField::Subject]);
        r.enabled = false;
        assert!(rule_hit(&r, &h).is_none());
    }

    #[test]
    fn account_scope_is_honoured() {
        let h = header("invoice", "a@b.example", None, "");
        let mut r = rule(&["invoice"], &[MailFilterField::Subject]);
        r.account_id = Some("other".into());
        assert!(rule_hit(&r, &h).is_none());
        r.account_id = Some("acct".into());
        assert!(rule_hit(&r, &h).is_some());
    }

    #[test]
    fn whole_word_stops_substring_hits() {
        let h = header("start the meeting", "a@b.example", None, "");
        let mut r = rule(&["art"], &[MailFilterField::Subject]);
        assert!(rule_hit(&r, &h).is_some(), "substring by default");
        r.whole_word = true;
        assert!(rule_hit(&r, &h).is_none(), "boundary refuses 'start'");
        let h2 = header("the art of it", "a@b.example", None, "");
        assert!(rule_hit(&r, &h2).is_some());
    }

    #[test]
    fn whole_word_still_matches_a_punctuated_term() {
        // The term carries its own left boundary; the text continues the word on
        // the right, which is the case a naive boundary check would refuse.
        let h = header("from noreply@acme.example today", "x@y.example", None, "");
        let mut r = rule(&["@acme."], &[MailFilterField::Subject]);
        r.whole_word = true;
        assert!(rule_hit(&r, &h).is_some());
    }

    #[test]
    fn match_all_spans_fields() {
        let h = header("Invoice 42", "billing@acme.example", None, "");
        let mut r = rule(
            &["invoice", "@acme.example"],
            &[MailFilterField::Subject, MailFilterField::Sender],
        );
        r.match_all = true;
        let hit = rule_hit(&r, &h).expect("both terms are present, in two fields");
        assert_eq!(hit.term, "invoice", "reports the first term that hit");

        r.terms.push("missing".into());
        assert!(rule_hit(&r, &h).is_none(), "all means all");
    }

    #[test]
    fn first_matching_rule_wins_in_list_order() {
        let h = header("Urgent invoice", "a@b.example", None, "");
        let mut broad = rule(&["invoice"], &[MailFilterField::Subject]);
        broad.id = "broad".into();
        broad.mark = MailPriority::Important;
        let mut narrow = rule(&["urgent"], &[MailFilterField::Subject]);
        narrow.id = "narrow".into();
        narrow.mark = MailPriority::Urgent;

        let rules = vec![narrow.clone(), broad.clone()];
        assert_eq!(first_hit(&rules, &h).unwrap().rule_id, "narrow");
        let rules = vec![broad, narrow];
        assert_eq!(first_hit(&rules, &h).unwrap().rule_id, "broad");
    }

    #[test]
    fn an_existing_mark_is_never_overwritten() {
        let mut h = header("invoice", "a@b.example", None, "");
        let rules = vec![rule(&["invoice"], &[MailFilterField::Subject])];
        assert!(mark_for(&rules, &h).is_some());
        h.priority = Some(MailPriority::Important);
        assert!(
            mark_for(&rules, &h).is_none(),
            "the user's own filing outranks a rule"
        );
    }

    #[test]
    fn absurdly_long_terms_are_refused() {
        let h = header("x", "a@b.example", None, &"a".repeat(1000));
        let r = rule(&["a"], &[MailFilterField::Preview]);
        assert!(rule_hit(&r, &h).is_some());
        let long = "a".repeat(MAX_TERM_LEN + 1);
        let r = rule(&[long.as_str()], &[MailFilterField::Preview]);
        assert!(rule_hit(&r, &h).is_none());
    }
}
