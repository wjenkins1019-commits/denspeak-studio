// Tests for the crash-resume identity logic: fingerprints must be stable for
// the same render and distinct for different ones, so a reloaded queue adopts
// the right takes and checkpoints. The IndexedDB wrappers themselves are
// covered by the browser crash test, not here.
import { describe, expect, it } from 'vitest';
import { checkpointKey, jobFingerprint } from './queuePersist';
import type { NarrationSettings } from './narrate';

function settings(overrides: Partial<NarrationSettings> = {}): NarrationSettings {
  return {
    voice: { baseVoiceId: 'en_US-bryce-medium', isClone: false, cloneName: '' },
    speed: 1,
    humanize: true,
    strength: 0.6,
    expressiveness: 0.5,
    semitones: 0,
    formant: 0,
    brightness: 0,
    eqPresetId: 'flat',
    ...overrides,
  };
}

describe('jobFingerprint', () => {
  it('is stable for the same render', () => {
    const input = { text: 'Hello world', settings: settings(), voiceId: 'en_US-bryce-medium' };
    expect(jobFingerprint(input)).toBe(jobFingerprint(input));
  });

  it('changes when text, settings or voice change', () => {
    const base = { text: 'Hello world', settings: settings(), voiceId: 'en_US-bryce-medium' };
    const variants = [
      { ...base, text: 'Hello world!' },
      { ...base, voiceId: 'en_US-amy-medium' },
      { ...base, settings: settings({ speed: 1.1 }) },
      { ...base, settings: settings({ eqPresetId: 'telephone' }) },
      { ...base, settings: settings({ mastering: 'audiobook' }) },
    ];
    for (const variant of variants) {
      expect(jobFingerprint(variant)).not.toBe(jobFingerprint(base));
    }
  });
});

describe('checkpointKey', () => {
  it('scopes blocks to their job', () => {
    expect(checkpointKey('job-a', 3)).toBe('job-a:3');
    expect(checkpointKey('job-a', 3)).not.toBe(checkpointKey('job-b', 3));
    expect(checkpointKey('job-a', 3)).not.toBe(checkpointKey('job-a', 4));
  });
});
