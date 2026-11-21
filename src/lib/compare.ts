// Shared bits for the Studio voice A/B compare.
//

// Both sides render through the global queue as ordinary jobs, so they can
// never drive the engine twice at once; the group keeps them apart from the
// Studio narration and the audiobook chapters.
export const COMPARE_GROUP = 'compare';

/** Longest sample worth rendering twice; beyond this the wait doubles. */
const MAX_SAMPLE = 600;

/**
 * The sample box default: the script's first paragraph, trimmed and capped.
 * Empty scripts give an empty sample, which disables Render both.
 */
export function defaultSample(script: string): string {
  const first = script.split(/\n\s*\n/)[0]?.trim() ?? '';
  if (first.length <= MAX_SAMPLE) return first;
  const cut = first.slice(0, MAX_SAMPLE);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > MAX_SAMPLE / 2 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/** Which compare side a queue job belongs to: chapter 0 is A, 1 is B. */
export function compareSideOf(job: { group: string; chapterIndex: number }): 0 | 1 | null {
  if (job.group !== COMPARE_GROUP) return null;
  if (job.chapterIndex === 0) return 0;
  if (job.chapterIndex === 1) return 1;
  return null;
}
