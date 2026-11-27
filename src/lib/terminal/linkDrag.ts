// A chat web link dragged out of the agent pane: the address only, as the
// URI list and plain text, so a browser, a mail or a text box takes it.
// Nothing is fetched or opened by the drag; opening stays the click's
// ask-then-open.

/** Fill a dragstart's data with `url` (an http(s) address already checked
 *  by `chatLinkUrl`). */
export function setLinkDragData(dt: DataTransfer | null, url: string): void {
  if (!dt) return;
  dt.setData("text/uri-list", url);
  dt.setData("text/plain", url);
  dt.effectAllowed = "copy";
}
