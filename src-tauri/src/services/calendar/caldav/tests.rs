use super::*;

const HOME_LISTING: &str = r#"<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"
               xmlns:CS="http://calendarserver.org/ns/"
               xmlns:IC="http://apple.com/ns/ical/">
  <D:response>
    <D:href>/calendars/user/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype><D:displayname>Home</D:displayname></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/calendars/user/personal/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>Personal</D:displayname>
        <IC:calendar-color>#4aa3dfff</IC:calendar-color>
        <CS:getctag>ctag-42</CS:getctag>
        <C:supported-calendar-component-set>
          <C:comp name="VEVENT"/><C:comp name="VTODO"/>
        </C:supported-calendar-component-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
    <D:propstat>
      <D:prop><D:sync-token/></D:prop>
      <D:status>HTTP/1.1 404 Not Found</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

#[test]
fn parses_a_home_listing_and_keeps_only_calendars() {
    let base = Url::parse("https://dav.example.org/calendars/user/").unwrap();
    let parsed = parse_multistatus(HOME_LISTING).unwrap();
    assert_eq!(parsed.responses.len(), 2);

    let calendars: Vec<CalDavCollection> = parsed
        .responses
        .iter()
        .filter(|r| r.is_calendar())
        .filter_map(|r| collection_from(&base, r))
        .collect();
    assert_eq!(
        calendars.len(),
        1,
        "the home collection itself is not a calendar"
    );
    let cal = &calendars[0];
    assert_eq!(cal.href, "https://dav.example.org/calendars/user/personal/");
    assert_eq!(cal.display_name, "Personal");
    assert_eq!(cal.color, "#4aa3dfff");
    assert_eq!(cal.ctag, "ctag-42");
    assert_eq!(cal.components, vec!["VEVENT", "VTODO"]);
}

#[test]
fn a_404_propstat_is_an_absent_property_not_a_failure() {
    let parsed = parse_multistatus(HOME_LISTING).unwrap();
    let cal = parsed.responses.iter().find(|r| r.is_calendar()).unwrap();
    assert!(
        cal.text(NS_DAV, "sync-token").is_none(),
        "a property answered 404 must not be read as present-and-empty"
    );
    assert_eq!(cal.text(NS_CALSERVER, "getctag"), Some("ctag-42"));
}

#[test]
fn privileges_decide_read_only_and_silence_asserts_nothing() {
    let shared = r#"<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/calendars/other/shared/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:current-user-privilege-set>
          <D:privilege><D:read/></D:privilege>
        </D:current-user-privilege-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;
    let base = Url::parse("https://dav.example.org/").unwrap();
    let parsed = parse_multistatus(shared).unwrap();
    let cal = collection_from(&base, &parsed.responses[0]).unwrap();
    assert!(
        cal.read_only,
        "read-only privileges are a fact the server stated"
    );

    // A server that reports no privileges at all asserts nothing — the
    // field stays false rather than claiming writability either way.
    let silent = parse_multistatus(HOME_LISTING).unwrap();
    let cal = silent
        .responses
        .iter()
        .find(|r| r.is_calendar())
        .and_then(|r| collection_from(&base, r))
        .unwrap();
    assert!(!cal.read_only);
}

#[test]
fn a_writable_collection_is_not_flagged_read_only() {
    let xml = r#"<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/calendars/me/personal/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:current-user-privilege-set>
          <D:privilege><D:read/></D:privilege>
          <D:privilege><D:write-content/></D:privilege>
          <D:privilege><D:bind/></D:privilege>
        </D:current-user-privilege-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;
    let base = Url::parse("https://dav.example.org/").unwrap();
    let parsed = parse_multistatus(xml).unwrap();
    assert!(
        !collection_from(&base, &parsed.responses[0])
            .unwrap()
            .read_only
    );
}

#[test]
fn parses_a_calendar_query_report_with_inline_data() {
    let xml = r#"<?xml version="1.0" encoding="utf-8" ?>
<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/calendars/user/personal/abc.ics</href>
    <propstat>
      <prop>
        <getetag>"etag-1"</getetag>
        <c:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:abc
DTSTART:20260708T090000Z
SUMMARY:standup
END:VEVENT
END:VCALENDAR
</c:calendar-data>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>"#;
    let base = Url::parse("https://dav.example.org/calendars/user/personal/").unwrap();
    let parsed = parse_multistatus(xml).unwrap();
    let changes = changes_from(&base, &base, &parsed, false).unwrap();
    assert_eq!(changes.resources.len(), 1);
    let res = &changes.resources[0];
    assert_eq!(
        res.href,
        "https://dav.example.org/calendars/user/personal/abc.ics"
    );
    assert_eq!(res.etag, "\"etag-1\"");
    assert!(res.data.starts_with("BEGIN:VCALENDAR"));
    assert!(res.data.contains("SUMMARY:standup"));
    assert!(changes.removed.is_empty());
}

#[test]
fn sync_collection_reports_deletions_as_404_stubs() {
    let xml = r#"<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/cal/kept.ics</D:href>
    <D:propstat>
      <D:prop><D:getetag>"e2"</D:getetag><C:calendar-data>BEGIN:VCALENDAR
END:VCALENDAR</C:calendar-data></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/cal/gone.ics</D:href>
    <D:status>HTTP/1.1 404 Not Found</D:status>
  </D:response>
  <D:sync-token>http://example.com/sync/2</D:sync-token>
</D:multistatus>"#;
    let base = Url::parse("https://dav.example.org/cal/").unwrap();
    let parsed = parse_multistatus(xml).unwrap();
    assert_eq!(
        parsed.sync_token.as_deref(),
        Some("http://example.com/sync/2")
    );
    let changes = changes_from(&base, &base, &parsed, true).unwrap();
    assert_eq!(changes.resources.len(), 1);
    assert_eq!(
        changes.resources[0].href,
        "https://dav.example.org/cal/kept.ics"
    );
    assert_eq!(
        changes.removed,
        vec!["https://dav.example.org/cal/gone.ics"]
    );
    assert!(changes.incremental);
}

#[test]
fn an_etag_without_data_is_kept_for_the_multiget_pass() {
    let xml = r#"<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/cal/one.ics</D:href>
    <D:propstat><D:prop><D:getetag>"e"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
</D:multistatus>"#;
    let base = Url::parse("https://dav.example.org/cal/").unwrap();
    let changes = changes_from(&base, &base, &parse_multistatus(xml).unwrap(), true).unwrap();
    assert_eq!(changes.resources.len(), 1);
    assert!(
        changes.resources[0].data.is_empty(),
        "an empty body must survive to the multiget pass, not be dropped"
    );
}

#[test]
fn the_principal_and_home_set_chain_reads_hrefs() {
    let xml = r#"<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/</d:href>
    <d:propstat>
      <d:prop><d:current-user-principal><d:href>/principals/users/me/</d:href></d:current-user-principal></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>"#;
    let parsed = parse_multistatus(xml).unwrap();
    let resp = parsed.responses.first().unwrap();
    assert_eq!(
        resp.href_in(NS_DAV, "current-user-principal"),
        Some("/principals/users/me/")
    );
    let base = Url::parse("https://dav.example.org/").unwrap();
    assert_eq!(
        absolute(
            &base,
            resp.href_in(NS_DAV, "current-user-principal").unwrap()
        )
        .as_deref(),
        Some("https://dav.example.org/principals/users/me/")
    );
}

#[test]
fn a_login_page_is_an_error_not_an_empty_calendar() {
    // The failure this check exists for: an expired session or an SSO
    // redirect answers 200 with HTML, and "parsed zero events" is
    // indistinguishable from a calendar that is genuinely empty.
    let err = parse_multistatus("<html><body>Please log in</body></html>").unwrap_err();
    assert!(err.contains("multistatus"), "{err}");
}

#[test]
fn a_non_xml_body_fails_loudly() {
    assert!(parse_multistatus("not xml at all").is_err());
}

#[test]
fn request_bodies_are_well_formed_xml() {
    for body in [
        body_current_user_principal(),
        body_calendar_home_set(),
        body_collection_props(),
        body_collection_props_minimal(),
        body_change_tokens(),
        body_probe(),
        body_calendar_query("VEVENT"),
        body_multiget(&["/cal/a.ics".to_string(), "/cal/b&c.ics".to_string()]),
        body_sync_collection("http://example.com/sync/1"),
    ] {
        Document::parse(&body).unwrap_or_else(|e| panic!("body is not valid XML: {e}\n{body}"));
    }
}

#[test]
fn a_token_with_xml_syntax_in_it_is_escaped() {
    let body = body_sync_collection("tok&<en>");
    assert!(body.contains("tok&amp;&lt;en&gt;"));
    Document::parse(&body).unwrap();
}

#[test]
fn a_bare_host_gets_https_never_http() {
    assert_eq!(
        normalize_base_url("cal.example.org/dav").unwrap().as_str(),
        "https://cal.example.org/dav"
    );
    // An explicit http:// is refused with the fixed code (E2b), the
    // self-hosted-on-localhost case included.
    for raw in ["http://localhost:5232/", "http://dav.example.org/", "HTTP://dav.example.org/"] {
        let err = normalize_base_url(raw).unwrap_err();
        assert!(err.starts_with(HTTP_REFUSED), "{raw}: {err}");
    }
    assert!(normalize_base_url("ftp://example.org").is_err());
    assert!(normalize_base_url("   ").is_err());
}

fn u(s: &str) -> Url {
    Url::parse(s).unwrap()
}

#[test]
fn credentials_ride_a_hop_inside_the_same_origin() {
    let from = u("https://dav.example.org/dav/");
    assert!(credentials_may_follow(
        &from,
        &u("https://dav.example.org/dav/me/")
    ));
    assert!(credentials_may_follow(
        &from,
        &u("https://dav.example.org/other")
    ));
    // A different port is a different service, whoever runs it.
    assert!(!credentials_may_follow(
        &from,
        &u("https://dav.example.org:8443/dav/")
    ));
}

#[test]
fn credentials_ride_the_well_known_hop_down_into_a_subdomain() {
    // RFC 6764's own shape: the user types the bare domain, and
    // `/.well-known/caldav` redirects to the DAV host.
    let from = u("https://example.org/.well-known/caldav");
    assert!(credentials_may_follow(
        &from,
        &u("https://caldav.example.org/dav/")
    ));
    assert!(credentials_may_follow(
        &from,
        &u("https://a.b.example.org/dav/")
    ));
}

#[test]
fn credentials_never_ride_a_hop_to_another_host() {
    let from = u("https://dav.example.org/dav/");
    // The attack this whole check exists for.
    assert!(!credentials_may_follow(
        &from,
        &u("https://evil.example/dav/")
    ));
    // Suffix matching must not be substring matching.
    assert!(!credentials_may_follow(
        &from,
        &u("https://notdav.example.org.evil.test/")
    ));
    assert!(!credentials_may_follow(
        &from,
        &u("https://evilexample.org/")
    ));
}

#[test]
fn credentials_ride_to_a_sibling_host_under_the_same_registrable_domain() {
    // The iCloud shape (decision 2026-10-13): the account names one host,
    // the principal and calendars live on a per-user sibling.
    let from = u("https://caldav.example.com/");
    assert!(credentials_may_follow(
        &from,
        &u("https://p42-caldav.example.com/123/calendars/")
    ));
    assert!(credentials_may_follow(&from, &u("https://example.com/dav/")));
    assert!(credentials_may_follow(&from, &u("https://a.b.example.com/")));
    // A different registrable domain is refused, however alike it looks.
    assert!(!credentials_may_follow(&from, &u("https://p42-caldav.example.net/")));
    assert!(!credentials_may_follow(&from, &u("https://caldav.example.com.evil.test/")));
    // Over http on either end: never another host.
    assert!(!credentials_may_follow(&from, &u("http://p42-caldav.example.com/")));
    // Another port on a sibling machine is another service; 443 is the
    // https service of that host.
    assert!(!credentials_may_follow(&from, &u("https://p42-caldav.example.com:8443/")));
    let odd = u("https://caldav.example.com:8443/");
    assert!(credentials_may_follow(&odd, &u("https://p42-caldav.example.com:8443/")));
    assert!(credentials_may_follow(&odd, &u("https://p42-caldav.example.com/")));
    assert!(!credentials_may_follow(&odd, &u("https://p42-caldav.example.com:9443/")));
    // The same host keeps the same-origin rule: its other ports are not ours.
    assert!(!credentials_may_follow(&odd, &u("https://caldav.example.com/")));
}

#[test]
fn the_registrable_domain_comes_from_the_public_suffix_list() {
    // `example.co.uk` never covers the rest of `.co.uk`.
    let uk = u("https://dav.example.co.uk/");
    assert!(credentials_may_follow(&uk, &u("https://p1.example.co.uk/")));
    assert!(!credentials_may_follow(&uk, &u("https://evil.co.uk/")));
    assert!(!credentials_may_follow(&uk, &u("https://co.uk/")));
    assert_eq!(registrable_domain("dav.example.co.uk").as_deref(), Some("example.co.uk"));
    // Private-section suffixes too: one user's pages are not another's.
    let gh = u("https://alice.github.io/dav/");
    assert!(!credentials_may_follow(&gh, &u("https://bob.github.io/")));
    assert!(!credentials_may_follow(&gh, &u("https://github.io/")));
    // A host that *is* a public suffix has no site: exact match only.
    assert_eq!(registrable_domain("co.uk"), None);
    let bare = u("https://co.uk/");
    assert!(!credentials_may_follow(&bare, &u("https://example.co.uk/")));
    assert!(credentials_may_follow(&bare, &u("https://co.uk/dav/")));
    // Wildcard rules (`*.ck`) and their exceptions (`!www.ck`).
    assert_eq!(registrable_domain("a.b.ck").as_deref(), Some("a.b.ck"));
    assert_eq!(registrable_domain("x.www.ck").as_deref(), Some("www.ck"));
    // An unknown TLD falls back to the `*` rule: its own site per name.
    assert_eq!(registrable_domain("dav.home.lan").as_deref(), Some("home.lan"));
    assert!(!credentials_may_follow(&u("https://dav.home.lan/"), &u("https://nas.lan/")));
    // Case is not identity.
    assert!(credentials_may_follow(&from_upper(), &u("https://p42-caldav.example.com/")));
}

fn from_upper() -> Url {
    u("https://CalDAV.Example.COM/")
}

#[test]
fn single_label_and_ip_hosts_match_only_exactly() {
    let local = u("https://nas/");
    assert_eq!(registrable_domain("nas"), None);
    assert!(credentials_may_follow(&local, &u("https://nas/dav/")));
    assert!(!credentials_may_follow(&local, &u("https://dav.nas/")));
    assert!(!credentials_may_follow(&u("https://localhost:5232/"), &u("https://sub.localhost:5232/")));

    let v4 = u("https://192.0.2.10/dav/");
    assert!(credentials_may_follow(&v4, &u("https://192.0.2.10/other")));
    assert!(!credentials_may_follow(&v4, &u("https://192.0.2.11/")));
    assert!(!credentials_may_follow(&v4, &u("https://192.0.2.10.example.com/")));
    let v6 = u("https://[2001:db8::1]/dav/");
    assert!(credentials_may_follow(&v6, &u("https://[2001:db8::1]/x")));
    assert!(!credentials_may_follow(&v6, &u("https://[2001:db8::2]/")));
    // A domain account never covers an IP, nor the other way round.
    assert!(!credentials_may_follow(&u("https://dav.example.com/"), &u("https://192.0.2.10/")));
    // A trailing-dot spelling fails closed.
    assert!(!credentials_may_follow(&u("https://dav.example.com./"), &u("https://p1.example.com./")));
}

#[test]
fn an_http_ref_on_the_same_host_has_an_https_twin_and_nothing_else_does() {
    let origin = u("https://dav.example.com/");
    assert_eq!(
        https_twin("http://dav.example.com/cal/home/", &origin).as_deref(),
        Some("https://dav.example.com/cal/home/")
    );
    assert_eq!(
        https_twin("http://DAV.example.com:80/cal/", &origin).as_deref(),
        Some("https://dav.example.com/cal/")
    );
    // The account's own port, whatever the http one was.
    let odd = u("https://dav.example.com:8443/");
    assert_eq!(
        https_twin("http://dav.example.com:5232/cal/", &odd).as_deref(),
        Some("https://dav.example.com:8443/cal/")
    );
    assert_eq!(https_twin("http://other.example.com/cal/", &origin), None);
    assert_eq!(https_twin("https://dav.example.com/cal/", &origin), None);
    assert_eq!(https_twin("not a url", &origin), None);
    assert_eq!(https_twin("http://dav.example.com/cal/", &u("http://dav.example.com/")), None);
}

#[test]
fn credentials_never_ride_a_hop_off_tls() {
    assert!(!credentials_may_follow(
        &u("https://example.org/.well-known/caldav"),
        &u("http://caldav.example.org/dav/")
    ));
    // A self-hosted plaintext server keeps working *on its own origin* —
    // that is the localhost/Radicale case `normalize_base_url` honours — but
    // it earns no subdomain latitude, since the header is readable anyway.
    let local = u("http://localhost:5232/");
    assert!(credentials_may_follow(
        &local,
        &u("http://localhost:5232/dav/")
    ));
    assert!(!credentials_may_follow(
        &local,
        &u("http://sub.localhost:5232/")
    ));
}

#[test]
fn a_resource_name_is_a_single_safe_path_segment() {
    assert_eq!(resource_name("abc-123").unwrap(), "abc-123.ics");
    // A UID out of an imported file is text somebody else wrote.
    assert_eq!(resource_name("../../etc/passwd").unwrap(), "etc-passwd.ics");
    assert_eq!(resource_name("a b?c#d").unwrap(), "a-b-c-d.ics");
    // `..` is the name that must never reach a URL join, and the refusal has
    // to carry a sentence rather than be a bare error.
    assert!(!resource_name("..").unwrap_err().is_empty());
    assert!(resource_name("").is_err());
    assert!(resource_name("///").is_err());
    // Bounded, so a pathological UID cannot become a pathological URL.
    assert!(resource_name(&"x".repeat(4000)).unwrap().len() <= 124);
}

#[tokio::test]
async fn an_update_with_no_known_etag_is_refused_rather_than_sent_blind() {
    // **The** rule of the write half, and the one a "make it work" fix would
    // quietly remove: there is no unconditional `PUT`, not even as a fallback
    // for a server that returned no validator. The unconditional write is
    // precisely the one that destroys an edit made from a phone between the
    // read and the write, and does it silently.
    //
    // This reaches no network: the refusal happens while building the
    // condition header, before a client is even used.
    let cred = cred("https://dav.example.org/dav/");
    let err = put_resource(
        "https://dav.example.org/dav/me/personal/e1.ics",
        &cred,
        "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
        WriteCondition::Update(String::new()),
    )
    .await
    .unwrap_err();
    assert!(err.contains("sync the calendar"), "{err}");

    // A delete is the same rule: no ETag, no request.
    let err = delete_resource(
        "https://dav.example.org/dav/me/personal/e1.ics",
        &cred,
        "  ",
    )
    .await
    .unwrap_err();
    assert!(err.contains("sync the calendar"), "{err}");
}

#[test]
fn a_new_resource_lands_inside_its_collection() {
    assert_eq!(
        resource_url("https://dav.example.org/dav/me/personal/", "evt-1").unwrap(),
        "https://dav.example.org/dav/me/personal/evt-1.ics"
    );
    // A collection href without the trailing slash must not put the resource
    // *beside* the collection.
    assert_eq!(
        resource_url("https://dav.example.org/dav/me/personal", "evt-1").unwrap(),
        "https://dav.example.org/dav/me/personal/evt-1.ics"
    );
    // And a traversal-shaped uid cannot climb out of it.
    let out = resource_url("https://dav.example.org/dav/me/personal/", "../../x").unwrap();
    assert!(
        out.starts_with("https://dav.example.org/dav/me/personal/"),
        "{out}"
    );
}

#[test]
fn status_lines_yield_their_code() {
    assert_eq!(status_code("HTTP/1.1 200 OK"), Some(200));
    assert_eq!(status_code("HTTP/1.1 404 Not Found"), Some(404));
    assert_eq!(status_code("nonsense"), None);
}

#[test]
fn credentials_never_print_the_password() {
    let cred = Credentials::new(
        "someone".into(),
        "hunter2".into(), // privacy-check: ok — test fixture, never sent
        "https://dav.example.org/",
    )
    .unwrap();
    let shown = format!("{cred:?}");
    assert!(!shown.contains("hunter2"), "{shown}");
}

// ── The in-process transport (gap 26 / E2b tests) ──────────────────────
//
// `Dav::send` asks [`fake::answer`] first under `cfg(test)`. A thread-local
// handler is safe here: `#[tokio::test]` runs each test on one thread.

pub mod fake {
    use super::super::{StatusCode, Wire};
    use std::cell::RefCell;
    use std::sync::{Arc, Mutex};

    /// One request as the fake server saw it.
    #[derive(Debug, Clone)]
    pub struct Seen {
        pub method: String,
        pub url: String,
        pub auth: bool,
        pub body: String,
    }

    type Handler = Arc<dyn Fn(&Seen) -> Wire + Send + Sync>;
    type Log = Arc<Mutex<Vec<Seen>>>;

    thread_local! {
        static HANDLER: RefCell<Option<(Handler, Log)>> = const { RefCell::new(None) };
    }

    pub fn answer(req: &reqwest::Request) -> Option<Wire> {
        HANDLER.with(|slot| {
            let slot = slot.borrow();
            let (handler, log) = slot.as_ref()?;
            let seen = Seen {
                method: req.method().as_str().to_string(),
                url: req.url().to_string(),
                auth: req.headers().contains_key(reqwest::header::AUTHORIZATION),
                body: req
                    .body()
                    .and_then(|b| b.as_bytes())
                    .map(|b| String::from_utf8_lossy(b).into_owned())
                    .unwrap_or_default(),
            };
            log.lock().unwrap().push(seen.clone());
            Some(handler(&seen))
        })
    }

    /// Uninstalls the handler when dropped.
    pub struct Server(Log);

    impl Server {
        pub fn seen(&self) -> Vec<Seen> {
            self.0.lock().unwrap().clone()
        }
        /// Every request that reached a host.
        pub fn to_host(&self, host: &str) -> Vec<Seen> {
            self.seen()
                .into_iter()
                .filter(|s| reqwest::Url::parse(&s.url).unwrap().host_str() == Some(host))
                .collect()
        }
    }

    impl Drop for Server {
        fn drop(&mut self) {
            HANDLER.with(|slot| *slot.borrow_mut() = None);
        }
    }

    pub fn serve(handler: impl Fn(&Seen) -> Wire + Send + Sync + 'static) -> Server {
        let log: Log = Arc::default();
        HANDLER.with(|slot| *slot.borrow_mut() = Some((Arc::new(handler), log.clone())));
        Server(log)
    }

    pub fn reply(status: u16, body: &str) -> Wire {
        Wire {
            status: StatusCode::from_u16(status).unwrap(),
            location: None,
            etag: String::new(),
            body: body.as_bytes().to_vec(),
        }
    }

    pub fn redirect(to: &str) -> Wire {
        Wire {
            status: StatusCode::TEMPORARY_REDIRECT,
            location: Some(to.to_string()),
            etag: String::new(),
            body: Vec::new(),
        }
    }
}

fn cred(origin: &str) -> Credentials {
    Credentials::new(
        "me".into(),
        "pw".into(), // privacy-check: ok — test fixture, reaches no network
        origin,
    )
    .unwrap()
}

/// A Depth-0 probe answer naming a principal and/or a home set.
fn probe(principal: Option<&str>, home: Option<&str>) -> String {
    let mut props = String::new();
    if let Some(p) = principal {
        props.push_str(&format!(
            "<d:current-user-principal><d:href>{p}</d:href></d:current-user-principal>"
        ));
    }
    if let Some(h) = home {
        props.push_str(&format!("<c:calendar-home-set><d:href>{h}</d:href></c:calendar-home-set>"));
    }
    format!(
        r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
<d:response><d:href>/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype>{props}</d:prop>
<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#
    )
}

/// A home listing with one calendar per href.
fn listing(hrefs: &[&str]) -> String {
    let mut out = String::from(
        r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">"#,
    );
    for h in hrefs {
        out.push_str(&format!(
            r#"<d:response><d:href>{h}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>C</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"#
        ));
    }
    out.push_str("</d:multistatus>");
    out
}

/// A `calendar-query` answer with one resource per href.
fn resources(hrefs: &[&str]) -> String {
    let mut out = String::from(
        r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">"#,
    );
    for h in hrefs {
        out.push_str(&format!(
            r#"<d:response><d:href>{h}</d:href><d:propstat><d:prop><d:getetag>"e1"</d:getetag><c:calendar-data>BEGIN:VCALENDAR
END:VCALENDAR</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"#
        ));
    }
    out.push_str("</d:multistatus>");
    out
}

#[tokio::test]
async fn a_principal_on_another_host_is_refused_before_any_request_reaches_it() {
    let server = fake::serve(|req| {
        if req.url.starts_with("https://dav.example.org/") {
            fake::reply(207, &probe(Some("https://evil.example.net/principals/me/"), None))
        } else {
            fake::reply(207, &listing(&["/cal/"]))
        }
    });
    let err = discover("https://dav.example.org/dav/", &cred("https://dav.example.org/dav/"))
        .await
        .unwrap_err();
    assert!(err.contains("evil.example.net"), "{err}");
    assert!(server.to_host("evil.example.net").is_empty(), "{:?}", server.seen());
    assert!(server.seen().iter().all(|s| s.auth), "every request went to the origin");
}

#[tokio::test]
async fn an_icloud_shaped_principal_on_a_sibling_host_signs_in() {
    // Decision 2026-10-13: the account names `caldav.example.com`, the
    // server answers with a per-user sibling; same registrable domain, so
    // the login follows and the calendars there are listed.
    let server = fake::serve(|req| {
        if req.url.starts_with("https://caldav.example.com/") {
            fake::reply(207, &probe(Some("https://p42-caldav.example.com/42/principal/"), None))
        } else if req.url.contains("/principal/") {
            fake::reply(207, &probe(None, Some("https://p42-caldav.example.com/42/calendars/")))
        } else {
            fake::reply(207, &listing(&["/42/calendars/home/"]))
        }
    });
    let found = discover("https://caldav.example.com/", &cred("https://caldav.example.com/"))
        .await
        .unwrap();
    assert!(
        found.iter().any(|c| c.href == "https://p42-caldav.example.com/42/calendars/home/"),
        "{found:?}"
    );
    assert!(!server.to_host("p42-caldav.example.com").is_empty());
    assert!(server.seen().iter().all(|s| s.auth), "{:?}", server.seen());
}

#[tokio::test]
async fn a_home_set_on_another_host_is_refused_before_any_request_reaches_it() {
    let server = fake::serve(|_| {
        fake::reply(207, &probe(None, Some("https://evil.example.net/home/")))
    });
    let err = discover("https://dav.example.org/", &cred("https://dav.example.org/"))
        .await
        .unwrap_err();
    assert!(err.contains("evil.example.net"), "{err}");
    assert!(server.to_host("evil.example.net").is_empty());
}

#[tokio::test]
async fn a_redirect_target_naming_itself_principal_never_gets_the_password() {
    // Gap 26 (a): the host a redirect reached is asked without credentials,
    // and naming itself as the principal does not make it the origin.
    let server = fake::serve(|req| {
        if req.url.starts_with("https://dav.example.org/") {
            fake::redirect("https://evil.example.net/dav/")
        } else {
            fake::reply(207, &probe(Some("https://evil.example.net/principals/me/"), None))
        }
    });
    let err = discover("https://dav.example.org/dav/", &cred("https://dav.example.org/dav/"))
        .await
        .unwrap_err();
    assert!(err.contains("evil.example.net"), "{err}");
    let evil = server.to_host("evil.example.net");
    assert!(!evil.is_empty(), "the redirect itself is followed");
    assert!(evil.iter().all(|s| !s.auth), "{evil:?}");
    assert!(
        evil.iter().all(|s| !s.url.contains("/principals/")),
        "the self-named principal is never requested: {evil:?}"
    );
}

#[tokio::test]
async fn the_well_known_hop_into_a_subdomain_still_signs_in() {
    let server = fake::serve(|req| match req.url.as_str() {
        "https://example.org/" => fake::reply(404, ""),
        "https://example.org/.well-known/caldav" => fake::redirect("https://caldav.example.org/"),
        "https://caldav.example.org/" => fake::reply(207, &probe(Some("/p/me/"), None)),
        "https://caldav.example.org/p/me/" => fake::reply(207, &probe(None, Some("/home/"))),
        _ => fake::reply(207, &listing(&["/home/work/", "https://other.example.net/x/"])),
    });
    let found = discover("https://example.org/", &cred("https://example.org/")).await.unwrap();
    assert_eq!(found.len(), 1, "the off-origin calendar is dropped: {found:?}");
    assert_eq!(found[0].href, "https://caldav.example.org/home/work/");
    assert!(server.seen().iter().all(|s| s.auth));
}

#[tokio::test]
async fn a_listing_whose_calendars_all_sit_elsewhere_says_so() {
    let _server = fake::serve(|_| {
        fake::reply(207, &listing(&["https://evil.example.net/cal/", "http://dav.example.org/cal/"]))
    });
    let err = list_collections(
        &client().unwrap(),
        &Url::parse("https://dav.example.org/home/").unwrap(),
        &cred("https://dav.example.org/"),
    )
    .await
    .unwrap_err();
    assert!(err.contains("evil.example.net"), "{err}");
}

#[tokio::test]
async fn stored_hrefs_outside_the_origin_get_no_request() {
    let server = fake::serve(|_| fake::reply(207, &resources(&[])));
    let cred = cred("https://dav.example.org/dav/");
    // A collection on another host (gap 26), and one on http under an
    // https origin (gap 26 (b), E2b).
    let off = "https://evil.example.net/cal/";
    let plain = "http://dav.example.org/dav/cal/";
    assert!(fetch_all(off, &cred, &[]).await.unwrap_err().contains("evil.example.net"));
    assert!(fetch_all(plain, &cred, &[]).await.unwrap_err().starts_with(HTTP_REFUSED));
    assert!(fetch_changes(off, &cred, "t").await.is_err());
    assert!(change_tokens(plain, &cred).await.is_err());
    assert!(collection_read_only(off, &cred).await.is_err());
    let put = put_resource(
        &format!("{off}e.ics"),
        &cred,
        "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
        WriteCondition::Create,
    )
    .await;
    assert!(put.is_err());
    assert!(delete_resource(&format!("{plain}e.ics"), &cred, "\"e\"").await.is_err());
    assert_eq!(current_etag(&format!("{off}e.ics"), &cred).await.unwrap(), "");
    assert!(server.seen().is_empty(), "nothing was sent: {:?}", server.seen());
}

#[tokio::test]
async fn resources_outside_the_origin_are_never_stored() {
    // Not dropped either: a full listing is authoritative, so a dropped
    // resource would delete its local copy behind a "synced" status. The
    // read fails, naming the host.
    let _server = fake::serve(|req| {
        if req.body.contains("calendar-query") {
            fake::reply(207, &resources(&["/dav/cal/ok.ics", "https://evil.example.net/x.ics"]))
        } else {
            fake::reply(207, &listing(&[]))
        }
    });
    let err = fetch_all(
        "https://dav.example.org/dav/cal/",
        &cred("https://dav.example.org/dav/"),
        &["VEVENT".to_string()],
    )
    .await
    .unwrap_err();
    assert!(err.contains("evil.example.net"), "{err}");
}

#[tokio::test]
async fn a_listing_of_http_entries_fails_the_sync_instead_of_emptying_the_calendar() {
    // A TLS proxy in front of a server that builds absolute `http://` hrefs:
    // every entry is outside the origin. Read as "nothing there", the merge
    // would delete every local row and call it a success.
    let _server = fake::serve(|req| {
        if req.body.contains("calendar-query") {
            fake::reply(
                207,
                &resources(&["http://dav.example.org/dav/cal/a.ics", "http://dav.example.org/dav/cal/b.ics"]),
            )
        } else {
            fake::reply(207, &listing(&[]))
        }
    });
    let cred = cred("https://dav.example.org/dav/");
    let err = fetch_all("https://dav.example.org/dav/cal/", &cred, &["VEVENT".to_string()])
        .await
        .unwrap_err();
    assert!(err.starts_with(HTTP_REFUSED), "{err}");
}

#[tokio::test]
async fn a_read_redirected_off_the_origin_fails_rather_than_reading_empty() {
    // A read may follow a redirect bare; what that host lists resolves
    // against it and is outside the origin — an error, not an empty listing.
    let server = fake::serve(|req| {
        if req.url.starts_with("https://dav.example.org/") {
            fake::redirect("https://elsewhere.example.net/cal/")
        } else {
            fake::reply(207, &resources(&["/cal/a.ics"]))
        }
    });
    let err = fetch_all(
        "https://dav.example.org/dav/cal/",
        &cred("https://dav.example.org/dav/"),
        &["VEVENT".to_string()],
    )
    .await
    .unwrap_err();
    assert!(err.contains("elsewhere.example.net"), "{err}");
    assert!(server.to_host("elsewhere.example.net").iter().all(|s| !s.auth));
}

#[test]
fn a_deletion_stub_outside_the_origin_is_ignored() {
    let xml = r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
<d:response><d:href>https://evil.example.net/x.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>
<d:response><d:href>/dav/cal/gone.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>
<d:sync-token>t2</d:sync-token></d:multistatus>"#;
    let base = u("https://dav.example.org/dav/cal/");
    let got = changes_from(&base, &base, &parse_multistatus(xml).unwrap(), true).unwrap();
    assert_eq!(got.removed, ["https://dav.example.org/dav/cal/gone.ics"]);
}

#[tokio::test]
async fn a_redirect_to_http_is_refused_outright() {
    let server = fake::serve(|req| {
        if req.url.starts_with("https://") {
            fake::redirect("http://dav.example.org/dav/cal/")
        } else {
            fake::reply(207, &resources(&[]))
        }
    });
    let err = fetch_all("https://dav.example.org/dav/cal/", &cred("https://dav.example.org/dav/"), &[])
        .await
        .unwrap_err();
    assert!(err.starts_with(HTTP_REFUSED), "{err}");
    assert!(server.seen().iter().all(|s| s.url.starts_with("https://")));
}

#[tokio::test]
async fn a_write_redirected_off_the_origin_is_refused_not_sent_bare() {
    // A redirected PUT would carry the event itself to the other host.
    let server = fake::serve(|req| {
        if req.url.starts_with("https://dav.example.org/") {
            fake::redirect("https://evil.example.net/e.ics")
        } else {
            fake::reply(201, "")
        }
    });
    let err = put_resource(
        "https://dav.example.org/dav/cal/e.ics",
        &cred("https://dav.example.org/dav/"),
        "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
        WriteCondition::Create,
    )
    .await
    .unwrap_err();
    assert!(err.contains("evil.example.net"), "{err}");
    assert!(server.to_host("evil.example.net").is_empty());
    assert!(server.seen().iter().all(|s| s.method == "PUT" && s.auth));
}

#[test]
fn an_http_account_has_no_credentials_and_hrefs_check_the_origin() {
    let err = Credentials::new("me".into(), "x".into(), "http://dav.example.org/").unwrap_err();
    assert!(err.starts_with(HTTP_REFUSED), "{err}");
    let origin = u("https://example.org/");
    assert!(href_in_origin(&origin, "https://example.org/cal/"));
    assert!(href_in_origin(&origin, "https://caldav.example.org/cal/"));
    assert!(!href_in_origin(&origin, "http://example.org/cal/"));
    assert!(!href_in_origin(&origin, "https://example.net/cal/"));
    assert!(!href_in_origin(&origin, "https://evilexample.org/cal/"));
    assert!(!href_in_origin(&origin, "not a url"));
}

#[tokio::test]
async fn the_real_client_refuses_plain_http_before_connecting() {
    // The `https_only` backstop: a refusal at build time, not a connect
    // error (which is what the same request gets without it).
    let dav = client().unwrap();
    let req = dav.client.get("http://127.0.0.1:9/").build().unwrap();
    let err = dav.client.execute(req).await.unwrap_err();
    assert!(err.is_builder(), "{err:?}");
}

#[test]
fn the_client_builds() {
    // Proves the crypto provider is installed before rustls is first used:
    // rustls 0.23 panics rather than erroring when none is, and that panic
    // would happen on a user's machine at their first sync.
    client().unwrap();
}
