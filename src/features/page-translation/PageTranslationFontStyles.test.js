import { beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensurePageTranslationFontStyles } from './PageTranslationFontStyles.js';

const css = readFileSync(resolve(process.cwd(), 'src/public/translate-it-page-font.css'), 'utf8');

describe('PageTranslationFontStyles', () => {
  beforeEach(() => vi.clearAllMocks());

  it('retries failed stylesheet injection on a later accepted target', async () => {
    const doc = document.implementation.createHTMLDocument('page font styles');
    const sendMessage = vi.spyOn(browser.runtime, 'sendMessage')
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: true });

    expect(ensurePageTranslationFontStyles(doc)).toBe(true);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      expect(ensurePageTranslationFontStyles(doc)).toBe(true);
      expect(sendMessage).toHaveBeenCalledTimes(2);
    });
    expect(sendMessage).toHaveBeenCalledWith({ action: 'injectPageTranslationFontStyles' });
  });

  it('styles textual links and quotes while excluding sensitive and Select-owned descendants', () => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    const root = document.createElement('div');
    root.setAttribute('data-ti-page-font-target', '');
    root.style.setProperty('--ti-page-translation-font-family', 'system-ui');
    const link = document.createElement('a');
    const quote = document.createElement('q');
    const explicitFont = document.createElement('span');
    explicitFont.style.fontFamily = 'serif';
    const code = document.createElement('code');
    const control = document.createElement('button');
    const buttonText = document.createElement('span');
    const form = document.createElement('form');
    const formText = document.createElement('span');
    const editable = document.createElement('div');
    const editableText = document.createElement('span');
    const roleButton = document.createElement('div');
    const roleButtonText = document.createElement('span');
    const label = document.createElement('label');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const icon = document.createElement('i');
    icon.className = 'icon-home';
    const fontIcons = ['material-symbols-outlined', 'bi bi-alarm', 'bi-alarm', 'glyph-star'].map(className => {
      const iconElement = document.createElement('span');
      iconElement.className = className;
      const iconChild = document.createElement('span');
      iconElement.append(iconChild);
      return { iconElement, iconChild };
    });
    const codeText = document.createElement('span');
    code.append(codeText);
    control.append(buttonText);
    form.append(formText);
    editable.setAttribute('contenteditable', 'true');
    editable.append(editableText);
    roleButton.setAttribute('role', 'button');
    roleButton.append(roleButtonText);
    const combo = document.createElement('div');
    combo.setAttribute('role', 'combobox');
    const comboText = document.createElement('span');
    combo.append(comboText);
    const selectOwned = document.createElement('span');
    selectOwned.setAttribute('data-ti-select-font-target', '');
    const selectOwnedDescendant = document.createElement('span');
    selectOwned.append(selectOwnedDescendant);
    const nestedPageTarget = document.createElement('span');
    nestedPageTarget.setAttribute('data-ti-page-font-target', '');
    selectOwned.append(nestedPageTarget);
    root.append(link, quote, explicitFont, code, control, form, editable, roleButton, label, svg, icon, combo, selectOwned, ...fontIcons.map(({ iconElement }) => iconElement));
    document.body.append(root);
    const selectors = [...style.sheet.cssRules].map(rule => rule.selectorText);
    const matchesTarget = element => selectors.some(selector => element.matches(selector));
    const rules = [...style.sheet.cssRules];
    const fontRules = rules.filter(rule => rule.style?.getPropertyValue('font-family'));

    expect(matchesTarget(link)).toBe(true);
    expect(matchesTarget(quote)).toBe(true);
    expect(fontRules).toHaveLength(2);
    expect(fontRules.every(rule => rule.style.getPropertyValue('font-family') === 'var(--ti-page-translation-font-family)')).toBe(true);
    expect(fontRules.every(rule => rule.style.getPropertyPriority('font-family') === '')).toBe(true);
    expect(explicitFont.style.fontFamily).toBe('serif');
    expect(matchesTarget(code)).toBe(false);
    expect(matchesTarget(codeText)).toBe(false);
    for (const { iconElement, iconChild } of fontIcons) {
      expect(matchesTarget(iconElement)).toBe(false);
      expect(matchesTarget(iconChild)).toBe(false);
    }
    expect(matchesTarget(control)).toBe(false);
    expect(matchesTarget(buttonText)).toBe(false);
    expect(matchesTarget(formText)).toBe(false);
    expect(matchesTarget(editableText)).toBe(false);
    expect(matchesTarget(roleButtonText)).toBe(false);
    expect(matchesTarget(label)).toBe(false);
    expect(matchesTarget(svg)).toBe(false);
    expect(matchesTarget(icon)).toBe(false);
    expect(matchesTarget(combo)).toBe(false);
    expect(matchesTarget(comboText)).toBe(false);
    expect(matchesTarget(selectOwned)).toBe(false);
    expect(matchesTarget(selectOwnedDescendant)).toBe(false);
    expect(matchesTarget(nestedPageTarget)).toBe(false);

    style.remove();
    root.remove();
  });
});
