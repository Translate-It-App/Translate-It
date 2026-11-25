import { describe, expect, it } from 'vitest';
import { TranslationMode } from '@/shared/config/config.js';
import {
  getProviderModeValidationError,
  getProviderModeValidationMessage,
  PROVIDER_CAPABILITY_UNSUPPORTED,
  resolveModeProvider,
} from './providerSelection.js';

describe('provider selection', () => {
  it('preserves mode, dictionary inheritance, and global precedence', () => {
    expect(resolveModeProvider(
      TranslationMode.Page,
      { [TranslationMode.Page]: 'google', [TranslationMode.Selection]: 'gemini' },
      'edge',
      TranslationMode.Dictionary_Translation,
      TranslationMode.Selection,
      'edge',
    )).toBe('google');
    expect(resolveModeProvider(
      TranslationMode.Dictionary_Translation,
      { [TranslationMode.Dictionary_Translation]: null, [TranslationMode.Selection]: 'gemini' },
      'edge',
      TranslationMode.Dictionary_Translation,
      TranslationMode.Selection,
      'edge',
    )).toBe('gemini');
    expect(resolveModeProvider(
      TranslationMode.Page,
      {},
      'edge',
      TranslationMode.Dictionary_Translation,
      TranslationMode.Selection,
      'edge',
    )).toBe('edge');
  });

  it('fails closed for unsupported mode capabilities, unknown, and unconfigured providers', () => {
    expect(getProviderModeValidationError('vajehyab', TranslationMode.Page)).toBeInstanceOf(Error);
    expect(getProviderModeValidationError('vajehyab', TranslationMode.PDF)).toBeInstanceOf(Error);
    expect(getProviderModeValidationError('vajehyab', TranslationMode.Select_Element)).toBeInstanceOf(Error);
    expect(getProviderModeValidationError('vajehyab', TranslationMode.Field)).toBeInstanceOf(Error);
    expect(getProviderModeValidationError('vajehyab', TranslationMode.Subtitle)).toBeInstanceOf(Error);
    expect(getProviderModeValidationError('missing-provider', TranslationMode.Selection)).toBeInstanceOf(Error);
    expect(getProviderModeValidationError('gemini', TranslationMode.Selection, { GEMINI_API_KEY: '' })).toBeInstanceOf(Error);
    expect(getProviderModeValidationError('googlev2', TranslationMode.Page)).toBeNull();
  });

  it('preserves typed provider configuration errors', () => {
    expect(getProviderModeValidationError('gemini', TranslationMode.Selection, { GEMINI_API_KEY: '' }))
      .toMatchObject({ type: 'API_KEY_MISSING' });
    expect(getProviderModeValidationError('custom', TranslationMode.Selection, {}))
      .toMatchObject({ type: 'API_URL_MISSING' });
  });

  it('distinguishes missing capability from missing provider configuration messages', () => {
    const unsupported = getProviderModeValidationError('vajehyab', TranslationMode.Page);
    const missingKey = getProviderModeValidationError(
      'gemini',
      TranslationMode.Selection,
      { GEMINI_API_KEY: '' },
    );
    const missingUrl = getProviderModeValidationError('custom', TranslationMode.Selection, {});
    const t = (key) => key;

    expect(unsupported.code).toBe(PROVIDER_CAPABILITY_UNSUPPORTED);
    expect(getProviderModeValidationMessage(unsupported, t)).toBe('provider_does_not_support_bulk');
    expect(missingKey.type).toBe('API_KEY_MISSING');
    expect(getProviderModeValidationMessage(missingKey, t)).toBe('ERRORS_API_KEY_MISSING');
    expect(missingUrl.type).toBe('API_URL_MISSING');
    expect(getProviderModeValidationMessage(missingUrl, t)).toBe('ERRORS_API_URL_MISSING');
  });

  it.each([
    ['en', 'Invalid provider configuration'],
    ['fa', 'پیکربندی ارائه‌دهنده نامعتبر است'],
    ['ja', 'プロバイダーの設定が無効です'],
  ])('uses a localized configuration fallback for unknown providers (%s)', (locale, translated) => {
    const unknown = getProviderModeValidationError('missing-provider', TranslationMode.Selection);
    const messages = {
      en: { ERRORS_API_CONFIG_INVALID: 'Invalid provider configuration' },
      fa: { ERRORS_API_CONFIG_INVALID: 'پیکربندی ارائه‌دهنده نامعتبر است' },
      ja: { ERRORS_API_CONFIG_INVALID: 'プロバイダーの設定が無効です' },
    };
    const t = (key, fallback) => messages[locale][key] || fallback || key;

    expect(getProviderModeValidationMessage(unknown, t)).toBe(translated);
    expect(getProviderModeValidationMessage(unknown, t)).not.toContain('ERRORS_');
  });

  it('does not impose dictionary capability validation that would prevent the established downgrade', () => {
    expect(getProviderModeValidationError('vajehyab', TranslationMode.Dictionary_Translation)).toBeNull();
  });
});
