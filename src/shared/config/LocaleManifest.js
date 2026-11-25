/**
 * LocaleManifest.js
 * Single source of truth for all supported UI languages (i18n).
 */

export const UI_LOCALES = [
  { 
    code: 'en', 
    name: 'English', 
    flag: 'gb', // References icons/flags/gb.svg
    dir: 'ltr',
    aliases: ['English', 'en']
  },
  { 
    code: 'fa', 
    name: 'فارسی', 
    flag: 'ir', // References icons/flags/ir.svg
    dir: 'rtl',
    aliases: ['فارسی', 'Persian', 'Farsi', 'fa']
  },
  { 
    code: 'ja', 
    name: '日本語', 
    flag: 'jp', // References icons/flags/jp.svg
    dir: 'ltr',
    aliases: ['日本語', 'Japanese', 'ja']
  }
];

/**
 * Gets the manifest for a specific locale code
 */
export const getLocaleInfo = (code) => UI_LOCALES.find(l => l.code === code);
