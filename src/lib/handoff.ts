// Passing a finished take to another section without exporting a WAV and
// uploading it again. The pending item is module state, which outlives the view
// that created it: navigating swaps the view, not the page.

export type HandoffTarget = 'convert' | 'transcribe' | 'process' | 'song';

/** Any section that can send a take, including the two that only ever send. */
export type HandoffSource = HandoffTarget | 'studio' | 'library';

/** What each section is called in the UI, e.g. 'Shape' for `process`. */
const SECTION_LABELS: Record<HandoffSource, string> = {
  studio: 'Studio',
  convert: 'Convert',
  transcribe: 'Transcribe',
  process: 'Shape',
  song: 'Song',
  library: 'Library',
};

/** Label for a section in prose, as in "Back to Convert". */
export function sectionLabel(section: HandoffSource): string {
  return SECTION_LABELS[section];
}

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
  /**
   * The section that sent it. A hand-off replaces the history entry the user
   * would have used to go back, so the receiver offers that way back itself.
   */
  from?: HandoffSource;
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
 * Show `section`, replacing the route rather than pushing one. Assigning a hash
 * would add an entry, and Back would then reopen a section whose take the
 * hand-off already consumed — an empty page that looks like undo. Replacing
 * leaves Back meaning "leave this flow".
 *
 * The History API never fires hashchange (MDN: pushState and replaceState both
 * leave it alone, even when only the fragment changes), so the router — which
 * only watches that event — is told by hand or the view would not swap.
 */
export function openSection(section: HandoffSource): void {
  if (typeof window === 'undefined') return;

  window.history.replaceState(null, '', `#/${section}`);
  window.dispatchEvent(new Event('hashchange'));
}

/** Queue the take, then open its section so it lands there. */
export function sendTake(target: HandoffTarget, item: HandoffItem): void {
  sendHandoff(target, item);
  openSection(target);
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
