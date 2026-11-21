import { describe, expect, it } from 'vitest';
import { describeLiveGrade, gradeLiveInput } from './liveLevel';

describe('gradeLiveInput', () => {
  it('warns on hot peaks over the ACX ceiling', () => {
    expect(gradeLiveInput(-1, -80)).toEqual({ hot: true, noisy: false });
    expect(gradeLiveInput(-3.1, -80).hot).toBe(false);
  });

  it('warns on a high noise floor', () => {
    expect(gradeLiveInput(-12, -50)).toEqual({ hot: false, noisy: true });
    expect(gradeLiveInput(-12, -60.1).noisy).toBe(false);
  });

  it('stays quiet before it has measured anything', () => {
    expect(gradeLiveInput(null, null)).toEqual({ hot: false, noisy: false });
    expect(describeLiveGrade({ hot: false, noisy: false })).toEqual([]);
  });

  it('describes each flag in plain words', () => {
    expect(describeLiveGrade({ hot: true, noisy: false })).toEqual([
      'Hot input — back off the mic or lower the input gain.',
    ]);
    expect(describeLiveGrade({ hot: false, noisy: true })).toHaveLength(1);
  });
});
