import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadFeature: vi.fn(),
  translateFieldViaSmartHandler: vi.fn(),
  sendMessage: vi.fn(),
  settingsGet: vi.fn(),
  settingsOnChange: vi.fn(),
  settingsCallbacks: new Map(),
  settingValues: new Map(),
  pageEventBusOn: vi.fn(),
  pageEventBusEmit: vi.fn(),
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    init: vi.fn(),
    operation: vi.fn(),
  })),
}));

vi.mock('@/core/memory/ResourceTracker.js', () => ({
  default: class ResourceTracker {
    constructor() {
      this.resources = [];
    }

    addEventListener(target, event, handler, options) {
      target.addEventListener(event, handler, options || undefined);
      this.resources.push({ target, event, handler, options });
    }

    trackResource() {}

    cleanup() {
      for (const { target, event, handler, options } of this.resources.splice(0)) {
        target.removeEventListener(event, handler, options || undefined);
      }
    }

    destroy() {
      this.cleanup();
    }
  },
}));

vi.mock('@/shared/managers/SettingsManager.js', () => ({
  settingsManager: {
    get: (...args) => mocks.settingsGet(...args),
    onChange: (...args) => mocks.settingsOnChange(...args),
    isExtensionEnabled: vi.fn(() => true),
  },
}));

vi.mock('@/features/exclusion/core/ExclusionChecker.js', () => ({
  ExclusionChecker: {
    getInstance: vi.fn(() => ({
      isFeatureAllowed: vi.fn(() => Promise.resolve(true)),
    })),
  },
}));

vi.mock('@/features/exclusion/utils/exclusion-utils.js', () => ({
  checkUrlExclusionAsync: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('@/core/PageEventBus.js', () => ({
  pageEventBus: {
    on: mocks.pageEventBusOn,
    emit: mocks.pageEventBusEmit,
  },
}));

vi.mock('@/core/content-scripts/chunks/lazy-features.js', () => ({
  loadFeature: (...args) => mocks.loadFeature(...args),
}));

vi.mock('@/handlers/smartTranslationIntegration.js', () => ({
  translateFieldViaSmartHandler: (...args) => mocks.translateFieldViaSmartHandler(...args),
}));

vi.mock('@/shared/messaging/core/UnifiedMessaging.js', () => ({
  sendMessage: (...args) => mocks.sendMessage(...args),
}));

vi.mock('@/shared/messaging/core/MessageActions.js', () => ({
  MessageActions: {
    TRANSLATE: 'TRANSLATE',
    CANCEL_TRANSLATION: 'CANCEL_TRANSLATION',
  },
}));

vi.mock('@/shared/messaging/core/MessagingCore.js', () => ({
  MessageFormat: {
    create: vi.fn((action, data, context) => ({ action, data, context })),
  },
  MessagingContexts: { CONTENT: 'content' },
}));

vi.mock('@/shared/config/config.js', () => ({
  TranslationMode: { Field: 'field' },
  getEffectiveProviderAsync: vi.fn(() => Promise.resolve('provider')),
}));

vi.mock('@/utils/UtilsFactory.js', () => ({
  utilsFactory: {
    getBrowserUtils: vi.fn(() => Promise.resolve({
      detectPlatform: vi.fn(() => 'WINDOWS'),
    })),
  },
}));

vi.mock('@/core/managers/core/NotificationManager.js', () => ({
  default: class NotificationManager {},
}));

vi.mock('@/shared/error-management/ErrorHandler.js', () => ({
  ErrorHandler: {
    getInstance: vi.fn(() => ({ handle: vi.fn() })),
  },
}));

vi.mock('@/shared/constants/detection.js', () => ({
  INPUT_TYPES: {
    ALL_TEXT_FIELDS: ['text', 'search', 'tel', 'url', 'email', 'password', 'number'],
  },
}));

import interactionCoordinator from './InteractionCoordinator.js';
import { ShortcutHandler } from '@/features/shortcuts/handlers/ShortcutHandler.js';
import { shortcutManager } from '@/core/managers/content/shortcuts/ShortcutManager.js';
import { FieldShortcutManager } from '@/features/text-field-interaction/managers/FieldShortcutManager.js';

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

function configureSettings() {
  mocks.settingsCallbacks.clear();
  mocks.settingValues.clear();
  mocks.settingsOnChange.mockImplementation((key, callback) => {
    const callbacks = mocks.settingsCallbacks.get(key) || new Set();
    callbacks.add(callback);
    mocks.settingsCallbacks.set(key, callbacks);
    return () => callbacks.delete(callback);
  });
  mocks.settingsGet.mockImplementation((key, fallback) => {
    if (mocks.settingValues.has(key)) return mocks.settingValues.get(key);
    if (key === 'EXTENSION_ENABLED') return true;
    if (key === 'ENABLE_SHORTCUT_FOR_TEXT_FIELDS') return true;
    if (key === 'TEXT_FIELD_SHORTCUT') return 'Ctrl+/';
    if (key === 'SOURCE_LANGUAGE') return 'auto';
    if (key === 'TARGET_LANGUAGE') return 'fa';
    return fallback;
  });
}

function changeSetting(key, value) {
  mocks.settingValues.set(key, value);
  for (const callback of mocks.settingsCallbacks.get(key) || []) callback(value, undefined, key);
}

function createEvent(key = '/', modifiers = {}) {
  return new KeyboardEvent('keydown', {
    key,
    code: key === '/' ? 'Slash' : `Key${key.toUpperCase()}`,
    ctrlKey: modifiers.ctrlKey ?? key === '/',
    altKey: modifiers.altKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
    metaKey: modifiers.metaKey ?? false,
    repeat: modifiers.repeat ?? false,
    bubbles: true,
    cancelable: true,
  });
}

describe('Ctrl+/ dispatch characterization', () => {
  let coordinator;
  let handler;
  let executeSpy;
  let delegatedKeyboardSpy;
  let textarea;

  beforeEach(() => {
    vi.clearAllMocks();
    configureSettings();
    mocks.translateFieldViaSmartHandler.mockResolvedValue(undefined);
    mocks.sendMessage.mockResolvedValue({ success: true });
    mocks.loadFeature.mockImplementation(async () => handler);

    textarea = document.createElement('textarea');
    textarea.value = 'hello';
    document.body.appendChild(textarea);
    textarea.focus();

    coordinator = interactionCoordinator;
    executeSpy = vi.spyOn(FieldShortcutManager.prototype, 'execute');
  });

  afterEach(async () => {
    coordinator?.cleanup();
    if (handler?.isActive) await handler.deactivate();
    ShortcutHandler.destroyInstance();
    if (shortcutManager.initialized) shortcutManager.cleanup();
    executeSpy?.mockRestore();
    delegatedKeyboardSpy?.mockRestore();
    textarea?.remove();
  });

  async function activateShortcutWiring() {
    handler = ShortcutHandler.getInstance({ featureManager: {} });
    await handler.activate();
    delegatedKeyboardSpy = vi.spyOn(handler, 'handleKeyboardEvent');
    mocks.shortcutHandler = handler;
    await coordinator.initialize();
  }

  it('dispatches one activated Ctrl+/ through canonical ownership', async () => {
    await activateShortcutWiring();
    const event = createEvent();
    const preventDefault = vi.spyOn(event, 'preventDefault');
    const stopPropagation = vi.spyOn(event, 'stopPropagation');
    const stopImmediatePropagation = vi.spyOn(event, 'stopImmediatePropagation');

    document.dispatchEvent(event);
    await nextTask();
    await nextTask();

    expect(mocks.translateFieldViaSmartHandler).toHaveBeenCalledTimes(1);
    expect(delegatedKeyboardSpy).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
    expect(stopImmediatePropagation).toHaveBeenCalled();
  });

  it('scales one canonical execution per separate physical Ctrl+/ event', async () => {
    await activateShortcutWiring();

    document.dispatchEvent(createEvent());
    await nextTask();
    await nextTask();
    document.dispatchEvent(createEvent());
    await nextTask();
    await nextTask();

    expect(mocks.translateFieldViaSmartHandler).toHaveBeenCalledTimes(2);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('does not start Field translation for unrelated keydown', async () => {
    await activateShortcutWiring();

    document.dispatchEvent(createEvent('a'));
    await nextTask();
    await nextTask();

    expect(mocks.translateFieldViaSmartHandler).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('does not manually redispatch Escape after ShortcutManager is initialized', async () => {
    await activateShortcutWiring();
    const dispatchSpy = vi.spyOn(shortcutManager, 'handleKeyboardEvent');
    const event = createEvent('Escape');

    coordinator.revertMightBeNeeded = true;
    await coordinator._handleKeyboardInteraction(event);

    expect(dispatchSpy).not.toHaveBeenCalled();
    dispatchSpy.mockRestore();
  });

  it('delegates first lazy Escape once after ShortcutManager initializes', async () => {
    mocks.loadFeature.mockImplementationOnce(async () => {
      handler = ShortcutHandler.getInstance({ featureManager: {} });
      await handler.activate();
      return handler;
    });
    await coordinator.initialize();
    coordinator.revertMightBeNeeded = true;
    const dispatchSpy = vi.spyOn(shortcutManager, 'handleKeyboardEvent');

    await coordinator._handleKeyboardInteraction(createEvent('Escape'));

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    dispatchSpy.mockRestore();
  });

  it('characterizes first-event lazy activation separately', async () => {
    let lazyHandler;
    mocks.loadFeature.mockImplementationOnce(async () => {
      lazyHandler = ShortcutHandler.getInstance({ featureManager: {} });
      await lazyHandler.activate();
      handler = lazyHandler;
      return lazyHandler;
    });
    await coordinator.initialize();

    document.dispatchEvent(createEvent());
    await nextTask();
    await nextTask();

    expect(mocks.translateFieldViaSmartHandler).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('uses a configured shortcut for first-event lazy activation', async () => {
    changeSetting('TEXT_FIELD_SHORTCUT', 'Alt+T');
    mocks.loadFeature.mockImplementationOnce(async () => {
      handler = ShortcutHandler.getInstance({ featureManager: {} });
      await handler.activate();
      return handler;
    });
    await coordinator.initialize();

    document.dispatchEvent(createEvent('t', { ctrlKey: false, altKey: true }));
    await nextTask();
    await nextTask();

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(mocks.loadFeature).toHaveBeenCalledTimes(1);
    expect(mocks.loadFeature).toHaveBeenCalledWith('shortcut', false);
    expect(mocks.translateFieldViaSmartHandler).toHaveBeenCalledTimes(1);
  });

  it('does not load shortcut feature for an unrelated key before lazy initialization', async () => {
    await coordinator.initialize();

    document.dispatchEvent(createEvent('a'));
    await nextTask();

    expect(mocks.loadFeature).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('does not activate or execute a repeated configured shortcut while lazy', async () => {
    changeSetting('TEXT_FIELD_SHORTCUT', 'Alt+T');
    await coordinator.initialize();

    document.dispatchEvent(createEvent('t', { ctrlKey: false, altKey: true, repeat: true }));
    await nextTask();

    expect(mocks.loadFeature).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
    expect(mocks.translateFieldViaSmartHandler).not.toHaveBeenCalled();
  });

  it('moves the registered shortcut when the setting changes', async () => {
    await activateShortcutWiring();
    const fieldShortcut = shortcutManager.shortcuts.get('Ctrl+/');
    changeSetting('TEXT_FIELD_SHORTCUT', 'Alt+T');

    expect(shortcutManager.shortcuts.has('Ctrl+/')).toBe(false);
    expect(shortcutManager.shortcuts.get('Alt+t')).toBe(fieldShortcut);
    expect(shortcutManager.shortcuts.has('escape')).toBe(true);
    expect(shortcutManager.shortcuts.has('a')).toBe(false);

    document.dispatchEvent(createEvent());
    document.dispatchEvent(createEvent('t', { ctrlKey: false, altKey: true, repeat: true }));
    document.dispatchEvent(createEvent('t', { ctrlKey: false, altKey: true }));
    await nextTask();
    await nextTask();

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(mocks.translateFieldViaSmartHandler).toHaveBeenCalledTimes(1);
    expect(mocks.loadFeature).toHaveBeenCalledTimes(1);
  });

  it('reconciles the latest setting after subscribing across initialization', async () => {
    const subscribe = mocks.settingsOnChange.getMockImplementation();
    let changedDuringFieldSubscription = false;
    mocks.settingsOnChange.mockImplementation((key, callback, ...args) => {
      const unsubscribe = subscribe(key, callback, ...args);
      if (key === 'TEXT_FIELD_SHORTCUT' && !changedDuringFieldSubscription) {
        changedDuringFieldSubscription = true;
        changeSetting(key, 'Alt+T');
      }
      return unsubscribe;
    });

    await activateShortcutWiring();
    const fieldShortcut = shortcutManager.ctrlSlashShortcut;

    expect(shortcutManager.shortcuts.has('Ctrl+/')).toBe(false);
    expect(shortcutManager.shortcuts.get('Alt+t')).toBe(fieldShortcut);

    document.dispatchEvent(createEvent('t', { ctrlKey: false, altKey: true }));
    await nextTask();
    await nextTask();

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(mocks.translateFieldViaSmartHandler).toHaveBeenCalledTimes(1);
  });

  it('keeps Escape reserved when configured as the field shortcut, then rebinds to a valid key', async () => {
    changeSetting('TEXT_FIELD_SHORTCUT', 'Escape');
    await activateShortcutWiring();
    const revertShortcut = shortcutManager.revertShortcut;
    const fieldShortcut = shortcutManager.ctrlSlashShortcut;

    expect(shortcutManager.shortcuts.get('escape')).toBe(revertShortcut);
    expect([...shortcutManager.shortcuts.values()]).not.toContain(fieldShortcut);

    changeSetting('TEXT_FIELD_SHORTCUT', 'Alt+T');

    expect(shortcutManager.shortcuts.get('escape')).toBe(revertShortcut);
    expect(shortcutManager.shortcuts.get('Alt+t')).toBe(fieldShortcut);

    changeSetting('TEXT_FIELD_SHORTCUT', 'Escape');

    expect(shortcutManager.shortcuts.get('escape')).toBe(revertShortcut);
    expect(shortcutManager.shortcuts.has('Alt+t')).toBe(false);

    changeSetting('TEXT_FIELD_SHORTCUT', 'Alt+T');

    expect(shortcutManager.shortcuts.get('escape')).toBe(revertShortcut);
    expect(shortcutManager.shortcuts.get('Alt+t')).toBe(fieldShortcut);
  });

  it('preserves an unrelated handler when the field shortcut collides with it', async () => {
    changeSetting('TEXT_FIELD_SHORTCUT', 'Alt+T');
    const unrelatedHandler = { shouldExecute: vi.fn(), execute: vi.fn() };
    shortcutManager.registerShortcut('Alt+T', unrelatedHandler);
    await activateShortcutWiring();
    const fieldShortcut = shortcutManager.ctrlSlashShortcut;

    expect(shortcutManager.shortcuts.get('Alt+t')).toBe(unrelatedHandler);
    expect([...shortcutManager.shortcuts.values()]).not.toContain(fieldShortcut);

    changeSetting('TEXT_FIELD_SHORTCUT', 'Cmd+T');

    expect(shortcutManager.shortcuts.get('Alt+t')).toBe(unrelatedHandler);
    expect(shortcutManager.shortcuts.get('Meta+t')).toBe(fieldShortcut);
  });

  it('matches Cmd independently from Ctrl and keeps exact complex modifiers', async () => {
    changeSetting('TEXT_FIELD_SHORTCUT', 'Cmd+Shift+T');
    await activateShortcutWiring();

    document.dispatchEvent(createEvent('t', { ctrlKey: true, shiftKey: true }));
    document.dispatchEvent(createEvent('t', { metaKey: true, shiftKey: true }));
    await nextTask();
    await nextTask();

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(mocks.translateFieldViaSmartHandler).toHaveBeenCalledTimes(1);
  });
});
