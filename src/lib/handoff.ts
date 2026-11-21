// Passing a finished take to another section without exporting a WAV and
// uploading it again. The pending item is module state, which outlives the view
// that created it: navigating swaps the view, not the page.

export type HandoffTarget = 'convert' | 'transcribe' | 'process' | 'song';

export interface HandoffItem {
  /** Take name without an extension; the receiving section adds its own. */
  name: string;
  blob: Blob;
}

/** Sections a take can be sent to, with the label their button shows. */
export const HANDOFF_TARGETS: Array<{ target: HandoffTarget; label: string }> = [
  { target: 'convert', label: 'Convert' },
  { target: 'transcribe', label: 'Transcribe' },
  { target: 'process', label: 'Shape' },
  { target: 'song', label: 'Beat' },
];

let pending: { target: HandoffTarget; item: HandoffItem } | null = null;

/** Queue a take for `target`; the next mount of that section picks it up. */
export function sendHandoff(target: HandoffTarget, item: HandoffItem): void {
  pending = { target, item };
}

/**
 * Queue the take and open its section. The app is hash-routed, so setting the
 * hash mounts that section, which takes the item on mount. Outside the browser
 * (unit tests) only the queue is touched.
 */
export function sendTake(target: HandoffTarget, item: HandoffItem): void {
  sendHandoff(target, item);
  if (typeof window !== 'undefined') window.location.hash = `#/${target}`;
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
