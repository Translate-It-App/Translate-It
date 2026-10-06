import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scssPath = resolve(dirname(fileURLToPath(import.meta.url)), 'DesktopFabMenu.scss');
const source = readFileSync(scssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function block(selector) {
  const match = selector.exec(source);
  expect(match, `missing SCSS block: ${selector}`).toBeTruthy();
  const start = match.index + match[0].lastIndexOf('{') + 1;
  let depth = 1;
  for (let end = start; end < source.length; end += 1) {
    if (source[end] === '{') depth += 1;
    if (source[end] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, end);
  }
  throw new Error(`Unclosed SCSS block: ${selector}`);
}

function declaration(rule, property) {
  return rule.match(new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+)`))?.[1].trim();
}

const menu = block(/\.desktop-fab-container\s*\{[\s\S]*?\.desktop-fab-menu\s*\{/);
const item = block(/\.fab-menu-item\s*\{/);

describe('DesktopFabMenu SCSS layout contract', () => {
  it('keeps menu icon geometry independent of FAB scaling', () => {
    const wrapper = block(/\.menu-icon-wrapper\s*\{/);
    const icon = block(/\.fab-menu-icon\s*\{/);
    const progress = block(/\.fab-circle-progress\s*\{/);

    expect(declaration(wrapper, 'width')).toBe('var(--menu-icon-box) !important');
    expect(declaration(wrapper, 'height')).toBe('var(--menu-icon-box) !important');
    expect(declaration(icon, 'width')).toBe('var(--menu-icon-size) !important');
    expect(declaration(icon, 'height')).toBe('var(--menu-icon-size) !important');
    expect(declaration(progress, 'width')).toMatch(/var\(--menu-icon-box\)/);
    expect(declaration(progress, 'height')).toMatch(/var\(--menu-icon-box\)/);
    expect(`${wrapper}${icon}${progress}`).not.toContain('--fab-size');
  });

  it('lets long labels wrap inside the row without forcing the star onto another line', () => {
    const label = block(/\.fab-menu-item-text\s*\{/);

    expect(declaration(label, 'min-width')).toBe('0 !important');
    expect(declaration(label, 'overflow-wrap')).toBe('anywhere !important');
    expect(label).not.toMatch(/(?:white-space|text-wrap)\s*:\s*nowrap/);
    expect(declaration(item, 'display')).toBe('flex !important');
    expect(declaration(item, 'flex-wrap')).toBe('wrap !important');
    expect(declaration(item, 'column-gap')).toBe('var(--menu-gap) !important');
    expect(declaration(block(/\.fab-auto-translate-scopes\s*\{/), 'flex'))
      .toBe('0 0 100% !important');
  });

  it('sizes the menu to content within the available viewport and contains the scope panel', () => {
    expect(declaration(menu, 'width')).toBe('max-content !important');
    const minWidth = declaration(menu, 'min-width') ?? '';
    const minWidthVariable = source.match(/--menu-min-width\s*:\s*([^;]+);/)?.[1] ?? '';
    const boundedMinimum = `${minWidth} ${minWidthVariable}`;
    expect(boundedMinimum).toMatch(/min\([^;]*(?:190px|var\(--menu-min-width\))[^;]*var\(--menu-(?:avail|available)-width\)|min\([^;]*var\(--menu-(?:avail|available)-width\)[^;]*(?:190px|var\(--menu-min-width\))/);

    const maxWidth = declaration(menu, 'max-width') ?? '';
    expect(maxWidth).toMatch(/min\([^;]*(?:260px|var\(--menu-max-width\))/);
    expect(maxWidth).toMatch(/var\(--menu-(?:avail|available)-width\)/);
    const availableWidth = declaration(menu, '--menu-avail-width')
      ?? declaration(menu, '--menu-available-width')
      ?? '';
    expect(availableWidth).toMatch(/100vw/);

    const scopes = block(/\.fab-auto-translate-scopes\s*\{/);
    const panelDeclarations = scopes.slice(0, scopes.indexOf('{'));
    expect(declaration(panelDeclarations, 'contain')).toBe('inline-size !important');
    expect(declaration(panelDeclarations, 'width')).toBe('100% !important');
    expect(declaration(panelDeclarations, 'flex')).toBe('0 0 100% !important');
    expect(declaration(panelDeclarations, 'padding-inline-start')).toBeUndefined();

    const scopeButton = block(/\.fab-auto-translate-scopes\s*\{[\s\S]*?button\s*\{/);
    const scopeInfo = block(/\.fab-auto-translate-scopes\s*\{[\s\S]*?div\s*\{/);
    const labelColumnIndent = /calc\(var\(--menu-icon-box\)\s*\+\s*var\(--menu-gap\)\)/;
    expect(declaration(scopeButton, 'margin-inline-start')).toMatch(labelColumnIndent);
    expect(declaration(scopeButton, 'width')).toBe('auto !important');
    expect(declaration(scopeInfo, 'font-size')).toBe('0.85em !important');
    expect(declaration(scopeInfo, 'margin-inline-start')).toMatch(labelColumnIndent);

    const separator = block(/\.fab-auto-translate-scopes\s*\{[\s\S]*?\.fab-scope-separator\s*\{/);
    const separatorOpacity = Number.parseFloat(declaration(separator, 'opacity'));
    const separatorAlpha = Number.parseFloat(
      declaration(separator, 'border-color')?.match(/,\s*(0?\.\d+)\s*\)/)?.[1],
    );
    expect(separatorOpacity <= 0.5 || separatorAlpha <= 0.5).toBe(true);
    expect(declaration(separator, 'margin') ?? declaration(separator, 'margin-inline-start'))
      .toMatch(labelColumnIndent);

    const note = block(/\.fab-auto-translate-scopes\s*\{[\s\S]*?\.fab-scope-note\s*\{/);
    expect(declaration(note, 'color')).toBe('#5b6472 !important');
    expect(declaration(note, 'overflow-wrap')).toMatch(/anywhere/);
    expect(declaration(note, 'margin-inline-start')).toBeUndefined();
    expect(declaration(note, 'font-size')).toBeUndefined();
    const darkNote = block(/&\.theme-dark\s*\{[\s\S]*?\.fab-scope-note\s*\{/);
    expect(declaration(darkNote, 'color')).toBe('rgba(255, 255, 255, 0.6) !important');

    const manageLink = block(/\.fab-auto-translate-scopes\s*\{[\s\S]*?\.fab-scope-link\s*\{/);
    const linkFontSize = declaration(manageLink, 'font-size') ?? '';
    const linkPadding = declaration(manageLink, 'padding') ?? '';
    const fontSizeValue = Number.parseFloat(linkFontSize);
    const compactFont = (linkFontSize.endsWith('px') && fontSizeValue < 13)
      || ((linkFontSize.endsWith('em') || linkFontSize.endsWith('rem')) && fontSizeValue < 1);
    const paddingValue = Number.parseFloat(linkPadding);
    expect(compactFont || paddingValue < 5).toBe(true);
    const focusVisible = block(/\.fab-scope-link\s*\{[\s\S]*?&:focus-visible\s*\{/);
    expect(declaration(focusVisible, 'outline')).toMatch(/\S/);
    expect(declaration(manageLink, 'margin-inline-start')).toBeUndefined();

    const lightLink = block(/&\.theme-light\s*\{[\s\S]*?\.fab-scope-link\s*\{/);
    const darkLink = block(/&\.theme-dark\s*\{[\s\S]*?\.fab-scope-link\s*\{/);
    const lightIdleColor = declaration(manageLink, 'color') ?? declaration(lightLink, 'color');
    expect(lightIdleColor).toBe('#1a5fb4 !important');
    expect(declaration(darkLink, 'color')).toMatch(/(?:#60a5fa|rgb\(96,\s*165,\s*250\))\s*!important/);
    expect(lightIdleColor).not.toBe(declaration(note, 'color'));
    expect(declaration(darkLink, 'color')).not.toBe(declaration(darkNote, 'color'));

    const linkAlignment = declaration(manageLink, 'align-self') ?? '';
    const linkWidth = declaration(manageLink, 'width') ?? declaration(manageLink, 'inline-size') ?? '';
    const linkFlex = declaration(manageLink, 'flex') ?? '';
    expect(/(?:flex-start|start)/.test(linkAlignment)
      || /(?:fit-content|max-content)/.test(linkWidth)
      || /0\s+0\s+auto/.test(linkFlex)).toBe(true);
    expect(declaration(manageLink, 'min-width')).toBe('0 !important');
    expect(declaration(manageLink, 'overflow-wrap')).toBe('anywhere !important');
    const linkMaxWidth = declaration(manageLink, 'max-width')
      ?? declaration(manageLink, 'max-inline-size')
      ?? '';
    expect(linkMaxWidth).toMatch(/calc\(/);
    expect(/--menu-icon-box/.test(linkMaxWidth) && /--menu-gap/.test(linkMaxWidth)
      || /var\(--menu-(?:label-)?indent/.test(linkMaxWidth)).toBe(true);
  });
});
