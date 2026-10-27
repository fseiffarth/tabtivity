// Tab-key and layout-node id counters: one instance per window, shared by
// the store and the pure tree helpers. Moved out of `stores/tabs.ts`.

let _keyCounter = 0;
export function nextKey(prefix: string) {
  return `${prefix}-${++_keyCounter}`;
}

let _nodeCounter = 0;
export function nextGroupId() {
  return `g-${++_nodeCounter}`;
}
export function nextSplitId() {
  return `s-${++_nodeCounter}`;
}
