import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import browser from 'webextension-polyfill';

vi.mock('@/shared/storage/core/StorageCore.js', () => ({
  storageManager: { on: vi.fn(), off: vi.fn() },
}));

vi.mock('@/config.js', () => ({
  getTranslationApiAsync: vi.fn(async () => 'google'),
  getTargetLanguageAsync: vi.fn(async () => 'fa'),
  TranslationMode: { Page: 'Page' },
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  })),
}));

vi.mock('@/core/PageEventBus.js', () => ({
  pageEventBus: { emit: vi.fn() },
}));

vi.mock('@/shared/messaging/core/UnifiedMessaging.js', () => ({
  sendRegularMessage: vi.fn(() => Promise.resolve({ success: true })),
}));

vi.mock('@/shared/messaging/core/ContentScriptIntegration.js', () => ({
  registerTranslation: vi.fn(),
  contentScriptIntegration: {},
}));

vi.mock('@/shared/error-management/ErrorHandler.js', () => ({
  ErrorHandler: { getInstance: vi.fn(() => ({ handle: vi.fn() })) },
}));

vi.mock('@/core/extensionContext.js', () => ({
  default: { isValidSync: vi.fn(() => true) },
}));

vi.mock('@/features/shared/hover-preview/HoverPreviewLookup.js', () => ({
  hoverPreviewLookup: {
    add: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock('@/utils/dom/DomDirectionManager.js', () => ({
  applyNodeDirection: vi.fn(),
  isRTL: vi.fn((language) => language === 'fa'),
  restoreElementDirection: vi.fn(),
  BIDI_MARKS: { RLM: '\u200f', LRM: '\u200e' },
}));

import { PageTranslationBridge } from './PageTranslationBridge.js';
import { PageTranslationEventManager } from './utils/PageTranslationEventManager.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { applyNodeDirection } from '@/utils/dom/DomDirectionManager.js';
import { hoverPreviewLookup } from '@/features/shared/hover-preview/HoverPreviewLookup.js';

const settlement = (text, onSettle = vi.fn()) => {
  let state = 'pending';
  return {
    __pageTranslationSettlement: true,
    text,
    get state() {
      return state;
    },
    settle(outcome) {
      if (state !== 'pending') return false;
      state = outcome;
      onSettle(outcome);
      return true;
    },
  };
};

const terminalSettlement = (text, state, settle = vi.fn()) => ({
  __pageTranslationSettlement: true,
  text,
  state,
  settle,
});

const settings = {
  targetLanguage: 'fa',
  lazyLoading: false,
  showOriginalOnHover: false,
  autoTranslateOnDOMChanges: false,
  attributesToTranslate: ['title'],
};

describe('PageTranslationBridge stale settlement integration', () => {
  let bridge;
  let originalUrl;

  beforeEach(() => {
    originalUrl = window.location.href;
    document.body.innerHTML = '';
    document.body.removeAttribute('data-page-translated');
    document.body.removeAttribute('data-has-original');
    bridge = new PageTranslationBridge();
  });

  afterEach(() => {
    bridge.cleanup();
    window.history.replaceState(null, '', originalUrl);
  });

  const startDeferredTranslation = async (options = {}) => {
    const pending = [];
    const onTranslate = vi.fn((text, context, score, node) => new Promise(resolve => {
      pending.push({ text, node, resolve });
    }));

    await bridge.initialize({ ...settings, ...options }, onTranslate);
    bridge.translate(document.body);
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    return { pending, onTranslate };
  };

  it('applies fresh text and leaves settlement accepted', async () => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation();
    const accepted = vi.fn();
    pending[0].resolve(settlement('Translated', accepted));

    await vi.waitFor(() => expect(node.nodeValue).toContain('Translated'));
    expect(accepted).toHaveBeenCalledWith('accepted');
    expect(applyNodeDirection).toHaveBeenCalled();
  });

  it('settles same-node duplicate updates once and applies only the newest generation', async () => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending, onTranslate } = await startDeferredTranslation();
    bridge.session.nodesTranslator.update(node);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(onTranslate.mock.calls.every(call => call[3] === node)).toBe(true);
    const obsoleteSettled = vi.fn();
    const freshSettled = vi.fn();
    const obsolete = settlement('Obsolete duplicate', obsoleteSettled);
    const fresh = settlement('Newest translation', freshSettled);
    const writes = [];
    const observer = new MutationObserver(records => writes.push(...records));
    observer.observe(node, { characterData: true });
    try {
      pending[1].resolve(fresh);
      await vi.waitFor(() => expect(fresh.state).toBe('accepted'));
      pending[0].resolve(obsolete);
      await vi.waitFor(() => expect(obsolete.state).toBe('stale'));

      expect(node.nodeValue).toContain('Newest translation');
      expect(node.nodeValue).not.toContain('Obsolete duplicate');
      expect(obsoleteSettled).toHaveBeenCalledExactlyOnceWith('stale');
      expect(freshSettled).toHaveBeenCalledExactlyOnceWith('accepted');
      expect(writes).toHaveLength(1);
      expect(onTranslate).toHaveBeenCalledTimes(2);
    } finally {
      observer.disconnect();
    }
  });

  it('does not invalidate pending output when the same node is translated twice', async () => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending, onTranslate } = await startDeferredTranslation();
    bridge.translate(document.body);
    expect(onTranslate).toHaveBeenCalledOnce();
    const accepted = vi.fn();
    const result = settlement('Translated once', accepted);
    pending[0].resolve(result);

    await vi.waitFor(() => expect(result.state).toBe('accepted'));
    expect(node.nodeValue).toContain('Translated once');
    expect(accepted).toHaveBeenCalledExactlyOnceWith('accepted');
    expect(pending).toHaveLength(1);
  });

  it.each([
    ['edited text', (node) => { node.nodeValue = 'Edited'; }],
    ['detached text', (node) => { node.remove(); }],
    ['replaced text', (node) => { node.replaceWith(document.createTextNode('Replacement')); }],
  ])('rejects stale %s without applying provider output', async (_name, mutate) => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation();
    const stale = vi.fn();
    mutate(node);
    pending[0].resolve(settlement('Translated', stale));

    await Promise.resolve();
    await Promise.resolve();
    expect(document.body.textContent).not.toContain('Translated');
    expect(stale).toHaveBeenCalledWith('stale');
  });

  it('rejects changed and recreated attributes by identity', async () => {
    const element = document.createElement('div');
    element.setAttribute('title', 'Original');
    document.body.appendChild(element);
    const { pending } = await startDeferredTranslation();
    const stale = vi.fn();

    element.removeAttribute('title');
    element.setAttribute('title', 'Replacement');
    pending[0].resolve(settlement('Translated', stale));

    await Promise.resolve();
    await Promise.resolve();
    expect(element.getAttribute('title')).toBe('Replacement');
    expect(stale).toHaveBeenCalledWith('stale');
  });

  it('cleans storage for stale initial work and allows later translation', async () => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation();
    const stale = vi.fn();

    node.nodeValue = 'Edited';
    pending[0].resolve(settlement('Translated', stale));
    await vi.waitFor(() => expect(bridge.session.nodesTranslator.has(node)).toBe(false));
    expect(stale).toHaveBeenCalledWith('stale');

    bridge.session.domTranslator.translate(node);
    await vi.waitFor(() => expect(pending.length).toBe(2));
    const accepted = vi.fn();
    pending[1].resolve(settlement('Fresh', accepted));

    await vi.waitFor(() => expect(node.nodeValue).toContain('Fresh'));
    expect(accepted).toHaveBeenCalledWith('accepted');
  });

  it('preserves newer storage when superseded task becomes stale', async () => {
    const node = document.createTextNode('one');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation({ autoTranslateOnDOMChanges: true });

    node.nodeValue = 'two';
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(1));
    const stale = vi.fn();
    pending[0].resolve(settlement('old', stale));
    await Promise.resolve();
    await Promise.resolve();

    expect(stale).toHaveBeenCalledWith('stale');
    expect(bridge.session.nodesTranslator.has(node)).toBe(true);

    const accepted = vi.fn();
    pending[1].resolve(settlement('new', accepted));
    await vi.waitFor(() => expect(node.nodeValue).toContain('new'));
    expect(accepted).toHaveBeenCalledWith('accepted');
  });

  it('closes settlement when storage is removed before writer continuation', async () => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation();
    const stale = vi.fn();

    bridge.session.nodesTranslator.restore(node);
    pending[0].resolve(settlement('Translated', stale));
    await Promise.resolve();
    await Promise.resolve();

    expect(stale).toHaveBeenCalledWith('stale');
    expect(bridge.session.nodesTranslator.has(node)).toBe(false);
  });

  it('preserves active provider-failure storage compatibility', async () => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation();
    const failed = vi.fn();

    pending[0].resolve(terminalSettlement('Original', 'failed', failed));
    await vi.waitFor(() => expect(bridge.session.nodesTranslator.has(node)).toBe(true));

    expect(node.nodeValue).toBe('Original');
    expect(failed).not.toHaveBeenCalled();
  });

  it('preserves user edit after stale update and restore', async () => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation();

    pending[0].resolve(settlement('Translated'));
    await vi.waitFor(() => expect(node.nodeValue).toContain('Translated'));

    node.nodeValue = 'Edited';
    bridge.session.nodesTranslator.update(node);
    await vi.waitFor(() => expect(pending.length).toBe(2));
    node.nodeValue = 'Edited again';
    const stale = vi.fn();
    pending[1].resolve(settlement('Stale update', stale));
    await vi.waitFor(() => expect(stale).toHaveBeenCalledWith('stale'));

    bridge.restore(document.body);
    expect(node.nodeValue).toBe('Edited again');
  });

  it.each(['a-first', 'b-first'])('preserves Task B restore baseline when %s settles', async (order) => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation({ autoTranslateOnDOMChanges: true });

    pending[0].resolve(settlement('Initial'));
    await vi.waitFor(() => expect(node.nodeValue).toContain('Initial'));
    node.nodeValue = 'A';
    await vi.waitFor(() => expect(pending.length).toBe(2));
    node.nodeValue = 'B';
    await vi.waitFor(() => expect(pending.length).toBe(3));

    const stale = vi.fn();
    const accepted = vi.fn();
    if (order === 'a-first') {
      pending[1].resolve(settlement('A translation', stale));
      await vi.waitFor(() => expect(stale).toHaveBeenCalledWith('stale'));
      pending[2].resolve(settlement('B translation', accepted));
    } else {
      pending[2].resolve(settlement('B translation', accepted));
      await vi.waitFor(() => expect(accepted).toHaveBeenCalledWith('accepted'));
      pending[1].resolve(settlement('A translation', stale));
    }

    await vi.waitFor(() => expect(accepted).toHaveBeenCalledWith('accepted'));
    await vi.waitFor(() => expect(node.nodeValue).toContain('B translation'));
    bridge.restore(document.body);
    expect(node.nodeValue).toBe('B');
    expect(stale).toHaveBeenCalledWith('stale');
  });

  it('preserves changed attribute after stale update and restore', async () => {
    const element = document.createElement('div');
    element.setAttribute('title', 'Original');
    document.body.appendChild(element);
    const { pending } = await startDeferredTranslation();

    pending[0].resolve(settlement('Translated title'));
    await vi.waitFor(() => expect(element.getAttribute('title')).toContain('Translated title'));

    element.setAttribute('title', 'Edited');
    const attribute = element.getAttributeNode('title');
    bridge.session.nodesTranslator.update(attribute);
    await vi.waitFor(() => expect(pending.length).toBe(2));
    element.setAttribute('title', 'Edited again');
    const stale = vi.fn();
    pending[1].resolve(settlement('Stale title', stale));
    await vi.waitFor(() => expect(stale).toHaveBeenCalledWith('stale'));

    bridge.restore(document.body);
    expect(element.getAttribute('title')).toBe('Edited again');
  });

  it('skips stale post-processing and hover registration', async () => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation({ showOriginalOnHover: true });
    const stale = vi.fn();
    applyNodeDirection.mockClear();
    hoverPreviewLookup.add.mockClear();

    node.nodeValue = '\u200fEdited';
    pending[0].resolve(settlement('Translated', stale));
    await Promise.resolve();
    await Promise.resolve();

    expect(node.nodeValue).toBe('\u200fEdited');
    expect(applyNodeDirection).not.toHaveBeenCalled();
    expect(hoverPreviewLookup.add).not.toHaveBeenCalled();
    expect(node.parentElement?.getAttribute('data-page-translated')).toBeNull();
    expect(stale).toHaveBeenCalledWith('stale');
  });

  it('rejects settlement after bridge cleanup as cancelled', async () => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation();
    const cancelled = vi.fn();

    bridge.cleanup();
    pending[0].resolve(settlement('Translated', cancelled));
    await Promise.resolve();
    await Promise.resolve();

    expect(node.nodeValue).toBe('Original');
    expect(cancelled).toHaveBeenCalledWith('cancelled');
  });

  it.each(['pushState', 'replaceState'])('rejects pending output after SPA %s navigation', async (method) => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation();
    const stale = vi.fn();

    window.history[method](null, '', '/next-page');
    pending[0].resolve(settlement('Old page translation', stale));

    await vi.waitFor(() => expect(stale).toHaveBeenCalledWith('stale'));
    expect(node.nodeValue).toBe('Original');
    expect(bridge.session.nodesTranslator.has(node)).toBe(false);

    const { pending: nextPage } = await startDeferredTranslation();
    const accepted = vi.fn();
    nextPage[0].resolve(settlement('New page translation', accepted));
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledWith('accepted'));
    expect(node.nodeValue).toContain('New page translation');
  });

  it('rejects old output after a trusted same-URL SPA history round trip', async () => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation();
    browser.runtime.id = 'test-extension';
    const manager = {
      logger: bridge.logger,
      addEventListener: vi.fn((target, event, handler) => {
        if (typeof target.on === 'function') target.on(event, handler);
        else target.addListener(handler);
      }),
      removeEventListener: vi.fn((target, _event, handler) => target.removeListener(handler)),
      stopAutoTranslation: vi.fn(async () => bridge.stopPersistence()),
      resetError: vi.fn(),
    };
    manager.featureManager = { checkForUrlChange: () => manager.stopAutoTranslation() };
    const events = new PageTranslationEventManager(manager);
    try {
      window.history.pushState(null, '', '/other-page');
      window.history.replaceState(null, '', originalUrl);
      events.navigationListener({ action: MessageActions.SPA_NAVIGATION }, { id: browser.runtime.id });
      const cancelled = vi.fn();
      pending[0].resolve(settlement('Old page translation', cancelled));

      await vi.waitFor(() => expect(cancelled).toHaveBeenCalledWith('cancelled'));
      expect(node.nodeValue).toBe('Original');
      expect(manager.stopAutoTranslation).toHaveBeenCalledOnce();
    } finally {
      events.destroy();
    }
  });

  it('cancels stopped output while preserving completed nodes for restore', async () => {
    const completedNode = document.createTextNode('Completed source');
    const pendingElement = document.createElement('p');
    const pendingNode = document.createTextNode('Pending source');
    pendingElement.appendChild(pendingNode);
    document.body.append(completedNode, pendingElement);
    const { pending } = await startDeferredTranslation();
    await vi.waitFor(() => expect(pending.length).toBe(2));
    pending.find(item => item.node === completedNode).resolve(settlement('Completed translation'));
    await vi.waitFor(() => expect(completedNode.nodeValue).toContain('Completed translation'));

    bridge.stopPersistence();
    const cancelled = vi.fn();
    pending.find(item => item.node === pendingNode).resolve(settlement('Stopped translation', cancelled));
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledWith('cancelled'));
    expect(pendingNode.nodeValue).toBe('Pending source');
    expect(completedNode.nodeValue).toContain('Completed translation');
    bridge.translate(document.body);
    expect(pending).toHaveLength(2);
    expect(bridge.session.active).toBe(false);

    bridge.restore(document.body);
    expect(completedNode.nodeValue).toBe('Completed source');
    const { pending: nextSession } = await startDeferredTranslation();
    nextSession.forEach(item => item.resolve(settlement('Retranslated')));
    await vi.waitFor(() => expect(pendingNode.nodeValue).toContain('Retranslated'));
  });

  it('retains unchanged accepted nodes across SPA routes without resending them or sharing old writers', async () => {
    document.body.innerHTML = '<p id="accepted">Accepted source</p><p id="pending">Pending source</p>';
    const acceptedNode = document.getElementById('accepted').firstChild;
    const pendingNode = document.getElementById('pending').firstChild;
    const { pending } = await startDeferredTranslation({ autoTranslateOnDOMChanges: true });
    pending.find(item => item.node === acceptedNode).resolve(settlement('Accepted translation'));
    await vi.waitFor(() => expect(acceptedNode.nodeValue).toContain('Accepted translation'));
    const oldStorage = bridge.session.nodesTranslator.nodeStorage;
    const oldRecord = oldStorage.get(acceptedNode);
    bridge.stopPersistence();
    window.history.replaceState({}, '', '/retained-pending-route');
    const requests = [];
    const retained = vi.fn();
    await bridge.initialize({ ...settings, autoTranslateOnDOMChanges: true }, (text, context, score, node) => new Promise(resolve => {
      requests.push({ text, node, resolve });
    }), Symbol('new-session'), {
      preserveAcceptedTranslations: true, onRetainedTranslation: retained,
    });
    bridge.translate(document.body);

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].node).toBe(pendingNode);
    expect(retained).toHaveBeenCalledOnce();
    expect(bridge.session.nodesTranslator.nodeStorage).not.toBe(oldStorage);
    expect(bridge.session.nodesTranslator.nodeStorage.get(acceptedNode)).not.toBe(oldRecord);
    bridge.session.domTranslator.translate(document.body);
    expect(retained).toHaveBeenCalledOnce();
    const cancelled = vi.fn();
    pending.find(item => item.node === pendingNode).resolve(settlement('Old pending output', cancelled));
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledWith('cancelled'));
    expect(bridge.session.nodesTranslator.has(pendingNode)).toBe(true);
    requests[0].resolve(settlement('Fresh pending translation'));
    await vi.waitFor(() => expect(pendingNode.nodeValue).toContain('Fresh pending translation'));

    acceptedNode.nodeValue = 'Edited after retention';
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    requests[1].resolve(settlement('Fresh edit translation'));
    await vi.waitFor(() => expect(acceptedNode.nodeValue).toContain('Fresh edit translation'));
    bridge.restore(document.body);
    expect(acceptedNode.nodeValue).toBe('Edited after retention');
    expect(pendingNode.nodeValue).toBe('Pending source');
  });

  it.each(['disconnected', 'outside-root'])(
    'does not retain a previously accepted %s node on the new SPA route', async (scenario) => {
      document.body.innerHTML = '<p id="old">Original shared source</p><main id="new"></main>';
      const oldOwner = document.getElementById('old');
      const oldNode = oldOwner.firstChild;
      const { pending } = await startDeferredTranslation();
      pending[0].resolve(settlement('Accepted shared translation'));
      await vi.waitFor(() => expect(oldNode.nodeValue).toContain('Accepted shared translation'));
      bridge.stopPersistence();
      window.history.replaceState({}, '', '/new-owned-root');
      if (scenario === 'disconnected') oldOwner.remove();
      const root = scenario === 'outside-root' ? document.getElementById('new') : document.body;
      const fresh = document.createElement('p');
      fresh.textContent = 'New route source';
      root.appendChild(fresh);
      const retained = vi.fn();
      const translate = vi.fn(async () => settlement('New route translation'));
      await bridge.initialize(settings, translate, Symbol('new'), {
        preserveAcceptedTranslations: true, onRetainedTranslation: retained,
      });
      bridge.translate(root);

      await vi.waitFor(() => expect(fresh.textContent).toContain('New route translation'));
      expect(translate).toHaveBeenCalledOnce();
      expect(retained).not.toHaveBeenCalled();
      expect(bridge.session.nodesTranslator.has(oldNode)).toBe(false);
      bridge.restore(root);
      expect(fresh.textContent).toBe('New route source');
    }
  );

  it('preserves original text and refreshes hover and font ownership across SPA routes', async () => {
    document.body.innerHTML = '<p style="font-family: serif">Original source</p>';
    const owner = document.body.firstChild;
    const node = owner.firstChild;
    const options = { showOriginalOnHover: true, translationFontFamily: 'sans-serif' };
    const { pending } = await startDeferredTranslation(options);
    pending[0].resolve(settlement('Translated source'));
    await vi.waitFor(() => expect(owner.style.fontFamily).toBe('sans-serif'));
    bridge.stopPersistence();
    window.history.replaceState({}, '', '/retained-font-route');
    hoverPreviewLookup.add.mockClear();
    const translate = vi.fn();
    await bridge.initialize({ ...settings, ...options }, translate, Symbol('next'), {
      preserveAcceptedTranslations: true,
    });
    bridge.translate(document.body);

    expect(translate).not.toHaveBeenCalled();
    expect(hoverPreviewLookup.add).toHaveBeenCalledExactlyOnceWith(node, 'Original source', node.nodeValue);
    expect(owner.style.fontFamily).toBe('sans-serif');
    bridge.restore(document.body);
    expect(node.nodeValue).toBe('Original source');
    expect(owner.style.fontFamily).toBe('serif');
  });

  it.each(['text', 'title', 'shadow'])('retains and restores accepted %s nodes across SPA routes after stopping', async (kind) => {
    const owner = document.createElement('div');
    document.body.appendChild(owner);
    let node;
    if (kind === 'title') {
      owner.setAttribute('title', 'Original source');
      node = owner.getAttributeNode('title');
    } else if (kind === 'shadow') {
      const shadow = owner.attachShadow({ mode: 'open' });
      const content = document.createElement('p');
      content.textContent = 'Original source';
      shadow.appendChild(content);
      node = content.firstChild;
    } else {
      owner.textContent = 'Original source';
      node = owner.firstChild;
    }
    const { pending } = await startDeferredTranslation();
    pending.find(item => item.node === node).resolve(settlement('Accepted translation'));
    await vi.waitFor(() => expect(node.nodeValue).toContain('Accepted translation'));
    const oldStorage = bridge.session.nodesTranslator.nodeStorage;
    const oldRecord = oldStorage.get(node);
    bridge.stopPersistence();
    window.history.replaceState({}, '', '/retained-node-route');
    const translate = vi.fn();
    const retained = vi.fn();
    await bridge.initialize(settings, translate, Symbol('next'), {
      preserveAcceptedTranslations: true, onRetainedTranslation: retained,
    });
    bridge.translate(document.body);

    expect(translate).not.toHaveBeenCalled();
    expect(retained).toHaveBeenCalledOnce();
    expect(bridge.session.nodesTranslator.nodeStorage).not.toBe(oldStorage);
    expect(bridge.session.nodesTranslator.nodeStorage.get(node)).not.toBe(oldRecord);
    bridge.restore(document.body);
    expect(node.nodeValue).toBe('Original source');
  });

  it('keeps DOM auto-translation disabled after retaining accepted nodes', async () => {
    document.body.innerHTML = '<p>Original source</p>';
    const { pending } = await startDeferredTranslation();
    pending[0].resolve(settlement('Accepted translation'));
    await vi.waitFor(() => expect(document.body.textContent).toContain('Accepted translation'));
    bridge.stopPersistence();
    const translate = vi.fn();
    await bridge.initialize(settings, translate, Symbol('next'), { preserveAcceptedTranslations: true });
    bridge.translate(document.body);
    const later = document.createElement('p');
    later.textContent = 'Later source';
    document.body.appendChild(later);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(translate).not.toHaveBeenCalled();
    expect(later.textContent).toBe('Later source');
    expect(bridge.session.persistentTranslator.observedNodesStorage.size).toBe(0);
  });

  it.each([
    ['immediate-restore', 'text'], ['two-resumes', 'text'],
    ['immediate-restore', 'title'], ['two-resumes', 'title'],
    ['immediate-restore', 'shadow'], ['two-resumes', 'shadow'],
  ])(
    'preserves lazy accepted nodes across SPA routes through %s for %s before intersection', async (scenario, kind) => {
      const previousIntersectionObserver = globalThis.IntersectionObserver;
      const observers = [];
      globalThis.IntersectionObserver = class {
        constructor(callback) {
          this.callback = callback;
          this.observe = vi.fn();
          this.unobserve = vi.fn();
          this.disconnect = vi.fn();
          observers.push(this);
        }
      };
      try {
        document.body.innerHTML = '';
        const owner = document.createElement('p');
        let node;
        if (kind === 'title') {
          owner.setAttribute('title', 'Original source');
          node = owner.getAttributeNode('title');
        } else {
          owner.textContent = 'Original source';
          node = owner.firstChild;
        }
        if (kind === 'shadow') {
          const host = document.createElement('div');
          document.body.appendChild(host);
          host.attachShadow({ mode: 'open' }).appendChild(owner);
        } else document.body.appendChild(owner);
        const pending = [];
        const translate = vi.fn(() => new Promise(resolve => pending.push(resolve)));
        const lazySettings = { ...settings, lazyLoading: true };
        await bridge.initialize(lazySettings, translate);
        bridge.translate(document.body);
        observers[0].callback([{ target: owner, isIntersecting: true }], observers[0]);
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        pending[0](settlement('Accepted translation'));
        await vi.waitFor(() => expect(node.nodeValue).toContain('Accepted translation'));

        const retained = vi.fn();
        const resume = async () => {
          bridge.stopPersistence();
          window.history.replaceState({}, '', `/retained-lazy-route-${observers.length}`);
          await bridge.initialize(lazySettings, translate, Symbol('resumed'), {
            preserveAcceptedTranslations: true, onRetainedTranslation: retained,
          });
          bridge.translate(document.body);
        };
        await resume();
        expect(bridge.session.nodesTranslator.has(node)).toBe(true);
        if (scenario === 'two-resumes') {
          await resume();
          const latest = observers.at(-1);
          latest.callback([{ target: owner, isIntersecting: true }], latest);
          await Promise.resolve();
          expect(translate).toHaveBeenCalledOnce();
          expect(retained).toHaveBeenCalledTimes(2);
        }
        bridge.restore(document.body);
        expect(node.nodeValue).toBe('Original source');
      } finally {
        if (previousIntersectionObserver) globalThis.IntersectionObserver = previousIntersectionObserver;
        else delete globalThis.IntersectionObserver;
      }
    }
  );

  it('hydrates accepted lazy nodes while changed and new offscreen nodes still wait for visibility', async () => {
    const previousIntersectionObserver = globalThis.IntersectionObserver;
    const observers = [];
    globalThis.IntersectionObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.observe = vi.fn();
        this.unobserve = vi.fn();
        this.disconnect = vi.fn();
        observers.push(this);
      }
    };
    try {
      document.body.innerHTML = '<p id="accepted">Accepted source</p><p id="edited">Initial source</p>';
      const acceptedOwner = document.getElementById('accepted');
      const editedOwner = document.getElementById('edited');
      const pending = [];
      const translate = vi.fn((text) => new Promise(resolve => pending.push({ text, resolve })));
      const lazySettings = { ...settings, lazyLoading: true };
      await bridge.initialize(lazySettings, translate);
      bridge.translate(document.body);
      observers[0].callback([
        { target: acceptedOwner, isIntersecting: true }, { target: editedOwner, isIntersecting: true },
      ], observers[0]);
      pending.forEach(item => item.resolve(settlement(`Translated ${item.text}`)));
      await vi.waitFor(() => expect(editedOwner.textContent).toContain('Translated Initial source'));
      editedOwner.firstChild.nodeValue = 'Edited source';
      const later = document.createElement('p');
      later.textContent = 'New source';
      document.body.appendChild(later);
      bridge.stopPersistence();
      const retained = vi.fn();
      await bridge.initialize(lazySettings, translate, Symbol('new'), {
        preserveAcceptedTranslations: true, onRetainedTranslation: retained,
      });
      bridge.translate(document.body);

      expect(bridge.session.nodesTranslator.has(acceptedOwner.firstChild)).toBe(true);
      expect(bridge.session.nodesTranslator.has(editedOwner.firstChild)).toBe(false);
      expect(bridge.session.nodesTranslator.has(later.firstChild)).toBe(false);
      expect(retained).toHaveBeenCalledOnce();
      expect(translate).toHaveBeenCalledTimes(2);
      const latest = observers.at(-1);
      latest.callback([
        { target: editedOwner, isIntersecting: true }, { target: later, isIntersecting: true },
      ], latest);
      expect(pending.slice(2).map(item => item.text)).toEqual(['Edited source', 'New source']);
      pending.slice(2).forEach(item => item.resolve(settlement(`Fresh ${item.text}`)));
      await vi.waitFor(() => expect(later.textContent).toContain('Fresh New source'));
      bridge.restore(document.body);
      expect(acceptedOwner.textContent).toBe('Accepted source');
      expect(editedOwner.textContent).toBe('Edited source');
      expect(later.textContent).toBe('New source');
    } finally {
      if (previousIntersectionObserver) globalThis.IntersectionObserver = previousIntersectionObserver;
      else delete globalThis.IntersectionObserver;
    }
  });

  it.each(['edited', 'pending-update', 'failed', 'target', 'provider', 'settings-revision', 'document', 'manual'])(
    'does not retain %s work across SPA routes', async (scenario) => {
      const node = document.createTextNode('Original source');
      document.body.appendChild(node);
      const { pending } = await startDeferredTranslation({ translationApi: 'custom' });
      if (scenario === 'failed') {
        pending[0].resolve(terminalSettlement('Original source', 'failed'));
        await vi.waitFor(() => expect(bridge.session.nodesTranslator.has(node)).toBe(true));
      } else {
        pending[0].resolve(settlement('Accepted translation'));
        await vi.waitFor(() => expect(node.nodeValue).toContain('Accepted translation'));
      }
      if (scenario === 'edited' || scenario === 'pending-update') node.nodeValue = 'Edited source';
      if (scenario === 'pending-update') {
        bridge.session.nodesTranslator.update(node);
        await vi.waitFor(() => expect(pending).toHaveLength(2));
      }
      if (scenario === 'document') bridge.session.root = document.implementation.createHTMLDocument('Other document').body;
      bridge.stopPersistence();
      window.history.replaceState({}, '', '/retention-mismatch-route');
      const retained = vi.fn();
      const translate = vi.fn(async () => settlement('New translation'));
      await bridge.initialize({
        ...settings, translationApi: scenario === 'provider' ? 'openai' : 'custom',
        targetLanguage: scenario === 'target' ? 'ja' : settings.targetLanguage,
      }, translate, Symbol('new-session'), {
        preserveAcceptedTranslations: scenario !== 'manual',
        settingsRevision: scenario === 'settings-revision' ? 1 : 0,
        onRetainedTranslation: retained,
      });
      bridge.translate(document.body);
      expect(translate).toHaveBeenCalledOnce();
      expect(retained).not.toHaveBeenCalled();
      if (scenario === 'pending-update') pending[1].resolve(settlement('Old update'));
    }
  );

  it('rejects older persistent work after an ABA source change', async () => {
    const node = document.createTextNode('one');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation({ autoTranslateOnDOMChanges: true });

    node.nodeValue = 'two';
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(1));
    node.nodeValue = 'one';
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(2));

    const stale = vi.fn();
    pending[0].resolve(settlement('old translation', stale));
    await Promise.resolve();
    await Promise.resolve();

    expect(node.nodeValue).toBe('one');
    expect(stale).toHaveBeenCalledWith('stale');
  });
});
