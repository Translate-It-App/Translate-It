import { describe, expect, it } from 'vitest';
import enMessages from '../../../_locales/en/messages.json';
import faMessages from '../../../_locales/fa/messages.json';
import jaMessages from '../../../_locales/ja/messages.json';
import { getProviderById } from '@/core/provider-registry.js';
import { ProviderCategories, findProviderById } from './ProviderManifest.js';
import { ProviderRegistryIds } from './ProviderConstants.js';

describe('provider manifest categories', () => {
  it('declares Page parallel execution for Google V2 and Edge among traditional providers', () => {
    expect(findProviderById(ProviderRegistryIds.GOOGLE_V2).supportsPageParallelExecution).toBe(true);
    expect(findProviderById(ProviderRegistryIds.GOOGLE).supportsPageParallelExecution).not.toBe(true);
    expect(findProviderById(ProviderRegistryIds.EDGE).supportsPageParallelExecution).toBe(true);
  });

  it('keeps the local category for local providers and categorizes WebAI as AI', () => {
    expect(ProviderCategories.LOCAL).toBe('local');
    expect(findProviderById(ProviderRegistryIds.WEBAI).category).toBe(ProviderCategories.AI);
    expect(findProviderById(ProviderRegistryIds.BROWSER).category).toBe(ProviderCategories.LOCAL);
    expect(findProviderById(ProviderRegistryIds.MOCK).category).toBe(ProviderCategories.LOCAL);
  });

  it('derives WebAI AI and Browser/Mock local categories in the provider registry', () => {
    expect(getProviderById(ProviderRegistryIds.WEBAI).category).toBe(ProviderCategories.AI);
    expect(getProviderById(ProviderRegistryIds.BROWSER).category).toBe(ProviderCategories.LOCAL);
    expect(getProviderById(ProviderRegistryIds.MOCK).category).toBe(ProviderCategories.LOCAL);
  });

  it('categorizes Vajehyab as local in the manifest and provider registry', () => {
    expect(findProviderById(ProviderRegistryIds.VAJEHYAB).category).toBe(ProviderCategories.LOCAL);
    expect(getProviderById(ProviderRegistryIds.VAJEHYAB).category).toBe(ProviderCategories.LOCAL);
    expect(findProviderById(ProviderRegistryIds.VAJEHYAB).category).not.toBe(ProviderCategories.FREE);
  });

  it('localizes the existing local category key as Other in supported locales', () => {
    expect(enMessages.provider_category_local.message).toBe('Other');
    expect(faMessages.provider_category_local.message).toBe('سایر');
    expect(jaMessages.provider_category_local.message).toBe('その他');
  });
});
