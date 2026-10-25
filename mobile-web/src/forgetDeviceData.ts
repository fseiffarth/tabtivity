/**
 * Everything this phone keeps of the desktop it was paired with, forgotten at
 * once — the one thing to call when the host definitely no longer knows this
 * device (`resumeAuth`'s `unpaired`, a rejected renewal, or no device key left
 * to sign with). A lost, revoked phone otherwise keeps its covers (pictures and
 * PDF first pages), its markup layers (marks, with the PDF's words they were
 * anchored to), unsent drafts and held prompts in IndexedDB and localStorage.
 *
 * Never for an offline or timed-out phone: that one is still paired, and only
 * a rejection of the device's own identity is an answer. Each store is emptied
 * on its own, and one that cannot be reached does not keep the others.
 */
import { forgetDrafts } from "./drafts";
import { forgetLastPlace } from "./lastPlace";
import { forgetLayers } from "./markup/store";
import { forgetHeld } from "./terminal/heldPrompts";
import { forgetCovers } from "./thumbs";

export async function forgetDeviceData(): Promise<void> {
  forgetLastPlace();
  forgetDrafts();
  forgetHeld();
  await Promise.allSettled([forgetCovers(), forgetLayers()]);
}
