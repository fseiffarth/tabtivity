import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useViewerState } from "./fileViewer/viewerState";
import { UntestedTag } from "../common/UntestedTag";
import {
  BIB_ENTRY_TYPES,
  BIB_FIELD_NAMES,
  addBibEntry,
  addBibField,
  bibByline,
  bibMacros,
  bibVenues,
  deleteBibField,
  deleteBibRecord,
  duplicateBibKeys,
  filterBibRecords,
  filterBibVenue,
  parseBib,
  setBibFieldName,
  setBibFieldValue,
  setBibKey,
  setBibType,
  sortBibRecords,
  type BibField,
  type BibRecord,
  type BibSortKey,
} from "../../lib/viewers/tex/bib";
import { useT } from "../../lib/i18n";

/** How many cards are mounted at once, and how many each extension adds. Big
 *  enough that a normal file is whole on the first paint and the sentinel is
 *  reached only by really scrolling; small enough that a 5000-entry library
 *  opens in the time a 60-entry one does. */
const BIB_PAGE = 60;

/**
 * The BibTeX (`.bib`) **card view** — one card per bibliography entry, each a
 * list of its `field = {value}` pairs, in one long scrolling column.
 *
 * The shape is the YAML/JSON card view's, minus its drill navigation, because a
 * `.bib` is not a nested document: it is a *flat list of records*, all at one
 * level, so there is nothing to drill into and the reader wants the whole list at
 * once. What a flat list of a few thousand records needs instead is a **filter**
 * (over the key, the type and every field value) and a per-card **fold**, and the
 * fold rides with the tab like the tree's collapse state.
 *
 * Like the tree and the table it renders controls but EDITS THE TEXT: every
 * action splices the draft via `lib/viewers/tex/bib`'s ops, so a card edit is an
 * ordinary dirty/undoable/saveable change on the same draft Source shows and
 * Ctrl+S writes — and the file's field order, brace-protected capitalization,
 * `"…"` quoting, indentation and `%` comments survive it untouched.
 *
 * Two honesty rules it inherits: a value it cannot safely rewrite (a `#`
 * concatenation, a `@string` macro reference) is **shown, not offered**, and text
 * belonging to no record is **admitted in a note** rather than silently omitted —
 * a card view that quietly hides part of a file is worse than no card view.
 *
 * Reading a list of a few thousand records needs three more things, and all three
 * are **display-only** — none of them rewrites the file, whose hand-sorted order
 * is somebody's own work:
 *
 *  - a **venue** picker (which conference/journal), because "what did we publish
 *    at this conference" is a question a text filter answers badly: `neurips`
 *    also matches every entry whose abstract mentions it;
 *  - a **sort** (file order · first author · year, either direction), persisted
 *    with the tab like the fold, since it hides nothing;
 *  - and **lazy rendering**: a card is a dozen inputs and a growing textarea per
 *    field, so a 2000-entry library was ~30k live DOM nodes to open a file with.
 *    Only a window of the list is mounted, extended as the reader scrolls (see
 *    {@link BIB_PAGE}).
 */
export function BibCards({
  text,
  onChange,
  tabKey,
  fontSize,
}: {
  text: string;
  onChange: (next: string) => void;
  tabKey?: string;
  fontSize?: number;
}) {
  const t = useT();
  const doc = useMemo(() => parseBib(text), [text]);
  const dupes = useMemo(() => duplicateBibKeys(doc), [doc]);
  const viewPos = useViewerState(tabKey);

  // Neither filter is persisted: one that survived a reopen would hide most of
  // the file with no visible cause (the to-do board's rule). The *order* is, one
  // line below — it hides nothing, so it has none of that failure mode.
  const [query, setQuery] = useState("");
  const [venue, setVenue] = useState("");
  const [sort, setSortState] = useState<BibSortKey>(
    () => (viewPos.initial?.bibSort as BibSortKey | undefined) ?? "file",
  );
  const [desc, setDescState] = useState(() => viewPos.initial?.bibSortDesc ?? false);
  const setSort = useCallback(
    (next: BibSortKey) => {
      setSortState(next);
      viewPos.persist({ bibSort: next });
    },
    [viewPos],
  );
  const setDesc = useCallback(
    (next: boolean) => {
      setDescState(next);
      viewPos.persist({ bibSortDesc: next });
    },
    [viewPos],
  );

  // The `@string` table, so a `journal = jml` is offered as the journal it names
  // rather than as the macro's name (which appears nowhere in the bibliography).
  const macros = useMemo(() => bibMacros(doc), [doc]);
  const venues = useMemo(() => bibVenues(doc.records, macros), [doc.records, macros]);
  // Filter first, order second: sorting the whole file and then dropping most of
  // it does the same work for a list nobody sees.
  const shown = useMemo(
    () =>
      sortBibRecords(
        filterBibVenue(filterBibRecords(doc.records, query), venue, macros),
        sort,
        desc,
      ),
    [doc.records, macros, query, venue, sort, desc],
  );

  // Folds ride with the tab, like the YAML tree's collapse: folding a 2000-entry
  // bibliography down to the few you are working on has to survive a reopen and a
  // restart. Ids are re-derived on every parse, so a stale one is simply inert.
  const [folded, setFoldedState] = useState<Set<string>>(
    () => new Set(viewPos.initial?.bibCollapsed ?? []),
  );
  const setFolded = useCallback(
    (next: Set<string>) => {
      setFoldedState(next);
      viewPos.persist({ bibCollapsed: [...next] });
    },
    [viewPos],
  );
  const toggleFold = useCallback(
    (id: string) => {
      const next = new Set(folded);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setFolded(next);
    },
    [folded, setFolded],
  );
  // ── The rendered window ───────────────────────────────────────────────────
  // Mounted cards are `shown.slice(start, start + count)`, never the whole list.
  // It is a *window* rather than a growing prefix because of the one action that
  // has to reach a card the reader has not scrolled to: adding an entry appends
  // it to the end of a list that may be thousands long, and revealing everything
  // above it to get there would pay exactly the cost this window exists to
  // avoid. So the window jumps to the card instead, and offers the way back up.
  const [start, setStart] = useState(0);
  const [count, setCount] = useState(BIB_PAGE);
  // A new list (another filter, another order) starts at the top again. NOT keyed
  // on `doc`: every field edit re-parses the file, and snapping back to the first
  // page after each one would throw the reader out of the entry being edited.
  useEffect(() => {
    setStart(0);
    setCount(BIB_PAGE);
  }, [query, venue, sort, desc]);
  const rendered = useMemo(() => shown.slice(start, start + count), [shown, start, count]);
  const hiddenAbove = Math.min(start, shown.length);
  const hiddenBelow = Math.max(0, shown.length - (start + count));

  // Collapse/expand applies to what is FILTERED IN, not to the whole file: with a
  // query typed, "collapse all" means the cards on screen — folding the other 1900
  // would change state the user cannot see.
  // A new entry is appended to the END of a list that may be thousands long, and
  // (having no title yet) would not match a filter that is typed — so adding one
  // clears the filter and brings the new card into view. Otherwise the click reads
  // as having done nothing at all.
  const listEl = useRef<HTMLDivElement | null>(null);
  const pendingScroll = useRef<string | null>(null);
  useEffect(() => {
    const id = pendingScroll.current;
    if (!id || !listEl.current) return;
    // Outside the window: move the window onto it and let the next pass scroll —
    // the card has to be mounted before anything can scroll it into view.
    const idx = shown.findIndex((r) => r.id === id);
    if (idx !== -1 && (idx < start || idx >= start + count)) {
      setStart(Math.max(0, idx - 2));
      setCount(BIB_PAGE);
      return;
    }
    for (const child of listEl.current.children) {
      if ((child as HTMLElement).dataset.bibId === id) {
        pendingScroll.current = null;
        // Optional-called: jsdom has no scrollIntoView, and a missing scroll is not
        // worth throwing inside an effect over (`ContextFilePicker`'s precedent).
        child.scrollIntoView?.({ block: "center" });
        return;
      }
    }
  }, [doc, shown, start, count]);
  const addEntry = () => {
    const { text: next, key } = addBibEntry(text, doc);
    pendingScroll.current = `entry:${key}`;
    setQuery("");
    setVenue("");
    onChange(next);
  };

  // Extending the window as the reader arrives at its end — the lazy half of the
  // lazy list. The sentinel sits below the last card, `root: null` because the
  // scroller is the *viewer pane's* body (an ancestor, not this component), and an
  // observer against the viewport already accounts for every clipping ancestor.
  // Re-armed on each extension: an observer only reports a *change*, so a sentinel
  // that is still on screen after the new cards mount would never fire again and
  // the list would stall one page in.
  const sentinel = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setCount((c) => c + BIB_PAGE);
      },
      // A page ahead of the fold, so the cards are mounted by the time they are
      // scrolled to rather than after.
      { rootMargin: "800px 0px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [start, count, shown.length]);

  const allFolded = shown.length > 0 && shown.every((r) => folded.has(r.id));
  const toggleAll = () => {
    const next = new Set(folded);
    for (const r of shown) {
      if (allFolded) next.delete(r.id);
      else next.add(r.id);
    }
    setFolded(next);
  };

  const style = fontSize ? { fontSize: `${fontSize}px` } : undefined;

  return (
    <div className="bib-cards" style={style}>
      <div className="bib-cards-bar">
        <input
          className="bib-filter"
          value={query}
          placeholder={t("bibCards.filterPlaceholder")}
          aria-label={t("bibCards.filterPlaceholder")}
          onChange={(e) => setQuery(e.target.value)}
        />
        {/* Which conference/journal — a question the text filter answers badly,
            since `neurips` also matches every abstract that mentions it. Only
            offered for a file that has venues to pick between; the current one is
            kept in the list even after an edit removes it from the file, so the
            control never shows a selection the list does not reflect. */}
        {venues.length > 0 && (
          <select
            className="bib-filter bib-venue"
            value={venue}
            title={t("bibCards.venueTitle")}
            aria-label={t("bibCards.venueLabel")}
            onChange={(e) => setVenue(e.target.value)}
          >
            <option value="">{t("bibCards.venueAll")}</option>
            {(venues.some((v) => v.toLowerCase() === venue.toLowerCase()) || !venue
              ? venues
              : [venue, ...venues]
            ).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        )}
        {/* Order is a reading of the list, never a rewrite: the file's own order
            is somebody's hand-sorting, and `file` is the default for that reason. */}
        <select
          className="bib-filter bib-sort"
          value={sort}
          title={t("bibCards.sortTitle")}
          aria-label={t("bibCards.sortLabel")}
          onChange={(e) => setSort(e.target.value as BibSortKey)}
        >
          <option value="file">{t("bibCards.sortFile")}</option>
          <option value="author">{t("bibCards.sortAuthor")}</option>
          <option value="year">{t("bibCards.sortYear")}</option>
        </select>
        <button
          className="yaml-add bib-cards-act bib-sort-dir"
          title={desc ? t("bibCards.sortDescTitle") : t("bibCards.sortAscTitle")}
          aria-label={desc ? t("bibCards.sortDescTitle") : t("bibCards.sortAscTitle")}
          aria-pressed={desc}
          onClick={() => setDesc(!desc)}
        >
          <span aria-hidden="true">{desc ? "↓" : "↑"}</span>
        </button>
        <span className="bib-cards-count">
          {query.trim() || venue
            ? t("bibCards.countFiltered", { shown: shown.length, total: doc.records.length })
            : t(doc.records.length === 1 ? "bibCards.countOne" : "bibCards.countMany", {
                n: doc.records.length,
              })}
        </span>
        {shown.length > 0 && (
          <button className="yaml-add bib-cards-act" onClick={toggleAll}>
            {allFolded ? t("bibCards.expandAll") : t("bibCards.collapseAll")}
          </button>
        )}
        <button className="yaml-add bib-cards-act" title={t("bibCards.addEntryTitle")} onClick={addEntry}>
          {t("bibCards.addEntry")}
        </button>
        <span className="yaml-cards-bar-spacer" />
        <UntestedTag id="bibCards.1" />
      </div>

      {/* The `%` comments and any other text between records: the cards neither
          render nor edit it, and saying so is the point — an unexplained
          difference between the cards and Source reads as data loss. */}
      {doc.strayLines > 0 && (
        <div className="bib-cards-note">
          {t(doc.strayLines === 1 ? "bibCards.strayOne" : "bibCards.strayMany", {
            n: doc.strayLines,
          })}
        </div>
      )}

      {/* Suggestions for the name/type inputs, declared once for every card. */}
      <datalist id="bib-field-names">
        {BIB_FIELD_NAMES.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <datalist id="bib-entry-types">
        {BIB_ENTRY_TYPES.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>

      {doc.records.length === 0 ? (
        <div className="yaml-tree-notice">
          <p>{t("bibCards.noEntries")}</p>
        </div>
      ) : shown.length === 0 ? (
        <div className="yaml-tree-notice">
          <p>{t("bibCards.noMatches", { query })}</p>
        </div>
      ) : (
        <>
          {/* The way back to the top of a window that jumped (adding an entry to a
              long file). Not an observer like the bottom edge: growing the list
              upwards moves everything under the reader's cursor, so going back is
              a click rather than something scrolling does to you. */}
          {hiddenAbove > 0 && (
            <button
              className="yaml-add bib-cards-more"
              onClick={() => {
                setCount(start + count);
                setStart(0);
              }}
            >
              {t("bibCards.showEarlier", { n: hiddenAbove })}
            </button>
          )}
          <div className="bib-card-list" ref={listEl}>
            {rendered.map((rec) => (
              <BibCard
                key={rec.id}
                rec={rec}
                text={text}
                onChange={onChange}
                duplicate={rec.kind === "entry" && dupes.has(rec.key.toLowerCase())}
                folded={folded.has(rec.id)}
                onToggleFold={() => toggleFold(rec.id)}
              />
            ))}
          </div>
          {/* The sentinel *is* the button: scrolling to it extends the window, and
              clicking it does the same where there is no IntersectionObserver
              (jsdom) or where the pane is too short to ever scroll it into view. */}
          {hiddenBelow > 0 && (
            <button
              className="yaml-add bib-cards-more"
              ref={sentinel}
              onClick={() => setCount((c) => c + BIB_PAGE)}
            >
              {t("bibCards.showMore", { n: hiddenBelow })}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** One record as a card: the type + key in the header, the fields in the body. */
function BibCard({
  rec,
  text,
  onChange,
  duplicate,
  folded,
  onToggleFold,
}: {
  rec: BibRecord;
  text: string;
  onChange: (next: string) => void;
  duplicate: boolean;
  folded: boolean;
  onToggleFold: () => void;
}) {
  const t = useT();
  const byline = useMemo(() => bibByline(rec), [rec]);
  // A `@comment`/`@preamble`, and a `@type(…)` record whose paren form the parser
  // deliberately treats as opaque, carry no field list the cards can edit. They
  // are shown as their own source text rather than dropped from the view.
  const opaque =
    rec.kind === "comment" || rec.kind === "preamble" || (rec.kind === "entry" && !rec.keyEnd);
  const editableHead = rec.kind === "entry" && !!rec.keyEnd;

  return (
    <div className={`bib-card${duplicate ? " bib-card-dup" : ""}`} data-bib-id={rec.id}>
      {/* The caret is its own button and the inputs are its siblings — nesting a
          text field inside the fold button would be invalid markup and would fold
          the card on every click meant for the key. */}
      <div className="bib-card-head">
        <button
          className="bib-card-caret"
          onClick={onToggleFold}
          title={folded ? t("bibCards.expandTitle") : t("bibCards.foldTitle")}
          aria-expanded={!folded}
        >
          <span aria-hidden="true">{folded ? "▸" : "▾"}</span>
        </button>
        {editableHead ? (
          <>
            <span className="bib-card-at" aria-hidden="true">@</span>
            <CommitInput
              className="bib-card-type"
              initial={rec.type}
              list="bib-entry-types"
              ariaLabel={t("bibCards.typeLabel")}
              title={t("bibCards.typeTitle")}
              onCommit={(next) => onChange(setBibType(text, rec, next))}
            />
            <CommitInput
              className="bib-card-key"
              initial={rec.key}
              ariaLabel={t("bibCards.keyLabel")}
              title={t("bibCards.keyTitle")}
              onCommit={(next) => onChange(setBibKey(text, rec, next))}
            />
          </>
        ) : (
          <span className="bib-card-type-static">@{rec.type}</span>
        )}
        {duplicate && (
          <span className="bib-card-warn" title={t("bibCards.duplicateTitle")}>
            {t("bibCards.duplicateBadge")}
          </span>
        )}
        {byline && (
          <span className="bib-card-byline" title={byline}>
            {byline}
          </span>
        )}
        <span className="bib-card-head-spacer" />
        {rec.kind === "entry" && rec.key && (
          <button
            className="yaml-act bib-card-copy"
            title={t("bibCards.copyKeyTitle")}
            aria-label={t("bibCards.copyKeyTitle")}
            onClick={() => navigator.clipboard?.writeText(rec.key).catch(() => {})}
          >
            ⧉
          </button>
        )}
        <button
          className="yaml-act yaml-act-del yaml-card-del"
          title={t("bibCards.deleteEntryTitle")}
          aria-label={t("bibCards.deleteEntryLabel", { key: rec.key || rec.type })}
          onClick={() => onChange(deleteBibRecord(text, rec))}
        >
          ×
        </button>
      </div>

      {!folded &&
        (opaque ? (
          <pre className="bib-card-raw" title={t("bibCards.sourceOnlyTitle")}>
            {rec.raw}
          </pre>
        ) : (
          <div className="bib-card-body">
            {rec.fields.length === 0 ? (
              <div className="yaml-card-empty">{t("bibCards.noFields")}</div>
            ) : (
              <div className="bib-card-fields">
                {rec.fields.map((f) => (
                  <BibFieldRow key={f.nameStart} field={f} text={text} onChange={onChange} />
                ))}
              </div>
            )}
            <AddFieldBar rec={rec} text={text} onChange={onChange} />
          </div>
        ))}
    </div>
  );
}

/** A `name = {value}` row: an editable name, an editable value (or a locked one),
 *  and a hover-delete. */
function BibFieldRow({
  field,
  text,
  onChange,
}: {
  field: BibField;
  text: string;
  onChange: (next: string) => void;
}) {
  const t = useT();
  return (
    <div className="bib-card-field">
      <CommitInput
        className="bib-card-fname"
        initial={field.name}
        list="bib-field-names"
        ariaLabel={t("bibCards.fieldNameLabel", { name: field.name })}
        onCommit={(next) => onChange(setBibFieldName(text, field, next))}
      />
      {field.editable ? (
        <ValueArea
          initial={field.value}
          ariaLabel={t("bibCards.valueOfLabel", { name: field.name })}
          onCommit={(next) => onChange(setBibFieldValue(text, field, next))}
        />
      ) : (
        // A macro reference or a `#` concatenation: shown in full, in its source
        // form, because rewriting it as a plain string would change what the
        // bibliography renders.
        <span className="yaml-value-locked bib-value-locked" title={t("bibCards.sourceOnlyTitle")}>
          {field.rawExpr}
        </span>
      )}
      <button
        className="yaml-act yaml-act-del yaml-card-field-del"
        title={t("bibCards.deleteFieldTitle")}
        aria-label={t("bibCards.deleteFieldLabel", { name: field.name })}
        onClick={() => onChange(deleteBibField(text, field))}
      >
        ×
      </button>
    </div>
  );
}

/** The foot of a card: name a field to add. The box clears on commit so several
 *  fields can be added in a row. */
function AddFieldBar({
  rec,
  text,
  onChange,
}: {
  rec: BibRecord;
  text: string;
  onChange: (next: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const add = () => {
    if (!name.trim()) return;
    onChange(addBibField(text, rec, name));
    setName("");
  };
  return (
    <div className="bib-card-add">
      <input
        className="bib-add-field"
        value={name}
        list="bib-field-names"
        placeholder={t("bibCards.addFieldPlaceholder")}
        aria-label={t("bibCards.addFieldPlaceholder")}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
      />
      <button className="yaml-add" onClick={add} disabled={!name.trim()}>
        {t("bibCards.addField")}
      </button>
    </div>
  );
}

/**
 * A value field. A textarea rather than an input because bib values are routinely
 * a wrapped multi-line abstract, and it grows to its content so a long value is
 * readable without a nested scroller. Commits on blur or Enter (a newline inside a
 * value is only line wrapping, so Enter is worth more as "done"); Shift+Enter
 * still inserts one, and Escape reverts.
 */
function ValueArea({
  initial,
  ariaLabel,
  onCommit,
}: {
  initial: string;
  ariaLabel: string;
  onCommit: (next: string) => void;
}) {
  const [buf, setBuf] = useState(initial);
  const dirty = useRef(false);
  const el = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!dirty.current) setBuf(initial);
  }, [initial]);
  // Grow to the content: the height is re-measured from `scrollHeight` after every
  // change, with the box first collapsed to `auto` so it also SHRINKS when text is
  // cut rather than keeping its high-water mark.
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  }, [buf]);

  return (
    <textarea
      ref={el}
      className="yaml-value-input bib-value-input"
      rows={1}
      value={buf}
      aria-label={ariaLabel}
      onChange={(e) => {
        dirty.current = true;
        setBuf(e.target.value);
      }}
      onBlur={() => {
        dirty.current = false;
        if (buf !== initial) onCommit(buf);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          dirty.current = false;
          if (buf !== initial) onCommit(buf);
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          dirty.current = false;
          setBuf(initial);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** A one-line field that commits on blur/Enter and reverts on Escape — the YAML
 *  card grid's `CommitInput` with a `list` for suggestions. Kept local rather than
 *  exported from `YamlGrid` so neither view's editing behaviour can be changed by
 *  a tweak meant for the other. */
function CommitInput({
  initial,
  className,
  ariaLabel,
  title,
  list,
  onCommit,
}: {
  initial: string;
  className: string;
  ariaLabel: string;
  title?: string;
  list?: string;
  onCommit: (next: string) => void;
}) {
  const [buf, setBuf] = useState(initial);
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setBuf(initial);
  }, [initial]);

  return (
    <input
      className={className}
      value={buf}
      list={list}
      title={title}
      aria-label={ariaLabel}
      onChange={(e) => {
        dirty.current = true;
        setBuf(e.target.value);
      }}
      onBlur={() => {
        dirty.current = false;
        if (buf !== initial) onCommit(buf);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          dirty.current = false;
          if (buf !== initial) onCommit(buf);
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          dirty.current = false;
          setBuf(initial);
          e.currentTarget.blur();
        }
      }}
    />
  );
}
