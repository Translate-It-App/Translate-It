import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PageTranslationSettingsLoader } from './PageTranslationSettingsLoader.js';
import { TranslationMode } from '@/config.js';

// Mock config functions
vi.mock('@/config.js', () => ({
  getWholePageLazyLoadingAsync: vi.fn(),
  getWholePageAutoTranslateOnDOMChangesAsync: vi.fn(),
  getWholePageRootMarginAsync: vi.fn(),
  getWholePageExcludedSelectorsAsync: vi.fn(),
  getWholePageAttributesToTranslateAsync: vi.fn(),
  getWholePageShowOriginalOnHoverAsync: vi.fn(),
  getWholePageUseTranslationFontAsync: vi.fn(),
  getWholePageTranslateAfterScrollStopAsync: vi.fn(),
  getWholePageScrollStopDelayAsync: vi.fn(),
  getWholePageTokenWarningHiddenAsync: vi.fn(),
  getTranslationApiAsync: vi.fn(),
  getTargetLanguageAsync: vi.fn(),
  getModeProvidersAsync: vi.fn(),
  getAIContextTranslationEnabledAsync: vi.fn(),
  getTranslationFontFamilyAsync: vi.fn(),
  TranslationMode: { Page: 'page' },
  CONFIG: {
    WHOLE_PAGE_CHUNK_SIZE: 100,
    WHOLE_PAGE_MAX_CONCURRENT_REQUESTS: 3
  }
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    debugLazy: vi.fn()
  }))
}));

vi.mock('@/shared/fonts/TranslationFontResolver.js', () => ({
  resolveTranslationFontFamily: vi.fn(),
}));

import * as config from '@/config.js';
import { resolveTranslationFontFamily } from '@/shared/fonts/TranslationFontResolver.js';

describe('PageTranslationSettingsLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Default mock returns
    config.getWholePageRootMarginAsync.mockResolvedValue(150);
    config.getModeProvidersAsync.mockResolvedValue({});
    config.getTranslationApiAsync.mockResolvedValue('google');
    config.getTargetLanguageAsync.mockResolvedValue('fa');
    config.getWholePageLazyLoadingAsync.mockResolvedValue(true);
    config.getWholePageAutoTranslateOnDOMChangesAsync.mockResolvedValue(true);
    config.getWholePageExcludedSelectorsAsync.mockResolvedValue(['.ignore']);
    config.getWholePageAttributesToTranslateAsync.mockResolvedValue(['title']);
    config.getWholePageShowOriginalOnHoverAsync.mockResolvedValue(true);
    config.getWholePageTranslateAfterScrollStopAsync.mockResolvedValue(true);
    config.getWholePageScrollStopDelayAsync.mockResolvedValue(500);
    config.getWholePageTokenWarningHiddenAsync.mockResolvedValue(false);
    config.getAIContextTranslationEnabledAsync.mockResolvedValue(true);
    config.getWholePageUseTranslationFontAsync.mockResolvedValue(false);
    config.getTranslationFontFamilyAsync.mockResolvedValue('auto');
    resolveTranslationFontFamily.mockReturnValue('system-ui');
  });

  it('should load settings with correct formatting', async () => {
    const settings = await PageTranslationSettingsLoader.load();

    expect(settings).toEqual({
      translationApi: 'google',
      isExplicitProvider: false,
      usesGlobalProvider: true,
      targetLanguage: 'fa',
      lazyLoading: true,
      rootMargin: '150px',
      autoTranslateOnDOMChanges: true,
      excludedSelectors: ['.ignore'],
      attributesToTranslate: ['title'],
      showOriginalOnHover: true,
      translateAfterScrollStop: true,
      scrollStopDelay: 500,
      tokenWarningHidden: false,
      aiContextTranslationEnabled: true,
      chunkSize: 100,
      maxConcurrentFlushes: 3,
      useTranslationFont: false,
      translationFontFamily: null,
    });
  });

  it('loads optional translation font settings only when enabled', async () => {
    config.getWholePageUseTranslationFontAsync.mockResolvedValue(true);
    config.getTranslationFontFamilyAsync.mockResolvedValue('auto');

    const settings = await PageTranslationSettingsLoader.load();

    expect(settings.useTranslationFont).toBe(true);
    expect(settings.translationFontFamily).toBe('system-ui');
    expect(resolveTranslationFontFamily).toHaveBeenCalledWith('auto', 'fa');
  });

  it('does not read or resolve font when optional toggle is off', async () => {
    const settings = await PageTranslationSettingsLoader.load();

    expect(settings.translationFontFamily).toBeNull();
    expect(config.getTranslationFontFamilyAsync).not.toHaveBeenCalled();
    expect(resolveTranslationFontFamily).not.toHaveBeenCalled();
  });

  it.each([
    ['toggle read', false, () => config.getWholePageUseTranslationFontAsync.mockRejectedValueOnce(new Error('toggle failure'))],
    ['font read', true, () => {
      config.getWholePageUseTranslationFontAsync.mockResolvedValueOnce(true);
      config.getTranslationFontFamilyAsync.mockRejectedValueOnce(new Error('font failure'));
    }],
    ['font resolution', true, () => {
      config.getWholePageUseTranslationFontAsync.mockResolvedValueOnce(true);
      resolveTranslationFontFamily.mockImplementationOnce(() => { throw new Error('resolver failure'); });
    }],
  ])('keeps Page Translation settings load successful when %s fails', async (_name, expectedUse, fail) => {
    fail();

    await expect(PageTranslationSettingsLoader.load()).resolves.toMatchObject({
      useTranslationFont: expectedUse,
      translationFontFamily: null,
    });
  });

  it('should preserve configured editable selectors unchanged', async () => {
    const selectors = ['textarea', "[contenteditable='true']", '.custom'];
    config.getWholePageExcludedSelectorsAsync.mockResolvedValue(selectors);

    const settings = await PageTranslationSettingsLoader.load();

    expect(settings.excludedSelectors).toEqual(selectors);
  });

  it('should handle rootMargin with units', async () => {
    config.getWholePageRootMarginAsync.mockResolvedValue('20%');
    const settings = await PageTranslationSettingsLoader.load();
    expect(settings.rootMargin).toBe('20%');
  });

  it('should prioritize options over stored settings', async () => {
    const settings = await PageTranslationSettingsLoader.load({
      provider: 'gemini',
      targetLanguage: 'en'
    });

    expect(settings.translationApi).toBe('gemini');
    expect(settings.isExplicitProvider).toBe(true);
    expect(settings.usesGlobalProvider).toBe(false);
    expect(settings.targetLanguage).toBe('en');
  });

  it('should resolve provider priority: Options > Mode Provider > Global Provider', async () => {
    // Mode specific exists
    config.getModeProvidersAsync.mockResolvedValue({ [TranslationMode.Page]: 'openai' });
    config.getTranslationApiAsync.mockResolvedValue('google');

    let settings = await PageTranslationSettingsLoader.load();
    expect(settings.translationApi).toBe('openai');
    expect(settings.isExplicitProvider).toBe(false);
    expect(settings.usesGlobalProvider).toBe(false);

    // Option overrides mode specific
    settings = await PageTranslationSettingsLoader.load({ provider: 'gemini' });
    expect(settings.translationApi).toBe('gemini');
    expect(settings.isExplicitProvider).toBe(true);
    expect(settings.usesGlobalProvider).toBe(false);

    // If mode specific doesn't exist, use global
    config.getModeProvidersAsync.mockResolvedValue({});
    settings = await PageTranslationSettingsLoader.load();
    expect(settings.translationApi).toBe('google');
    expect(settings.usesGlobalProvider).toBe(true);
  });

  it.each([undefined, null, ''])('marks a falsy Page override (%s) as global-dependent', async (provider) => {
    config.getModeProvidersAsync.mockResolvedValue({ [TranslationMode.Page]: provider });

    expect(await PageTranslationSettingsLoader.load()).toMatchObject({
      translationApi: 'google', isExplicitProvider: false, usesGlobalProvider: true,
    });
  });

  it('keeps a Page override independent even when it equals the global provider', async () => {
    config.getModeProvidersAsync.mockResolvedValue({ [TranslationMode.Page]: 'google' });

    expect(await PageTranslationSettingsLoader.load()).toMatchObject({
      translationApi: 'google', isExplicitProvider: false, usesGlobalProvider: false,
    });
  });

  it('should use default values for missing settings', async () => {
    config.getWholePageRootMarginAsync.mockResolvedValue(null);
    config.getWholePageScrollStopDelayAsync.mockResolvedValue(undefined);
    
    const settings = await PageTranslationSettingsLoader.load();
    
    expect(settings.rootMargin).toBe('150px');
    expect(settings.scrollStopDelay).toBe(500);
  });
});
