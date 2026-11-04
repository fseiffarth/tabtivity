import { useRef, useState, type ReactNode } from "react";
import { ANY_FILE_ACCEPT, MAX_INBOX_FILE, pickPhoneFiles } from "../api";

/** One file picked on the phone, from the tap to the desktop's answer. */
export interface PickedFile {
  id: number;
  name: string;
  state: "sending" | "sent" | "failed";
  failure?: string;
}

/**
 * What every "a file from this phone" uploader shares — **Send to desktop**,
 * the ＋ sheet's **Send a file** and the files drawer's **Upload here**: the
 * phone's own picker with its hidden `ANY_FILE_ACCEPT` fallback input, a row
 * per pick, and the 24 MB check, so an oversized pick fails (`tooLarge`, the
 * row's sentence) before any bytes leave the phone.
 *
 * `send` gets each pick that passed with its row already `sending`, and
 * settles that row itself through `settle`. `oneByOne` sends the picks one
 * after another instead of all at once. `open` must run inside the tap that
 * asked for it (the picker needs the gesture); what it is handed (`extra`)
 * goes into each row of that pick, as it stood at the tap.
 */
export function usePhonePicks<R extends PickedFile>({ testId, tooLarge, send, oneByOne = false, maxSize = MAX_INBOX_FILE }: {
  testId: string;
  tooLarge: string;
  send: (file: File, row: R, settle: (patch: Partial<R>) => void) => Promise<void>;
  oneByOne?: boolean;
  /** The largest file the desktop takes on this route (24 MB unless the
   * route stages bigger ones, as **Upload here** does). */
  maxSize?: number;
}): {
  rows: R[];
  update: (id: number, patch: Partial<R>) => void;
  dismiss: (id: number) => void;
  open: (extra?: Partial<R>) => void;
  /** Files that came another way (dropped on the list), sent as picks are. */
  add: (files: ArrayLike<File>, extra?: Partial<R>) => void;
  input: ReactNode;
} {
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  /** The `extra` of the tap whose picker is open (the fallback input answers later). */
  const pending = useRef<Partial<R>>({});
  const [rows, setRows] = useState<R[]>([]);

  const update = (id: number, patch: Partial<R>) =>
    setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  const dismiss = (id: number) => setRows((current) => current.filter((row) => row.id !== id));

  const take = (files: ArrayLike<File> | null, extra: Partial<R> = pending.current) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      const row = { ...extra, id: ++seq.current, name: file.name || "attachment" } as R;
      if (file.size > maxSize) {
        setRows((current) => [...current, { ...row, state: "failed", failure: tooLarge }]);
        continue;
      }
      const sending = { ...row, state: "sending" } as R;
      setRows((current) => [...current, sending]);
      // `send` settles its own row; a throw past it must not stop the queue.
      const go = () => send(file, sending, (patch) => update(sending.id, patch)).catch(() => undefined);
      if (oneByOne) queue.current = queue.current.then(go);
      else void go();
    }
  };

  const view = <input ref={input} type="file" accept={ANY_FILE_ACCEPT} multiple hidden aria-hidden="true" tabIndex={-1} data-testid={testId}
    onChange={(event) => { take(event.target.files); event.target.value = ""; }} />;

  return {
    rows,
    update,
    dismiss,
    open: (extra = {}) => {
      pending.current = extra;
      pickPhoneFiles(input.current, (files) => take(files));
    },
    add: (files, extra = {}) => take(files, extra),
    input: view,
  };
}
