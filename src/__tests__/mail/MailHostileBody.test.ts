/**
 * The frontend half of the hostile-message end-to-end check.
 *
 * `src-tauri/tests/mail_hostile_message.rs` drives one message carrying ~40
 * payloads through `parse_message` → `sanitize_message_html` and writes the
 * result to `fixtures/hostile_sanitized_body.html`. A Rust test asserts that
 * file is byte-identical to what the pipeline produces today, so what is
 * checked here is the **real** backend output rather than a hand-written
 * approximation that could drift into being easier than the real thing.
 *
 * What this file adds is the last leg: that same output going through the
 * render path — the tripwire that guards it, and the srcdoc it lands in.
 *
 * Regenerate the fixture with:
 *   UPDATE_HOSTILE_FIXTURE=1 cargo test --manifest-path src-tauri/Cargo.toml \
 *     --test it mail_hostile_message
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";
import { bodyLooksUnsafe, buildMessageSrcdoc, MAIL_FRAME_CSP } from "../../lib/mail";

const BODY: string = readFileSync(
  "src/__tests__/fixtures/hostile_sanitized_body.html",
  "utf8",
);

describe("the sanitized hostile body reaches the frame", () => {
  it("is not what the tripwire is looking for", () => {
    // Both directions matter. A tripwire that fired here would replace the
    // whole message with the error card — and this body is what the sanitizer
    // is *supposed* to produce, so firing on it would mean every hostile
    // message becomes an error card instead of a readable, defanged one.
    expect(bodyLooksUnsafe(BODY)).toBe(false);
  });

  it("still fires if the backend regressed on this very body", () => {
    // The positive control for the assertion above: the tripwire being quiet
    // must mean "this body is clean", not "this tripwire never fires".
    expect(bodyLooksUnsafe(BODY.replace("<img>", '<img src=x onerror=alert(1)>'))).toBe(true);
    expect(bodyLooksUnsafe(BODY.replace("<a class=", '<a href="https://evil.example" class='))).toBe(
      true,
    );
    expect(bodyLooksUnsafe(`${BODY}<script>alert(1)</script>`)).toBe(true);
  });
});

describe("the srcdoc the body renders in", () => {
  const doc = buildMessageSrcdoc({ html: BODY });

  it("carries the frozen CSP and no-referrer", () => {
    expect(doc).toContain(MAIL_FRAME_CSP);
    expect(MAIL_FRAME_CSP).toContain("default-src 'none'");
    expect(MAIL_FRAME_CSP).toContain("script-src 'none'");
    expect(MAIL_FRAME_CSP).toContain("form-action 'none'");
    expect(MAIL_FRAME_CSP).toContain("base-uri 'none'");
    expect(MAIL_FRAME_CSP).toContain("sandbox");
    expect(doc).toContain('<meta name="referrer" content="no-referrer">');
  });

  it("contains nothing that can execute, navigate or fetch", () => {
    const lower = doc.toLowerCase();
    for (const bad of [
      "<script",
      "<iframe",
      "<object",
      "<embed",
      "<form",
      "<input",
      "<base",
      "<link",
      "<svg",
      "<math",
      "javascript:",
      "vbscript:",
      "srcset",
      "formaction",
      "src=http",
      'src="http',
      "src='http",
      "evil.example/",
      "tracker.example",
    ]) {
      expect(lower, `srcdoc must not contain ${bad}`).not.toContain(bad);
    }
    // The one `href` in the document is the CSP/style scaffolding's absence —
    // there must be none at all, in our chrome or the message.
    expect(/\shref\s*=/i.test(doc)).toBe(false);
  });

  it("keeps the message readable", () => {
    // A frame that renders nothing would pass every assertion above.
    expect(doc).toContain("Your account needs attention");
    expect(doc).toContain("Security Team");
    expect(doc).toContain("data-lid=");
  });
});

/**
 * **A known residue, characterized rather than asserted as desirable.**
 *
 * Bidi format controls are stripped from the subject, from attachment names and
 * from the *link table's* display text (`anchor_text_at` → `is_format_char`),
 * which is what the link-confirm dialog reads. They are **not** stripped from
 * the message body, so an anchor's visible text inside the frame can still
 * reorder itself — `bank.example<RLO>gnp.exe` reads as `bank.exampleexe.png`.
 *
 * It is inert (no href, so the body text is not clickable at all) and the
 * decision surface — the links panel and its confirm dialog — is clean. What it
 * can do is make body prose lie about itself. If body-side stripping is added
 * later, this test is the place that says what changed.
 */
describe("bidi controls in body text", () => {
  it("survive in the frame, though not in the link panel", () => {
    expect(BODY).toContain("‮");
    expect(buildMessageSrcdoc({ html: BODY })).toContain("‮");
  });
});
