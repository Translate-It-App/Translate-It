import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useMobileStore } from './mobile.js';

describe('mobile store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('resets failed page translations', () => {
    const store = useMobileStore();
    store.setPageTranslation({ failedCount: 3 });

    store.resetPageTranslation();

    expect(store.pageTranslationData.failedCount).toBe(0);
  });

  it('clears manual continuity on reset without lowering its generation', () => {
    const store = useMobileStore();
    store.setPageTranslation({ hasManualContinuity: false, manualContinuityGeneration: 5 });

    store.resetPageTranslation();

    expect(store.pageTranslationData.hasManualContinuity).toBe(false);
    expect(store.pageTranslationData.manualContinuityGeneration).toBe(5);
  });

  it('does not expose Mobile Whole Page retry state', () => {
    const store = useMobileStore();

    expect(store.pageTranslationData).not.toHaveProperty('canRetry');

    store.setPageTranslation({ status: 'error' });
    store.resetPageTranslation();

    expect(store.pageTranslationData).not.toHaveProperty('canRetry');
  });
});
