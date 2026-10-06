import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, reactive } from 'vue';
import { useAutoTranslateRules } from './useAutoTranslateRules.js';
import { matchesAutoTranslateRule } from '@/utils/ui/exclusion.js';

const harness = vi.hoisted(() => ({ store: null, openOptionsPage: vi.fn() }));

vi.mock('@/features/settings/stores/settings.js', () => ({ useSettingsStore: () => harness.store }));
vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({ useUnifiedI18n: () => ({ t: key => key }) }));
vi.mock('@/core/helpers.js', () => ({ openOptionsPage: (...args) => harness.openOptionsPage(...args) }));

const makeStore = (rules = []) => ({
  settings: reactive({ WHOLE_PAGE_AUTO_TRANSLATE_RULES: [...rules] }),
  updateSettingAndPersist: vi.fn(async (key, value) => {
    harness.store.settings[key] = value;
  }),
});

const setup = (url = 'https://example.com/docs?query=1#section', rules = []) => {
  harness.store = makeStore(rules);
  const currentUrl = ref(url);
  return { currentUrl, rulesApi: useAutoTranslateRules({ currentUrl }) };
};

describe('useAutoTranslateRules', () => {
  beforeEach(() => harness.openOptionsPage.mockReset());

  it('adds and removes a page rule independently', async () => {
    const { rulesApi } = setup();
    await rulesApi.scopeActions.togglePageScope();
    expect(harness.store.settings.WHOLE_PAGE_AUTO_TRANSLATE_RULES).toEqual(['https://example.com/docs']);
    await rulesApi.toggleAutoTranslateForCurrentPage();
    expect(harness.store.settings.WHOLE_PAGE_AUTO_TRANSLATE_RULES).toEqual([]);
  });

  it('removes all semantically exact page rules without disturbing the site scope', async () => {
    const { rulesApi } = setup('https://example.com/docs', [
      'example.com/docs', 'https://example.com/docs', 'example.com/*',
    ]);
    expect(rulesApi.hasPageRule.value).toBe(true);
    await rulesApi.scopeActions.togglePageScope();
    expect(harness.store.settings.WHOLE_PAGE_AUTO_TRANSLATE_RULES).toEqual(['example.com/*']);
  });

  it('recognizes and removes a file page rule despite current query and hash', async () => {
    const { rulesApi } = setup('file:///tmp/page.html?x=1#frag', ['file:///tmp/page.html']);
    expect(rulesApi.hasPageRule.value).toBe(true);
    await rulesApi.scopeActions.togglePageScope();
    expect(harness.store.settings.WHOLE_PAGE_AUTO_TRANSLATE_RULES).toEqual([]);
  });

  it('adds and removes the current hostname site rule', async () => {
    const { rulesApi } = setup('https://docs.example.com/page');
    expect(rulesApi.siteRule.value).toBe('docs.example.com/*');
    await rulesApi.scopeActions.toggleSiteScope();
    expect(harness.store.settings.WHOLE_PAGE_AUTO_TRANSLATE_RULES).toEqual(['docs.example.com/*']);
    await rulesApi.scopeActions.toggleSiteScope();
    expect(harness.store.settings.WHOLE_PAGE_AUTO_TRANSLATE_RULES).toEqual([]);
  });

  it('removes an equivalent site rule instead of adding the canonical duplicate', async () => {
    const { rulesApi } = setup('https://example.com/docs/page', ['https://example.com/*']);
    expect(rulesApi.hasSiteRule.value).toBe(true);
    expect(rulesApi.hasBroaderMatchingRule.value).toBe(false);
    expect(rulesApi.showManageRules.value).toBe(false);

    await rulesApi.scopeActions.toggleSiteScope();

    const rules = harness.store.settings.WHOLE_PAGE_AUTO_TRANSLATE_RULES;
    expect(rules).toHaveLength(0);
    expect(rules).not.toContain('example.com/*');
  });

  it('removes every equivalent site rule when toggling the site scope off', async () => {
    const { rulesApi } = setup('https://example.com/docs/page', [
      'https://example.com/*', '  EXAMPLE.com/*  ', 'http://example.com/*',
    ]);
    await rulesApi.scopeActions.toggleSiteScope();
    expect(harness.store.settings.WHOLE_PAGE_AUTO_TRANSLATE_RULES).toEqual([]);
  });

  it('removes a site rule with a different port without adding a portless duplicate', async () => {
    const { rulesApi } = setup('https://example.com:8443/docs', ['https://example.com:9999/*']);
    expect(rulesApi.hasSiteRule.value).toBe(true);
    expect(rulesApi.hasBroaderMatchingRule.value).toBe(false);

    await rulesApi.scopeActions.toggleSiteScope();

    expect(harness.store.settings.WHOLE_PAGE_AUTO_TRANSLATE_RULES).toEqual([]);
  });

  it('removes a Unicode IDN site rule without adding its punycode canonical form', async () => {
    const { rulesApi } = setup('https://bücher.de/path', ['bücher.de/*']);
    expect(rulesApi.siteRule.value).toBe('xn--bcher-kva.de/*');
    expect(rulesApi.hasSiteRule.value).toBe(true);
    expect(rulesApi.hasBroaderMatchingRule.value).toBe(false);

    await rulesApi.scopeActions.toggleSiteScope();

    expect(harness.store.settings.WHOLE_PAGE_AUTO_TRANSLATE_RULES).toEqual([]);
  });

  it('allows page and site scopes to coexist and removes only the selected scope', async () => {
    const { rulesApi } = setup('https://example.com/docs');
    await rulesApi.scopeActions.togglePageScope();
    await rulesApi.scopeActions.toggleSiteScope();
    expect(harness.store.settings.WHOLE_PAGE_AUTO_TRANSLATE_RULES).toEqual([
      'https://example.com/docs', 'example.com/*',
    ]);
    await rulesApi.scopeActions.togglePageScope();
    expect(harness.store.settings.WHOLE_PAGE_AUTO_TRANSLATE_RULES).toEqual(['example.com/*']);
    await rulesApi.scopeActions.toggleSiteScope();
    expect(harness.store.settings.WHOLE_PAGE_AUTO_TRANSLATE_RULES).toEqual([]);
  });

  it('strips query and hash and treats HTTP and HTTPS as the same page', async () => {
    const { currentUrl, rulesApi } = setup('http://example.com/docs?query=1#section');
    expect(rulesApi.normalizedPageUrl.value).toBe('https://example.com/docs');
    await rulesApi.scopeActions.togglePageScope();
    currentUrl.value = 'https://example.com/docs';
    expect(rulesApi.hasPageRule.value).toBe(true);
  });

  it('uses the current hostname for site rules and does not match sibling subdomains', () => {
    const { rulesApi } = setup('https://docs.example.com/page');
    expect(rulesApi.siteRule.value).toBe('docs.example.com/*');
    expect(matchesAutoTranslateRule('https://other.example.com/page', rulesApi.siteRule.value)).toBe(false);
  });

  it('allows only page scope for file URLs', async () => {
    const { rulesApi } = setup('file:///tmp/page.html');
    expect(rulesApi.isFileUrl.value).toBe(true);
    expect(rulesApi.siteRule.value).toBe('');
    expect(rulesApi.siteScopeAvailable.value).toBe(false);
    await rulesApi.scopeActions.toggleSiteScope();
    await rulesApi.scopeActions.togglePageScope();
    expect(harness.store.settings.WHOLE_PAGE_AUTO_TRANSLATE_RULES).toEqual(['file:///tmp/page.html']);
    expect(rulesApi.hasPageRule.value).toBe(true);
  });

  it('classifies a non-wildcard path rule as page scope, not broader', () => {
    const { rulesApi } = setup('https://example.com/docs', ['example.com/docs']);
    expect(rulesApi.hasPageRule.value).toBe(true);
    expect(rulesApi.hasBroaderMatchingRule.value).toBe(false);
    expect(rulesApi.isActive.value).toBe(true);
  });

  it('leaves wildcard-subdomain rules untouched and exposes manage-rules action', async () => {
    const rule = '*.example.com/*';
    const { rulesApi } = setup('https://example.com/docs', [rule]);
    expect(rulesApi.hasBroaderMatchingRule.value).toBe(true);
    expect(rulesApi.showManageRules.value).toBe(true);
    await rulesApi.scopeActions.togglePageScope();
    expect(harness.store.settings.WHOLE_PAGE_AUTO_TRANSLATE_RULES).toEqual([rule, 'https://example.com/docs']);
    await rulesApi.openManageRules();
    expect(harness.openOptionsPage).toHaveBeenCalledWith('/activation?highlight=WHOLE_PAGE_AUTO_TRANSLATE_RULES_DRAWER');
  });

  it('retains backward-compatible computed aliases', () => {
    const { rulesApi } = setup('https://example.com/docs', ['*.example.com/*']);
    expect(rulesApi.hasExactAutoTranslateRule).toBe(rulesApi.hasPageRule);
    expect(rulesApi.hasNonExactMatchingAutoTranslateRule).toBe(rulesApi.hasBroaderMatchingRule);
    expect(rulesApi.isAutoTranslateToggleActive).toBe(rulesApi.isActive);
    expect(rulesApi.isAutoTranslateToggleDisabled.value).toBe(true);
    expect(rulesApi.hasExactAutoTranslateRule.value).toBe(false);
    expect(rulesApi.hasNonExactMatchingAutoTranslateRule.value).toBe(true);
    expect(rulesApi.isAutoTranslateToggleVisible.value).toBe(true);
  });
});
