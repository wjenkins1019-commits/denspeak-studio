// Tests for multi-voice tag parsing and voiced block planning.
import { describe, expect, it } from 'vitest';
import {
  extractVoiceTag,
  extractVoiceTagWithSpeaker,
  stripCastTags,
  type CastMember,
} from './cast';
import { planSpeech, planVoicedBlocks } from './humanize';

const CAST: CastMember[] = [
  { name: 'Leah', voiceId: 'en_US-lessac-high' },
  { name: 'Ryan', voiceId: 'en_US-ryan-high' },
];

describe('extractVoiceTag', () => {
  it('matches cast names case-insensitively and strips the tag', () => {
    expect(extractVoiceTag('Leah: Hello there.', CAST)).toEqual({
      voiceId: 'en_US-lessac-high',
      text: 'Hello there.',
    });
    expect(extractVoiceTag('ryan: Hello there.', CAST)).toEqual({
      voiceId: 'en_US-ryan-high',
      text: 'Hello there.',
    });
  });

  it('leaves non-cast prefixes untouched', () => {
    expect(extractVoiceTag('Note: read this carefully.', CAST)).toEqual({
      voiceId: null,
      text: 'Note: read this carefully.',
    });
    expect(extractVoiceTag('No colon here', CAST)).toEqual({
      voiceId: null,
      text: 'No colon here',
    });
  });

  it('treats a backslashed tag as literal text with the backslash stripped', () => {
    expect(extractVoiceTag('\\Leah: come here.', CAST)).toEqual({
      voiceId: null,
      text: 'Leah: come here.',
    });
  });

  it('only treats a paragraph-leading tag as a tag', () => {
    expect(extractVoiceTag('She said Leah: hello.', CAST)).toEqual({
      voiceId: null,
      text: 'She said Leah: hello.',
    });
  });
});

describe('extractVoiceTagWithSpeaker', () => {
  it('keeps the cast display name for captions', () => {
    expect(extractVoiceTagWithSpeaker('Leah: Hello there.', CAST)).toEqual({
      voiceId: 'en_US-lessac-high',
      speaker: 'Leah',
      text: 'Hello there.',
    });
  });

  it('reports no speaker for plain narration', () => {
    expect(extractVoiceTagWithSpeaker('Just narration.', CAST).speaker).toBeNull();
    expect(extractVoiceTagWithSpeaker('Note: read this carefully.', CAST).speaker).toBeNull();
  });
});

describe('stripCastTags', () => {
  it('strips tags for titles while keeping everything else', () => {
    expect(stripCastTags('Leah: Hello there.\n\nJust narration.', CAST)).toBe(
      'Hello there.\n\nJust narration.',
    );
    expect(stripCastTags('\\Leah: come here.', CAST)).toBe('Leah: come here.');
  });
});

describe('planVoicedBlocks', () => {
  it('matches planSpeech on untagged scripts', () => {
    const script = 'First paragraph here.\n\nSecond paragraph here.';
    const plain = planSpeech(script);
    const voiced = planVoicedBlocks(script, []);
    expect(voiced.map(({ text, pauseAfterMs }) => ({ text, pauseAfterMs }))).toEqual(plain);
    expect(voiced.every((block) => block.voiceId === null)).toBe(true);
  });

  it('assigns tagged paragraphs their cast voice and drops tag-only lines', () => {
    const script = 'Leah: First line here.\n\nRyan: Second line here.\n\nLeah:';
    const voiced = planVoicedBlocks(script, CAST);
    expect(voiced).toHaveLength(2);
    expect(voiced[0].voiceId).toBe('en_US-lessac-high');
    expect(voiced[0].text).toBe('First line here.');
    expect(voiced[0].speaker).toBe('Leah');
    expect(voiced[1].voiceId).toBe('en_US-ryan-high');
    expect(voiced[1].text).toBe('Second line here.');
    expect(voiced[1].speaker).toBe('Ryan');
  });

  it('leaves untagged blocks speaker-less', () => {
    const voiced = planVoicedBlocks('Just narration here.', CAST);
    expect(voiced).toHaveLength(1);
    expect(voiced[0].speaker).toBeNull();
  });

  it('keeps paragraph-end pauses between voices', () => {
    const script = 'Leah: One short line here.\n\nRyan: Another short line here.';
    const voiced = planVoicedBlocks(script, CAST);
    expect(voiced).toHaveLength(2);
    expect(voiced[0].pauseAfterMs).toBeGreaterThan(0);
    expect(voiced[1].pauseAfterMs).toBe(0);
  });
});
