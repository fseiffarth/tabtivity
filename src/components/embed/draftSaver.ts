/** One file identity owns its queue, including writes that outlive its viewer. */
export class DraftSaver {
  private draft = "";
  private baseline: string | null = null;
  private enabled = false;
  private inputBaseline: string | null | undefined;
  private timer?: ReturnType<typeof setTimeout>;
  private maximum?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  onSaved = (_text: string) => {};
  onStatus = (_busy: boolean, _error: string | null) => {};
  constructor(private write: (text: string) => Promise<void>) {}
  private cancel() {
    clearTimeout(this.timer);
    clearTimeout(this.maximum);
    this.timer = this.maximum = undefined;
  }
  update(draft: string, baseline: string | null, loaded: boolean, autosave: boolean) {
    this.draft = draft;
    const nextBaseline = loaded ? baseline : null;
    if (nextBaseline !== this.inputBaseline) this.baseline = nextBaseline;
    this.inputBaseline = nextBaseline;
    this.enabled = autosave;
    if (!autosave || this.baseline === null || draft === this.baseline) {
      this.cancel();
      return;
    }
    clearTimeout(this.timer);
    const run = () => { void this.flush(); };
    this.timer = setTimeout(run, 400);
    this.maximum ??= setTimeout(run, 2000);
  }
  flush(): Promise<void> {
    this.cancel();
    if (this.running) return this.running;
    this.running = (async () => {
      this.onStatus(true, null);
      try {
        while (this.baseline !== null && this.draft !== this.baseline) {
          const text = this.draft;
          await this.write(text);
          this.baseline = text;
          this.onSaved(text);
        }
        this.onStatus(false, null);
      } catch (error) {
        this.onStatus(false, String(error));
      }
    })().finally(() => { this.cancel(); this.running = undefined; });
    return this.running;
  }
  /** The last draft seen differs from what was last known on disk. */
  get dirty(): boolean {
    return this.baseline !== null && this.draft !== this.baseline;
  }
  /** Unsaved, and `dispose` would not save it: autosave is off. What closing
   *  its tab would throw away (`lib/tabs/tabCloseGuard`). */
  get lostOnDispose(): boolean {
    return !this.enabled && this.dirty;
  }
  /** Save now only if autosave would save it anyway (the retire handshake). */
  flushIfAutosave(): Promise<void> {
    return this.enabled ? this.flush() : Promise.resolve();
  }
  dispose() {
    this.cancel();
    if (this.enabled) void this.flush();
  }
}
