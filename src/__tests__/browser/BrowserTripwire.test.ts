/**
 * The in-app browser's frontend tripwires (#61).
 *
 * The rule, borrowed from the mail client: **every defence the browser depends
 * on has a test that fails if someone deletes it.** These are deliberately
 * mechanical — several of them read the components as *text* — because the
 * things they guard are absences, and an absence has nothing to unit-test. The
 * value is that a future edit which quietly adds `allow-scripts`, a
 * `dangerouslySetInnerHTML`, a path parameter, or a live-page button on a build
 * that cannot host one becomes a red build rather than a code-review argument.
 *
 * Design rationale: `docs/browser_plan_b.md` §12.5.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync, readdirSync } from "node:fs";

import {
  READER_FRAME_CSP,
  REASON_KEYS,
  SCHEME_REASON_PREFIX,
  buildReaderSrcdoc,
  errorPhrase,
  formatAddressParts,
  liveControlAvailable,
  readerLooksUnsafe,
  reasonPhrase,
  securityTone,
  titleToTabLabel,
} from "../../lib/browser";
import { LANGUAGES, translate } from "../../lib/i18n";
import { MAIL_FRAME_CSP, bodyLooksUnsafe } from "../../lib/mail";
import { routeUri } from "../../lib/linkTarget";
import type { BrowserCapabilities } from "../../types/browser";

const BROWSER_DIR = "src/components/browser";

/**
 * Strip comments before scanning for a *forbidden* token.
 *
 * These files document the rules they obey, by name — the reader-view header
 * says in so many words that `allow-scripts` must never be added, and that is
 * the most useful sentence in the file. A scan that counted prose would force
 * every such rule to be written in euphemisms, which is precisely how the reason
 * for a defence gets lost. So: forbidden-token scans run over code only;
 * positive assertions ("this call site exists") run over the whole file.
 *
 * Block comments go wholesale; line comments are matched at the start of a line
 * (after indentation) so a `https://…` inside a string literal survives.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

function browserSources(): Array<[string, string]> {
  return (readdirSync(BROWSER_DIR) as string[])
    .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
    .map((f) => [f, codeOnly(readFileSync(`${BROWSER_DIR}/${f}`, "utf8") as string)]);
}

const LIB_BROWSER: string = readFileSync("src/lib/browser.ts", "utf8");
const READER_VIEW: string = readFileSync(`${BROWSER_DIR}/BrowserReaderView.tsx`, "utf8");
const READER_VIEW_CODE: string = codeOnly(READER_VIEW);
const PANE: string = readFileSync(`${BROWSER_DIR}/BrowserPane.tsx`, "utf8");

describe("no unsanitized HTML ever reaches the DOM", () => {
  it("no browser component uses dangerouslySetInnerHTML", () => {
    for (const [name, src] of browserSources()) {
      expect(
        src.includes("dangerouslySetInnerHTML"),
        `${name} must not set innerHTML — a fetched page renders in the sandboxed frame or not at all`,
      ).toBe(false);
    }
  });

  it("the reader frame carries sandbox=\"\" with no tokens", () => {
    // `sandbox=""` is the whole policy: no allow-scripts (JS is disabled by the
    // sandbox, not merely by the sanitizer) and no allow-same-origin (the two
    // together are a total escape into the app origin's __TAURI__).
    expect(READER_VIEW_CODE).toContain('sandbox=""');
    for (const token of [
      "allow-scripts",
      "allow-same-origin",
      "allow-top-navigation",
      "allow-popups",
      "allow-forms",
      "allow-modals",
      "allow-downloads",
      "allow-presentation",
      "allow-pointer-lock",
    ]) {
      expect(READER_VIEW_CODE.includes(token), `sandbox must not gain ${token}`).toBe(false);
    }
  });

  it("the render path is gated by the sanitizer tripwire", () => {
    expect(READER_VIEW_CODE).toContain("readerLooksUnsafe");
    // It must be the mail client's function, not a second, differently-parsing
    // one: two allowlists drift, and mismatched parse semantics are a known
    // mutation-XSS source.
    expect(readerLooksUnsafe).toBe(bodyLooksUnsafe);
  });

  it("refuses to build a document from live markup", () => {
    expect(readerLooksUnsafe('<p>hi</p><script>alert(1)</script>')).toBe(true);
    expect(readerLooksUnsafe('<a href="https://evil.example">x</a>')).toBe(true);
    expect(readerLooksUnsafe("<p>a documentation page about href= attributes</p>")).toBe(false);
  });
});

describe("the reader frame's CSP", () => {
  it("is the mail constant itself, not a copy", () => {
    expect(READER_FRAME_CSP).toBe(MAIL_FRAME_CSP);
  });

  it("names no network scheme in any fetch directive", () => {
    // Reader mode must never be "fixed" by letting the frame reach the network:
    // remote content is a backend proxy that inlines `data:` URIs, or it does
    // not happen.
    expect(READER_FRAME_CSP).not.toMatch(/https?:/);
    expect(READER_FRAME_CSP).toContain("default-src 'none'");
    expect(READER_FRAME_CSP).toContain("script-src 'none'");
  });

  it("puts the CSP meta before anything that could load", () => {
    const doc = buildReaderSrcdoc({ html: "<p>x</p>", title: "t" });
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<div"));
    expect(doc).toContain('<meta name="referrer" content="no-referrer">');
  });

  it("escapes the page title into the document", () => {
    const doc = buildReaderSrcdoc({ html: "", title: '<img src=x onerror=alert(1)>' });
    expect(doc).not.toContain("<img");
    expect(doc).toContain("&lt;img");
  });
});

describe("the capability boundary: no command names a path", () => {
  // The same statement `src/types/mail.ts` makes, enforced the same mechanical
  // way. An attacker who controls a page's bytes, its filename and its declared
  // type still has no IPC verb that names a destination.
  const RESERVED = [
    "path",
    "paths",
    "dest",
    "destination",
    "dir",
    "directory",
    "file",
    "filename",
    "fileName",
    "cwd",
    "root",
    "target",
    "location",
    "glob",
  ];

  it("no browser_* invoke passes a filesystem-shaped argument", () => {
    // Every `invoke("browser_…", { … })` argument object in the wrapper module.
    const calls = LIB_BROWSER.match(/invoke(?:<[^>]*>)?\(\s*"browser_[a-z_]+"[^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const args = /\{([^}]*)\}/.exec(call)?.[1] ?? "";
      const names = args
        .split(",")
        .map((part) => part.split(":")[0].trim())
        .filter(Boolean);
      for (const name of names) {
        expect(
          RESERVED.includes(name),
          `${call} passes "${name}" — no browser command may name a filesystem path`,
        ).toBe(false);
      }
    }
  });

  it("the download decision carries an opaque id and a boolean, nothing else", () => {
    expect(LIB_BROWSER).toContain('invoke<DownloadOutcome>("browser_download_decide", { downloadId, accept })');
  });

  it("lib/browser.ts is the only place that invokes a browser_* command", () => {
    // The convention `src/lib/mail.ts` established: one typed wrapper per
    // command, and no component invokes directly. It is what makes the path-free
    // scan above cover the whole feature rather than one file.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true }) as Array<{
        name: string;
        isDirectory: () => boolean;
      }>) {
        const full = `${dir}/${entry.name}`;
        // The wrapper module is the one legitimate home; the tests quote the
        // call sites they assert on, so they are not evidence of anything.
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__") walk(full);
        } else if (/\.tsx?$/.test(entry.name) && full !== "src/lib/browser.ts") {
          const src: string = readFileSync(full, "utf8");
          if (/invoke(?:<[^>]*>)?\(\s*"browser_/.test(codeOnly(src))) offenders.push(full);
        }
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
  });

  it("no browser component imports a filesystem or dialog plugin", () => {
    for (const [name, src] of browserSources()) {
      expect(src.includes("@tauri-apps/plugin-fs"), `${name}`).toBe(false);
      expect(src.includes("@tauri-apps/plugin-dialog"), `${name}`).toBe(false);
    }
  });
});

describe("reader mode is the default for untrusted origins", () => {
  const base = {
    setting: "in_app" as const,
    browserEnabled: true,
    mailEnabled: true,
  };

  it("a link from mail, a terminal, an agent or a viewer opens in reader and may not go live", () => {
    for (const origin of ["mail", "terminal", "agent", "viewer", "filetree"] as const) {
      const target = routeUri("https://example.com/doc", { ...base, origin });
      expect(target.kind).toBe("in_app");
      if (target.kind !== "in_app") continue;
      expect(target.mode).toBe("reader");
      // The whole point: untrusted content chose this destination, so the tab it
      // lands in must not offer a one-click path to a live engine.
      expect(target.allowLive).toBe(false);
    }
  });

  it("a URL the user typed may offer the live control", () => {
    const target = routeUri("https://example.com/", { ...base, origin: "address_bar" });
    expect(target.kind).toBe("in_app");
    if (target.kind !== "in_app") return;
    expect(target.mode).toBe("reader");
    expect(target.allowLive).toBe(true);
  });

  it("an explicit gesture is the only thing that opens a live page", () => {
    const gesture = routeUri("https://example.com/", {
      ...base,
      origin: "terminal",
      explicit: "live",
    });
    expect(gesture).toEqual({
      kind: "in_app",
      url: "https://example.com/",
      mode: "live",
      allowLive: true,
    });
  });
});

describe("the live-page control", () => {
  const caps = (live: boolean): BrowserCapabilities => ({
    live_windows_supported: live,
    reader_supported: true,
  });

  it("is unavailable when the backend says live windows are not supported", () => {
    expect(liveControlAvailable(caps(false))).toBe(false);
    expect(liveControlAvailable(null)).toBe(false);
    expect(liveControlAvailable(caps(true))).toBe(true);
  });

  it("is rendered behind that capability, not behind a platform check", () => {
    // Hidden, not disabled: a control that will lie is never rendered.
    expect(codeOnly(PANE)).toContain("liveControlAvailable");
    expect(codeOnly(PANE)).toMatch(/canGoLive\s*&&/);
    // A frontend platform check would be a second source of truth that drifts
    // away from what the backend actually refuses.
    expect(codeOnly(PANE)).not.toContain("IS_WINDOWS");
    expect(codeOnly(PANE)).not.toContain("navigator.platform");
  });

  it("has no bounds/visibility plumbing left over from the cancelled native view", () => {
    // Plan C proved an in-pane child webview is impossible under WebKitGTK, so
    // there is no view to keep glued to a rect and no suppression refcount.
    for (const [name, src] of browserSources()) {
      expect(src.includes("browser_view_"), `${name}`).toBe(false);
      expect(src.includes("set_bounds"), `${name}`).toBe(false);
    }
  });
});

describe("the address bar tells the truth", () => {
  it("takes the host from the parser, not from a string search", () => {
    const parts = formatAddressParts("https://example.com@evil.example/login");
    expect(parts.host).toBe("evil.example");
    expect(parts.userinfo).toBe("example.com@");
  });

  it("never shortens the host, however long the URL", () => {
    const host = `${"a".repeat(120)}.example.com`;
    const parts = formatAddressParts(`https://${host}/${"b".repeat(400)}`);
    expect(parts.host).toBe(host);
    expect(parts.host).not.toContain("…");
  });

  it("renders unparseable text verbatim and emphasizes nothing", () => {
    const parts = formatAddressParts("not a url at all");
    expect(parts.raw).toBe(true);
    expect(parts.host).toBe("");
  });

  it("strips bidi controls from a page's title before it becomes a tab label", () => {
    const label = titleToTabLabel("example.com ‮ gnp.exe");
    expect(label).not.toContain("‮");
  });

  it("caps a title at 60 characters", () => {
    expect(titleToTabLabel("x".repeat(400))).toHaveLength(60);
  });
});

describe("the security chip renders what it is given", () => {
  const state = (tls: string) => ({
    tls: tls as "secure",
    scheme: "https",
    host_display: "example.com",
    vpn_active: false,
  });

  it("degrades an unrecognized state to unknown, never to secure", () => {
    expect(securityTone(state("secure"))).toBe("secure");
    expect(securityTone(state("insecure"))).toBe("insecure");
    expect(securityTone(state("something-new"))).toBe("unknown");
    expect(securityTone(null)).toBe("unknown");
  });
});

describe("the frozen contract holds across the IPC boundary", () => {
  const RUST_CMDS: string = readFileSync("src-tauri/src/commands/browser.rs", "utf8");
  const RUST_SCHEMA: string = readFileSync("src-tauri/src/schema/browser.rs", "utf8");

  it("every command the frontend invokes exists in the backend, and vice versa", () => {
    // Two halves written in parallel by two people compile independently and
    // still fail at runtime if a name drifts by a character — `tsc` and `cargo`
    // between them prove nothing about this.
    const invoked = new Set(
      Array.from(LIB_BROWSER.matchAll(/invoke(?:<[^>]*>)?\(\s*"(browser_[a-z_]+)"/g)).map(
        (m) => m[1],
      ),
    );
    const declared = new Set(
      Array.from(RUST_CMDS.matchAll(/pub async fn (browser_[a-z_]+)\s*\(/g)).map((m) => m[1]),
    );
    expect(invoked.size).toBe(8);
    expect([...invoked].sort()).toEqual([...declared].sort());

    // …and each one is registered with Tauri, or the invoke rejects at runtime.
    const lib: string = readFileSync("src-tauri/src/lib.rs", "utf8");
    for (const cmd of invoked) {
      expect(lib, `${cmd} is not in generate_handler!`).toContain(`commands::browser::${cmd}`);
    }
  });

  it("every event the frontend listens for is emitted by the backend", () => {
    const listened = Array.from(
      LIB_BROWSER.matchAll(/listen<[^>]*>\(\s*"(browser:[a-z-]+)"/g),
    ).map((m) => m[1]);
    expect(listened.sort()).toEqual([
      "browser:blocked",
      "browser:download-requested",
      "browser:live-closed",
      "browser:live-state",
    ]);
    for (const ev of listened) {
      expect(RUST_CMDS, `${ev} is never emitted`).toContain(`"${ev}"`);
    }
  });

  it("the argument the one non-trivial command takes is camelCase on the wire", () => {
    // Tauri lowercases an invoke argument name into snake_case on the Rust side,
    // so `downloadId` here is `download_id` there. Spelling it `download_id` in
    // TS is the classic silent-undefined bug.
    expect(LIB_BROWSER).toContain("{ downloadId, accept }");
    expect(RUST_CMDS).toContain("download_id: String");
    expect(LIB_BROWSER).not.toContain("{ download_id");
  });

  it("every wire field the frontend reads exists on the Rust struct", () => {
    // Field-for-field, because these are serde-serialized structs rendered
    // verbatim: a renamed field is `undefined` at runtime and renders as a blank,
    // which is the worst failure mode for a *security* readout.
    const fields: Record<string, string[]> = {
      UrlVerdict: ["allowed", "reason", "display_url", "punycode_warning", "scheme", "is_loopback"],
      SecurityState: ["tls", "scheme", "host_display", "punycode_warning", "vpn_active"],
      ReaderPage: [
        "requested_url",
        "final_url",
        "display_url",
        "title",
        "html",
        "security",
        "truncated",
        "blocked_remote_assets",
      ],
      DownloadRequest: ["download_id", "file_name", "mime_type", "size_bytes", "sniff_mismatch"],
      DownloadOutcome: ["saved", "file_name"],
      BlockedNavigation: ["display_url", "reason", "window_label"],
      LiveWindowRef: ["label", "display_url"],
      LiveWindowState: ["label", "display_url", "title", "security", "loading"],
      BrowserCapabilities: ["live_windows_supported", "reader_supported", "platform_note"],
    };
    const types: string = readFileSync("src/types/browser.ts", "utf8");
    for (const [name, keys] of Object.entries(fields)) {
      const rustBlock = new RegExp(`pub struct ${name} \\{([\\s\\S]*?)\\n\\}`).exec(RUST_SCHEMA);
      expect(rustBlock, `Rust struct ${name} is gone`).not.toBeNull();
      const tsBlock = new RegExp(`interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(types);
      expect(tsBlock, `TS interface ${name} is gone`).not.toBeNull();
      for (const key of keys) {
        expect(rustBlock![1], `${name}.${key} missing in Rust`).toContain(`pub ${key}:`);
        expect(tsBlock![1], `${name}.${key} missing in TS`).toMatch(
          new RegExp(`\\b${key}\\??:`),
        );
      }
    }
    // The enum the security chip renders verbatim, lowercased by serde.
    expect(RUST_SCHEMA).toContain('#[serde(rename_all = "lowercase")]');
    expect(types).toContain('tls: "secure" | "insecure" | "unknown"');
  });
});

describe("no machine token ever reaches the user", () => {
  /**
   * The canonical token list, **read out of the Rust source**.
   *
   * This is the point of the whole test: the backend deliberately speaks in
   * stable machine tokens (`app-origin`, `redirect-to-link-local`) so the
   * wording can live in `i18n.ts` in five languages. That split is only safe if
   * the two halves cannot drift apart — and drift here is not cosmetic, it is a
   * user being shown `redirect-to-link-local` at the exact moment they most need
   * a sentence. `services::web_safety::REASON_TOKENS` is the contract; a Rust
   * test proves it covers every `BlockReason`/`ConfirmReason` variant, and this
   * one proves every entry in it has a phrase.
   */
  function rustReasonTokens(): string[] {
    const src: string = readFileSync("src-core/src/services/web_safety.rs", "utf8");
    const decl = /pub const REASON_TOKENS: &\[&str\] = &\[([\s\S]*?)\n\];/.exec(src);
    expect(decl, "REASON_TOKENS is gone from web_safety.rs").not.toBeNull();
    const tokens = Array.from(decl![1].matchAll(/"([^"]+)"/g)).map((m) => m[1]);
    expect(tokens.length).toBeGreaterThan(10);
    return tokens;
  }

  it("every reason token the backend can emit has an English phrase", () => {
    for (const token of rustReasonTokens()) {
      // `scheme:` is the one prefix token — the gate appends the offending
      // scheme to it, so it is matched by prefix and interpolated.
      const sample = token === SCHEME_REASON_PREFIX ? `${token}file` : token;
      const phrase = reasonPhrase(sample);
      expect(
        phrase.key,
        `"${sample}" has no phrase — add it to REASON_KEYS in src/lib/browser.ts`,
      ).not.toBe("browser.reasonUnknown");
      expect(
        translate("en", phrase.key, phrase.vars),
        `${phrase.key} is missing from i18n's en dictionary`,
      ).not.toBe(phrase.key);
    }
  });

  it("every phrase it maps to exists in all five languages", () => {
    const keys = [...Object.values(REASON_KEYS), "browser.reasonScheme", "browser.reasonUnknown"];
    for (const key of keys) {
      for (const { value } of LANGUAGES) {
        const out = translate(value, key as never, { scheme: "file", token: "x" });
        expect(out, `${key} unresolved in ${value}`).not.toBe(key);
        expect(out.length).toBeGreaterThan(0);
      }
    }
  });

  it("an unknown token degrades to a sentence that still carries it", () => {
    // Never a bare identifier in front of the user — but never hidden either, or
    // a bug report becomes impossible.
    const phrase = reasonPhrase("something-invented-later");
    expect(phrase.key).toBe("browser.reasonUnknown");
    expect(translate("en", phrase.key, phrase.vars)).toContain("something-invented-later");
    // An empty reason is a generic sentence, not an empty line.
    expect(reasonPhrase("").key).toBe("browser.blockedGeneric");
  });

  it("the backend's typed errors become words too", () => {
    expect(errorPhrase("http-status:404").vars).toEqual({ status: "404" });
    expect(errorPhrase("unsupported-content-type:application/pdf").vars).toEqual({
      type: "application/pdf",
    });
    expect(errorPhrase("fetch-failed: connection refused").vars).toEqual({
      detail: "connection refused",
    });
    expect(errorPhrase("browser-unsupported-platform").key).toBe("browser.errorUnsupported");
    // `browser_open_live` rejects with a bare reason token, so the error path has
    // to understand those as well.
    expect(errorPhrase("scheme:file").key).toBe("browser.reasonScheme");
    expect(errorPhrase("app-origin").key).toBe("browser.reasonAppOrigin");
    for (const { value } of LANGUAGES) {
      const p = errorPhrase("fetch-failed: x");
      expect(translate(value, p.key, p.vars)).not.toBe(p.key);
    }
  });

  it("the blocked notice renders the phrase, never the raw token", () => {
    const src: string = readFileSync(`${BROWSER_DIR}/BrowserBlockedNotice.tsx`, "utf8");
    expect(codeOnly(src)).toContain("reasonPhrase");
    expect(
      /\{\s*blocked\.reason\s*\}/.test(codeOnly(src)),
      "BrowserBlockedNotice must not render `reason` as a text node",
    ).toBe(false);
    // Same for the pane's error strips.
    expect(codeOnly(PANE)).toContain("errorPhrase");
    expect(/\{\s*state\.error\s*\}/.test(codeOnly(PANE))).toBe(false);
    expect(/\{\s*liveError\s*\}/.test(codeOnly(PANE))).toBe(false);
  });
});

describe("a private address is a question, not a silent yes", () => {
  it("the notice grows an 'open anyway' button only when one is offered", () => {
    // The gate has three outcomes and the wire type has two fields:
    // `allowed: true` WITH a reason means "reachable, but tell the user first".
    // A hard block must still have no override at all.
    const src: string = codeOnly(
      readFileSync(`${BROWSER_DIR}/BrowserBlockedNotice.tsx`, "utf8"),
    );
    expect(src).toContain("onProceed");
    expect(src).toContain("browser.confirmProceed");
    // The button is rendered behind `onProceed &&`, so a block (which passes
    // none) cannot show it.
    expect(src).toMatch(/onProceed\s*&&/);
  });

  it("the pane parks the confirmation instead of fetching", () => {
    const src = codeOnly(PANE);
    expect(src).toContain("state.confirm");
    expect(src).toContain("acceptConfirm");
    expect(src).toContain("cancelConfirm");
    // And the live-page button goes through the same gate, so it cannot be the
    // way around the question the reader path asks.
    expect(src).toContain("requestLive");
    expect(src).not.toMatch(/getState\(\)\.openLive\(/);
  });

  it("the store only fetches after the confirmation is answered", () => {
    const src: string = codeOnly(readFileSync("src/stores/browser.ts", "utf8"));
    // The `allowed && reason` branch must return before `browserReaderFetch`.
    const confirmAt = src.indexOf("mode: \"reader\"");
    const fetchAt = src.indexOf("browserReaderFetch(url)");
    expect(confirmAt).toBeGreaterThan(0);
    expect(fetchAt).toBeGreaterThan(confirmAt);
  });
});

describe("a live window's refusal is attributed to that window", () => {
  it("the event carries a window label end to end", () => {
    const rust: string = readFileSync("src-tauri/src/commands/browser.rs", "utf8");
    // Every emit site names its window (the Rust suite asserts this too; this
    // side asserts the frontend was given something to route on).
    expect(rust).toContain("window_label");
    const types: string = readFileSync("src/types/browser.ts", "utf8");
    expect(types).toContain("window_label?: string");
    const store: string = codeOnly(readFileSync("src/stores/browser.ts", "utf8"));
    expect(store).toContain("blocked.window_label");
    expect(store).toContain("liveBlocked");
  });
});

describe("origin emphasis: a documented v1 limitation", () => {
  /**
   * Plan B §7.1 rule 1 wants the **registrable domain** (eTLD+1) emphasized. It
   * is not implemented, deliberately and in both halves:
   *
   *  - the frontend refuses to guess, because the two-label heuristic bolds
   *    `co.uk` for `shop.example.co.uk` — which that same section calls worse
   *    than not bolding at all;
   *  - the backend declined to adopt the `psl` crate, because `registrable()`
   *    is shared with the mail client's phishing check and changing it would
   *    change decisions cached under `SANITIZER_VERSION` — a mail change wearing
   *    a browser change's clothes.
   *
   * So v1 emphasizes the **whole host** and mutes everything else, and the
   * contract carries no `registrable` field. This test is the record of that
   * decision: it fails if a two-label guess is ever quietly introduced, and it is
   * what a future PSL upgrade has to change on purpose.
   */
  it("emphasizes the whole host, and never a two-label guess", () => {
    const parts = formatAddressParts("https://shop.example.co.uk/cart?x=1");
    expect(parts.host).toBe("shop.example.co.uk");
    // The failure this guards against: bolding `co.uk`.
    expect(parts.host).not.toBe("co.uk");
    expect(parts.host).not.toBe("example.co.uk");
    expect(parts.scheme).toBe("https://");
    expect(parts.rest).toBe("/cart?x=1");
  });

  it("the contract still carries no registrable-domain field", () => {
    const types: string = readFileSync("src/types/browser.ts", "utf8");
    expect(types).not.toContain("registrable");
    const rust: string = readFileSync("src-tauri/src/schema/browser.rs", "utf8");
    expect(rust).not.toContain("registrable");
  });

  it("mail's registrable() is untouched, so its cached decisions still hold", () => {
    // The reason the browser did not upgrade it. If this ever changes,
    // SANITIZER_VERSION has to change with it.
    const rust: string = readFileSync("src-core/src/services/web_safety.rs", "utf8");
    expect(rust).toContain("pub fn registrable(");
    expect(rust).not.toContain("psl::");
  });
});

describe("the untested pill is present", () => {
  it("the pane, the start page, the security popover and the download dialog carry it", () => {
    for (const file of [
      "BrowserPane.tsx",
      "BrowserStartPage.tsx",
      "BrowserSecurityChip.tsx",
      "BrowserDownloadDialog.tsx",
    ]) {
      const src: string = readFileSync(`${BROWSER_DIR}/${file}`, "utf8");
      expect(src.includes("UntestedTag"), `${file} must carry the untested pill`).toBe(true);
    }
  });
});

describe("live pages are opt-in, and stay opt-in", () => {
  /**
   * The one browser switch that must be OFF in a debug build too.
   *
   * Every other experimental flag follows "unset means on in debug", which is
   * right for a surface that is merely unfinished and wrong for this one: a live
   * page can reach a loopback service by way of any hostname that resolves
   * there, and `ws://` reaches one regardless of the scheme allowlist because a
   * WebSocket is not a navigation. Neither is fixable from app code. A debug
   * build is what the author runs all day, so `useExperimental` here would mean
   * the risky surface is on for exactly the person most likely to click it.
   */
  it("the settings toggle does not read the experimental gate", () => {
    const src: string = readFileSync("src/components/layout/SettingsPanel.tsx", "utf8");
    // The toggle's label, not the bare key: the settings search index names
    // the key first, well above the control.
    const row = src.slice(src.indexOf('label={t("settings.browserLivePages")}'));
    const toggle = row.slice(0, row.indexOf("/>") + 2);
    expect(
      toggle.includes("browser_live_pages: e.target.checked"),
      "the toggle must write the real setting",
    ).toBe(true);
    expect(
      /useExperimental|experimentalOn/.test(toggle),
      "live pages must NOT ride the experimental gate — unset must mean off, " +
        "including in a debug build",
    ).toBe(false);
    expect(
      toggle.includes("?? false"),
      "the checkbox must default to off when the setting is unset",
    ).toBe(true);
  });

  /**
   * The backend refuses `browser_open_live` without the opt-in and says so with
   * its own token. If that token has no phrase, a user who clicks the control
   * before turning the setting on is shown `browser-live-pages-disabled`, which
   * reads like a crash rather than an answer.
   */
  it("the backend's refusal is a sentence in every language", () => {
    const phrase = errorPhrase("browser-live-pages-disabled");
    expect(phrase.key).toBe("browser.errorLiveDisabled");
    for (const { value } of LANGUAGES) {
      const text: string = translate(value, phrase.key, phrase.vars);
      expect(text, `${value} must translate ${phrase.key}`).not.toBe(phrase.key);
      expect(text.length, `${value}'s phrase must not be empty`).toBeGreaterThan(0);
    }
  });

  /** Distinct from the platform refusal — different cause, different action. */
  it("is not conflated with the unsupported-platform refusal", () => {
    expect(errorPhrase("browser-unsupported-platform").key).toBe("browser.errorUnsupported");
    expect(errorPhrase("browser-live-pages-disabled").key).toBe("browser.errorLiveDisabled");
  });

  /**
   * The backend folds "this platform cannot" and "you have not asked for it"
   * into one bool, because the frontend's only question is whether to offer the
   * control. Either reason must hide it.
   */
  it("the control is hidden whenever the backend says live windows are unavailable", () => {
    const off: BrowserCapabilities = {
      live_windows_supported: false,
      reader_supported: true,
      platform_note: "Live pages are off.",
    };
    expect(liveControlAvailable(off)).toBe(false);
    expect(liveControlAvailable({ ...off, live_windows_supported: true })).toBe(true);
  });
});
