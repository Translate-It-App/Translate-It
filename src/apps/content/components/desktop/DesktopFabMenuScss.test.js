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

  it('sizes the menu to content within the available viewport and aligns scopes to the label column', () => {
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
    expect(declaration(scopes, 'padding-inline-start'))
      .toMatch(/calc\(var\(--menu-icon-box\)\s*\+\s*var\(--menu-gap\)\)/);
  });
});
