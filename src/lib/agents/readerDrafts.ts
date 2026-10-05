/**
 * The desktop Reader composer's unsent text, per agent tab (`scope` + tab
 * key), so a draft survives the Reader unmounting — another tab shown, the
 * Chat/Terminal switch flipped — and is back when the tab's chat is. Kept in
 * memory for this window only; sending (or emptying the box) drops it.
 */
const drafts = new Map<string, string>();

const draftKey = (scope: string, tabKey: string) => `${scope}\n${tabKey}`;

export function readerDraft(scope: string, tabKey: string): string {
  return drafts.get(draftKey(scope, tabKey)) ?? "";
}

export function setReaderDraft(scope: string, tabKey: string, text: string): void {
  if (text) drafts.set(draftKey(scope, tabKey), text);
  else drafts.delete(draftKey(scope, tabKey));
}
