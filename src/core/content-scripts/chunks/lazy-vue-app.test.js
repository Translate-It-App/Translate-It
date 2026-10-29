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
let frameCallbacks;
let frameId = 0;

const makeCore = () => ({ vueLoaded: false, dispatchEvent: vi.fn() });

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  document.getElementById(HOST_ID)?.remove();
  document.head.querySelectorAll('[data-test-root-promotion]').forEach(style => style.remove());
  document.documentElement.style.cssText = '';
  frameCallbacks = null;
  frameId = 0;
});

afterEach(async () => {
  const { cleanupVueApp } = await import('./lazy-vue-app.js');
  cleanupVueApp();
  if (showPopoverDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'showPopover', showPopoverDescriptor);
  } else {
    delete HTMLElement.prototype.showPopover;
  }
  vi.unstubAllGlobals();
});

function controlAnimationFrames() {
  frameCallbacks = new Map();
  vi.stubGlobal('requestAnimationFrame', callback => {
    const id = ++frameId;
    frameCallbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', id => frameCallbacks.delete(id));
}

async function flushPromotionFrame() {
  await Promise.resolve(); // Run MutationObserver deliveries before the queued frame.
  const callbacks = [...frameCallbacks.values()];
  frameCallbacks.clear();
  callbacks.forEach(callback => callback(0));
  await Promise.resolve();
}

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
      'perspective: none !important', 'will-change: auto !important',
      'content-visibility: visible !important', 'zoom: 1 !important',
      'opacity: 1 !important', 'visibility: visible !important', 'contain: none !important',
      'filter: none !important', 'clip-path: none !important',
    ]) expect(resetCss).toContain(reset);
    expect(resetCss).toContain(':host([popover])::backdrop {\n        display: none !important;');
  });

  it.each([
    ['transform', 'translateX(1px)'],
    ['perspective', '1000px'],
    ['rotate', '1deg'],
    ['scale', '1.1'],
    ['translate', '1px 0'],
    ['will-change', 'transform'],
    ['will-change', 'perspective'],
    ['will-change', 'rotate'],
    ['will-change', 'scale'],
    ['will-change', 'translate'],
    ['will-change', 'opacity, transform'],
  ])('uses a manual top-layer host for root %s: %s', async (property, value) => {
    const showPopover = vi.fn();
    HTMLElement.prototype.showPopover = showPopover;
    document.documentElement.style.setProperty(property, value);
    const { loadVueApp } = await import('./lazy-vue-app.js');

    await loadVueApp(makeCore());
    expect(document.getElementById(HOST_ID).getAttribute('popover')).toBe('manual');
    expect(showPopover).toHaveBeenCalledOnce();
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

  it.each([
    ['transform', 'none'],
    ['perspective', 'none'],
    ['rotate', 'none'],
    ['scale', 'none'],
    ['translate', 'none'],
    ['filter', 'blur(1px)'],
    ['content-visibility', 'hidden'],
    ['content-visibility', 'auto'],
    ['will-change', 'filter'],
    ['will-change', 'opacity'],
    ['will-change', 'opacity, filter'],
  ])('keeps a normal host for root %s: %s', async (property, value) => {
    const showPopover = vi.fn();
    HTMLElement.prototype.showPopover = showPopover;
    document.documentElement.style.setProperty(property, value);
    const { loadVueApp } = await import('./lazy-vue-app.js');

    await loadVueApp(makeCore());
    expect(document.getElementById(HOST_ID).hasAttribute('popover')).toBe(false);
    expect(showPopover).not.toHaveBeenCalled();
  });

  it('falls back when showPopover is absent', async () => {
    delete HTMLElement.prototype.showPopover;
    document.documentElement.style.contain = 'layout';
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const { loadVueApp } = await import('./lazy-vue-app.js');

    await loadVueApp(makeCore());
    expect(document.getElementById(HOST_ID).hasAttribute('popover')).toBe(false);
    expect(observe).not.toHaveBeenCalled();
  });

  it('falls back to the ordinary host when entering the top layer throws', async () => {
    HTMLElement.prototype.showPopover = vi.fn(() => { throw new Error('unsupported'); });
    document.documentElement.style.contain = 'strict';
    const { loadVueApp } = await import('./lazy-vue-app.js');

    await loadVueApp(makeCore());
    expect(document.getElementById(HOST_ID).hasAttribute('popover')).toBe(false);
  });
});

describe('dynamic root viewport promotion', () => {
  it.each(['style', 'class'])(
    'promotes the existing host once after a root %s change without remounting', async (change) => {
      controlAnimationFrames();
      const { createApp } = await import('vue');
      const showPopover = vi.fn();
      HTMLElement.prototype.showPopover = showPopover;
      const root = document.documentElement;
      const previousClass = root.getAttribute('class');
      const previousStyle = root.getAttribute('style');
      const preservedClass = 'preexisting-root-promotion-class';
      root.classList.remove('needs-viewport-host');
      root.classList.add(preservedClass);
      const { loadVueApp, cleanupVueApp } = await import('./lazy-vue-app.js');
      let style;
      if (change === 'class') {
        style = document.createElement('style');
        style.dataset.testRootPromotion = 'true';
        style.textContent = 'html.needs-viewport-host { transform: translateX(1px); }';
        document.head.appendChild(style);
      }
      try {
        await loadVueApp(makeCore());
        const host = document.getElementById(HOST_ID);
        expect(host.hasAttribute('popover')).toBe(false);
        expect(showPopover).not.toHaveBeenCalled();

        if (change === 'style') root.style.transform = 'translateX(1px)';
        else root.classList.add('needs-viewport-host');
        await Promise.resolve();
        expect(frameCallbacks.size).toBe(1);
        await flushPromotionFrame();

        expect(host.getAttribute('popover')).toBe('manual');
        expect(showPopover).toHaveBeenCalledOnce();
        expect(createApp).toHaveBeenCalledOnce();
        expect(createApp.mock.results[0].value.mount).toHaveBeenCalledOnce();

        if (change === 'style') root.style.transform = 'none';
        else root.classList.remove('needs-viewport-host');
        root.dispatchEvent(new Event('resize'));
        await Promise.resolve();
        expect(frameCallbacks.size).toBe(0);
        expect(showPopover).toHaveBeenCalledOnce();
        expect(root.classList.contains(preservedClass)).toBe(true);
        expect(root.classList.contains('needs-viewport-host')).toBe(false);
      } finally {
        cleanupVueApp();
        style?.remove();
        if (previousClass === null) root.removeAttribute('class');
        else root.setAttribute('class', previousClass);
        if (previousStyle === null) root.removeAttribute('style');
        else root.setAttribute('style', previousStyle);
      }
    }
  );

  it.each(['insert', 'text', 'characterData'])(
    'promotes after stylesheet %s mutation', async (edit) => {
      controlAnimationFrames();
      const showPopover = vi.fn();
      HTMLElement.prototype.showPopover = showPopover;
      let style;
      let container;
      if (edit === 'text') {
        style = document.createElement('style');
        style.dataset.testRootPromotion = 'true';
        document.head.appendChild(style);
      } else if (edit === 'characterData') {
        style = document.createElement('style');
        style.dataset.testRootPromotion = 'true';
        style.textContent = 'html { filter: blur(1px); }';
        document.head.appendChild(style);
      }
      const { loadVueApp } = await import('./lazy-vue-app.js');
      try {
        await loadVueApp(makeCore());
        expect(document.getElementById(HOST_ID).hasAttribute('popover')).toBe(false);
        if (edit === 'insert') {
          container = document.createElement('div');
          container.dataset.testRootPromotion = 'true';
          style = document.createElement('style');
          style.textContent = 'html { transform: translateX(1px); }';
          container.appendChild(style);
          document.head.appendChild(container);
        } else if (edit === 'text') {
          style.textContent = 'html { contain: layout; }';
        } else if (edit === 'characterData') {
          style.firstChild.data = 'html { contain: layout; }';
        }
        await Promise.resolve();
        expect(frameCallbacks.size).toBe(1);
        await flushPromotionFrame();
        expect(showPopover, edit).toHaveBeenCalledOnce();
        expect(document.getElementById(HOST_ID).getAttribute('popover')).toBe('manual');
      } finally {
        const { cleanupVueApp } = await import('./lazy-vue-app.js');
        cleanupVueApp();
        container?.remove();
        style?.remove();
      }
    }
  );

  it.each(['media', 'disabled'])(
    'queues one check for a stylesheet %s change without triggering unrelated root CSS', async (change) => {
      controlAnimationFrames();
      const showPopover = vi.fn();
      HTMLElement.prototype.showPopover = showPopover;
      const style = document.createElement('style');
      style.dataset.testRootPromotion = 'true';
      style.media = 'not all';
      style.textContent = 'html.never-matches { contain: layout style; }';
      document.head.appendChild(style);
      const { loadVueApp } = await import('./lazy-vue-app.js');
      await loadVueApp(makeCore());
      expect(document.getElementById(HOST_ID).hasAttribute('popover')).toBe(false);

      if (change === 'media') style.media = 'all';
      else style.setAttribute('disabled', '');
      await Promise.resolve();
      expect(frameCallbacks.size).toBe(1);
      await flushPromotionFrame();
      expect(showPopover).not.toHaveBeenCalled();
      expect(document.getElementById(HOST_ID).hasAttribute('popover')).toBe(false);
      style.remove();
    }
  );

  it('promotes when removing a stylesheet that masks a root containing block', async () => {
    controlAnimationFrames();
    const showPopover = vi.fn();
    HTMLElement.prototype.showPopover = showPopover;
    const base = document.createElement('style');
    const overrideContainer = document.createElement('div');
    const override = document.createElement('style');
    base.dataset.testRootPromotion = 'true';
    overrideContainer.dataset.testRootPromotion = 'true';
    base.textContent = 'html { contain: layout style; }';
    override.textContent = 'html { contain: none !important; }';
    overrideContainer.appendChild(override);
    document.head.append(base, overrideContainer);
    const { loadVueApp, cleanupVueApp } = await import('./lazy-vue-app.js');
    try {
      expect(getComputedStyle(document.documentElement).contain).toBe('none');
      await loadVueApp(makeCore());
      const host = document.getElementById(HOST_ID);
      expect(host.hasAttribute('popover')).toBe(false);
      overrideContainer.remove();
      await Promise.resolve();
      expect(frameCallbacks.size).toBe(1);
      await flushPromotionFrame();
      expect(getComputedStyle(document.documentElement).contain).toBe('layout style');
      expect(host.getAttribute('popover')).toBe('manual');
      expect(showPopover).toHaveBeenCalledOnce();
    } finally {
      cleanupVueApp();
      base.remove();
      overrideContainer.remove();
    }
  });

  it('observes stylesheet rel transitions into and out of the stylesheet relation', async () => {
    controlAnimationFrames();
    const showPopover = vi.fn();
    HTMLElement.prototype.showPopover = showPopover;
    const { loadVueApp } = await import('./lazy-vue-app.js');
    await loadVueApp(makeCore());
    const link = document.createElement('link');
    link.dataset.testRootPromotion = 'true';
    link.setAttribute('rel', 'alternate');
    document.head.appendChild(link);
    try {
      await Promise.resolve();
      expect(frameCallbacks.size).toBe(0);

      link.setAttribute('rel', 'alternate Stylesheet');
      await Promise.resolve();
      expect(frameCallbacks.size).toBe(1);
      await flushPromotionFrame();
      expect(showPopover).not.toHaveBeenCalled();

      link.setAttribute('rel', 'alternate');
      await Promise.resolve();
      expect(frameCallbacks.size).toBe(1);
      await flushPromotionFrame();
      expect(showPopover).not.toHaveBeenCalled();
    } finally {
      link.remove();
    }
  });

  it.each(['href', 'media', 'disabled', 'load'])(
    'schedules one root check for stylesheet link %s changes', async (change) => {
      controlAnimationFrames();
      const showPopover = vi.fn();
      HTMLElement.prototype.showPopover = showPopover;
      const { loadVueApp } = await import('./lazy-vue-app.js');
      await loadVueApp(makeCore());
      const link = document.createElement('link');
      link.dataset.testRootPromotion = 'true';
      link.rel = 'stylesheet';
      document.head.appendChild(link);
      await flushPromotionFrame();
      frameCallbacks.clear();

      if (change === 'href') link.setAttribute('href', 'data:text/css,html%7Bcontain%3Alayout%7D');
      else if (change === 'media') link.setAttribute('media', 'screen');
      else if (change === 'disabled') link.setAttribute('disabled', '');
      else if (change === 'load') link.dispatchEvent(new Event('load'));

      await Promise.resolve();
      expect(frameCallbacks.size).toBe(1);
      await flushPromotionFrame();
      expect(showPopover).not.toHaveBeenCalled();
      expect(document.getElementById(HOST_ID).hasAttribute('popover')).toBe(false);
      link.remove();
    }
  );

  it('ignores unrelated head mutations and non-stylesheet link changes without reading root style', async () => {
    controlAnimationFrames();
    const showPopover = vi.fn();
    HTMLElement.prototype.showPopover = showPopover;
    const { loadVueApp } = await import('./lazy-vue-app.js');
    await loadVueApp(makeCore());
    const getComputedStyleSpy = vi.spyOn(window, 'getComputedStyle');
    getComputedStyleSpy.mockClear();
    const noise = document.createElement('div');
    noise.innerHTML = '<title>ignored</title><script>const x = 1</script><meta name="description" content="ignored"><span>text</span>';
    const link = document.createElement('link');
    link.rel = 'alternate';
    try {
      document.head.append(noise, link);
      link.setAttribute('href', 'data:text/css,html%7Bcontain%3Alayout%7D');
      link.setAttribute('media', 'screen');
      link.setAttribute('disabled', '');
      link.setAttribute('rel', 'icon');
      noise.querySelector('title').textContent = 'changed title';
      noise.querySelector('script').textContent = 'const y = 2';
      noise.remove();
      link.remove();

      await Promise.resolve();
      expect(frameCallbacks.size).toBe(0);
      expect(getComputedStyleSpy).not.toHaveBeenCalled();
      expect(showPopover).not.toHaveBeenCalled();
    } finally {
      getComputedStyleSpy.mockRestore();
      noise.remove();
      link.remove();
    }
  });

  it('retries a throwing promotion only on a later external trigger', async () => {
    controlAnimationFrames();
    const showPopover = vi.fn()
      .mockImplementationOnce(() => { throw new Error('transient failure'); })
      .mockImplementation(() => {});
    HTMLElement.prototype.showPopover = showPopover;
    document.documentElement.style.contain = 'layout';
    const { loadVueApp } = await import('./lazy-vue-app.js');
    await loadVueApp(makeCore());
    const host = document.getElementById(HOST_ID);
    expect(showPopover).toHaveBeenCalledOnce();
    expect(host.hasAttribute('popover')).toBe(false);
    expect(frameCallbacks.size).toBe(0); // Removing our failed popover attribute does not self-trigger.

    const stylesheet = document.createElement('style');
    stylesheet.dataset.testRootPromotion = 'true';
    document.head.appendChild(stylesheet);
    await flushPromotionFrame();
    expect(showPopover).toHaveBeenCalledTimes(2);
    expect(host.getAttribute('popover')).toBe('manual');
    expect(frameCallbacks.size).toBe(0);
  });

  it('cancels a queued frame during normal cleanup', async () => {
    controlAnimationFrames();
    const showPopover = vi.fn();
    HTMLElement.prototype.showPopover = showPopover;
    const { loadVueApp, cleanupVueApp } = await import('./lazy-vue-app.js');
    await loadVueApp(makeCore());
    const host = document.getElementById(HOST_ID);
    document.documentElement.style.transform = 'translateX(1px)';
    await Promise.resolve();
    expect(frameCallbacks.size).toBe(1);

    cleanupVueApp();
    expect(frameCallbacks.size).toBe(0);
    expect(host.isConnected).toBe(false);
    await flushPromotionFrame();
    expect(showPopover).not.toHaveBeenCalled();
  });

  it('clears promotion state and remounts when the promoted host was removed externally', async () => {
    const showPopover = vi.fn();
    HTMLElement.prototype.showPopover = showPopover;
    document.documentElement.style.contain = 'layout';
    const { loadVueApp, cleanupVueApp } = await import('./lazy-vue-app.js');
    await loadVueApp(makeCore());
    const oldHost = document.getElementById(HOST_ID);
    oldHost.remove();
    cleanupVueApp();

    await loadVueApp(makeCore());
    const newHost = document.getElementById(HOST_ID);
    expect(newHost).not.toBe(oldHost);
    expect(newHost.getAttribute('popover')).toBe('manual');
    expect(showPopover).toHaveBeenCalledTimes(2);
  });

  it('removes the host and cancels its watcher when Vue unmount throws', async () => {
    controlAnimationFrames();
    const showPopover = vi.fn();
    HTMLElement.prototype.showPopover = showPopover;
    const { createApp } = await import('vue');
    const { loadVueApp, cleanupVueApp } = await import('./lazy-vue-app.js');
    await loadVueApp(makeCore());
    const host = document.getElementById(HOST_ID);
    createApp.mock.results[0].value.unmount.mockImplementation(() => { throw new Error('unmount failed'); });
    document.documentElement.style.transform = 'translateX(1px)';
    await Promise.resolve();
    expect(frameCallbacks.size).toBe(1);

    expect(() => cleanupVueApp()).not.toThrow();
    expect(frameCallbacks.size).toBe(0);
    expect(host.isConnected).toBe(false);
    await flushPromotionFrame();
    expect(showPopover).not.toHaveBeenCalled();
  });

  it('cancels pending checks and removes an orphaned host after failed mount cleanup', async () => {
    controlAnimationFrames();
    const { createApp } = await import('vue');
    const showPopover = vi.fn();
    HTMLElement.prototype.showPopover = showPopover;
    const failedApp = { use: vi.fn(), mount: vi.fn(() => { throw new Error('mount failed'); }), unmount: vi.fn() };
    createApp.mockImplementationOnce(() => failedApp);
    const { loadVueApp, cleanupVueApp } = await import('./lazy-vue-app.js');
    await expect(loadVueApp(makeCore())).rejects.toThrow('mount failed');
    const host = document.getElementById(HOST_ID);
    expect(host).not.toBeNull();

    document.documentElement.style.transform = 'translateX(1px)';
    await Promise.resolve();
    expect(frameCallbacks.size).toBe(0); // Load failure stopped monitoring.
    cleanupVueApp();
    expect(host.isConnected).toBe(false);
    expect(failedApp.unmount).toHaveBeenCalledOnce();
    expect(showPopover).not.toHaveBeenCalled();
  });

  it('reinstalls monitoring on failed-mount retry and promotes the same host once', async () => {
    controlAnimationFrames();
    const { createApp } = await import('vue');
    const showPopover = vi.fn();
    HTMLElement.prototype.showPopover = showPopover;
    const failedApp = { use: vi.fn(), mount: vi.fn(() => { throw new Error('mount failed'); }), unmount: vi.fn() };
    createApp.mockImplementationOnce(() => failedApp);
    const { loadVueApp } = await import('./lazy-vue-app.js');
    await expect(loadVueApp(makeCore())).rejects.toThrow('mount failed');
    const host = document.getElementById(HOST_ID);

    document.documentElement.style.transform = 'translateX(1px)';
    await loadVueApp(makeCore());
    expect(document.getElementById(HOST_ID)).toBe(host);
    expect(showPopover).toHaveBeenCalledOnce();
    expect(createApp).toHaveBeenCalledTimes(2);
    expect(createApp.mock.results[1].value.mount).toHaveBeenCalledOnce();
    expect(frameCallbacks.size).toBe(0);
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
