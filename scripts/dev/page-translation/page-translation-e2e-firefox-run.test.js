// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  PAGE_TRANSLATION_SLICED_DISCOVERY,
  PAGE_TRANSLATION_VIEWPORT_FIRST_DISCOVERY,
} from '../../../src/features/page-translation/PageTranslationConstants.js';

const runSource = await readFile(new URL('./e2e-firefox/run.mjs', import.meta.url), 'utf8');

function readSourceDefault(name) {
  const objectMatch = runSource.match(/sourceDefaults:\s*\{([^}]*)\}/);
  expect(objectMatch, 'sourceDefaults literal not found in run.mjs').not.toBeNull();
  const fieldMatch = objectMatch[1].match(new RegExp(`\\b${name}:\\s*(true|false)\\b`));
  expect(fieldMatch, `sourceDefaults.${name} not found in run.mjs`).not.toBeNull();
  return fieldMatch[1] === 'true';
}

describe('run.mjs source discovery defaults', () => {
  it('mirrors the production discovery constants', () => {
    expect(readSourceDefault('slicedDiscovery')).toBe(PAGE_TRANSLATION_SLICED_DISCOVERY);
    expect(readSourceDefault('viewportFirstDiscovery')).toBe(PAGE_TRANSLATION_VIEWPORT_FIRST_DISCOVERY);
  });
});
