// Render presets must only name things that exist: every voice and EQ id is
// checked against the catalogs so a typo fails here, not in the Studio.
import { describe, expect, it } from 'vitest';
import { VOICES_BY_ID } from '../voices';
import { styleById } from './eq';
import { LOUDNESS_STANDARDS } from './loudness';
import { RENDER_PRESETS } from './renderPresets';

describe('render presets', () => {
  it('names four presets', () => {
    expect(RENDER_PRESETS.map((preset) => preset.name)).toEqual([
      'Audiobook Chapter',
      'Ad Spot',
      'Podcast',
      'Quick Draft',
    ]);
  });

  it('references real voices, sane speeds and strengths, and real EQ presets', () => {
    for (const preset of RENDER_PRESETS) {
      expect(VOICES_BY_ID.has(preset.voiceId), `${preset.name} voice`).toBe(true);
      expect(preset.speed).toBeGreaterThanOrEqual(0.6);
      expect(preset.speed).toBeLessThanOrEqual(1.6);
      expect(preset.strength).toBeGreaterThanOrEqual(0);
      expect(preset.strength).toBeLessThanOrEqual(1);
      expect(styleById(preset.eqPresetId).id, `${preset.name} EQ`).toBe(preset.eqPresetId);
    }
  });

  it('masters the delivery presets to real standards, and nothing else', () => {
    const byId = new Map(RENDER_PRESETS.map((preset) => [preset.id, preset]));
    expect(byId.get('audiobook')?.mastering).toBe('audiobook');
    expect(byId.get('ad')?.mastering).toBe('ad');
    expect(byId.get('podcast')?.mastering).toBeNull();
    expect(byId.get('draft')?.mastering).toBeNull();
    for (const preset of RENDER_PRESETS) {
      if (preset.mastering !== null) {
        expect(
          LOUDNESS_STANDARDS.some((entry) => entry.id === preset.mastering),
          `${preset.name} mastering`,
        ).toBe(true);
      }
    }
  });
});
