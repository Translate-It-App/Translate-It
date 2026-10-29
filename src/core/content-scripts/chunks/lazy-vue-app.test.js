import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
const showPopoverDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'showPopover');

const makeCore = () => ({ vueLoaded: false, dispatchEvent: vi.fn() });

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  document.getElementById(HOST_ID)?.remove();
  document.documentElement.style.contain = '';
});

afterEach(() => {
  if (showPopoverDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'showPopover', showPopoverDescriptor);
  } else {
    delete HTMLElement.prototype.showPopover;
  }
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

  it.each(['layout', 'layout style', 'paint', 'content', 'strict'])(
    'uses a manual top-layer host for root contain: %s', async (contain) => {
    const showPopover = vi.fn();
    HTMLElement.prototype.showPopover = showPopover;
    document.documentElement.style.contain = contain;
    const { loadVueApp } = await import('./lazy-vue-app.js');

    await loadVueApp(makeCore());
    const host = document.getElementById(HOST_ID);
    expect(host.getAttribute('popover')).toBe('manual');
    expect(showPopover).toHaveBeenCalledOnce();
    expect(host.style.pointerEvents).toBe('none');
    const resetCss = host.shadowRoot.querySelector('style').textContent;
    expect(resetCss).toContain(':host([popover]) {');
    for (const reset of [
      'transform: none !important', 'translate: none !important', 'scale: none !important', 'rotate: none !important',
      'opacity: 1 !important', 'visibility: visible !important', 'contain: none !important',
      'filter: none !important', 'clip-path: none !important',
    ]) expect(resetCss).toContain(reset);
    expect(resetCss).toContain(':host([popover])::backdrop {\n        display: none !important;');
  });

  it.each(['none', 'style', 'size'])(
    'keeps the ordinary host out of the top layer for root contain: %s', async (contain) => {
      const showPopover = vi.fn();
      HTMLElement.prototype.showPopover = showPopover;
      document.documentElement.style.contain = contain;
      const { loadVueApp } = await import('./lazy-vue-app.js');

      await loadVueApp(makeCore());
      expect(document.getElementById(HOST_ID).hasAttribute('popover')).toBe(false);
      expect(showPopover).not.toHaveBeenCalled();
    }
  );

  it('falls back when showPopover is absent', async () => {
    delete HTMLElement.prototype.showPopover;
    document.documentElement.style.contain = 'layout';
    const { loadVueApp } = await import('./lazy-vue-app.js');

    await loadVueApp(makeCore());
    expect(document.getElementById(HOST_ID).hasAttribute('popover')).toBe(false);
  });

  it('falls back to the ordinary host when entering the top layer throws', async () => {
    HTMLElement.prototype.showPopover = vi.fn(() => { throw new Error('unsupported'); });
    document.documentElement.style.contain = 'strict';
    const { loadVueApp } = await import('./lazy-vue-app.js');

    await loadVueApp(makeCore());
    expect(document.getElementById(HOST_ID).hasAttribute('popover')).toBe(false);
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

  it('reuses a contained top-layer host across mount retry and cleanup/remount', async () => {
    const { createApp } = await import('vue');
    const showPopover = vi.fn();
    HTMLElement.prototype.showPopover = showPopover;
    document.documentElement.style.contain = 'layout';
    const failedApp = { use: vi.fn(), mount: vi.fn(() => { throw new Error('mount failed'); }), unmount: vi.fn() };
    createApp.mockImplementationOnce(() => failedApp);
    const { loadVueApp, cleanupVueApp } = await import('./lazy-vue-app.js');

    await expect(loadVueApp(makeCore())).rejects.toThrow('mount failed');
    const firstHost = document.getElementById(HOST_ID);
    expect(firstHost.getAttribute('popover')).toBe('manual');
    await loadVueApp(makeCore());
    expect(document.getElementById(HOST_ID)).toBe(firstHost);
    expect(showPopover).toHaveBeenCalledOnce();

    cleanupVueApp();
    expect(document.getElementById(HOST_ID)).toBeNull();
    await loadVueApp(makeCore());
    expect(document.getElementById(HOST_ID)).not.toBe(firstHost);
    expect(showPopover).toHaveBeenCalledTimes(2);
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
