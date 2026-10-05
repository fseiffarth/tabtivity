import { useMemo, useState } from "react";
import { useRootReviewStore, type RootProposal, type ReviewRow, type StagedIcsImport } from "../../stores/rootReview";
import { useT } from "../../lib/i18n";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { splitPtyId } from "../../lib/terminal/ptyId";
import { UntestedTag } from "../common/UntestedTag";
import { useMailStore } from "../../stores/mail";
import { inspectIcs } from "../../lib/calendar/icsSafety";
import { IcsReportBody } from "../calendar/IcsImportReviewDialog";
import { UndoIcon } from "../common/icons/Icon";
import type { MailDraft } from "../../types/mail";

/** Strip bidi overrides, zero-width controls and default-ignorable text. Keep
 * normal line breaks; rendering is always React text, never HTML/Markdown. */
export function stripInvisible(text: string): string {
  return [...text].filter((char) => {
    const cp = char.codePointAt(0)!;
    return !/\p{Default_Ignorable_Code_Point}/u.test(char)
      && !(cp < 32 && cp !== 9 && cp !== 10 && cp !== 13)
      && !(cp >= 127 && cp <= 159);
  }).join("");
}
/** The title of the tab a PTY id (`<scope>:<key>`) belongs to, while the
 *  window still has that tab; `undefined` for a closed tab or a foreign id. A
 *  proposal and an MCP session are both keyed by the PTY id, which is what the
 *  cards used to show — a title is what the user recognises. */
export function tabLabelForPty(s: { tabsByScope: Record<string, TabEntry[]> }, ptyId: string): string | undefined {
  const split = splitPtyId(ptyId);
  if (!split) return undefined;
  const label = (s.tabsByScope[split.scope] ?? []).find((t: TabEntry) => t.key === split.key)?.label;
  return label ? stripInvisible(label) : undefined;
}
/** A card's "which tab" line: the tab's title, falling back to the id. */
function TabLine({ tab, created }: { tab: string; created: string }) {
  const label = useTabsStore((s) => tabLabelForPty(s, tab));
  return <div className="settings-help root-review-meta" title={stripInvisible(tab)}>
    {label ?? stripInvisible(tab)} · {new Date(Number(created)).toLocaleString()}
  </div>;
}
function display(value: unknown): string {
  return stripInvisible(typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "—");
}
export function reviewRows(proposal: RootProposal) {
  const folded = proposal.tool === "todo_move"
    ? proposal.rows.filter((r) => r.kind === "task" && r.local && r.post.id !== proposal.args.id
      && r.pre && Object.keys({ ...r.pre, ...r.post }).every((key) =>
        ["column", "rank"].includes(key) || JSON.stringify(r.pre?.[key]) === JSON.stringify(r.post[key])))
    : [];
  return { rows: proposal.rows.filter((r) => !folded.includes(r)), folded: folded.length };
}
function RowDiff({ row }: { row: ReviewRow }) {
  const t = useT();
  const keys = Object.keys({ ...row.pre, ...row.post }).filter((key) =>
    !row.pre || row.op === "delete" || JSON.stringify(row.pre[key]) !== JSON.stringify(row.post[key]));
  const title = display(row.post.title ?? row.post.name ?? row.post.id);
  return <div className="root-review-row">
    <div className="root-review-row-head">
      <strong className="settings-list-label" title={title}>{title}</strong>
      <span className="ollama-badge root-review-op">
        {t(row.op === "delete" ? "rootReview.delete" : row.pre ? "rootReview.update" : "rootReview.create")}
      </span>
    </div>
    <table>
      <thead><tr><th>{t("rootReview.field")}</th><th>{t("rootReview.before")}</th><th>{t("rootReview.after")}</th></tr></thead>
      <tbody>{keys.map((key) => <tr key={key}>
        <th>{stripInvisible(key)}</th>
        <td className="root-review-before"><pre>{display(row.pre?.[key])}</pre></td>
        <td className="root-review-after"><pre>{row.op === "delete" ? "—" : display(row.post[key])}</pre></td>
      </tr>)}</tbody>
    </table>
  </div>;
}
/** The overlay a proposal belongs to, read off its tool's family
 *  (`services::root_mcp_security` names them `calendar_*`, `todo_*`, `mail_*`). */
export type ReviewDomain = "mail" | "calendar" | "todo";
const DOMAINS: ReviewDomain[] = ["mail", "calendar", "todo"];
function inDomain(tool: string, domain?: ReviewDomain) {
  return !domain || tool.startsWith(`${domain}_`);
}
/** The MCP group a proposal is approved with: its tool's family, or `other`
 *  for a tool of none of them (never silently folded into one). */
function groupOf(tool: string): ReviewDomain | "other" {
  return DOMAINS.find((d) => inDomain(tool, d)) ?? "other";
}
/** What one overlay's ✓ Approvals shows: its own tools' proposals, plus the
 *  agent mail drafts still awaiting approval (mail) or staged `.ics` files
 *  (calendar). No domain is the root console's view — everything. */
export function useDomainReview(domain?: ReviewDomain) {
  const allProposals = useRootReviewStore((s) => s.proposals);
  const allImports = useRootReviewStore((s) => s.imports);
  const allDrafts = useMailStore((s) => s.pendingAgentDrafts);
  const proposals = useMemo(() => allProposals.filter((p) => inDomain(p.tool, domain)), [allProposals, domain]);
  const imports = !domain || domain === "calendar" ? allImports : NONE_IMPORTS;
  const drafts = !domain || domain === "mail" ? allDrafts : NONE_DRAFTS;
  const waiting = proposals.filter((p) => p.status === "pending").length + imports.length + drafts.length;
  return { proposals, imports, drafts, waiting };
}
const NONE_IMPORTS: StagedIcsImport[] = [];
const NONE_DRAFTS: MailDraft[] = [];
/**
 * The proposals themselves. It used to sit under the console's title bar as a
 * permanent strip, taking a slice of the terminals' height to say "(0)" most of
 * the time; it is now the body of the panel the ✓ Approvals button drops
 * (`RootOverlay`), which is why it keeps its own heading and empty line — a
 * panel that opens on nothing must still say so.
 *
 * It is built out of what Tabtivity already uses for a list of objects, and adds
 * no surface of its own: the menu family's pinned accent title over a
 * `.menu-scroll-region` (the VPN/machines menus' shape), and inside it the
 * settings design system's object list — a `.settings-list` of
 * `.settings-card`s with `.settings-btn` actions and an `.ollama-badge` chip
 * for the status. Only the proposal's own parts (the diff table, the ✓/✗
 * glyphs) are drawn here.
 */
export function RootReviewStrip({ advisory = false, domain }: { advisory?: boolean; domain?: ReviewDomain }) {
  const t = useT();
  const { error, busy, applyAll, fileDrafts } = useRootReviewStore();
  const { proposals, imports, drafts, waiting } = useDomainReview(domain);
  const isOpen = (p: RootProposal) => p.status === "pending" || p.status === "conflicted";
  const open = proposals.filter(isOpen).sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));
  const decided = proposals.filter((p) => !isOpen(p));
  // One section per MCP group (mail, calendar, to-do, and `other` for a tool
  // of none), each with its own Approve all: approving the calendar's queue
  // must never also approve the board's. Mail's are the agent drafts, which
  // an approve only files into "Drafted by agents"; a staged `.ics` sits in
  // the calendar's section but is never part of its Approve all.
  const groups = [...DOMAINS, "other" as const].map((key) => {
    const items = open.filter((p) => groupOf(p.tool) === key);
    const groupDrafts = key === "mail" ? drafts : NONE_DRAFTS;
    const groupImports = key === "calendar" ? imports : NONE_IMPORTS;
    const pending = items.filter((p) => p.status === "pending");
    return { key, items, drafts: groupDrafts, imports: groupImports, pending,
      size: items.length + groupDrafts.length + groupImports.length };
  }).filter((g) => g.size > 0);
  // Settled cards are history: folded shut until asked for, so the ones that
  // still want a ✓/✗ are what the panel opens on.
  const [showDecided, setShowDecided] = useState(false);
  return <section className="root-review-strip" aria-label={t("rootReview.title")}>
    <div className="tab-new-menu-group-label root-review-heading">
      <span className="root-review-heading-title">{t("rootReview.title")} ({waiting})</span>
      <UntestedTag id="rootReview.title" />
    </div>
    <div className="menu-scroll-region root-review-scroll">
      {proposals.length === 0 && drafts.length === 0 && imports.length === 0
        && <p className="settings-empty root-review-empty">{t("rootReview.empty")}</p>}
      {advisory && <p role="note" className="root-review-notice">{t("rootConsole.reviewAdvisory")}</p>}
      {error && <p role="alert" className="settings-error">{stripInvisible(error)}</p>}
      {/* Each group under its own label, what still wants a decision first;
          what is already decided after a rule, so the ✓/✗ cards never blur
          into the settled ones. */}
      {groups.map((group) => {
        const approvable = group.key === "mail" ? group.drafts.length : group.pending.length;
        return <div key={group.key} className={`root-review-group open ${group.key}`}>
          <div className="root-review-group-label root-review-group-head">
            <span>{t(`rootReview.group.${group.key}` as "rootReview.group.mail")} ({group.size})</span>
            <UntestedTag id="rootReview.groupApproveAll" />
            {approvable > 0 && <button type="button" className="settings-btn sm primary" disabled={busy}
              onClick={() => void (group.key === "mail" ? fileDrafts(group.drafts) : applyAll(group.pending))}>
              ✓ {t("rootReview.approveAll", { count: approvable })}
            </button>}
          </div>
          <div className="settings-list root-review-cards">
            {group.drafts.map((draft) => <DraftCard key={draft.id} draft={draft} />)}
            {group.imports.map((staged) => <ImportCard key={staged.id} staged={staged} />)}
            {group.items.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} />)}
          </div>
        </div>;
      })}
      {decided.length > 0 && <div className="root-review-group decided">
        <button type="button" className="root-review-group-label root-review-group-toggle"
          aria-expanded={showDecided} onClick={() => setShowDecided((o) => !o)}>
          <span className="root-review-group-chevron" aria-hidden="true">›</span>
          {t("rootReview.decided", { count: decided.length })}
        </button>
        {showDecided && <div className="settings-list root-review-cards">
          {decided.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} />)}
        </div>}
      </div>}
    </div>
  </section>;
}

/** An agent mail draft awaiting approval. Not a proposal: ✓ only files it into
 *  "Drafted by agents" — nothing is sent; the composer's Send, bound to
 *  exactly what it shows, stays the only way out. ✗ discards it. What it says
 *  is shown here, so the ✓ is given on the draft itself. */
function DraftCard({ draft }: { draft: MailDraft }) {
  const t = useT();
  const { busy, fileDrafts, discardDraft } = useRootReviewStore();
  const to = [...draft.to, ...draft.cc].map(stripInvisible).join(", ");
  return <article className="settings-card root-review-card">
    <div className="root-review-card-head">
      <span className="settings-list-label" title={stripInvisible(draft.subject)}>
        {stripInvisible(draft.subject) || t("mail.noSubject")}
      </span>
      <span className="ollama-badge root-review-status">{t("rootReview.draft")}</span>
    </div>
    <p className="settings-help">{t(draft.origin === "reader" ? "mail.agentDraftReaderBanner" : "mail.agentDraftBanner")}</p>
    <div className="settings-help root-review-meta">{to || t("mail.noRecipient")}</div>
    {(draft.staged.length > 0 || (draft.suggested_to?.length ?? 0) > 0) && <div className="settings-help root-review-meta">
      {[
        draft.staged.length > 0 ? t("mail.agentDraftAttachments", { count: draft.staged.length }) : "",
        draft.suggested_to?.length ? t("mail.agentDraftSuggests", { count: draft.suggested_to.length }) : "",
      ].filter(Boolean).join(" · ")}
    </div>}
    {draft.body_text && <pre className="root-review-draft-body">{stripInvisible(draft.body_text)}</pre>}
    <div className="root-review-actions">
      <button type="button" className="settings-btn sm"
        onClick={() => void useMailStore.getState().openAgentDraft(draft)}>
        {t("rootReview.openDraft")}
      </button>
      <button className="root-review-btn approve" disabled={busy}
        title={t("rootReview.fileDraft")} aria-label={t("rootReview.fileDraft")}
        onClick={() => void fileDrafts([draft])}>✓</button>
      <button className="root-review-btn reject" disabled={busy}
        title={t("rootReview.discard")} aria-label={t("rootReview.discard")}
        onClick={() => void discardDraft(draft)}>✗</button>
    </div>
  </article>;
}

/** A staged `.ics`: the agent only put the file here. The report is this
 *  window's own reading of it, and ✓ runs the calendar's importer on exactly
 *  the text reported on — never part of "Approve all". */
function ImportCard({ staged }: { staged: StagedIcsImport }) {
  const t = useT();
  const { busy, importStaged, discardStaged, imported } = useRootReviewStore();
  const report = inspectIcs(staged.text);
  const name = stripInvisible(staged.name) || t("calendarPane.importedCalendarName");
  return <article className="settings-card root-review-card">
    <div className="root-review-card-head">
      <span className="settings-list-label" title={name}>{name}</span>
      <UntestedTag id="rootReview.icsImport" />
      <span className="ollama-badge root-review-status">{t("rootReview.icsImport")}</span>
    </div>
    <TabLine tab={staged.tab} created={staged.created} />
    <p className="settings-help">{t("rootReview.icsImportHelp", { name })}</p>
    <IcsReportBody report={report} />
    <div className="root-review-actions">
      <button className="root-review-btn approve" disabled={busy || !report.looksLikeIcs || imported.includes(staged.id)}
        title={t("icsReview.import")} aria-label={t("icsReview.import")}
        onClick={() => void importStaged(staged, t("calendarPane.importedCalendarName"))}>✓</button>
      <button className="root-review-btn reject" disabled={busy}
        title={t("rootReview.discard")} aria-label={t("rootReview.discard")}
        onClick={() => void discardStaged(staged)}>✗</button>
    </div>
  </article>;
}

function ProposalCard({ proposal }: { proposal: RootProposal }) {
  const t = useT();
  const { busy, decide } = useRootReviewStore();
  const { rows, folded } = reviewRows(proposal);
  const known = ["pending", "applied", "rejected", "conflicted", "undone", "failed"].includes(proposal.status);
  const status = known ? t(`rootReview.${proposal.status}` as "rootReview.pending") : stripInvisible(proposal.status);
  return <article className="settings-card root-review-card">
    <div className="root-review-card-head">
      <span className="settings-list-label root-review-tool" title={stripInvisible(proposal.tool)}>
        {stripInvisible(proposal.tool)}
      </span>
      <span className={`ollama-badge root-review-status${known ? ` ${proposal.status}` : ""}`}>{status}</span>
    </div>
    <TabLine tab={proposal.tab} created={proposal.created} />
    {proposal.mcp_access && proposal.mcp_caller && <p className="settings-help">{t("mcpSecurity.reviewScope", {
      calendars: proposal.mcp_access.calendars.all ? t("mcpSecurity.allScopes") : proposal.mcp_access.calendars.ids.length,
      projects: proposal.mcp_access.projects.all ? t("mcpSecurity.allScopes") : proposal.mcp_access.projects.ids.length,
      caller: t(`mcpSecurity.${proposal.mcp_caller}`),
    })}</p>}
    {proposal.closed && <p className="settings-help">{t("rootReview.closed")}</p>}
    {proposal.tainted && <p className="root-review-notice">{t("rootReview.tainted")}</p>}
    {proposal.calendars.filter((c) => c.caldav_account_id).map((c) =>
      <p key={String(c.id)} className="root-review-notice">{t("rootReview.outbound", { name: display(c.name) })}</p>)}
    {proposal.status === "conflicted" && <p className="root-review-notice">{t("rootReview.conflict")}</p>}
    {proposal.status === "failed" && <p className="root-review-notice">{t("rootReview.failedNote")}</p>}
    {/* Every pending card's actual rows stay visible, including in the
        bulk-approval view. No agent summary substitutes for these. */}
    {proposal.status === "pending" || proposal.status === "conflicted"
      ? rows.map((row, index) => <RowDiff key={index} row={row} />)
      : <details className="root-review-fold">
          <summary>{t("rootReview.details")}</summary>
          {rows.map((row, index) => <RowDiff key={index} row={row} />)}
        </details>}
    {folded > 0 && <p className="settings-help">{t("rootReview.reordered", { count: folded })}</p>}
    {/* A decision is one glyph: ✓ approve, ✗ reject (a conflict's ✗ is a
        discard, and says so). The word stays as the button's name, so a
        screen reader and a tooltip still read "Approve", never "check". */}
    <div className="root-review-actions">
      {(proposal.status === "pending" || proposal.status === "conflicted") && <>
        <button className="root-review-btn approve" disabled={busy || proposal.status !== "pending"}
          title={t("rootReview.approve")} aria-label={t("rootReview.approve")}
          onClick={() => void decide(proposal, "apply")}>✓</button>
        <button className="root-review-btn reject" disabled={busy}
          title={t(proposal.status === "conflicted" ? "rootReview.discard" : "rootReview.reject")}
          aria-label={t(proposal.status === "conflicted" ? "rootReview.discard" : "rootReview.reject")}
          onClick={() => void decide(proposal, "reject")}>✗</button>
      </>}
      {proposal.status === "applied" && proposal.undo && <button className="root-review-btn undo" disabled={busy}
        title={t("rootReview.undo")} aria-label={t("rootReview.undo")}
        onClick={() => void decide(proposal, "undo")}><UndoIcon /></button>}
    </div>
  </article>;
}
