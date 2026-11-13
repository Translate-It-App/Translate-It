import { describe, expect, it } from 'vitest';
import { targetTexts } from './e2e-benchmark/fixture.mjs';
import { mapEdgeResponse, validateTranslation } from './e2e-benchmark/metrics.mjs';

describe('page translation runtime fixture', () => {
  it('uses short unique source strings and validates the fixture translation mapping', () => {
    expect(targetTexts.length).toBeGreaterThan(0);
    expect(new Set(targetTexts).size).toBe(targetTexts.length);
    const originals = targetTexts.map((text, index) => [`target-${index}`, text]);
    const translated = originals.map(([id, text]) => [id, `\u200efixture translation: ${text}`]);
    const requests = originals.map(([, text]) => text);
    const restored = new Map(originals);
    expect(mapEdgeResponse(requests)).toHaveLength(requests.length);
    expect(validateTranslation({ originals, translated, requests, restored }).ok).toBe(true);
    expect(validateTranslation({ originals, translated, requests, restored, expectedCount: targetTexts.length + 1 }).ok).toBe(false);
  });
});
