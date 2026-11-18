import { beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applySelectElementMixedFontStyle, ensureSelectElementFontStyles } from './SelectElementFontStyles.js';

const selectFontCss = readFileSync(resolve(process.cwd(), 'src/public/translate-it-select-font.css'), 'utf8');
const protectedRoles = [
  'button', 'link', 'checkbox', 'radio', 'switch', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'tablist',
  'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'slider', 'spinbutton', 'scrollbar', 'treeitem', 'tree',
  'treegrid', 'gridcell', 'grid', 'row', 'rowheader', 'columnheader', 'menu', 'menubar', 'radiogroup', 'toolbar', 'application',
];
const getSelectors = style => {
  const selectors = [];
  for (const rule of style.sheet.cssRules) {
    let start = 0;
    let depth = 0;
    for (let index = 0; index < rule.selectorText.length; index += 1) {
      if (rule.selectorText[index] === '(') depth += 1;
      if (rule.selectorText[index] === ')') depth -= 1;
      if (rule.selectorText[index] === ',' && depth === 0) {
        selectors.push(rule.selectorText.slice(start, index).trim());
        start = index + 1;
      }
    }
    selectors.push(rule.selectorText.slice(start).trim());
  }
  return selectors;
};
const matchesTarget = (style, element) => getSelectors(style).some(selector => element.matches(selector));

describe('SelectElementFontStyles', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requests extension-context stylesheet injection once per document', () => {
    const doc = document.implementation.createHTMLDocument('font styles');
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({ success: true });

    expect(ensureSelectElementFontStyles(doc)).toBe(true);
    expect(ensureSelectElementFontStyles(doc)).toBe(true);
    expect(browser.runtime.sendMessage).toHaveBeenCalledOnce();
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({ action: 'injectSelectElementFontStyles' });
  });

  it('retries after an asynchronous injection rejection and caches success', async () => {
    const doc = document.implementation.createHTMLDocument('retry font styles');
    const sendMessage = vi.spyOn(browser.runtime, 'sendMessage')
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ success: true });

    expect(ensureSelectElementFontStyles(doc)).toBe(true);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      expect(ensureSelectElementFontStyles(doc)).toBe(true);
      expect(sendMessage).toHaveBeenCalledTimes(2);
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(ensureSelectElementFontStyles(doc)).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('retries after an explicit unsuccessful injection response', async () => {
    const doc = document.implementation.createHTMLDocument('unsuccessful font styles');
    const sendMessage = vi.spyOn(browser.runtime, 'sendMessage')
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: true });

    expect(ensureSelectElementFontStyles(doc)).toBe(true);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      expect(ensureSelectElementFontStyles(doc)).toBe(true);
      expect(sendMessage).toHaveBeenCalledTimes(2);
    });
  });

  it('deduplicates concurrent injection requests for a document', async () => {
    const doc = document.implementation.createHTMLDocument('concurrent font styles');
    let resolveRequest;
    const request = new Promise(resolve => { resolveRequest = resolve; });
    const sendMessage = vi.spyOn(browser.runtime, 'sendMessage').mockReturnValue(request);

    expect(ensureSelectElementFontStyles(doc)).toBe(true);
    expect(ensureSelectElementFontStyles(doc)).toBe(true);
    expect(sendMessage).toHaveBeenCalledOnce();
    resolveRequest({ success: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(ensureSelectElementFontStyles(doc)).toBe(true);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('does not trust a page-owned stylesheet ID when requesting extension injection', () => {
    const doc = document.implementation.createHTMLDocument('page-owned stylesheet ID');
    const pageElement = doc.createElement('style');
    pageElement.id = 'translate-it-select-font-styles';
    doc.head.append(pageElement);
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({ success: true });

    expect(ensureSelectElementFontStyles(doc)).toBe(true);
    expect(browser.runtime.sendMessage).toHaveBeenCalledOnce();
  });

  it('degrades without throwing when extension stylesheet messaging fails', () => {
    const doc = document.implementation.createHTMLDocument('blocked font styles');
    vi.spyOn(browser.runtime, 'sendMessage').mockRejectedValue(new Error('CSP'));

    expect(() => ensureSelectElementFontStyles(doc)).not.toThrow();
    expect(ensureSelectElementFontStyles(doc)).toBe(true);
    expect(browser.runtime.sendMessage).toHaveBeenCalledOnce();
  });

  it('skips CSS marker mutation when stylesheet messaging throws synchronously', () => {
    const doc = document.implementation.createHTMLDocument('invalidated extension context');
    const target = doc.createElement('span');
    const targetStates = new Map();
    vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(() => { throw new Error('context invalidated'); });

    expect(() => applySelectElementMixedFontStyle(target, 'system-ui', targetStates, doc)).not.toThrow();
    expect(targetStates.size).toBe(0);
    expect(target.hasAttribute('data-ti-select-font-target')).toBe(false);
    expect(target.style.getPropertyValue('--ti-select-element-font-family')).toBe('');
  });

  it('applies CSS marker and font without throwing when asynchronous stylesheet injection rejects', () => {
    const doc = document.implementation.createHTMLDocument('blocked target');
    const target = doc.createElement('span');
    const targetStates = new Map();
    vi.spyOn(browser.runtime, 'sendMessage').mockRejectedValue(new Error('CSP'));

    expect(() => applySelectElementMixedFontStyle(target, 'system-ui', targetStates, doc)).not.toThrow();
    expect(targetStates.size).toBe(1);
    expect(target.hasAttribute('data-ti-select-font-target')).toBe(true);
    expect(target.style.getPropertyValue('--ti-select-element-font-family')).toBe('system-ui');
  });

  it('styles textual links and quotes but excludes unsafe roots and descendants in the stylesheet selectors', () => {
    const style = document.createElement('style');
    style.textContent = selectFontCss;
    document.head.append(style);
    const root = document.createElement('span');
    root.setAttribute('data-ti-select-font-target', '');
    root.setAttribute('data-translate-dir', 'rtl');
    const link = document.createElement('a');
    const quote = document.createElement('q');
    const code = document.createElement('code');
    const codeText = document.createElement('span');
    code.append(codeText);
    const pre = document.createElement('pre');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const icon = document.createElement('i');
    icon.className = 'icon-home';
    const iconText = document.createElement('span');
    icon.append(iconText);
    const fontAwesome = document.createElement('i');
    fontAwesome.className = 'fa';
    const fontAwesomeText = document.createElement('span');
    fontAwesome.append(fontAwesomeText);
    const fontIcons = ['material-symbols-outlined', 'bi bi-alarm', 'bi-alarm', 'glyph-star'].map(className => {
      const iconElement = document.createElement('span');
      iconElement.className = className;
      const iconChild = document.createElement('span');
      iconElement.append(iconChild);
      return { iconElement, iconChild };
    });
    const protectedContainers = ['button', 'form', 'fieldset', 'label', 'kbd', 'samp', '[contenteditable]', ...protectedRoles.map(role => `[role="${role}"]`)]
      .map(selector => {
        const container = document.createElement(selector.startsWith('[') ? 'div' : selector);
        if (selector.startsWith('[')) {
          const [attribute, value] = selector.slice(1, -1).split('=');
          container.setAttribute(attribute, value ? value.replaceAll('"', '') : 'true');
        }
        const nestedText = document.createElement('span');
        container.append(nestedText);
        root.append(container);
        return { container, nestedText };
      });
    root.append(link, quote, code, pre, svg, icon, fontAwesome, ...fontIcons.map(({ iconElement }) => iconElement));
    document.body.append(root);
    const matches = element => matchesTarget(style, element);

    expect(matches(root)).toBe(true);
    expect(matches(link)).toBe(true);
    expect(matches(quote)).toBe(true);
    expect(matches(code)).toBe(false);
    expect(matches(codeText)).toBe(false);
    expect(matches(pre)).toBe(false);
    expect(matches(svg)).toBe(false);
    expect(matches(icon)).toBe(false);
    expect(matches(iconText)).toBe(false);
    expect(matches(fontAwesome)).toBe(false);
    expect(matches(fontAwesomeText)).toBe(false);
    for (const { iconElement, iconChild } of fontIcons) {
      expect(matches(iconElement)).toBe(false);
      expect(matches(iconChild)).toBe(false);
    }
    for (const { container, nestedText } of protectedContainers) {
      expect(matches(container)).toBe(false);
      expect(matches(nestedText)).toBe(false);
    }
    const ltrRoot = document.createElement('span');
    ltrRoot.setAttribute('data-ti-select-font-target', '');
    ltrRoot.setAttribute('data-translate-dir', 'ltr');
    document.body.append(ltrRoot);
    expect(matches(ltrRoot)).toBe(true);
    ltrRoot.remove();
    root.remove();
    style.remove();
  });

  it('does not match an explicitly marked Font Awesome root', () => {
    const style = document.createElement('style');
    style.textContent = selectFontCss;
    document.head.append(style);
    const root = document.createElement('i');
    root.className = 'fa';
    root.setAttribute('data-ti-select-font-target', '');
    expect(matchesTarget(style, root)).toBe(false);
    style.remove();
  });

  it.each(['code', 'pre', 'kbd', 'samp', 'button', 'input', 'textarea', 'select', '[contenteditable]', '.icon-home', '[data-icon]'])('does not match unsafe marked root %s', selector => {
      const root = document.createElement(selector.startsWith('[') || selector.startsWith('.') ? 'span' : selector);
      if (selector.startsWith('.')) root.className = selector.slice(1);
      else if (selector.startsWith('[')) root.setAttribute(selector.slice(1, -1).split('=')[0], '');
      root.setAttribute('data-ti-select-font-target', '');
      const rule = document.createElement('style');
      rule.textContent = selectFontCss;
      document.head.append(rule);
      expect(matchesTarget(rule, root)).toBe(false);
      rule.remove();
    });

  it.each(protectedRoles)('does not match a marked root with interactive ARIA role %s', role => {
    const root = document.createElement('span');
    root.setAttribute('role', role);
    root.setAttribute('data-ti-select-font-target', '');
    const rule = document.createElement('style');
    rule.textContent = selectFontCss;
    document.head.append(rule);
    expect(matchesTarget(rule, root)).toBe(false);
    rule.remove();
  });

  it('leaves the persistent stylesheet inert after ownership markers are removed', () => {
    const style = document.createElement('style');
    style.textContent = selectFontCss;
    document.head.append(style);
    const target = document.createElement('span');
    target.setAttribute('data-ti-select-font-target', '');
    document.body.append(target);
    const matches = () => matchesTarget(style, target);

    expect(matches()).toBe(true);
    target.removeAttribute('data-ti-select-font-target');
    expect(matches()).toBe(false);
    target.remove();
    style.remove();
  });
});
