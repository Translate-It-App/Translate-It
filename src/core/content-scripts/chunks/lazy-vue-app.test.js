import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vue', () => ({
  createApp: vi.fn(() => ({ use: vi.fn(), mount: vi.fn(), unmount: vi.fn() }))
}));

vi.mock('pinia', () => ({
  createPinia: vi.fn(() => ({}))
}));

vi.mock('@/apps/content/ContentApp.vue', () => ({ default: {} }));

vi.mock('@/shared/vue/vue-utils.js', () => ({
  setupTrustedTypesCompatibility: vi.fn()
}));

vi.mock('@/utils/UtilsFactory.js', () => ({
  utilsFactory: {
    getI18nUtils: vi.fn().mockResolvedValue({ i18nPlugin: {} })
  }
}));

vi.mock('@/assets/styles/content-app-global.scss?inline', () => ({ default: '' }));

vi.mock('./lazy-styles.js', () => ({ sharedStyles: {} }));

vi.mock('@/core/extensionContext.js', () => ({
  default: { isValidSync: vi.fn().mockReturnValue(true) }
}));

const HOST_ID = 'translate-it-host-main';

const makeCore = () => ({ vueLoaded: false, dispatchEvent: vi.fn() });

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  document.getElementById(HOST_ID)?.remove();
});

describe('loadVueApp idempotence', () => {
  it('loads and mounts once; second call is a no-op', async () => {
    const { createApp } = await import('vue');
    const { loadVueApp } = await import('./lazy-vue-app.js');
    const core = makeCore();

    await loadVueApp(core);
    expect(createApp).toHaveBeenCalledTimes(1);
    expect(core.vueLoaded).toBe(true);
    expect(core.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'vue-loaded' }));

    await loadVueApp(core);
    expect(createApp).toHaveBeenCalledTimes(1);
    expect(core.dispatchEvent).toHaveBeenCalledTimes(1);
  });
});

describe('loadVueApp failure / retry contract', () => {
  it('a thrown failure leaves vueLoaded false and does not poison a later attempt', async () => {
    const { createApp } = await import('vue');
    createApp.mockImplementationOnce(() => { throw new Error('boom'); });
    const { loadVueApp } = await import('./lazy-vue-app.js');
    const core = makeCore();

    await expect(loadVueApp(core)).rejects.toThrow('boom');
    expect(core.vueLoaded).toBe(false);

    await loadVueApp(core);
    expect(createApp).toHaveBeenCalledTimes(2);
    expect(core.vueLoaded).toBe(true);
  });

  it('an invalid context early-returns without mounting; a later valid attempt succeeds', async () => {
    const { default: ExtensionContextManager } = await import('@/core/extensionContext.js');
    const { loadVueApp } = await import('./lazy-vue-app.js');
    const core = makeCore();

    ExtensionContextManager.isValidSync.mockReturnValueOnce(false);
    await loadVueApp(core);
    expect(core.vueLoaded).toBe(false);

    ExtensionContextManager.isValidSync.mockReturnValue(true);
    await loadVueApp(core);
    expect(core.vueLoaded).toBe(true);
  });

  it('reuses one focusin boundary when a mount retry reuses the existing root', async () => {
    const { createApp } = await import('vue');
    const failedApp = { use: vi.fn(), mount: vi.fn(() => { throw new Error('mount failed'); }), unmount: vi.fn() };
    createApp.mockImplementationOnce(() => failedApp);
    const { loadVueApp } = await import('./lazy-vue-app.js');
    const addEventListener = vi.spyOn(EventTarget.prototype, 'addEventListener');

    await expect(loadVueApp(makeCore())).rejects.toThrow('mount failed');
    const root = document.getElementById(HOST_ID).shadowRoot;
    await loadVueApp(makeCore());

    const registrations = addEventListener.mock.calls.filter(([type], index) =>
      type === 'focusin' && addEventListener.mock.instances[index] === root
    );
    expect(registrations).toHaveLength(2);
    expect(registrations[0][1]).toBe(registrations[1][1]);
    const event = new Event('focusin', { bubbles: true, composed: true });
    const stopPropagation = vi.spyOn(event, 'stopPropagation');
    root.getElementById('translate-it-app-container').dispatchEvent(event);
    expect(stopPropagation).toHaveBeenCalledOnce();
    addEventListener.mockRestore();
  });
});

describe('ShadowRoot event boundary', () => {
  it('stops extension focusin at the root while preserving internal and page-origin events', async () => {
    const { loadVueApp } = await import('./lazy-vue-app.js');
    await loadVueApp(makeCore());
    const root = document.getElementById(HOST_ID).shadowRoot;
    const descendant = document.createElement('button');
    root.getElementById('translate-it-app-container').appendChild(descendant);
    const internalFocus = vi.fn();
    const documentFocus = vi.fn();
    descendant.addEventListener('focusin', internalFocus);
    document.addEventListener('focusin', documentFocus);

    const internalEvent = new Event('focusin', { bubbles: true, composed: true });
    const stopPropagation = vi.spyOn(internalEvent, 'stopPropagation');
    descendant.dispatchEvent(internalEvent);
    expect(internalFocus).toHaveBeenCalledOnce();
    expect(documentFocus).not.toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalledOnce();

    const pageEvent = new Event('focusin', { bubbles: true });
    document.body.dispatchEvent(pageEvent);
    expect(documentFocus).toHaveBeenCalledOnce();
    document.removeEventListener('focusin', documentFocus);
  });

  it('does not isolate keyboard events, and removes the boundary on cleanup before remount', async () => {
    const { loadVueApp, cleanupVueApp } = await import('./lazy-vue-app.js');
    await loadVueApp(makeCore());
    const firstRoot = document.getElementById(HOST_ID).shadowRoot;
    const keydown = vi.fn();
    document.addEventListener('keydown', keydown);
    firstRoot.getElementById('translate-it-app-container').dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, composed: true })
    );
    expect(keydown).toHaveBeenCalledOnce();

    cleanupVueApp();
    expect(document.getElementById(HOST_ID)).toBeNull();
    await loadVueApp(makeCore());
    const remountedRoot = document.getElementById(HOST_ID).shadowRoot;
    const documentFocus = vi.fn();
    document.addEventListener('focusin', documentFocus);
    remountedRoot.getElementById('translate-it-app-container').dispatchEvent(
      new Event('focusin', { bubbles: true, composed: true })
    );
    expect(documentFocus).not.toHaveBeenCalled();
    document.removeEventListener('focusin', documentFocus);
    document.removeEventListener('keydown', keydown);
  });
});
