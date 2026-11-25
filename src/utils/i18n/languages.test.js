import { describe, expect, it } from 'vitest';
import {
  findLanguageCode,
  getLanguageByName,
  getLanguageCodeForTTS,
  getLanguageData,
} from './languages.js';
import fa from './locales/fa.json';
import { UI_LOCALE_TO_CODE_MAP, getLanguageNameFromCode, getProviderLanguageCode } from '@/shared/config/languageConstants.js';
import { UI_LOCALES } from '@/shared/config/LocaleManifest.js';
import { OCR_LANGUAGE_MAP, SUPPORTED_OCR_LANGUAGES, toTesseractLanguageCode } from '@/features/screen-capture/utils/ocrLanguageMap.js';

describe('Persian language naming compatibility', () => {
  it('uses Persian for display and AI names while preserving the native UI name', async () => {
    const language = await getLanguageData('fa');
    expect(language.name).toBe('Persian');
    expect(fa.promptName).toBe('Persian');
    expect(getLanguageNameFromCode('fa')).toBe('Persian');
    expect(UI_LOCALES.find(locale => locale.code === 'fa')).toMatchObject({
      name: 'فارسی',
      aliases: ['فارسی', 'Persian', 'Farsi', 'fa'],
      flag: 'ir',
      dir: 'rtl',
    });
    expect(UI_LOCALE_TO_CODE_MAP.Persian).toBe('fa');
    expect(UI_LOCALE_TO_CODE_MAP.Farsi).toBe('fa');
  });

  it.each(['Persian', 'Farsi'])('resolves %s consistently for preferences and TTS', async name => {
    expect(await findLanguageCode(name)).toBe('fa');
    expect((await getLanguageByName(name)).code).toBe('fa');
    expect(await getLanguageCodeForTTS(name)).toBe('fa');
  });

  it('keeps provider, OCR, and language-code compatibility', () => {
    for (const provider of ['GOOGLE', 'LINGVA', 'BING', 'YANDEX', 'BROWSER', 'VAJEHYAB']) {
      expect(getProviderLanguageCode('Persian', provider)).toBe(getProviderLanguageCode('Farsi', provider));
    }
    expect(getProviderLanguageCode('Persian', 'GOOGLE')).toBe('fa');
    expect(OCR_LANGUAGE_MAP.fa).toBe('fas');
    expect(toTesseractLanguageCode('fa')).toBe('fas');
    expect(SUPPORTED_OCR_LANGUAGES.find(language => language.code === 'fas')).toMatchObject({ name: 'Persian' });
    expect(fa).toMatchObject({ code: 'fa', locale: 'fa', voiceCode: 'fa-IR', flagCode: 'ir' });
  });

  it('leaves unknown language fallback behavior intact', async () => {
    expect(await findLanguageCode('zz-unknown')).toBe('en');
    expect(await getLanguageCodeForTTS('zz-unknown')).toBe('en');
  });

  it('preserves unrelated language-name resolution behavior', async () => {
    expect(await findLanguageCode('Amharic')).toBe('en');
    expect(await getLanguageByName('Amharic')).toBeUndefined();
    expect(await getLanguageCodeForTTS('Amharic')).toBe('en');
  });

  it('does not treat inherited mapping properties as language aliases', async () => {
    expect(await findLanguageCode('constructor')).toBe('en');
    expect(await getLanguageByName('constructor')).toBeUndefined();
    expect(await getLanguageCodeForTTS('constructor')).toBe('en');
  });
});
