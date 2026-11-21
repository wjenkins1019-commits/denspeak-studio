import { HANDOFF_TARGETS, type HandoffTarget } from './handoff';

/** How many takes are waiting for each section, as the rail sees them. */
export type WaitingCounts = Partial<Record<HandoffTarget, number>>;

/**
 * What to say when takes land for sections other than the one on screen.
 *
 * Increases only: taking or discarding lowers a count, and reading every
 * decrement aloud would bury the arrival it is meant to announce. The section
 * already open reports its own queue in the notice, so it is left out.
 */
export function waitingAnnouncement(
  before: WaitingCounts,
  after: WaitingCounts,
  onScreen: string | null,
  labelFor: (target: HandoffTarget) => string,
): string {
  const landed: string[] = [];

  for (const { target } of HANDOFF_TARGETS) {
    if (target === onScreen) continue;
    const now = after[target] ?? 0;
    if (now <= (before[target] ?? 0)) continue;
    landed.push(`${now === 1 ? '1 take' : `${now} takes`} waiting for ${labelFor(target)}`);
  }

  return landed.join('. ');
}

/** Whether a queue got shorter, so the last spoken line is no longer true. */
export function waitingFell(before: WaitingCounts, after: WaitingCounts): boolean {
  return HANDOFF_TARGETS.some(({ target }) => (after[target] ?? 0) < (before[target] ?? 0));
}
