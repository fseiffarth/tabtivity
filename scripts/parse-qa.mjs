// Parse open 🖐️ manual-test boxes out of todo/group-*.md into qa-items.json.
//
//   node scripts/parse-qa.mjs [repo-root] [--os x11|wayland|windows|macos]
//                                            → writes ./qa-items.json
//
// The items feed the "Tabtivity QA Runner" page (see docs/start-qa-runner.sh):
// replace its <script id="qa-data" type="application/json"> block with this
// output, escaping "<" as \u003c. A box carries a "✅ Works on <platform>" and
// a "❌ Doesn't work on <platform>" child per platform; it is open on every
// platform whose ✅ is unticked (`openOs`; a ticked ❌ lands in `brokenOs` and
// stays open), and dropped once all ✅ or every step checkbox is ticked. With
// --os only boxes still open on that platform are kept. `needs` is a keyword guess used
// only to order the queue by setup cost.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import console from "node:console";

const args = process.argv.slice(2);
const osAt = args.indexOf("--os");
const ONLY_OS = osAt >= 0 ? args.splice(osAt, 2)[1] : null;
const ROOT = args[0] || ".";
// "✅ Works on <label>" / "❌ Doesn't work on <label>" → platform key. A legacy
// bare "✅ Works" counts for all.
const OS_KEYS = { "Linux (X11)": "x11", "Linux (Wayland)": "wayland", Windows: "windows", macOS: "macos" };
const ALL_OS = Object.values(OS_KEYS);
const files = fs.readdirSync(path.join(ROOT, "todo")).filter((f) => /^group-.*\.md$/.test(f)).sort();

const indentOf = (l) => l.match(/^\s*/)[0].length;
const clean = (s) => s.replace(/\s+/g, " ").trim();

const GROUP_NEEDS = { V: ["presenter"], X: ["caldav"], Z: ["server"], W: ["skills"], Q: ["mail", "gpu/ollama"] };
const NEED_RX = [
  ["windows", /\bwindows\b(?! manager)/i],
  ["macos", /\bmacos\b|\bmac\b/i],
  ["remote", /\bssh\b|\bsftp\b|remote host|live host|remote project|\bcluster\b|slurm|worker host|compute host/i],
  ["vpn", /openvpn|\bvpn\b/i],
  ["docker", /\bdocker\b|container/i],
  ["vm", /\bqemu\b|\bvm project|\bvm\b/i],
  ["gpu/ollama", /ollama|\bgpu\b/i],
  ["mail", /\bmail\b|\bimap\b|\bsmtp\b|inbox|\bpgp\b/i],
  ["caldav", /caldav/i],
  ["phone", /\bphone\b|tabtivity mobile|\bpwa\b|handset/i],
  ["2nd screen", /second (screen|monitor|display)|two (monitors|screens|displays)|projector|external (monitor|display)/i],
  ["server", /tabtivity server/i],
  ["presenter", /presenter|\bdeck\b/i],
  ["skills", /\bskills?\b/i],
  ["install", /fresh install|clean install|\binstaller\b|appimage/i],
  ["backend", /rebuild|restart|relaunch|backend/i],
];
const FLAG_RX = [["partial", /\bpartial\b/i], ["deferred", /\bdeferred\b/i], ["n/a", /\bn\/a\b/i], ["reverted", /\breverted\b/i]];

// An item start: numbered bold, bullet bold, or heading.
function itemStart(line) {
  let m;
  if ((m = line.match(/^(#{2,})\s+(.*)$/)) && !/^## Group /.test(line)) {
    const t = m[2].trim();
    const idm = t.match(/^([A-Z]\.\d+[a-z]?)\s*[—-]\s*(.*)$/);
    return { heading: true, indent: -1, num: idm ? idm[1] : null, title: idm ? idm[2] : t };
  }
  if ((m = line.match(/^(\s*)(\d+[a-z]?)\.\s+(?:[^\s*]{1,3}\s+)?\*\*(.+?)(?:\*\*|$)/))) {
    return { indent: m[1].length, num: m[2], title: m[3] };
  }
  if ((m = line.match(/^(\s*)- (?:\[[ x~]\] )?\*\*(.+?)(?:\*\*|$)/))) {
    if (/🖐|🤖/.test(line)) return null;
    let t = m[2];
    const idm = t.match(/^(\d+(?:\.\d+)?[a-z]*\d*)\s*[—-]\s*(.*)$/);
    return { indent: m[1].length, num: idm ? idm[1] : null, title: idm ? idm[2] : t };
  }
  return null;
}
const stripTitle = (t) => clean(t.replace(/[*`]/g, "").replace(/[.:]\s*$/, "").replace(/\s*\((DONE|✅)[^)]*\)\s*$/i, ""));

const firstClause = (h) => {
  const t = clean(h.replace(/[*`]/g, "").replace(/^\([^)]*\)\s*/, ""));
  let c = t.split(/(?<=[.;])\s|\s→\s|:\s/)[0];
  if (c.length < 24) c = t.split(/(?<=[.;])\s/)[0];
  return c.length > 90 ? c.slice(0, 88).replace(/\s+\S*$/, "") + " …" : c.replace(/[.;]$/, "");
};
const items = [];
const seen = {};
for (const f of files) {
  const rel = `todo/${f}`;
  const lines = fs.readFileSync(path.join(ROOT, "todo", f), "utf8").split("\n");
  const gm = lines[0].match(/^## Group ([A-Z]) — (.*)$/);
  if (!gm) continue;
  const [, G, groupTitle] = gm;

  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const mm = L.match(/^(\s*)- \[ \] 🖐️?\s*(.*)$/);
    if (!mm) continue;
    const ind = mm[1].length;

    // Children of the manual box (continuation text + step checkboxes).
    const cont = [], steps = [];
    const osTicked = new Set(), brokenOs = new Set();
    let j = i + 1;
    for (; j < lines.length; j++) {
      const c = lines[j];
      if (!c.trim()) break;
      if (indentOf(c) <= ind) break;
      const cm = c.match(/^\s*- \[([ x])\]\s*(.*)$/);
      if (cm) {
        const wm = cm[2].match(/^✅ Works(?: on (.+))?$/);
        if (wm) {
          if (cm[1] === "x") (wm[1] ? [OS_KEYS[wm[1]]] : ALL_OS).forEach((k) => k && osTicked.add(k));
          continue;
        }
        const bm = cm[2].match(/^❌ Doesn.t work(?: on (.+))?$/);
        if (bm) {
          if (cm[1] === "x") (bm[1] ? [OS_KEYS[bm[1]]] : ALL_OS).forEach((k) => k && brokenOs.add(k));
          continue;
        }
        steps.push({ done: cm[1] === "x", text: cm[2] });
      } else if (steps.length) {
        steps[steps.length - 1].text += " " + c.trim();
      } else cont.push(c.trim());
    }
    const openOs = ALL_OS.filter((k) => !osTicked.has(k));
    if (!openOs.length || (ONLY_OS && !openOs.includes(ONLY_OS))) continue;
    const openSteps = steps.filter((s) => !s.done);
    if (steps.length && !openSteps.length) continue;

    let head = clean([mm[2], ...cont].join(" ")).replace(/^\*\*/, "");
    let label = "", ownNum = null;
    const om = head.match(/^#(\d+[a-z]*)(?:\/#\d+[a-z]*)*\s*[—:–-]\s*/);
    if (om) { ownNum = om[1]; head = head.slice(om[0].length); }
    const lm = head.match(/^([^—:(]{1,40}?)\*{0,2}\s*(?=\(|[—:–]|$)/);
    if (!om && lm && (/manual|qa|test/i.test(lm[1]) || /[—:–]/.test(head.slice(lm[0].length, lm[0].length + 2)))) {
      label = lm[1].replace(/\*/g, "").trim();
      head = head.slice(lm[0].length);
    }
    if (/^manual( test)?$/i.test(label)) label = "";
    head = head.replace(/^\*\*/, "").trim();
    let qualifier = "";
    const qm = head.match(/^\(([^)]*)\)\*?\*?\s*/);
    if (qm) { qualifier = qm[1]; head = head.slice(qm[0].length); }
    head = head.replace(/^[—:–-]\s*/, "").trim();
    let hint = [qualifier && `(${qualifier})`, head].filter(Boolean).join(" ");
    if (openSteps.length) hint += (hint ? "\n" : "") + openSteps.map((s) => "• " + clean(s.text)).join("\n");

    // Ancestors: walk upward, keep starts with strictly smaller indent.
    const anc = [];
    let limit = ind;
    let startLine = null;
    for (let k = i - 1; k >= 0 && limit > -1; k--) {
      const s = itemStart(lines[k]);
      if (!s || s.indent >= limit) continue;
      anc.push({ ...s, line: k });
      if (startLine === null) startLine = k;
      limit = s.indent;
    }
    const titled = anc[0];
    const withNum = ownNum ? { num: ownNum } : anc.find((a) => a.num);
    const numIdx = withNum ? anc.indexOf(withNum) : -1;
    const parentAnc = ownNum ? anc.find((a) => a.num) : numIdx >= 0 ? anc.slice(numIdx + 1).find((a) => a.num) : null;

    let base = withNum ? `${G}#${withNum.num.replace(/^[A-Z]\./, "")}` : `${G}:L${i + 1}`;
    if (withNum && withNum.heading) base = `${G}§${withNum.num.replace(/^[A-Z]\./, "")}`;
    seen[base] = (seen[base] || 0) + 1;
    const id = seen[base] > 1 ? `${base}.${seen[base]}` : base;

    let title = titled && !ownNum ? stripTitle(titled.title) : "";
    if (!title) title = firstClause(head) || "Manual test";
    if (label) title += ` — ${label}`;
    const parent = parentAnc ? `${G}#${parentAnc.num.replace(/^[A-Z]\./, "")} ${stripTitle(parentAnc.title)}` : "";

    // Body of the nearest titled ancestor up to the manual box.
    const from = titled ? titled.line : Math.max(0, i - 12);
    const bodyLines = lines.slice(from, i).filter((l) => !/^\s*- \[[ x]\] (🤖|✅|❌)/.test(l));
    let prose = bodyLines.map((l) => l.replace(/^\s*(\d+[a-z]?\.\s+|- (\[[ x]\] )?|> ?)/, "")).join("\n").trim();
    prose = prose.replace(/^\*\*.+?\*\*\s*/, "");
    if (prose.length > 1500) prose = prose.slice(0, 1500).replace(/\s+\S*$/, "") + " …";
    const fm = lines.slice(from, i).join(" ").match(/\*Files(?: \([^)]*\))?:\s*(.+?)\*/);
    const filesRef = fm ? clean(fm[1]) : "";

    // Automated sibling: a ticked 🤖 box at the same indent between the item start and the next sibling.
    let auto = false;
    for (let k = from + 1; k < j + 40 && k < lines.length; k++) {
      const s = lines[k];
      if (k > i && s.trim() && indentOf(s) < ind) break;
      if (indentOf(s) === ind && /^\s*- \[x\] 🤖/.test(s)) { auto = true; break; }
    }

    const narrow = [title, hint, qualifier].join(" ");
    const needs = new Set(GROUP_NEEDS[G] || []);
    const probe = hint.trim() ? narrow : narrow + " " + prose.slice(0, 600);
    for (const [n, rx] of NEED_RX) if (rx.test(probe)) needs.add(n);
    const flags = FLAG_RX.filter(([, rx]) => rx.test(narrow)).map(([n]) => n);

    items.push({ base, first: firstClause(head), ancTitle: titled ? stripTitle(titled.title) : "", ancNum: withNum && !ownNum ? withNum.num : null, id, group: G, groupTitle, file: rel, line: i + 1, title, parent, hint, auto, openOs, brokenOs: [...brokenOs], flags, needs: [...needs], filesRef, prose });
  }
}
// An item with several manual boxes: name each box by what it checks.
for (const it of items) {
  if (seen[it.base] > 1 && it.first && it.ancTitle) {
    it.parent = `${it.base} ${it.ancTitle}`;
    it.title = it.first;
  }
  delete it.base; delete it.first; delete it.ancTitle; delete it.ancNum;
}
const byTitle = {};
for (const it of items) (byTitle[it.title] = byTitle[it.title] || []).push(it);
for (const group of Object.values(byTitle)) if (group.length > 1) group.forEach((it, k) => { if (k) it.title += ` (${k + 1})`; });
fs.writeFileSync("qa-items.json", JSON.stringify(items));
console.log(items.length, "items");
