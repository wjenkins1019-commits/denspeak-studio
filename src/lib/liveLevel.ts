// Live input grading for the record-time meter.
//
// The same two bars the post-take LevelCheck grades, read off the live mic:
// peaks must stay under the -3 dB ACX ceiling (anything hotter will need
// peak-limiting later, and clipping can't be fixed at all), and the room's
// noise floor must stay under -60 dB. Pure data, so the thresholds are
// unit-tested in node; the meter component only reads the mic and calls this.
export const LIVE_HOT_PEAK_DB = -3;
export const LIVE_NOISE_MAX_DB = -60;

export interface LiveGrade {
  hot: boolean;
  noisy: boolean;
}

/**
 * Grade one meter reading. Nulls mean "not measured yet" (first frames) and
 * never warn — a meter that cries wolf before it has heard anything is worse
 * than a quiet one.
 */
export function gradeLiveInput(
  peakDb: number | null,
  noiseDb: number | null,
): LiveGrade {
  return {
    hot: peakDb !== null && peakDb > LIVE_HOT_PEAK_DB,
    noisy: noiseDb !== null && noiseDb > LIVE_NOISE_MAX_DB,
  };
}

/** Short human advice for each raised flag, in display order. */
export function describeLiveGrade(grade: LiveGrade): string[] {
  const notes: string[] = [];
  if (grade.hot) notes.push('Hot input — back off the mic or lower the input gain.');
  if (grade.noisy) notes.push('Room noise is high — a quieter spot now beats cleaning gaps later.');
  return notes;
}
