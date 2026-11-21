// One-click render presets: curated voice + speed + naturalness + EQ stacks.
// Built-in only — applying one sets the four knobs directly and leaves pitch,
// form, shape and expressiveness alone. Projects auto-save the result.
export interface RenderPreset {
  id: string;
  name: string;
  blurb: string;
  voiceId: string;
  speed: number;
  humanize: boolean;
  strength: number;
  eqPresetId: string;
  /**
   * Delivery bar mastered at render time (`matchSamples` in the DSP tail),
   * so the take lands inside the standard without a later Match. Null means
   * no mastering — the raw -1 dBFS peak behaviour from before.
   */
  mastering: string | null;
}

export const RENDER_PRESETS: RenderPreset[] = [
  {
    id: 'audiobook',
    name: 'Audiobook Chapter',
    blurb: 'Leah at 75% through the audiobook EQ, mastered to Audiobook spec with ACX head/tail.',
    voiceId: 'en_US-lessac-high',
    speed: 1,
    humanize: true,
    strength: 0.75,
    eqPresetId: 'audiobook',
    mastering: 'audiobook',
  },
  {
    id: 'ad',
    name: 'Ad Spot',
    blurb: 'Ryan, slightly quickened, through the ad EQ, mastered to Ad Spot spec.',
    voiceId: 'en_US-ryan-high',
    speed: 1.05,
    humanize: true,
    strength: 0.8,
    eqPresetId: 'ad',
    mastering: 'ad',
  },
  {
    id: 'podcast',
    name: 'Podcast',
    blurb: 'Ava at 70% through the podcast EQ.',
    voiceId: 'en_US-amy-medium',
    speed: 1,
    humanize: true,
    strength: 0.7,
    eqPresetId: 'podcast',
    mastering: null,
  },
  {
    id: 'draft',
    name: 'Quick Draft',
    blurb: 'Ava raw and quick for timing checks.',
    voiceId: 'en_US-amy-medium',
    speed: 1.1,
    humanize: false,
    strength: 0.6,
    eqPresetId: 'flat',
    mastering: null,
  },
];
