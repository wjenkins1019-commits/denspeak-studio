// Passing a finished take to another section without exporting a WAV and
// uploading it again. The pending item is module state, which outlives the view
// that created it: navigating swaps the view, not the page.

export type HandoffTarget = 'convert' | 'transcribe' | 'process' | 'song';

export interface HandoffItem {
  /** Take name without an extension; the receiving section adds its own. */
  name: string;
  blob: Blob;
  /**
   * Length in seconds when the sender knows it, so a receiver can fill in its
   * own duration instead of decoding the audio again to measure it.
   */
  duration?: number;
  /**
   * Timed captions when the sender has them. A receiver whose output keeps the
   * words (Convert, Shape) passes them on again rather than losing them.
   */
  captions?: { srt: string; vtt: string };
}

/** Sections a take can be sent to, with the label their button shows. */
export const HANDOFF_TARGETS: Array<{ target: HandoffTarget; label: string }> = [
  { target: 'convert', label: 'Convert' },
  { target: 'transcribe', label: 'Transcribe' },
  { target: 'process', label: 'Shape' },
  { target: 'song', label: 'Beat' },
];

type Listener = (item: HandoffItem) => void;

let pending: { target: HandoffTarget; item: HandoffItem } | null = null;

/**
 * The sections that are open right now. A take sent to one of them is handed
 * over immediately: the hash would not change, so nothing would remount to take
 * it, and it would sit until the next visit and land there unasked.
 */
const open = new Map<HandoffTarget, Set<Listener>>();

/** Queue a take for `target`, or hand it straight to that section if it is open. */
export function sendHandoff(target: HandoffTarget, item: HandoffItem): void {
  const listeners = open.get(target);

  if (listeners && listeners.size > 0) {
    for (const listener of [...listeners]) listener(item);
    return;
  }

  pending = { target, item };
}

/**
 * Listen for takes sent to this section: one queued before it opened is handed
 * over at once, and one sent while it is open arrives without a remount.
 * Reading the queued item clears it, so a later visit starts empty.
 */
export function subscribeHandoff(target: HandoffTarget, listener: Listener): () => void {
  const listeners = open.get(target) ?? new Set<Listener>();
  open.set(target, listeners);
  listeners.add(listener);

  const queued = takeHandoff(target);
  if (queued) listener(queued);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) open.delete(target);
  };
}

/**
 * Queue the take and open its section. The route is replaced rather than pushed:
 * assigning a hash adds a history entry, and Back would then reopen the section
 * the user came from with its take already consumed — an empty page that looks
 * like undo. Replacing leaves Back pointing where they actually came from.
 * replaceState fires no hashchange, so the router is told by hand.
 */
export function sendTake(target: HandoffTarget, item: HandoffItem): void {
  sendHandoff(target, item);
  if (typeof window === 'undefined') return;

  window.history.replaceState(null, '', `#/${target}`);
  window.dispatchEvent(new Event('hashchange'));
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
