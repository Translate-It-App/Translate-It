import { describe, it, expect, vi, afterEach } from 'vitest';

const initializeSettings = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@/shared/managers/SettingsManager.js', () => ({
  default: { initialize: initializeSettings, warmup: vi.fn() }
}));

vi.mock('@/core/managers/content/FeatureManager.js', () => ({
  FeatureManager: { getInstance: vi.fn(() => ({
    requestFeatureActivation: vi.fn().mockResolvedValue(null),
    getFeatureHandler: vi.fn(),
    isFeatureActive: vi.fn().mockReturnValue(false)
  })) }
}));

import { loadCoreFeatures, loadFeatureOnDemand, getFeatureManager } from './lazy-features.js';
import { FeatureManager } from '@/core/managers/content/FeatureManager.js';
import SettingsManager from '@/shared/managers/SettingsManager.js';

describe('loadFeatureOnDemand vue special-case', () => {
  afterEach(() => {
    delete window.translateItContentCore;
    delete window.featureManager;
    vi.clearAllMocks();
  });

  it('top-frame core: delegates to loadVueApp, returns vueLoaded, never reaches FeatureManager activation', async () => {
    const loadVueApp = vi.fn().mockResolvedValue(undefined);
    window.translateItContentCore = { loadVueApp, vueLoaded: true };

    const result = await loadFeatureOnDemand('vue');

    expect(loadVueApp).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
    expect(getFeatureManager()).toBeNull();
    expect(FeatureManager.getInstance).not.toHaveBeenCalled();
  });

  it('iframe-like core without loadVueApp: returns null, does not throw, never reaches FeatureManager activation', async () => {
    window.translateItContentCore = {};

    const result = await loadFeatureOnDemand('vue');

    expect(result).toBeNull();
    expect(getFeatureManager()).toBeNull();
    expect(FeatureManager.getInstance).not.toHaveBeenCalled();
  });

  it('does not warm settings after successful initialization', async () => {
    await loadCoreFeatures();

    expect(initializeSettings).toHaveBeenCalledOnce();
    expect(SettingsManager.warmup).not.toHaveBeenCalled();
  });
});
