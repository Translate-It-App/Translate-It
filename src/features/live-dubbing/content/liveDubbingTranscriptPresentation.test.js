import { describe, expect, it } from 'vitest';
import {
  getVisibleLiveDubbingSourceTranscript,
  getVisibleLiveDubbingTranscript,
  shouldShowLiveDubbingOriginalTranscript,
  LIVE_DUBBING_VISIBLE_CHARACTER_LIMIT,
  LIVE_DUBBING_VISIBLE_SOURCE_CHARACTER_LIMIT,
} from './liveDubbingTranscriptPresentation.js';

describe('live dubbing transcript presentation', () => {
  it('uses the active transcript provider preference without leaking across providers', () => {
    const settings = {
      LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_GEMINI: true,
      LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_OPENAI: false,
    };

    expect(shouldShowLiveDubbingOriginalTranscript(settings, 'gemini')).toBe(true);
    expect(shouldShowLiveDubbingOriginalTranscript(settings, 'openai')).toBe(false);
    expect(shouldShowLiveDubbingOriginalTranscript({
      LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_GEMINI: false,
      LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_OPENAI: true,
    }, 'openai')).toBe(true);
    expect(shouldShowLiveDubbingOriginalTranscript(settings, null)).toBe(false);
  });

  it('keeps short translated text with whitespace unchanged', () => {
    expect(getVisibleLiveDubbingTranscript({ translatedFragments: ['hello world'] })).toBe('hello world');
  });

  it('clips only the visible window while retaining newest translated text', () => {
    const retained = { translatedFragments: ['a'.repeat(2000), 'b'.repeat(2000)] };

    expect(retained.translatedFragments.join('').length).toBeGreaterThan(LIVE_DUBBING_VISIBLE_CHARACTER_LIMIT);
    expect(getVisibleLiveDubbingTranscript(retained)).toBe('b'.repeat(400));
  });

  it('starts the translated window at the first whitespace boundary in the recent suffix', () => {
    const text = 'older '.repeat(100) + 'newest words';
    const suffix = text.slice(-LIVE_DUBBING_VISIBLE_CHARACTER_LIMIT);
    const boundary = suffix.search(/\s/);

    expect(getVisibleLiveDubbingTranscript({ translatedFragments: [text] })).toBe(suffix.slice(boundary + 1));
  });

  it('keeps a translated suffix unchanged when no whitespace boundary exists', () => {
    expect(getVisibleLiveDubbingTranscript({ translatedFragments: ['x'.repeat(500)] })).toBe('x'.repeat(400));
  });

  it('keeps short source text with whitespace unchanged', () => {
    expect(getVisibleLiveDubbingSourceTranscript({ sourceFragments: ['hello world'] })).toBe('hello world');
  });

  it('clips the source window at its own limit, not the translated limit', () => {
    const retained = { sourceFragments: ['a'.repeat(2000), 'b'.repeat(200)] };

    expect(retained.sourceFragments.join('').length).toBeGreaterThan(LIVE_DUBBING_VISIBLE_SOURCE_CHARACTER_LIMIT);
    expect(LIVE_DUBBING_VISIBLE_SOURCE_CHARACTER_LIMIT).toBeLessThan(LIVE_DUBBING_VISIBLE_CHARACTER_LIMIT);
    expect(getVisibleLiveDubbingSourceTranscript(retained)).toBe('b'.repeat(200));
  });

  it('starts the source window at the first whitespace boundary in the recent suffix', () => {
    const text = 'ancien '.repeat(50) + 'derniers mots';
    const suffix = text.slice(-LIVE_DUBBING_VISIBLE_SOURCE_CHARACTER_LIMIT);
    const boundary = suffix.search(/\s/);

    expect(getVisibleLiveDubbingSourceTranscript({ sourceFragments: [text] })).toBe(suffix.slice(boundary + 1));
  });

  it('keeps a source suffix unchanged when no whitespace boundary exists', () => {
    expect(getVisibleLiveDubbingSourceTranscript({ sourceFragments: ['y'.repeat(300)] })).toBe('y'.repeat(200));
  });

  it('computes each kind window independently of the other kind', () => {
    const snapshot = {
      translatedFragments: ['t'.repeat(4000)],
      sourceFragments: ['short source'],
    };
    expect(getVisibleLiveDubbingTranscript(snapshot)).toBe('t'.repeat(400));
    expect(getVisibleLiveDubbingSourceTranscript(snapshot)).toBe('short source');

    const flipped = {
      translatedFragments: ['short translated'],
      sourceFragments: ['s'.repeat(4000)],
    };
    expect(getVisibleLiveDubbingTranscript(flipped)).toBe('short translated');
    expect(getVisibleLiveDubbingSourceTranscript(flipped)).toBe('s'.repeat(200));
  });
});
