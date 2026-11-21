// Passing a finished take to another section without exporting a WAV and
// uploading it again. The pending item is module state, which outlives the view
// that created it: navigating swaps the view, not the page.

export type HandoffTarget = 'convert' | 'transcribe' | 'process' | 'song';

export interface HandoffItem {
  /** Take name without an extension; the receiving section adds its own. */
  name: string;
  blob: Blob;
}

let pending: { target: HandoffTarget; item: HandoffItem } | null = null;

/** Queue a take for `target`; the next mount of that section picks it up. */
export function sendHandoff(target: HandoffTarget, item: HandoffItem): void {
  pending = { target, item };
}

/**
 * The item queued for this section, if any. Reading it clears it, so a later
 * visit starts empty instead of re-loading audio the user already moved on from.
 */
export function takeHandoff(target: HandoffTarget): HandoffItem | null {
  if (!pending || pending.target !== target) return null;
  const { item } = pending;
  pending = null;
  return item;
}

/** Drop anything queued. Used by tests between cases. */
export function clearHandoff(): void {
  pending = null;
}
