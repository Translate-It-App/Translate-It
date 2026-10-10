import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ContentMessageHandler } from './ContentMessageHandler.js';
import { TranslationMode } from '@/shared/config/config.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { ActionReasons } from '@/shared/messaging/core/MessagingConstants.js';
import { applyTranslationToTextField } from '../smartTranslationIntegration.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import browser from 'webextension-polyfill';
import { loadFeature } from '@/core/content-scripts/chunks/lazy-features.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LIVE_DUBBING_ACTIONS } from '@/features/live-dubbing/constants.js';
import {
  getLiveDubbingTranscriptSnapshot,
  resetLiveDubbingTranscriptState,
} from '@/features/live-dubbing/content/liveDubbingTranscriptStore.js';

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {
      sendMessage: vi.fn(),
    },
  },
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    init: vi.fn(),
    warn: vi.fn(),
  })),
}));

vi.mock('@/core/memory/ResourceTracker.js', () => ({
  default: class ResourceTracker {
    constructor() {
      this.eventListeners = [];
    }

    addEventListener(element, event, handler, options = null) {
      if (options) {
        element.addEventListener(event, handler, options);
      } else {
        element.addEventListener(event, handler);
      }
      this.eventListeners.push({ element, event, handler, options });
    }

    trackResource() {}

    cleanup() {
      for (const { element, event, handler, options } of this.eventListeners) {
        if (options) {
          element.removeEventListener(event, handler, options);
        } else {
          element.removeEventListener(event, handler);
        }
      }
      this.eventListeners = [];
    }
  },
}));

vi.mock('@/shared/error-management/ErrorHandler.js', () => ({
  ErrorHandler: {
    getInstance: vi.fn(() => ({ handle: vi.fn() })),
  },
}));

vi.mock('@/features/element-selection/utils/activationError.js', () => ({
  getSelectElementActivationErrorMessage: vi.fn(() => Promise.resolve('Could not activate Select Element mode.')),
}));

vi.mock('./RevertHandler.js', () => ({
  revertHandler: { executeRevert: vi.fn() },
}));

vi.mock('@/core/content-scripts/chunks/lazy-features.js', () => ({ loadFeature: vi.fn() }));

vi.mock('../smartTranslationIntegration.js', () => ({
  applyTranslationToTextField: vi.fn(),
}));

vi.mock('@/core/PageEventBus.js', () => ({
  pageEventBus: { emit: vi.fn() },
}));
import { pageEventBus } from '@/core/PageEventBus.js';

describe('ContentMessageHandler iframe Select Element activation', () => {
  let handler;

  const createQueuedManager = manager => {
    let queue = Promise.resolve();
    const run = operation => operation({
      activate: options => manager.activateSelectElementMode?.(options),
      deactivate: options => manager.deactivate?.(options),
    });
    return {
      ...manager,
      enqueueSelectElementLifecycle(operation) {
        const queued = queue.then(run.bind(null, operation), run.bind(null, operation));
        queue = queued.catch(() => {});
        return queued;
      },
    };
  };

  beforeEach(() => {
    ContentMessageHandler.resetInstance();
    vi.clearAllMocks();
    loadFeature.mockReset();
    resetLiveDubbingTranscriptState();
    browser.runtime.sendMessage.mockResolvedValue({ success: true });
    handler = new ContentMessageHandler();
    handler.handlers.clear();
    handler.setSelectElementManager(null);
    handler.setPageTranslationManager(null);
  });

  it('does not expose legacy iframe Select Element activation route', async () => {
    expect(typeof handler.handleIFrameActivateSelectElement).toBe('undefined');
    expect(handler.handlers.has(MessageActions.IFRAME_ACTIVATE_SELECT_ELEMENT)).toBe(false);
  });

  it('bridges valid live dubbing transcript envelopes and rejects invalid ones', () => {
    handler.initialize();
    const envelope = {
      sessionId: 'session-1',
      providerId: 'gemini',
      eventSequence: 4,
      transcriptSequence: 4,
      transcript: { kind: 'translated', text: 'Hello' },
    };

    expect(handler.handleLiveDubbingStatus({ data: envelope })).toEqual({ success: true, accepted: true });
    expect(handler.handleLiveDubbingStatus({ data: { ...envelope, transcript: { kind: 'partial', text: 'No' } } }))
      .toEqual({ success: true, accepted: false });
    expect(getLiveDubbingTranscriptSnapshot().translatedFragments).toEqual(['Hello']);
    expect(pageEventBus.emit).not.toHaveBeenCalled();
  });

  it('accepts the original-transcript action into the source buffer on the shared path', () => {
    handler.initialize();
    expect(handler.handlers.has(LIVE_DUBBING_ACTIONS.TRANSLATED_TRANSCRIPT)).toBe(true);
    expect(handler.handlers.has(LIVE_DUBBING_ACTIONS.ORIGINAL_TRANSCRIPT)).toBe(true);

    const sourceEnvelope = {
      sessionId: 'session-1',
      providerId: 'gemini',
      eventSequence: 5,
      transcriptSequence: 5,
      transcript: { kind: 'source', text: 'Original line' },
    };

    expect(handler.handleLiveDubbingStatus({ data: sourceEnvelope })).toEqual({ success: true, accepted: true });
    const snapshot = getLiveDubbingTranscriptSnapshot();
    expect(snapshot.sourceFragments).toEqual(['Original line']);
    expect(snapshot.translatedFragments).toEqual([]);
    expect(pageEventBus.emit).not.toHaveBeenCalled();
  });

  it('clears both transcript kinds through the single existing clear handler', () => {
    handler.initialize();
    handler.handleLiveDubbingStatus({
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence: 1,
        transcriptSequence: 1,
        transcript: { kind: 'translated', text: 'Hello' },
      },
    });
    handler.handleLiveDubbingStatus({
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence: 2,
        transcriptSequence: 2,
        transcript: { kind: 'source', text: 'Hola' },
      },
    });

    expect(handler.handleLiveDubbingClear({ data: { sessionId: 'session-1' } })).toEqual({ success: true });
    const snapshot = getLiveDubbingTranscriptSnapshot();
    expect(snapshot.translatedFragments).toEqual([]);
    expect(snapshot.sourceFragments).toEqual([]);
    // STOP/terminal stays on one clear registration; no per-kind clear action.
    expect(handler.handlers.has(LIVE_DUBBING_ACTIONS.TRANSCRIPT_CLEAR)).toBe(true);
    expect(handler.handlers.has(LIVE_DUBBING_ACTIONS.ORIGINAL_TRANSCRIPT_CLEAR)).toBe(true);
    expect(pageEventBus.emit).not.toHaveBeenCalled();
  });

  it('never writes transcript text into handler logs', () => {
    const secret = 'Top secret spoken line';
    handler.initialize();
    const logger = getScopedLogger.mock.results.at(-1).value;

    handler.handleLiveDubbingStatus({
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence: 1,
        transcriptSequence: 1,
        transcript: { kind: 'translated', text: secret },
      },
    });
    handler.handleLiveDubbingStatus({
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence: 2,
        transcriptSequence: 2,
        transcript: { kind: 'source', text: secret },
      },
    });
    handler.handleLiveDubbingClear({ data: { sessionId: 'session-1' } });

    const logged = [logger.debug, logger.info, logger.warn, logger.error, logger.init]
      .flatMap(fn => fn.mock.calls)
      .flat()
      .map((arg) => {
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(' ');
    expect(logged).not.toContain(secret);
  });

  it('keeps the transcript bridge on the plain store without a Vue dependency', () => {
    const handlerSource = readFileSync('src/handlers/content/ContentMessageHandler.js', 'utf8');
    const storeSource = readFileSync('src/features/live-dubbing/content/liveDubbingTranscriptStore.js', 'utf8');

    expect(handlerSource).toContain('liveDubbingTranscriptStore.js');
    expect(handlerSource).not.toContain('liveDubbingTranscriptState.js');
    expect(storeSource).not.toMatch(/from\s+["']vue["']/);
  });

  it('does not announce iframe readiness during local initialization', () => {
    handler.initialize();

    expect(handler.handlers.has(MessageActions.GET_SELECT_ELEMENT_FRAME_STATE)).toBe(true);
    expect(handler.handlers.has(MessageActions.ACTIVATE_SELECT_ELEMENT_MODE)).toBe(true);
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('registers Select Element receivers before activation resolves', async () => {
    const registrations = new Map();
    window.translateItContentCore = {
      messageHandler: {
        isListenerActive: true,
        registerHandler: vi.fn((action, callback) => registrations.set(action, callback)),
      },
    };

    await expect(handler.activate()).resolves.toBe(true);

    expect(registrations.has(MessageActions.GET_SELECT_ELEMENT_FRAME_STATE)).toBe(true);
    expect(registrations.has(MessageActions.ACTIVATE_SELECT_ELEMENT_MODE)).toBe(true);
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    delete window.translateItContentCore;
  });

  it('rejects coordinate Select Element operation via legacy iframe route', async () => {
    handler.setSelectElementManager({
      isInitialized: true,
      activateSelectElementMode: vi.fn().mockResolvedValue({ isActive: true }),
    });

    const response = await handler.handleIFrameCoordinateOperation({
      operation: TranslationMode.Select_Element,
    });

    expect(response).toMatchObject({
      success: false,
    });
    expect(response.error).toMatch(/Unsupported/);
  });

  it('keeps iframe frame-info route available', async () => {
    handler.setSelectElementManager({
      isInitialized: true,
      activateSelectElementMode: vi.fn().mockResolvedValue({
        isActive: true,
        instanceId: 'manager-1',
      }),
    });

    // Frame info handler should still exist and be registered
    expect(typeof handler.handleIFrameGetFrameInfo).toBe('function');
    expect(handler.handlers.has(MessageActions.IFRAME_GET_FRAME_INFO)).toBe(false);
    // After initialize, it would be registered; but fresh handler without initialize has empty handlers map.
    // Ensure class method exists.
  });

  it('stores accepted activation generation only after successful activation', async () => {
    const activateSelectElementMode = vi.fn().mockResolvedValue({
      isActive: true,
      instanceId: 'manager-1',
    });
    handler.setSelectElementManager({ isInitialized: true, activateSelectElementMode });

    const response = await handler.handleActivateSelectElementMode({
      data: { activationGeneration: 7 },
    });

    expect(response).toMatchObject({
      success: true,
      activated: true,
      activationGeneration: 7,
    });
    expect(handler.acceptedSelectElementGeneration).toBe(7);
  });

  it('rejects lower generations within the same background epoch', async () => {
    const activateSelectElementMode = vi.fn().mockResolvedValue({ isActive: true });
    handler.setSelectElementManager({ isInitialized: true, activateSelectElementMode });

    await handler.handleActivateSelectElementMode({
      data: { activationEpoch: 'epoch-a', activationGeneration: 4 },
    });
    const staleResponse = await handler.handleActivateSelectElementMode({
      data: { activationEpoch: 'epoch-a', activationGeneration: 3 },
    });

    expect(staleResponse).toMatchObject({ success: false, staleGeneration: true });
    expect(activateSelectElementMode).toHaveBeenCalledTimes(1);
  });

  it('simulates background restart across the content message boundary', async () => {
    const activateSelectElementMode = vi.fn().mockResolvedValue({ isActive: true });
    const deactivate = vi.fn().mockResolvedValue({ success: true, cleanupCompleted: true });
    handler.setSelectElementManager({
      isInitialized: true,
      activateSelectElementMode,
      deactivate,
      isSelectElementActive: () => true,
    });
    handler.registerHandler(
      MessageActions.ACTIVATE_SELECT_ELEMENT_MODE,
      handler.handleActivateSelectElementMode.bind(handler),
    );
    handler.registerHandler(
      MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE,
      handler.handleDeactivateSelectElementMode.bind(handler),
    );
    const sendBackgroundMessage = async (action, data) => {
      let response;
      await handler.handleMessage(
        { action, data },
        { tab: { id: 1 } },
        value => { response = value.data; },
      );
      return response;
    };

    await sendBackgroundMessage(MessageActions.ACTIVATE_SELECT_ELEMENT_MODE, {
      activationEpoch: 'epoch-a',
      activationGeneration: 4,
    });
    await sendBackgroundMessage(MessageActions.DEACTIVATE_SELECT_ELEMENT_MODE, {
      activationEpoch: 'epoch-a',
      activationGeneration: 4,
      fromBackground: true,
      isExplicitDeactivation: true,
    });

    const response = await sendBackgroundMessage(MessageActions.ACTIVATE_SELECT_ELEMENT_MODE, {
      activationEpoch: 'epoch-b',
      activationGeneration: 1,
    });

    expect(response).toMatchObject({
      success: true,
      activated: true,
      activationEpoch: 'epoch-b',
      activationGeneration: 1,
    });
    expect(handler.acceptedSelectElementEpoch).toBe('epoch-b');
    expect(handler.acceptedSelectElementGeneration).toBe(1);
    expect(handler.invalidatedSelectElementGeneration).toBeNull();
  });

  it('ignores old-epoch deactivation after newer epoch activation', async () => {
    const activateSelectElementMode = vi.fn().mockResolvedValue({ isActive: true });
    const deactivate = vi.fn().mockResolvedValue({ success: true, cleanupCompleted: true });
    handler.setSelectElementManager({
      isInitialized: true,
      activateSelectElementMode,
      deactivate,
      isSelectElementActive: () => true,
    });

    await handler.handleActivateSelectElementMode({
      data: { activationEpoch: 'epoch-b', activationGeneration: 1 },
    });
    deactivate.mockClear();

    const response = await handler.handleDeactivateSelectElementMode({
      data: {
        activationEpoch: 'epoch-a',
        activationGeneration: 4,
        fromBackground: true,
        isExplicitDeactivation: true,
      },
    });

    expect(response).toMatchObject({ success: false, staleEpoch: true, activated: true });
    expect(deactivate).not.toHaveBeenCalled();
    expect(handler.acceptedSelectElementEpoch).toBe('epoch-b');
    expect(handler.acceptedSelectElementGeneration).toBe(1);
    expect(handler.invalidatedSelectElementGeneration).toBeNull();
  });

  it('performs normal cleanup for current-epoch deactivation', async () => {
    const activateSelectElementMode = vi.fn().mockResolvedValue({ isActive: true });
    const deactivate = vi.fn().mockResolvedValue({ success: true, cleanupCompleted: true });
    handler.setSelectElementManager({ isInitialized: true, activateSelectElementMode, deactivate });

    await handler.handleActivateSelectElementMode({
      data: { activationEpoch: 'epoch-b', activationGeneration: 1 },
    });
    const response = await handler.handleDeactivateSelectElementMode({
      data: {
        activationEpoch: 'epoch-b',
        activationGeneration: 1,
        fromBackground: true,
        isExplicitDeactivation: true,
      },
    });

    expect(response).toMatchObject({ success: true, cleanupCompleted: true, activated: false });
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(handler.acceptedSelectElementEpoch).toBe('epoch-b');
    expect(handler.acceptedSelectElementGeneration).toBeNull();
  });

  it('does not replace accepted generation when newer activation fails', async () => {
    const activateSelectElementMode = vi.fn()
      .mockResolvedValueOnce({ isActive: true })
      .mockRejectedValueOnce(new Error('activation failed'));
    handler.setSelectElementManager({ isInitialized: true, activateSelectElementMode });

    await handler.handleActivateSelectElementMode({ data: { activationGeneration: 8 } });
    const failedResponse = await handler.handleActivateSelectElementMode({ data: { activationGeneration: 9 } });

    expect(failedResponse.success).toBe(false);
    expect(handler.acceptedSelectElementGeneration).toBe(8);
  });

  it('rejects stale deactivation before manager cleanup', async () => {
    const activateSelectElementMode = vi.fn().mockResolvedValue({ isActive: true });
    const deactivate = vi.fn();
    handler.setSelectElementManager({
      isInitialized: true,
      activateSelectElementMode,
      deactivate,
      isSelectElementActive: vi.fn(() => true),
    });
    await handler.handleActivateSelectElementMode({ data: { activationGeneration: 1 } });
    await handler.handleActivateSelectElementMode({ data: { activationGeneration: 2 } });

    await expect(handler.handleDeactivateSelectElementMode({
      data: {
        fromBackground: true,
        isExplicitDeactivation: true,
        activationGeneration: 1,
      },
    })).resolves.toEqual({
      success: false,
      cleanupCompleted: false,
      activated: true,
      staleGeneration: true,
    });

    expect(deactivate).not.toHaveBeenCalled();
  });

  it('blocks delayed activation after compensating invalidation arrives first', async () => {
    const activateSelectElementMode = vi.fn().mockResolvedValue({ isActive: true });
    const deactivate = vi.fn().mockResolvedValue({ success: true, cleanupCompleted: true });
    handler.setSelectElementManager({
      isInitialized: true,
      activateSelectElementMode,
      deactivate,
      isSelectElementActive: () => false,
    });

    await expect(handler.handleDeactivateSelectElementMode({
      data: {
        fromBackground: true,
        isExplicitDeactivation: true,
        activationGeneration: 1,
      },
    })).resolves.toMatchObject({ success: true, cleanupCompleted: true });

    await expect(handler.handleActivateSelectElementMode({
      data: { activationGeneration: 1 },
    })).resolves.toMatchObject({
      success: false,
      activated: false,
      staleGeneration: true,
    });
    expect(activateSelectElementMode).not.toHaveBeenCalled();
  });

  it('serializes deactivation before queued newer activation', async () => {
    let resolveCleanup;
    let managerActive = true;
    const activateSelectElementMode = vi.fn().mockImplementation(async () => {
      managerActive = true;
      return { isActive: true };
    });
    const deactivate = vi.fn().mockImplementation(() => new Promise(resolve => {
      managerActive = false;
      resolveCleanup = resolve;
    }));
    handler.setSelectElementManager(createQueuedManager({
      isInitialized: true,
      activateSelectElementMode,
      deactivate,
      isSelectElementActive: () => managerActive,
    }));
    handler.acceptedSelectElementGeneration = 1;

    const deactivation = handler.handleDeactivateSelectElementMode({
      data: {
        fromBackground: true,
        isExplicitDeactivation: true,
        activationGeneration: 1,
      },
    });
    await vi.waitFor(() => expect(deactivate).toHaveBeenCalledTimes(1));

    const activation = handler.handleActivateSelectElementMode({
      data: { activationGeneration: 2 },
    });
    expect(activateSelectElementMode).not.toHaveBeenCalled();

    resolveCleanup({ success: true, cleanupCompleted: true });
    await expect(deactivation).resolves.toMatchObject({ success: true, cleanupCompleted: true });
    await expect(activation).resolves.toMatchObject({
      success: true,
      activated: true,
      activationGeneration: 2,
    });
    expect(handler.acceptedSelectElementGeneration).toBe(2);
    expect(managerActive).toBe(true);
  });

  it('rejects older deactivation queued after newer activation', async () => {
    let resolveActivation;
    const activateSelectElementMode = vi.fn().mockImplementation(() => new Promise(resolve => {
      resolveActivation = resolve;
    }));
    const deactivate = vi.fn().mockResolvedValue({ success: true, cleanupCompleted: true });
    handler.setSelectElementManager(createQueuedManager({
      isInitialized: true,
      activateSelectElementMode,
      deactivate,
      isSelectElementActive: () => true,
    }));
    handler.acceptedSelectElementGeneration = 1;

    const activation = handler.handleActivateSelectElementMode({
      data: { activationGeneration: 2 },
    });
    await vi.waitFor(() => expect(activateSelectElementMode).toHaveBeenCalledTimes(1));

    const deactivation = handler.handleDeactivateSelectElementMode({
      data: {
        fromBackground: true,
        isExplicitDeactivation: true,
        activationGeneration: 1,
      },
    });
    expect(deactivate).not.toHaveBeenCalled();

    resolveActivation({ isActive: true });
    await expect(activation).resolves.toMatchObject({ success: true, activationGeneration: 2 });
    await expect(deactivation).resolves.toEqual({
      success: false,
      cleanupCompleted: false,
      activated: true,
      staleGeneration: true,
    });
    expect(deactivate).not.toHaveBeenCalled();
    expect(handler.acceptedSelectElementGeneration).toBe(2);
  });

  it('does not let generation-less deactivation bypass accepted ownership', async () => {
    const deactivate = vi.fn();
    handler.setSelectElementManager({
      deactivate,
      isSelectElementActive: () => true,
    });
    handler.acceptedSelectElementGeneration = 2;

    await expect(handler.handleDeactivateSelectElementMode({
      data: { fromBackground: true, isExplicitDeactivation: true },
    })).resolves.toEqual({
      success: false,
      cleanupCompleted: false,
      activated: true,
      staleGeneration: true,
    });
    expect(deactivate).not.toHaveBeenCalled();
  });

  it('cleans up matching generation and returns strict cleanup ACK', async () => {
    const deactivate = vi.fn().mockResolvedValue({ success: true, cleanupCompleted: true });
    handler.setSelectElementManager({ deactivate });
    handler.acceptedSelectElementGeneration = 2;

    const response = await handler.handleDeactivateSelectElementMode({
      data: {
        fromBackground: true,
        isExplicitDeactivation: true,
        activationGeneration: 2,
      },
    });

    expect(response).toEqual({
      success: true,
      cleanupCompleted: true,
      activated: false,
      activationGeneration: 2,
    });
    expect(handler.acceptedSelectElementGeneration).toBeNull();
    expect(deactivate).toHaveBeenCalledWith({ fromBackground: true });
  });

  it('deactivates once for trusted background Select Element messages', async () => {
    const deactivate = vi.fn().mockResolvedValue({ success: true, cleanupCompleted: true });
    handler.setSelectElementManager({ deactivate });

    await handler.handleDeactivateSelectElementMode({
      data: { fromBackground: true, isExplicitDeactivation: true },
    });

    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(deactivate).toHaveBeenCalledWith({ fromBackground: true });
  });

  it.each([
    ['success', { success: true, cleanupCompleted: true }, {
      success: true,
      cleanupCompleted: true,
      activated: false,
    }],
    ['failure', { success: false, cleanupCompleted: false, error: 'safe cleanup error' }, {
      success: false,
      cleanupCompleted: false,
      activated: false,
      error: 'safe cleanup error',
    }],
  ])('propagates manager deactivation ACK: %s', async (_name, managerResult, expected) => {
    const deactivate = vi.fn().mockResolvedValue(managerResult);
    handler.setSelectElementManager({ deactivate });

    await expect(handler.handleDeactivateSelectElementMode({
      data: { fromBackground: true, isExplicitDeactivation: true },
    })).resolves.toEqual(expected);
  });

  it('rejects a successful ACK without completed cleanup', async () => {
    const deactivate = vi.fn().mockResolvedValue({ success: true, cleanupCompleted: false });
    handler.setSelectElementManager({ deactivate });

    await expect(handler.handleDeactivateSelectElementMode({
      data: { fromBackground: true, isExplicitDeactivation: true },
    })).resolves.toEqual({
      success: false,
      cleanupCompleted: false,
      activated: false,
      error: 'Could not deactivate Select Element mode.',
    });
  });

  it('returns a failed cleanup ACK when Select Element manager is unavailable', async () => {
    await expect(handler.handleDeactivateSelectElementMode({
      data: { fromBackground: true, isExplicitDeactivation: true },
    })).resolves.toEqual({
      success: false,
      cleanupCompleted: false,
      activated: false,
      error: 'Select Element manager unavailable',
    });
  });

  it('leaves generic non-activation error responses unchanged', async () => {
    const technicalMessage = 'unrelated internal failure';
    handler.registerHandler('UNRELATED_ACTION', async () => {
      throw new Error(technicalMessage);
    });
    const sendResponse = vi.fn();

    await handler.handleMessage({ action: 'UNRELATED_ACTION' }, {}, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({
      success: false,
      error: technicalMessage,
    });
  });

  it('returns normal Page Translation admission rejection unchanged', async () => {
    const rejection = {
      success: false,
      reason: ActionReasons.BUSY_OR_DONE,
    };
    handler.setPageTranslationManager({
      isActive: true,
      translatePage: vi.fn().mockResolvedValue(rejection),
    });

    await expect(handler.handlePageTranslate({ data: {} })).resolves.toBe(rejection);
    expect(handler.pageTranslationManager.translatePage).toHaveBeenCalledWith({});
  });

  it('reacquires the current Page instance after its cached instance was deactivated', async () => {
    const retired = {
      isActive: false,
      activate: vi.fn().mockResolvedValue(true),
      translatePage: vi.fn().mockResolvedValue({ success: true }),
    };
    const current = { isActive: true, translatePage: vi.fn().mockResolvedValue({ success: true }) };
    handler.setPageTranslationManager(retired);
    loadFeature.mockResolvedValue(current);

    await expect(handler.handlePageTranslate({ data: { isAuto: true } })).resolves.toEqual({ success: true });
    await handler.handlePageTranslate({ data: {} });

    expect(loadFeature).toHaveBeenCalledExactlyOnceWith('pageTranslation');
    expect(handler.pageTranslationManager).toBe(current);
    expect(current.translatePage).toHaveBeenCalledTimes(2);
    expect(retired.activate).not.toHaveBeenCalled();
    expect(retired.translatePage).not.toHaveBeenCalled();
  });

  it('does not revive a retired Page instance when current feature admission is unavailable', async () => {
    const retired = { isActive: false, activate: vi.fn().mockResolvedValue(true), translatePage: vi.fn() };
    handler.setPageTranslationManager(retired);
    loadFeature.mockResolvedValue(null);
    handler.errorHandler = {
      getErrorForUI: vi.fn().mockResolvedValue({ message: 'Page feature unavailable', type: ErrorTypes.SERVICE }),
      handle: vi.fn().mockResolvedValue(undefined),
    };

    await expect(handler.handlePageTranslate({ data: {} })).resolves.toMatchObject({ success: false });

    expect(loadFeature).toHaveBeenCalledWith('pageTranslation');
    expect(retired.activate).not.toHaveBeenCalled();
    expect(retired.translatePage).not.toHaveBeenCalled();
  });

  it('keeps restore and stop-auto commands on trusted runtime handlers', async () => {
    const restorePage = vi.fn().mockResolvedValue({ success: true });
    const stopAutoTranslation = vi.fn().mockResolvedValue({ success: true });
    handler.setPageTranslationManager({ restorePage, stopAutoTranslation });

    await expect(handler.handlePageRestore()).resolves.toEqual({ success: true });
    await expect(handler.handlePageStopAuto()).resolves.toEqual({ success: true });

    expect(restorePage).toHaveBeenCalledTimes(1);
    expect(stopAutoTranslation).toHaveBeenCalledTimes(1);
  });

  it('keeps cancellation on trusted runtime translation handling', async () => {
    const cancelTranslation = vi.fn().mockResolvedValue({ success: true });
    handler.setPageTranslationManager({ cancelTranslation });

    await expect(handler.handlePageTranslate({ data: { cancel: true } })).resolves.toEqual({
      success: true,
      cancelled: true,
    });

    expect(cancelTranslation).toHaveBeenCalledTimes(1);
  });

  it('routes trusted top-frame lifecycle to MainFrameCoordinator', async () => {
    const handleTrustedPageLifecycle = vi.fn().mockReturnValue({ success: true, aggregated: true });
    const previousCore = window.translateItContentCore;
    window.translateItContentCore = { mainFrameCoordinator: { handleTrustedPageLifecycle } };

    try {
      const relay = {
        frameId: 7,
        action: MessageActions.PAGE_TRANSLATE_PROGRESS,
        data: { translatedCount: 2, totalCount: 3, frameId: 99 },
      };
      await expect(handler.handlePageTranslationLifecycle(
        { data: relay },
        {}
      )).resolves.toEqual({ success: true, aggregated: true });

      expect(handleTrustedPageLifecycle).toHaveBeenCalledWith(relay);
    } finally {
      window.translateItContentCore = previousCore;
    }
  });

  it('installs one child retirement listener after translation participation becomes available', async () => {
    const previousTop = window.top;
    const addEventListener = vi.spyOn(window, 'addEventListener');
    Object.defineProperty(window, 'top', { configurable: true, value: {} });

    try {
      handler.setPageTranslationManager({
        isActive: true,
        acceptedLifecycleSessionId: 'session-a',
        translatePage: vi.fn().mockResolvedValue({ success: true }),
      });

      expect(addEventListener.mock.calls.filter(([event]) => event === 'beforeunload')).toHaveLength(0);

      await handler.handlePageTranslate({ data: {} });
      await handler.handlePageTranslate({ data: {} });

      expect(addEventListener.mock.calls.filter(([event]) => event === 'beforeunload')).toHaveLength(1);
    } finally {
      addEventListener.mockRestore();
      Object.defineProperty(window, 'top', { configurable: true, value: previousTop });
    }
  });

  it('sends child retirement through runtime messaging without payload identity', async () => {
    const previousTop = window.top;
    Object.defineProperty(window, 'top', { configurable: true, value: {} });

    try {
      handler.setPageTranslationManager({
        isActive: true,
        acceptedLifecycleSessionId: 'session-a',
        translatePage: vi.fn().mockResolvedValue({ success: true }),
      });
      await handler.handlePageTranslate({ data: {} });
      browser.runtime.sendMessage.mockClear();

      window.dispatchEvent(new Event('beforeunload'));

      expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(1);
      expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
        action: MessageActions.PAGE_TRANSLATION_FRAME_LIFECYCLE,
        data: {
          action: MessageActions.PAGE_TRANSLATION_FRAME_RETIRED,
          data: { sessionId: 'session-a' },
        },
        context: 'page-translation-frame-retirement',
      });
    } finally {
      Object.defineProperty(window, 'top', { configurable: true, value: previousTop });
    }
  });

  it('does not send child retirement without an accepted session', async () => {
    const previousTop = window.top;
    Object.defineProperty(window, 'top', { configurable: true, value: {} });

    try {
      handler.setPageTranslationManager({
        isActive: true,
        acceptedLifecycleSessionId: null,
        translatePage: vi.fn().mockResolvedValue({ success: true }),
      });
      await handler.handlePageTranslate({ data: {} });
      browser.runtime.sendMessage.mockClear();

      window.dispatchEvent(new Event('beforeunload'));

      expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'top', { configurable: true, value: previousTop });
    }
  });

  it('reads latest accepted session when child unloads', async () => {
    const previousTop = window.top;
    Object.defineProperty(window, 'top', { configurable: true, value: {} });

    try {
      const pageTranslationManager = {
        isActive: true,
        acceptedLifecycleSessionId: 'session-a',
        translatePage: vi.fn().mockResolvedValue({ success: true }),
      };
      handler.setPageTranslationManager(pageTranslationManager);
      await handler.handlePageTranslate({ data: {} });
      pageTranslationManager.acceptedLifecycleSessionId = 'session-b';
      browser.runtime.sendMessage.mockClear();

      window.dispatchEvent(new Event('beforeunload'));

      expect(browser.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        data: {
          action: MessageActions.PAGE_TRANSLATION_FRAME_RETIRED,
          data: { sessionId: 'session-b' },
        },
      }));
    } finally {
      Object.defineProperty(window, 'top', { configurable: true, value: previousTop });
    }
  });

  it('does not install or send child retirement from the top frame', async () => {
    const addEventListener = vi.spyOn(window, 'addEventListener');
    handler.setPageTranslationManager({
      isActive: true,
      translatePage: vi.fn().mockResolvedValue({ success: true }),
    });

    await handler.handlePageTranslate({ data: {} });
    window.dispatchEvent(new Event('beforeunload'));

    expect(addEventListener.mock.calls.filter(([event]) => event === 'beforeunload')).toHaveLength(0);
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    addEventListener.mockRestore();
  });

  it('removes child retirement listener on cleanup and reinstalls one after reinjection', async () => {
    const previousTop = window.top;
    const addEventListener = vi.spyOn(window, 'addEventListener');
    Object.defineProperty(window, 'top', { configurable: true, value: {} });

    try {
      handler.setPageTranslationManager({
        isActive: true,
        acceptedLifecycleSessionId: 'session-a',
        translatePage: vi.fn().mockResolvedValue({ success: true }),
      });
      await handler.handlePageTranslate({ data: {} });
      await handler.cleanup();
      browser.runtime.sendMessage.mockClear();
      window.dispatchEvent(new Event('beforeunload'));
      expect(browser.runtime.sendMessage).not.toHaveBeenCalled();

      ContentMessageHandler.resetInstance();
      handler = new ContentMessageHandler();
      handler.setPageTranslationManager({
        isActive: true,
        acceptedLifecycleSessionId: 'session-b',
        translatePage: vi.fn().mockResolvedValue({ success: true }),
      });
      await handler.handlePageTranslate({ data: {} });
      browser.runtime.sendMessage.mockClear();
      window.dispatchEvent(new Event('beforeunload'));

      expect(addEventListener.mock.calls.filter(([event]) => event === 'beforeunload')).toHaveLength(2);
      expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      addEventListener.mockRestore();
      Object.defineProperty(window, 'top', { configurable: true, value: previousTop });
    }
  });

  it('rejects lifecycle relay outside the top frame', async () => {
    const previousTop = window.top;
    const previousCore = window.translateItContentCore;
    const handleTrustedPageLifecycle = vi.fn();
    window.translateItContentCore = { mainFrameCoordinator: { handleTrustedPageLifecycle } };

    try {
      Object.defineProperty(window, 'top', { configurable: true, value: {} });

      await expect(handler.handlePageTranslationLifecycle(
        { data: {} },
        {}
      )).resolves.toEqual({ success: false, error: 'Page lifecycle relay requires top frame' });
      expect(handleTrustedPageLifecycle).not.toHaveBeenCalled();
    } finally {
      window.translateItContentCore = previousCore;
      Object.defineProperty(window, 'top', { configurable: true, value: previousTop });
    }
  });

  it('preserves canonical details for thrown Page Translation failures', async () => {
    const originalError = Object.assign(new Error('raw provider response'), {
      type: ErrorTypes.NETWORK_ERROR,
      originalType: ErrorTypes.HTTP_ERROR,
      statusCode: 503,
      context: 'page-translation',
      providerName: 'Provider',
      providerId: 'provider-id',
      code: 'UPSTREAM_FAILURE',
      errorCode: 'E_UPSTREAM',
      operationAborted: false,
      cancellationReason: 'user_action',
      translationOutcome: { committedParentCount: 0 },
    });
    handler.setPageTranslationManager({
      isActive: true,
      translatePage: vi.fn().mockRejectedValue(originalError),
    });
    handler.errorHandler = {
      getErrorForUI: vi.fn().mockResolvedValue({
        message: 'Safe provider failure',
        type: ErrorTypes.NETWORK_ERROR,
      }),
      handle: vi.fn().mockResolvedValue(undefined),
    };

    const response = await handler.handlePageTranslate({ data: {} });

    expect(response).toMatchObject({
      success: false,
      error: 'Safe provider failure',
      errorType: ErrorTypes.NETWORK_ERROR,
      errorDetails: {
        message: 'raw provider response',
        type: ErrorTypes.NETWORK_ERROR,
        originalType: ErrorTypes.HTTP_ERROR,
        statusCode: 503,
        context: 'page-translation',
        providerName: 'Provider',
        providerId: 'provider-id',
        code: 'UPSTREAM_FAILURE',
        errorCode: 'E_UPSTREAM',
        operationAborted: false,
        cancellationReason: 'user_action',
        translationOutcome: { committedParentCount: 0 },
      },
    });
    expect(response.errorDetails).not.toHaveProperty('cause');
    expect(handler.errorHandler.handle).toHaveBeenCalledTimes(1);
  });

  it('sanitizes ordinary Field response failures before ErrorHandler', async () => {
    const error = {
      message: 'raw provider API response body',
      type: ErrorTypes.API_ERROR,
      originalType: 'HTTP_ERROR',
      statusCode: 503,
      context: 'field-translation',
      providerName: 'Private Provider',
      providerId: 'provider-id',
      code: 'UPSTREAM_FAILURE',
      errorCode: 'E_UPSTREAM',
      translationOutcome: { partial: true },
      responseBody: 'private response body',
      arbitrary: { ignored: true }
    };
    handler.errorHandler = {
      getErrorForUI: vi.fn(),
      handle: vi.fn().mockResolvedValue(undefined)
    };

    const thrown = await handler.handleTranslationResult({
      data: {
        translationMode: TranslationMode.Field,
        success: false,
        error
      }
    }).catch((value) => value);

    const handledError = handler.errorHandler.handle.mock.calls[0][0];
    expect(handler.errorHandler.handle).toHaveBeenCalledTimes(1);
    expect(handler.errorHandler.getErrorForUI).not.toHaveBeenCalled();
    expect(handledError).toBe(thrown);
    expect(handledError).not.toBe(error);
    expect(handledError.message).not.toContain('raw provider API response body');
    expect(handledError.message).not.toContain('Private Provider');
    expect(handledError).not.toHaveProperty('statusCode');
    expect(handledError).not.toHaveProperty('originalType');
    expect(handledError).not.toHaveProperty('providerName');
    expect(handledError).not.toHaveProperty('providerId');
    expect(handledError).not.toHaveProperty('code');
    expect(handledError).not.toHaveProperty('errorCode');
    expect(handledError).not.toHaveProperty('translationOutcome');
    expect(handledError).not.toHaveProperty('responseBody');
    expect(handledError).not.toHaveProperty('arbitrary');
    expect(handledError.alreadyHandled).toBe(true);
    expect(handledError.cause).toBeInstanceOf(Error);
    expect(Object.prototype.propertyIsEnumerable.call(handledError, 'cause')).toBe(false);
    expect(handler.errorHandler.handle).toHaveBeenCalledWith(handledError, {
      context: 'text-field-translation',
      type: ErrorTypes.API_ERROR,
      showToast: true,
    });
  });

  it('prefers canonical errorDetails over conflicting legacy error', async () => {
    handler.errorHandler = {
      getErrorForUI: vi.fn(),
      handle: vi.fn().mockResolvedValue(undefined),
    };

    const thrown = await handler.handleTranslationResult({
      data: {
        translationMode: TranslationMode.Field,
        success: false,
        error: { message: 'legacy failure', type: 'LEGACY_ERROR' },
        errorDetails: {
          message: 'canonical failure',
          type: ErrorTypes.MODEL_MISSING,
          statusCode: 404,
          providerName: 'Provider',
          code: 'MODEL_NOT_FOUND',
          errorCode: 'E_MODEL',
        },
      },
    }).catch((value) => value);

    expect(handler.errorHandler.handle).toHaveBeenCalledTimes(1);
    expect(handler.errorHandler.handle.mock.calls[0][1]).toMatchObject({
      type: ErrorTypes.MODEL_MISSING,
      context: 'text-field-translation',
    });
    expect(thrown.message).not.toContain('legacy failure');
    expect(applyTranslationToTextField).not.toHaveBeenCalled();
  });

  it('handles errorDetails-only Field failures without applying text', async () => {
    handler.errorHandler = {
      getErrorForUI: vi.fn(),
      handle: vi.fn().mockResolvedValue(undefined),
    };

    const thrown = await handler.handleTranslationResult({
      data: {
        translationMode: TranslationMode.Field,
        success: false,
        errorDetails: {
          message: 'canonical failure',
          type: ErrorTypes.API_KEY_INVALID,
        },
      },
    }).catch((value) => value);

    expect(handler.errorHandler.handle).toHaveBeenCalledTimes(1);
    expect(handler.errorHandler.handle.mock.calls[0][1]).toMatchObject({
      type: ErrorTypes.API_KEY_INVALID,
      context: 'text-field-translation',
    });
    expect(thrown).toBeInstanceOf(Error);
    expect(applyTranslationToTextField).not.toHaveBeenCalled();
  });

  it('falls back to legacy error when errorDetails is malformed', async () => {
    handler.errorHandler = {
      getErrorForUI: vi.fn(),
      handle: vi.fn().mockResolvedValue(undefined),
    };

    const thrown = await handler.handleTranslationResult({
      data: {
        translationMode: TranslationMode.Field,
        success: false,
        error: { message: 'legacy failure', type: ErrorTypes.NETWORK_ERROR },
        errorDetails: { arbitrary: true },
      },
    }).catch((value) => value);

    expect(handler.errorHandler.handle).toHaveBeenCalledTimes(1);
    expect(handler.errorHandler.handle.mock.calls[0][1]).toMatchObject({
      type: ErrorTypes.NETWORK_ERROR,
      context: 'text-field-translation',
    });
    expect(thrown.message).not.toContain('legacy failure');
    expect(applyTranslationToTextField).not.toHaveBeenCalled();
  });

  it.each([
    ErrorTypes.HTTP_ERROR,
    ErrorTypes.NETWORK_ERROR,
    ErrorTypes.SERVER_ERROR,
    ErrorTypes.TRANSLATION_TIMEOUT,
    ErrorTypes.API_RESPONSE_INVALID,
    ErrorTypes.JSON_PARSING_ERROR,
  ])('uses adapted safe Error for %s without duplicate presentation', async (type) => {
    const error = Object.assign(new Error(`raw ${type} parser/provider detail`), {
      type,
      statusCode: 502,
    });
    handler.errorHandler = {
      getErrorForUI: vi.fn(),
      handle: vi.fn().mockResolvedValue(undefined),
    };

    const thrown = await handler.handleTranslationResult({
      data: {
        translationMode: TranslationMode.Field,
        success: false,
        error,
      },
    }).catch((value) => value);

    expect(handler.errorHandler.handle).toHaveBeenCalledTimes(1);
    expect(handler.errorHandler.getErrorForUI).not.toHaveBeenCalled();
    expect(thrown).toBe(handler.errorHandler.handle.mock.calls[0][0]);
    expect(thrown.message).not.toContain(`raw ${type}`);
    expect(thrown.alreadyHandled).toBe(true);
    expect(handler.errorHandler.handle.mock.calls[0][1]).toMatchObject({
      context: 'text-field-translation',
      type,
      showToast: true,
    });
  });

  it('uses safe fallback for generic Field response failures', async () => {
    const error = { message: 'raw untyped provider detail' };
    handler.errorHandler = {
      getErrorForUI: vi.fn(),
      handle: vi.fn().mockResolvedValue(undefined),
    };

    const thrown = await handler.handleTranslationResult({
      data: {
        translationMode: TranslationMode.Field,
        success: false,
        error,
      },
    }).catch((value) => value);

    expect(handler.errorHandler.handle).toHaveBeenCalledTimes(1);
    expect(thrown.message).not.toContain('raw untyped provider detail');
    expect(handler.errorHandler.handle.mock.calls[0][0].type).toBe(ErrorTypes.TRANSLATION_FAILED);
    expect(handler.errorHandler.handle.mock.calls[0][1].type).toBe(ErrorTypes.UNKNOWN);
  });

  it.each([
    { type: ErrorTypes.USER_CANCELLED, message: 'cancelled' },
    { type: ErrorTypes.TRANSLATION_CANCELLED, message: 'cancelled' },
    { type: ErrorTypes.EXTENSION_CONTEXT_INVALIDATED, message: 'context invalidated' },
  ])('keeps $type response failure silent', async (error) => {
    handler.errorHandler = {
      getErrorForUI: vi.fn(),
      handle: vi.fn().mockResolvedValue(undefined),
    };

    const thrown = await handler.handleTranslationResult({
      data: {
        translationMode: TranslationMode.Field,
        success: false,
        error,
      },
    }).catch((value) => value);

    expect(handler.errorHandler.handle).not.toHaveBeenCalled();
    expect(handler.errorHandler.getErrorForUI).not.toHaveBeenCalled();
    expect(thrown.alreadyHandled).toBe(true);
    expect(thrown.type).toBe(error.type);
  });

  it('keeps Field application failure handling unchanged', async () => {
    const applicationError = new Error('DOM mutation failed');
    handler.errorHandler = {
      getErrorForUI: vi.fn().mockResolvedValue({ type: ErrorTypes.UI, message: 'safe application error' }),
      handle: vi.fn().mockResolvedValue(undefined),
    };
    const { applyTranslationToTextField } = await import('../smartTranslationIntegration.js');
    applyTranslationToTextField.mockRejectedValue(applicationError);

    await expect(handler.handleTranslationResult({
      data: {
        translationMode: TranslationMode.Field,
        success: true,
        translatedText: 'translated',
        originalText: 'original',
      },
    })).rejects.toBe(applicationError);

    expect(handler.errorHandler.getErrorForUI).toHaveBeenCalledWith(applicationError, 'text-field-application');
    expect(handler.errorHandler.handle).toHaveBeenCalledWith(applicationError, expect.objectContaining({
      context: 'text-field-application',
      showToast: true,
    }));
  });
});
