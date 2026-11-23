import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleTranslateProvider } from './GoogleTranslate.js';
import { GoogleTranslateV2Provider } from './GoogleTranslateV2Provider.js';
import { BaseTranslateProvider } from './BaseTranslateProvider.js';
import {
  getDictionaryShowPronunciationAsync,
  getDictionaryShowPosAsync,
  getDictionaryShowDefinitionsAsync,
  getDictionaryShowExamplesAsync
} from '@/shared/config/config.js';
import { getTranslationString } from '@/utils/i18n/i18n.js';

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn() } },
    storage: { local: { get: vi.fn(), set: vi.fn() } }
  }
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    init: vi.fn(),
    operation: vi.fn(),
    performance: vi.fn()
  })
}));

vi.mock('@/shared/config/config.js', () => ({
  TranslationMode: {
    Page: 'page',
    Select_Element: 'select-element',
    Dictionary_Translation: 'dictionary'
  },
  getProviderOptimizationLevelAsync: vi.fn(() => Promise.resolve('balanced')),
  getGoogleTranslateUrlAsync: vi.fn(() => Promise.resolve('https://translate.google.com/translate_a/single')),
  getDictionaryShowPronunciationAsync: vi.fn(() => Promise.resolve(false)),
  getDictionaryShowPosAsync: vi.fn(() => Promise.resolve(false)),
  getDictionaryShowDefinitionsAsync: vi.fn(() => Promise.resolve(false)),
  getDictionaryShowExamplesAsync: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('@/shared/proxy/ProxySettings.js', () => ({
  getProxySettingsAsync: vi.fn().mockResolvedValue({}),
  resolveProxyConfig: vi.fn().mockResolvedValue({})
}));

vi.mock('@/features/translation/core/ProviderConfigurations.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getProviderBatching: vi.fn(() => ({
    strategy: 'character_limit',
    characterLimit: 5000,
    maxChunksPerBatch: 150
  }))
}));

vi.mock('@/features/translation/core/TranslationStatsManager.js', () => ({
  statsManager: {
    getSessionSummary: vi.fn(() => null)
  }
}));

vi.mock('@/features/translation/core/StreamingManager.js', () => ({
  streamingManager: {
    initializeStream: vi.fn()
  }
}));

vi.mock('./utils/TraditionalStreamManager.js', () => ({
  TraditionalStreamManager: {
    streamChunkResults: vi.fn(),
    streamChunkError: vi.fn()
  }
}));

vi.mock('@/utils/i18n/i18n.js', () => ({
  getTranslationString: vi.fn(() => Promise.resolve(''))
}));

vi.mock('@/utils/translation/TranslationSegmentMapper.js', () => ({
  TranslationSegmentMapper: {
    mapTranslationToOriginalSegments: vi.fn((joined, originalTexts) =>
      originalTexts.map((_, index) => joined.split('|||')[index] || '')
    )
  }
}));

describe('GoogleTranslateProvider newline chunk isolation', () => {
  let provider;
  let baseCreateChunksSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GoogleTranslateProvider();
    baseCreateChunksSpy = vi.spyOn(BaseTranslateProvider.prototype, '_createChunks');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('isolates newline-bearing items inside mixed multi-segment chunks', async () => {
    baseCreateChunksSpy.mockResolvedValue([
      { texts: ['A', 'B\n\nC', 'D'], charCount: 5 }
    ]);

    const chunks = await provider._createChunks(['A', 'B\n\nC', 'D']);

    expect(chunks.map(chunk => chunk.texts)).toEqual([
      ['A'],
      ['B\n\nC'],
      ['D']
    ]);
  });

  it('isolates line-break-bearing items inside mixed multi-segment chunks', async () => {
    baseCreateChunksSpy.mockResolvedValue([
      { texts: ['A', 'B\nC', 'D'], charCount: 5 }
    ]);

    const chunks = await provider._createChunks(['A', 'B\nC', 'D']);

    expect(chunks.map(chunk => chunk.texts)).toEqual([
      ['A'],
      ['B\nC'],
      ['D']
    ]);
  });

  it('does not isolate whitespace-padded wrapper newlines', async () => {
    const originalChunk = { texts: ['A', '\n      Pinned\n    ', 'C'], charCount: 3 };
    baseCreateChunksSpy.mockResolvedValue([originalChunk]);

    const chunks = await provider._createChunks(['A', '\n      Pinned\n    ', 'C']);

    expect(chunks).toEqual([originalChunk]);
  });

  it('does not isolate indentation-only wrapper newlines around one content line', async () => {
    const first = { i: 'n1', t: 'A' };
    const wrapped = { i: 'n2', t: '\n        Webchat to API (Gemini)\n      ' };
    const last = { i: 'n3', t: 'C' };
    baseCreateChunksSpy.mockResolvedValue([
      { texts: [first, wrapped, last], charCount: 3 }
    ]);

    const chunks = await provider._createChunks([first, wrapped, last]);

    expect(chunks).toEqual([
      { texts: [first, wrapped, last], charCount: 3 }
    ]);
    expect(chunks[0].texts[1]).toBe(wrapped);
  });

  describe('_formatDictionaryAsMarkdown', () => {
    beforeEach(() => {
      vi.mocked(getDictionaryShowPronunciationAsync).mockResolvedValue(true);
      vi.mocked(getDictionaryShowPosAsync).mockResolvedValue(true);
      vi.mocked(getDictionaryShowDefinitionsAsync).mockResolvedValue(true);
      vi.mocked(getDictionaryShowExamplesAsync).mockResolvedValue(true);
      vi.mocked(getTranslationString).mockResolvedValue('');
    });

    it('formats legacy string candidates as the current Markdown contract', async () => {
      const result = await provider._formatDictionaryAsMarkdown(
        'Noun*Phrase: test, experiment\nVerb_(rare): try, attempt'
      );

      expect(result).toBe('**Noun\\*Phrase**: test, experiment\n**Verb\\_\\(rare\\)**: try, attempt');
    });

    it('formats dj=1 JSON candidates as the current Markdown contract', async () => {
      vi.mocked(getTranslationString).mockImplementation(async (key) => {
        const labels = {
          dict_pronunciation: 'Pronou[nce](ment)*',
          dict_definitions: 'Defi[nitions](set)*',
          dict_examples: 'Exam[ples](list)*'
        };

        return labels[key] || '';
      });

      const result = await provider._formatDictionaryAsMarkdown({
        dict: [{ pos: 'Noun*Phrase', terms: ['test', 'experiment'] }],
        sentences: [{ src_translit: 'tɛst*' }],
        definitions: [{ pos: 'noun', entry: [{ gloss: 'a *test* (example)' }] }],
        examples: { example: [{ text: 'This *is* a [test]' }] }
      });

      expect(result).toBe(
        '**Noun\\*Phrase**: test, experiment\n\n**Pronou\\[nce\\]\\(ment\\)\\***: /tɛst*/\n\n**Defi\\[nitions\\]\\(set\\)\\***:\n- (noun) a *test* (example)\n\n**Exam\\[ples\\]\\(list\\)\\***:\n- This *is* a [test]'
      );
    });

    it('returns an empty string for malformed or empty candidate data', async () => {
      expect(await provider._formatDictionaryAsMarkdown(null)).toBe('');
      expect(await provider._formatDictionaryAsMarkdown('')).toBe('');
      expect(await provider._formatDictionaryAsMarkdown({})).toBe('');
    });

    it('matches Google Translate V2 for the same candidate fixture', async () => {
      vi.mocked(getTranslationString).mockImplementation(async (key) => {
        const labels = {
          dict_pronunciation: 'Pronou[nce](ment)*',
          dict_definitions: 'Defi[nitions](set)*',
          dict_examples: 'Exam[ples](list)*'
        };

        return labels[key] || '';
      });

      const v2Provider = new GoogleTranslateV2Provider();
      const candidate = {
        dict: [{ pos: 'Noun*Phrase', terms: ['test', 'experiment'] }],
        sentences: [{ src_translit: 'tɛst*' }],
        definitions: [{ pos: 'noun', entry: [{ gloss: 'a *test* (example)' }] }],
        examples: { example: [{ text: 'This *is* a [test]' }] }
      };

      const classicResult = await provider._formatDictionaryAsMarkdown(candidate);
      const v2Result = await v2Provider._formatDictionaryAsMarkdown(candidate);

      expect(classicResult).toBe(v2Result);
      expect(classicResult).toBe(
        '**Noun\\*Phrase**: test, experiment\n\n**Pronou\\[nce\\]\\(ment\\)\\***: /tɛst*/\n\n**Defi\\[nitions\\]\\(set\\)\\***:\n- (noun) a *test* (example)\n\n**Exam\\[ples\\]\\(list\\)\\***:\n- This *is* a [test]'
      );
    });
  });

  describe('_translateChunk', () => {
    beforeEach(() => {
      vi.mocked(getDictionaryShowPronunciationAsync).mockResolvedValue(true);
      vi.mocked(getDictionaryShowPosAsync).mockResolvedValue(true);
      vi.mocked(getDictionaryShowDefinitionsAsync).mockResolvedValue(true);
      vi.mocked(getDictionaryShowExamplesAsync).mockResolvedValue(true);
      vi.mocked(getTranslationString).mockResolvedValue('');
    });

    it('returns translation only when dictionary data is absent', async () => {
      const options = { providerMetadataRef: { metadata: {} } };
      vi.spyOn(provider, '_executeRequest').mockImplementation(async (opts) =>
        opts.extractResponse({
          sentences: [{ trans: 'translated text' }],
          src: 'en'
        })
      );

      const result = await provider._translateChunk(
        ['hello'],
        'en',
        'fa',
        'page',
        null,
        0,
        1,
        0,
        1,
         options
      );

      expect(result).toBe('translated text');
      expect(options.providerMetadataRef.metadata.detectedLanguage).toBe('en');
      expect(provider).not.toHaveProperty('lastDetectedLanguage');
    });

    it.each([
      ['invalid response shape', {}],
      ['empty modern sentences', { sentences: [] }],
      ['invalid legacy array', { 0: {} }],
      ['blank modern item', { sentences: [{ trans: '   ' }] }],
    ])('throws API_RESPONSE_INVALID for %s', async (_label, response) => {
      vi.spyOn(provider, '_executeRequest').mockImplementation(async (opts) => opts.extractResponse(response));

      const options = { providerMetadataRef: { metadata: {} } };
      await expect(provider._translateChunk(['source'], 'en', 'fa', 'page', null, 0, 1, 0, 1, options))
        .rejects.toMatchObject({ type: 'API_RESPONSE_INVALID' });
      expect(options.providerMetadataRef.metadata).toEqual({});
    });

    it('accepts valid legacy and source-equal responses', async () => {
      vi.spyOn(provider, '_executeRequest').mockImplementation(async (opts) => opts.extractResponse([[['URL', 'URL']]]));

      await expect(provider._translateChunk(['URL'], 'en', 'fa', 'page', null, 0, 1, 0, 1, {})).resolves.toBe('URL');
    });

    it('keeps Classic gtx request parameters and maps delimiter-separated segments', async () => {
      const execute = vi.spyOn(provider, '_executeRequest').mockImplementation(async options =>
        options.extractResponse([
          [['ترجمه اول', 'first source'], ['[[---]]', '[[---]]'], ['ترجمه دوم', 'second source']],
          null,
          'en',
        ])
      );

      await expect(provider._translateChunk(
        ['first source', 'second source'], 'en', 'fa', 'page', null, 0, 2, 0, 1, {}
      )).resolves.toEqual(['ترجمه اول', 'ترجمه دوم']);

      const request = execute.mock.calls[0][0];
      const url = new URL(request.url);
      expect(url.searchParams.get('client')).toBe('gtx');
      expect(url.searchParams.get('sl')).toBe('en');
      expect(url.searchParams.get('tl')).toBe('fa');
      expect(url.searchParams.getAll('dt')).toEqual(['at', 'bd', 'ex', 'ld', 'md', 'qca', 'rw', 'rm', 'ss', 't']);
      expect(request.fetchOptions.method).toBe('POST');
      expect(request.fetchOptions.headers['Content-Type']).toBe('application/x-www-form-urlencoded;charset=UTF-8');
      expect(request.fetchOptions.body).toContain(encodeURIComponent('first source'));
    });

    it('rejects a missing required segment in a multi-item legacy response', async () => {
      vi.spyOn(provider, '_executeRequest').mockImplementation(async (opts) => opts.extractResponse([[['only first', 'first']]]));

      await expect(provider._translateChunk(['first', 'second'], 'en', 'fa', 'page', null, 0, 2, 0, 1, {}))
        .rejects.toMatchObject({ type: 'API_RESPONSE_INVALID' });
    });

    it('appends single-segment dictionary output using the current Markdown contract', async () => {
      vi.spyOn(provider, '_executeRequest').mockImplementation(async (opts) =>
        opts.extractResponse({
          sentences: [{ trans: 'translated text', src_translit: 'tɛst*' }],
          src: 'en',
          dict: [{ pos: 'Noun*Phrase', terms: ['test', 'experiment'] }],
          definitions: [{ pos: 'noun', entry: [{ gloss: 'a test' }] }],
          examples: { example: [{ text: 'This is a test' }] }
        })
      );

      const result = await provider._translateChunk(
        ['hello'],
        'en',
        'fa',
        'dictionary',
        null,
        0,
        1,
        0,
        1,
        {}
      );

      expect(result).toBe(
        'translated text\n\n**Noun\\*Phrase**: test, experiment\n\n**Pronunciation**: /tɛst*/\n\n**Definitions**:\n- (noun) a test\n\n**Examples**:\n- This is a test'
      );
    });
  });

  it('sends newline-bearing items to _translateChunk as single-item chunks', async () => {
    baseCreateChunksSpy.mockResolvedValue([
      { texts: ['A', 'B\n\nC', 'D'], charCount: 5 }
    ]);
    vi.spyOn(provider, '_executeWithRateLimit').mockImplementation(async (fn) => fn({}));
    const translateChunkSpy = vi.spyOn(provider, '_translateChunk').mockImplementation(async (texts) =>
      texts.map(text => `translated:${text}`)
    );

    const result = await provider._traditionalBatchTranslate(
      ['A', 'B\n\nC', 'D'],
      'en',
      'fa',
      'select-element',
      null,
      null,
      null,
      'high',
      'session-1',
      'STRING'
    );

    expect(translateChunkSpy.mock.calls.map(call => call[0])).toEqual([
      ['A'],
      ['B\n\nC'],
      ['D']
    ]);
    expect(result).toEqual([
      'translated:A',
      'translated:B\n\nC',
      'translated:D'
    ]);
  });

  it('keeps non-paragraph multi-segment chunks unchanged', async () => {
    const originalChunk = { texts: ['A', 'B', 'C'], charCount: 3 };
    baseCreateChunksSpy.mockResolvedValue([originalChunk]);

    const chunks = await provider._createChunks(['A', 'B', 'C']);

    expect(chunks).toEqual([originalChunk]);
  });

  it('preserves Select Element object identity for line-break-bearing payloads', async () => {
    const first = { i: 'n1', t: 'A' };
    const lineBreak = { i: 'n2', t: 'B\nC' };
    const last = { i: 'n3', t: 'D' };
    baseCreateChunksSpy.mockResolvedValue([
      { texts: [first, lineBreak, last], charCount: 5 }
    ]);

    const chunks = await provider._createChunks([first, lineBreak, last]);

    expect(chunks.map(chunk => chunk.texts)).toEqual([
      [first],
      [lineBreak],
      [last]
    ]);
    expect(chunks[1].texts[0]).toBe(lineBreak);
  });

  it('isolates real single internal newlines', async () => {
    baseCreateChunksSpy.mockResolvedValue([
      { texts: ['A', 'Photo: Aryamhar\nBio: constitutional monarchist', 'C'], charCount: 3 }
    ]);

    const chunks = await provider._createChunks(['A', 'Photo: Aryamhar\nBio: constitutional monarchist', 'C']);

    expect(chunks.map(chunk => chunk.texts)).toEqual([
      ['A'],
      ['Photo: Aryamhar\nBio: constitutional monarchist'],
      ['C']
    ]);
  });

  it('isolates paragraph double newlines', async () => {
    baseCreateChunksSpy.mockResolvedValue([
      { texts: ['A', 'Paragraph one\n\nParagraph two', 'C'], charCount: 3 }
    ]);

    const chunks = await provider._createChunks(['A', 'Paragraph one\n\nParagraph two', 'C']);

    expect(chunks.map(chunk => chunk.texts)).toEqual([
      ['A'],
      ['Paragraph one\n\nParagraph two'],
      ['C']
    ]);
  });

  it('preserves result order across isolated and batched chunks', async () => {
    baseCreateChunksSpy.mockResolvedValue([
      { texts: ['A', 'B\n\nC', 'D', 'E'], charCount: 7 }
    ]);
    vi.spyOn(provider, '_executeWithRateLimit').mockImplementation(async (fn) => fn({}));
    vi.spyOn(provider, '_translateChunk').mockImplementation(async (texts) =>
      texts.map(text => `translated:${text}`)
    );

    const result = await provider._traditionalBatchTranslate(
      ['A', 'B\n\nC', 'D', 'E'],
      'en',
      'fa',
      'select-element',
      null,
      null,
      null,
      'high',
      'session-1',
      'STRING'
    );

    expect(result).toEqual([
      'translated:A',
      'translated:B\n\nC',
      'translated:D',
      'translated:E'
    ]);
  });

  it('normalizes duplicated slash-dash artifacts in the single-segment sentences parser', async () => {
    const sourceText = '+ /-';
    const apiResponse = {
      sentences: [
        { trans: '+ //-', orig: sourceText }
      ]
    };

    vi.spyOn(provider, '_executeRequest').mockImplementation(async (opts) => opts.extractResponse(apiResponse));

    const result = await provider._translateChunk(
      [sourceText],
      'en',
      'fa',
      'select-element',
      null,
      0,
      1,
      0,
      1,
      {}
    );

    expect(result).toBe('+ /-');
  });
});
