import { useState } from "react";
import { OptionSheet } from "./OptionSheet";

/** A destructive act waiting on a second tap: the shared option sheet, with
 * one option, in place of `window.confirm` — the same sheet the composer's
 * choices and the calendar's edits use, so a delete looks like the rest of
 * the phone and cannot be reached by a stray tap. */
export type Confirm = { title: string; note?: string; label: string; run: () => Promise<void> | void };

export function ConfirmSheet({ confirm, busy, onClose }: { confirm: Confirm; busy: boolean; onClose: () => void }) {
  return <OptionSheet
    title={confirm.title}
    note={confirm.note ? { text: confirm.note } : undefined}
    options={[{ key: "confirm", label: confirm.label, current: false }]}
    waiting=""
    busy={busy}
    onPick={() => { void Promise.resolve(confirm.run()).finally(onClose); }}
    onClose={onClose}
  />;
}

/** A name to type, in place of `window.prompt`: the same sheet with the field
 * above its one option. `initial` pre-fills it; an empty or unchanged value
 * keeps the option disabled, so it never sends a no-op. */
export type NameAsk = { title: string; label: string; initial?: string; action: string; run: (name: string) => Promise<void> | void };

export function NameSheet({ ask, busy, onClose }: { ask: NameAsk; busy: boolean; onClose: () => void }) {
  const [value, setValue] = useState(ask.initial ?? "");
  const name = value.trim();
  const ready = name !== "" && name !== (ask.initial ?? "").trim();
  const submit = () => { if (ready) void Promise.resolve(ask.run(name)).finally(onClose); };
  return <OptionSheet
    title={ask.title}
    options={[{ key: "save", label: ask.action, current: false }]}
    waiting=""
    busy={busy || !ready}
    onPick={submit}
    onClose={onClose}
  >{/* A lone field: Enter submits the form without a button of its own. */}
    <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <input aria-label={ask.label} placeholder={ask.label} value={value} maxLength={160} autoFocus enterKeyHint="done" onChange={(event) => setValue(event.target.value)} />
    </form>
  </OptionSheet>;
}
