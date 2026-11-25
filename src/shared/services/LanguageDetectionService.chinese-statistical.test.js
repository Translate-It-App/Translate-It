import { beforeEach, describe, expect, it, vi } from 'vitest';

const { detectLanguage } = vi.hoisted(() => ({
  detectLanguage: vi.fn(),
}));

vi.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: {
    i18n: {
      detectLanguage,
      getUILanguage: () => 'en-US',
    },
  },
}));

vi.mock('@/shared/config/config.js', () => ({
  getLanguageDetectionPreferencesAsync: vi.fn(async () => ({
    'latin-script': 'none',
    'arabic-script': 'fa',
    'chinese-script': 'zh-cn',
    'devanagari-script': 'hi',
    targetLanguage: 'en',
  })),
}));

import {
  DETECTION_PROVENANCE,
  DETECTION_CONFIDENCE,
  LanguageDetectionService,
} from './LanguageDetectionService.js';

describe('LanguageDetectionService statistical Chinese validation', () => {
  beforeEach(() => {
    detectLanguage.mockReset();
    LanguageDetectionService.clearSessionCache();
  });

  it.each(['zh', 'zh-CN', 'zh-TW', 'lzh', 'yue'])(
    'rejects Latin-only samples for statistical candidate %s without forcing English',
    async (language) => {
      const sample = 'This is a sufficiently long Latin-only sample for detection.';
      detectLanguage.mockResolvedValue({
        isReliable: true,
        languages: [{ language, percentage: 100 }],
      });

      await expect(LanguageDetectionService.detectDetailed(sample)).resolves.toMatchObject({
        language: null,
        confidence: DETECTION_CONFIDENCE.UNKNOWN,
        provenance: DETECTION_PROVENANCE.UNKNOWN,
      });
    },
  );

  it.each([
    ['Simplified Chinese', '这是一个用于验证统计检测的简体中文样本。'.repeat(5), 'zh-CN', 'zh-cn'],
    ['Traditional Chinese', '這是一個用於驗證統計檢測的繁體中文樣本。'.repeat(5), 'zh-TW', 'zh-tw'],
  ])('accepts genuine %s with statistical provenance', async (_label, sample, detectedLanguage, expectedLanguage) => {
    detectLanguage.mockResolvedValue({
      isReliable: true,
      languages: [{ language: detectedLanguage, percentage: 96 }],
    });

    await expect(LanguageDetectionService.detectDetailed(sample)).resolves.toMatchObject({
      language: expectedLanguage,
      confidence: DETECTION_CONFIDENCE.HIGH,
      provenance: DETECTION_PROVENANCE.STATISTICAL,
    });
  });

  it('accepts mixed Chinese/Latin text with low Han density', async () => {
    const sample = `This long Latin sample contains a Han character 中 ${'and more English text '.repeat(4)}`;
    detectLanguage.mockResolvedValue({
      isReliable: false,
      languages: [{ language: 'zh-TW', percentage: 55 }],
    });

    await expect(LanguageDetectionService.detectDetailed(sample)).resolves.toMatchObject({
      language: 'zh-tw',
      confidence: DETECTION_CONFIDENCE.MEDIUM,
      provenance: DETECTION_PROVENANCE.STATISTICAL,
    });
  });

  it('accepts supplementary Han characters', async () => {
    const sample = `This sample contains supplementary Han ${String.fromCodePoint(0x20000)} and enough Latin text to exercise statistics.`;
    detectLanguage.mockResolvedValue({
      isReliable: true,
      languages: [{ language: 'zh', percentage: 90 }],
    });

    await expect(LanguageDetectionService.detectDetailed(sample)).resolves.toMatchObject({
      language: 'zh-cn',
      provenance: DETECTION_PROVENANCE.STATISTICAL,
    });
  });

  it('rejects an untrusted short Traditional Chinese guess and preserves the low-confidence heuristic fallback', async () => {
    detectLanguage.mockResolvedValue({
      isReliable: true,
      languages: [{ language: 'zh-TW', percentage: 100 }],
    });

    await expect(LanguageDetectionService.detectDetailed('中日和平')).resolves.toMatchObject({
      language: 'zh-cn',
      confidence: DETECTION_CONFIDENCE.LOW,
      provenance: DETECTION_PROVENANCE.HEURISTIC,
      reliable: false,
    });
  });
});
