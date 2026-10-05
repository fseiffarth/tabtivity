import ReactDOM from "react-dom/client";
import { Terminal } from "./screens/Terminal";
import "./style.css";
import "./themes.css";
import { BRAND } from "../../src/lib/brand";

// Escape sequences on purpose: the reading view renders the colours the
// program emitted, so a fixture without them exercises none of that path.
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const OFF = "\u001b[0m";
const GREEN = "\u001b[32m";
const CYAN = "\u001b[36m";
const MAGENTA = "\u001b[35m";

const AGENT_OUTPUT = [
  `${MAGENTA}›${OFF} Build a phone-first terminal wrapper with readable output`,
  "",
  `${CYAN}● Read${OFF}(mobile-web/src/screens/Terminal.tsx)`,
  `  ${DIM}⎿  Read 525 lines${OFF}`,
  "",
  `${BOLD}Mobile terminal wrapper${OFF}`,
  "The Focus view keeps the exact terminal running while presenting the session at the phone's own width.",
  "Colour, emphasis, and wrapping come from the session itself — nothing is classified or renamed.",
  "",
  "Here is what it does:",
  "  1. Rejoins the rows tmux wrapped.",
  "  2. Keeps the colours the program sent.",
  "  3. Never offers an answer it inferred.",
  "",
  `  ${DIM}const view = connected ? "focus" : "terminal";${OFF}`,
  "",
  `${GREEN}✓${OFF} Completed the readable output pass`,
  "",
  `${MAGENTA}›${OFF} Now lay it out like a chat: my prompts on the right,`,
  "  the agent on the left",
  "",
  "Done — each echoed prompt is a bubble on the right, the rest stays as printed.",
  "",
  "╭────────────────────────────────────────────────────────────╮",
  "│ >                                                          │",
  "╰────────────────────────────────────────────────────────────╯",
  `  ${DIM}~/projects/${BRAND.slug} (develop) · Opus 4.1 · plan mode on (shift+tab to cycle) · 85% context left${OFF}`,
].join("\r\n");

const SHELL_OUTPUT = [
  `dev@workstation:~/project${BRAND.slug}$ npm test`,
  "",
  ` RUN  v4.1.8 /home/dev/projects/project${BRAND.slug}`,
  " ✓ MobileReadableScreen.test.ts (11 tests)",
  " ✓ MobileTerminalVoice.test.tsx (5 tests)",
  "",
  " Test Files  2 passed (2)",
  "      Tests  16 passed (16)",
  "",
  `dev@workstation:~/project${BRAND.slug}$ git status --short --untracked-files=all`,
  " M mobile-web/src/screens/Terminal.tsx",
  "?? mobile-web/src/terminal/readableScreen.ts",
  `dev@workstation:~/project${BRAND.slug}$ `,
].join("\r\n");

class PreviewWebSocket {
  static readonly OPEN = 1;
  readyState = PreviewWebSocket.OPEN;
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null = null;

  constructor() {
    queueMicrotask(() => this.onopen?.());
  }

  send(value: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (typeof value !== "string" || !value.includes('"type":"ready"')) return;
    const source = new URLSearchParams(location.search).get("kind") === "shell" ? SHELL_OUTPUT : AGENT_OUTPUT;
    const encoded = new TextEncoder().encode(source);
    const payload = new ArrayBuffer(encoded.byteLength);
    new Uint8Array(payload).set(encoded);
    this.onmessage?.(new MessageEvent("message", { data: payload }));
  }

  close() {
    this.readyState = 3;
  }
}

class PreviewSpeechRecognition {
  static available() { return Promise.resolve("available" as const); }
  continuous = false;
  interimResults = false;
  lang = "";
  maxAlternatives = 1;
  onstart: (() => void) | null = null;
  onresult = null;
  onerror = null;
  onend: (() => void) | null = null;
  start() { this.onstart?.(); }
  stop() { this.onend?.(); }
  abort() { this.onend?.(); }
}

const previewDevelopment = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV;
if (!previewDevelopment) {
  throw new Error("The terminal preview is development-only");
}

Object.defineProperty(window, "WebSocket", { configurable: true, value: PreviewWebSocket });
Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: PreviewSpeechRecognition });

const kind = new URLSearchParams(location.search).get("kind") === "shell" ? "shell" : "agent";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <Terminal
    tab={{
      id: `preview-${kind}`,
      label: kind === "agent" ? "Codex · Mobile wrapper" : "Project shell",
      kind,
      available: true,
      viewer_busy: false,
    }}
    back={() => {}}
  />,
);

// Firefox's command-line screenshot is taken as soon as the load event fires.
// Keep this development-only module pending long enough for React effects,
// xterm writes, and the throttled reading-view frame to reach first paint.
await new Promise((resolve) => window.setTimeout(resolve, 900));
