import { describe, expect, it } from 'vitest';
import { TranslationMode } from '@/shared/config/config.js';
import { resolveModeProvider, getProviderModeValidationError } from './providerSelection.js';

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

  it('does not impose dictionary capability validation that would prevent the established downgrade', () => {
    expect(getProviderModeValidationError('vajehyab', TranslationMode.Dictionary_Translation)).toBeNull();
  });
});
