import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveDubbingCoordinator } from './LiveDubbingCoordinator.js';
import { LiveDubbingController } from '../offscreen/LiveDubbingController.js';
import { storageManager } from '@/shared/storage/core/StorageCore.js';
import {
  LIVE_DUBBING_ACTIONS,
  LIVE_DUBBING_OPENAI_PROVIDER_ID,
  LIVE_DUBBING_OWNER,
  LIVE_DUBBING_PROVIDER_ID,
  LIVE_DUBBING_PROVIDER_IDS,
  LIVE_DUBBING_STORAGE_KEY,
  LIVE_DUBBING_OUTCOME_STORAGE_KEY,
  LIVE_DUBBING_OUTCOME_STORAGE_STATE,
  LIVE_DUBBING_STORAGE_STATE,
  LIVE_DUBBING_INTERNAL_STATUS,
  LIVE_DUBBING_STATUS,
  LIVE_DUBBING_START_TIMEOUT,
  LIVE_DUBBING_STOP_TIMEOUT,
} from '../constants.js';

function createHarness({ stored = null, outcome = null, streamId = 'stream-secret', statusResponse, documentExists, runtimeGateway = null, hasConfiguredCredentials = vi.fn(async () => true), supportsOffscreenDocument, volumePreferencesReader = null } = {}) {
  const storage = new Map(stored
    ? [[LIVE_DUBBING_STORAGE_KEY, { providerId: 'gemini', ...stored }]]
    : []);
  if (outcome) storage.set(LIVE_DUBBING_OUTCOME_STORAGE_KEY, outcome);
  const calls = [];
  const logger = { warn: vi.fn() };
  const manager = {
    documentExists,
    activeLeases: [],
    acquire: vi.fn(async lease => {
      calls.push(['acquire', lease]);
      manager.activeLeases = [lease];
      return true;
    }),
    release: vi.fn(async lease => {
      calls.push(['release', lease]);
      manager.activeLeases = manager.activeLeases.filter(item => item.leaseId !== lease.leaseId);
      return true;
    }),
    ensureDocument: vi.fn(),
    getSnapshot: vi.fn(() => ({ documentExists: manager.documentExists, activeLeases: manager.activeLeases })),
  };
  if (supportsOffscreenDocument !== undefined) manager.supportsOffscreenDocument = supportsOffscreenDocument;
  const sendMessage = vi.fn(async message => {
    calls.push(['message', message]);
    if (message.action === 'LIVE_DUBBING_PREPARE') {
      return {
        success: true,
        ack: 'READY',
        sessionId: message.data.sessionId,
        providerId: message.data.providerId,
        eventSequence: message.data.eventSequence,
      };
    }
    if (message.action === 'LIVE_DUBBING_CONSUME') {
      return {
        success: true,
        ack: 'MEDIA_ACQUIRED',
        sessionId: message.data.sessionId,
        providerId: message.data.providerId,
        status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
        eventSequence: message.data.eventSequence,
        captureReady: true,
        audioPathReady: true,
        inputPipelineReady: true,
       outputPipelineReady: true,
      };
    }
    if (message.action === 'LIVE_DUBBING_CONNECT_PROVIDER') {
      return {
        success: true,
        ack: 'PROVIDER_READY',
        sessionId: message.data.sessionId,
        providerId: message.data.providerId,
        status: LIVE_DUBBING_STATUS.RUNNING,
        eventSequence: message.data.eventSequence + 1,
        captureReady: true,
        audioPathReady: true,
        inputPipelineReady: true,
       outputPipelineReady: true,
        setupComplete: true,
      };
    }
    if (message.action === 'LIVE_DUBBING_DISPOSE') {
      return {
        success: true,
        ack: 'DISPOSED',
        sessionId: message.data.sessionId,
        providerId: message.data.providerId,
      };
    }
    if (message.action === 'LIVE_DUBBING_STATUS') {
      return statusResponse
        ? { providerId: message.data.providerId, ...statusResponse }
        : { success: true, active: false, sessionId: message.data.sessionId, providerId: message.data.providerId };
    }
    return { success: true };
  });
  const browserAPI = {
    runtime: {
      id: 'extension-id',
      getURL: (path = '') => `chrome-extension://extension-id/${path}`,
      sendMessage,
    },
    storage: {
      session: {
        get: vi.fn(async key => Array.isArray(key)
          ? Object.fromEntries(key.map(item => [item, storage.get(item)]))
          : { [key]: storage.get(key) }),
        set: vi.fn(async record => Object.entries(record).forEach(([key, value]) => storage.set(key, value))),
        remove: vi.fn(async key => storage.delete(key)),
      },
    },
    tabs: {
      query: vi.fn(async () => [{ id: 42, url: 'https://example.test' }]),
      get: vi.fn(async id => ({ id, url: 'https://example.test' })),
    },
  };
  const chromeAPI = {
    tabCapture: {
      getMediaStreamId: vi.fn(async () => streamId),
      getCapturedTabs: vi.fn(async () => []),
    },
  };

  return {
    calls,
    storage,
    manager,
    browserAPI,
    chromeAPI,
    coordinator: new LiveDubbingCoordinator({
      browserAPI,
      chromeAPI,
      runtimeGateway,
      leaseManager: manager,
      uuid: () => 'session-1',
      now: () => 123,
      logger,
      hasConfiguredCredentials,
      ...(volumePreferencesReader ? { volumePreferencesReader } : {}),
    }),
    logger,
    hasConfiguredCredentials,
  };
}

function createVolumeHarness(status = LIVE_DUBBING_STATUS.RUNNING, overrides = {}, harnessOptions = {}) {
  return createHarness({
    stored: {
      sessionId: 'session-1',
      tabId: 42,
      targetLanguage: 'en',
      status,
      startedAt: 123,
      lastError: null,
      eventSequence: 4,
      ...overrides,
    },
    ...harnessOptions,
  });
}

function reserveVolumeBridge(harness, descriptorOverrides = {}) {
  const descriptor = {
    ...harness.storage.get(LIVE_DUBBING_STORAGE_KEY),
    ...descriptorOverrides,
  };
  const state = {
    descriptor,
    leasePromise: null,
    leaseAcquired: true,
    prepared: true,
    terminalRequested: false,
    cleanupCompleted: false,
    providerDiagnostic: null,
  };
  harness.coordinator.sessionRegistry.setSessionState(descriptor.sessionId, state);
  expect(harness.coordinator._reserveVolumeEventSequence(
    descriptor,
    descriptor.eventSequence + 1,
  )).toBe(true);
  return { descriptor, state };
}

describe('LiveDubbingCoordinator', () => {
  beforeEach(() => vi.restoreAllMocks());

  it.each([
    LIVE_DUBBING_STATUS.PREPARING_CAPTURE,
    LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
    LIVE_DUBBING_STATUS.RUNNING,
  ])('sets original volume during %s without changing lifecycle state', async status => {
    const harness = createVolumeHarness(status);
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => ({
      success: true,
      sessionId: message.data.sessionId,
      providerId: message.data.providerId,
      eventSequence: message.data.eventSequence,
      status,
      originalVolume: message.data.volume,
    }));

    const result = await harness.coordinator.setOriginalVolume({
      action: LIVE_DUBBING_ACTIONS.SET_ORIGINAL_VOLUME,
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence: 4,
        volume: 0,
      },
    });

    expect(result).toEqual({
      success: true,
      sessionId: 'session-1',
      providerId: 'gemini',
      eventSequence: 4,
      status,
      originalVolume: 0,
    });
    expect(harness.browserAPI.runtime.sendMessage).toHaveBeenCalledWith({
      target: 'offscreen',
      action: LIVE_DUBBING_ACTIONS.SET_ORIGINAL_VOLUME_OFFSCREEN,
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence: 4,
        volume: 0,
      },
    });
    expect(harness.browserAPI.storage.session.set).not.toHaveBeenCalled();
    expect(harness.browserAPI.storage.session.remove).not.toHaveBeenCalled();
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({ status, eventSequence: 4 });
  });

  it.each([
    ['original set', 'setOriginalVolume', { volume: 0.4 }, 'originalVolume'],
    ['dubbed set', 'setDubbedVolume', { volume: 0.6 }, 'dubbedVolume'],
    ['original get', 'getOriginalVolume', {}, 'originalVolume'],
    ['dubbed get', 'getDubbedVolume', {}, 'dubbedVolume'],
  ])('forwards %s on the exact reserved provider-ready sequence', async (
    _label,
    method,
    payload,
    resultField,
  ) => {
    const harness = createVolumeHarness(LIVE_DUBBING_STATUS.CONNECTING_PROVIDER, {
      eventSequence: 2,
    });
    reserveVolumeBridge(harness);
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => ({
      success: true,
      sessionId: message.data.sessionId,
      providerId: message.data.providerId,
      eventSequence: message.data.eventSequence,
      status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
      [resultField]: method.includes('set') ? payload.volume : 0.5,
    }));

    const result = await harness.coordinator[method]({
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence: 2,
        ...payload,
      },
    });

    expect(result, JSON.stringify(result)).toMatchObject({
      success: true,
      eventSequence: 2,
      status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
      [resultField]: method.includes('set') ? payload.volume : 0.5,
    });
    expect(harness.browserAPI.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventSequence: 3 }),
    }));
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
      status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
      eventSequence: 2,
    });
  });

  it.each([
    ['setOriginalVolume', { volume: 0.4 }],
    ['setDubbedVolume', { volume: 0.6 }],
    ['getOriginalVolume', {}],
    ['getDubbedVolume', {}],
  ])('rejects future and unrelated public volume fences for %s', async (method, payload) => {
    const harness = createVolumeHarness(LIVE_DUBBING_STATUS.CONNECTING_PROVIDER, {
      eventSequence: 2,
    });
    reserveVolumeBridge(harness);
    const request = eventSequence => harness.coordinator[method]({
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence,
        ...payload,
      },
    });

    for (const eventSequence of [3, 4]) {
      await expect(request(eventSequence)).resolves.toMatchObject({
        success: false,
        error: 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH',
      });
    }
    await expect(harness.coordinator[method]({
      data: { sessionId: 'session-1', providerId: 'openai', eventSequence: 3, ...payload },
    })).resolves.toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_SESSION_MISMATCH',
    });
    expect(harness.browserAPI.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('does not allow an old provider-ready reservation through a replacement session', async () => {
    const harness = createVolumeHarness(LIVE_DUBBING_STATUS.CONNECTING_PROVIDER, {
      eventSequence: 2,
    });
    reserveVolumeBridge(harness);
    harness.storage.set(LIVE_DUBBING_STORAGE_KEY, {
      ...harness.storage.get(LIVE_DUBBING_STORAGE_KEY),
      sessionId: 'session-2',
      eventSequence: 2,
    });
    harness.coordinator.sessionRegistry.setSessionState('session-2', {
      descriptor: { ...harness.storage.get(LIVE_DUBBING_STORAGE_KEY) },
      terminalRequested: false,
    });

    await expect(harness.coordinator.getOriginalVolume({
      data: { sessionId: 'session-2', providerId: 'gemini', eventSequence: 3 },
    })).resolves.toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH',
    });
    await expect(harness.coordinator.getOriginalVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 3 },
    })).resolves.toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_SESSION_MISMATCH',
    });
  });

  it('bridges volume controls until the RUNNING descriptor write settles, then clears the reservation', async () => {
    const harness = createHarness({ supportsOffscreenDocument: vi.fn(() => true) });
    let releaseRunningWrite;
    let signalRunningWrite;
    const runningWriteStarted = new Promise(resolve => { signalRunningWrite = resolve; });
    const runningWrite = new Promise(resolve => { releaseRunningWrite = resolve; });
    harness.browserAPI.storage.session.set.mockImplementation(async record => {
      const nextDescriptor = record[LIVE_DUBBING_STORAGE_KEY];
      if (nextDescriptor?.status === LIVE_DUBBING_STATUS.RUNNING) {
        signalRunningWrite();
        await runningWrite;
      }
      Object.entries(record).forEach(([key, value]) => harness.storage.set(key, value));
    });

    const sendMessage = harness.browserAPI.runtime.sendMessage;
    const defaultSendMessage = sendMessage.getMockImplementation();
    sendMessage.mockImplementation(async message => {
      if (message.action === LIVE_DUBBING_ACTIONS.SET_ORIGINAL_VOLUME_OFFSCREEN) {
        return {
          success: true,
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          eventSequence: message.data.eventSequence,
          status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
          originalVolume: message.data.volume,
        };
      }
      return defaultSendMessage(message);
    });

    const startPromise = harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    await runningWriteStarted;
    const state = harness.coordinator.sessionRegistry.getSessionState('session-1');
    expect(state.volumeEventSequenceReservation).toEqual({
      sessionId: 'session-1',
      providerId: 'gemini',
      eventSequence: 3,
    });
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
      status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
      eventSequence: 2,
    });

    await expect(harness.coordinator.setOriginalVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 2, volume: 0.4 },
    })).resolves.toMatchObject({
      success: true,
      eventSequence: 2,
      status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
      originalVolume: 0.4,
    });
    await expect(harness.coordinator.setOriginalVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 3, volume: 0.4 },
    })).resolves.toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH',
    });

    releaseRunningWrite();
    await expect(startPromise).resolves.toMatchObject({
      success: true,
      status: { status: LIVE_DUBBING_STATUS.RUNNING, eventSequence: 3 },
    });
    expect(state.volumeEventSequenceReservation).toBeNull();
    await expect(harness.coordinator.setOriginalVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 3, volume: 0.5 },
    })).resolves.toMatchObject({
      success: true,
      eventSequence: 3,
      status: LIVE_DUBBING_STATUS.RUNNING,
      originalVolume: 0.5,
    });
  });

  it.each([
    ['original GET', 'getOriginalVolume', {}, 'originalVolume'],
    ['original SET', 'setOriginalVolume', { volume: 0.4 }, 'originalVolume'],
    ['dubbed GET', 'getDubbedVolume', {}, 'dubbedVolume'],
    ['dubbed SET', 'setDubbedVolume', { volume: 0.6 }, 'dubbedVolume'],
  ])('reconciles one pre-reservation %s response and replays exactly once', async (
    _label,
    method,
    payload,
    resultField,
  ) => {
    const harness = createHarness({ supportsOffscreenDocument: vi.fn(() => true) });
    const volumeActions = new Set([
      LIVE_DUBBING_ACTIONS.GET_ORIGINAL_VOLUME_OFFSCREEN,
      LIVE_DUBBING_ACTIONS.SET_ORIGINAL_VOLUME_OFFSCREEN,
      LIVE_DUBBING_ACTIONS.GET_DUBBED_VOLUME_OFFSCREEN,
      LIVE_DUBBING_ACTIONS.SET_DUBBED_VOLUME_OFFSCREEN,
    ]);
    let resolveProviderResponse;
    let signalConnectRequested;
    const providerResponsePending = new Promise(resolve => { resolveProviderResponse = resolve; });
    const connectRequested = new Promise(resolve => { signalConnectRequested = resolve; });
    let resolveRunningWrite;
    let signalRunningWrite;
    const runningWrite = new Promise(resolve => { resolveRunningWrite = resolve; });
    const runningWriteStarted = new Promise(resolve => { signalRunningWrite = resolve; });
    const volumeMessages = [];
    let firstVolumeResponse = true;
    const storageSet = harness.browserAPI.storage.session.set;
    const defaultStorageSet = storageSet.getMockImplementation();
    storageSet.mockImplementation(async record => {
      if (record[LIVE_DUBBING_STORAGE_KEY]?.status === LIVE_DUBBING_STATUS.RUNNING) {
        signalRunningWrite();
        await runningWrite;
      }
      return defaultStorageSet(record);
    });

    const sendMessage = harness.browserAPI.runtime.sendMessage;
    const defaultSendMessage = sendMessage.getMockImplementation();
    sendMessage.mockImplementation(async message => {
      if (message.action === LIVE_DUBBING_ACTIONS.CONNECT_PROVIDER) {
        signalConnectRequested();
        return providerResponsePending;
      }
      if (volumeActions.has(message.action)) {
        volumeMessages.push(message);
        if (firstVolumeResponse) {
          firstVolumeResponse = false;
          return {
            success: false,
            error: 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH',
            ignored: true,
            sessionId: message.data.sessionId,
            providerId: message.data.providerId,
            status: LIVE_DUBBING_STATUS.RUNNING,
            eventSequence: 3,
          };
        }
        return {
          success: true,
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          status: LIVE_DUBBING_STATUS.RUNNING,
          eventSequence: message.data.eventSequence,
          [resultField]: method.startsWith('set') ? message.data.volume : 0.5,
        };
      }
      return defaultSendMessage(message);
    });

    const startPromise = harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    await connectRequested;
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
      status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
      eventSequence: 2,
    });

    const result = await harness.coordinator[method]({
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence: 2,
        ...payload,
      },
    });
    expect(result).toMatchObject({
      success: true,
      sessionId: 'session-1',
      providerId: 'gemini',
      eventSequence: 2,
      status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
      [resultField]: method.startsWith('set') ? payload.volume : 0.5,
    });
    expect(volumeMessages).toHaveLength(2);
    expect(volumeMessages.map(message => message.data.eventSequence)).toEqual([2, 3]);
    if (method.startsWith('set')) {
      expect(volumeMessages[1].data.volume).toBe(payload.volume);
    }
    await expect(harness.coordinator[method]({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 3, ...payload },
    })).resolves.toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH',
    });
    expect(volumeMessages).toHaveLength(2);

    resolveProviderResponse({
      success: true,
      ack: 'PROVIDER_READY',
      sessionId: 'session-1',
      providerId: 'gemini',
      status: LIVE_DUBBING_STATUS.RUNNING,
      eventSequence: 3,
      captureReady: true,
      audioPathReady: true,
      setupComplete: true,
    });
    await runningWriteStarted;
    expect(harness.coordinator.sessionRegistry.getSessionState('session-1')
      .volumeEventSequenceReservation).toMatchObject({ eventSequence: 3 });
    resolveRunningWrite();
    await expect(startPromise).resolves.toMatchObject({
      success: true,
      status: { status: LIVE_DUBBING_STATUS.RUNNING, eventSequence: 3 },
    });
    expect(harness.coordinator.sessionRegistry.getSessionState('session-1')
      .volumeEventSequenceReservation).toBeNull();

    await expect(harness.coordinator[method]({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 3, ...payload },
    })).resolves.toMatchObject({
      success: true,
      eventSequence: 3,
      status: LIVE_DUBBING_STATUS.RUNNING,
    });
    expect(volumeMessages).toHaveLength(3);
  });

  it.each([
    ['original', 'setOriginalVolume', 'originalVolume', 'LIVE_DUBBING_ORIGINAL_VOLUME'],
    ['dubbed', 'setDubbedVolume', 'dubbedVolume', 'LIVE_DUBBING_DUBBED_VOLUME'],
  ])('does not let a superseded %s SET replay over the latest request', async (
    lane,
    method,
    resultField,
    storageKey,
  ) => {
    const harness = createVolumeHarness(LIVE_DUBBING_STATUS.CONNECTING_PROVIDER, {
      eventSequence: 2,
    });
    const { state } = reserveVolumeBridge(harness);
    state.volumeEventSequenceReservation = null;
    const persisted = vi.spyOn(storageManager, 'set').mockResolvedValue({});
    let releaseA;
    let signalA;
    const responseA = new Promise(resolve => { releaseA = resolve; });
    const firstA = new Promise(resolve => { signalA = resolve; });
    const messages = [];
    const candidate = message => ({
      success: false,
      error: 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH',
      ignored: true,
      sessionId: message.data.sessionId,
      providerId: message.data.providerId,
      status: LIVE_DUBBING_STATUS.RUNNING,
      eventSequence: 3,
    });
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      messages.push(message);
      if (messages.length === 1) {
        signalA();
        return responseA;
      }
      if (messages.length === 2) return candidate(message);
      return {
        success: true,
        sessionId: message.data.sessionId,
        providerId: message.data.providerId,
        status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
        eventSequence: message.data.eventSequence,
        [resultField]: message.data.volume,
      };
    });

    const aPromise = harness.coordinator[method]({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 2, volume: 0.2 },
    });
    await firstA;
    const bResult = await harness.coordinator[method]({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 2, volume: 0.8 },
    });
    expect(bResult).toMatchObject({
      success: true,
      eventSequence: 2,
      status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
      [resultField]: 0.8,
    });
    releaseA(candidate(messages[0]));
    await expect(aPromise).resolves.toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH',
    });

    expect(messages.map(message => [message.data.eventSequence, message.data.volume]))
      .toEqual([[2, 0.2], [2, 0.8], [3, 0.8]]);
    await harness.coordinator[lane === 'original'
      ? '_volumePreferenceWrites'
      : '_dubbedVolumePreferenceWrites']?.inflight;
    expect(persisted.mock.calls.map(([payload]) => payload[storageKey]))
      .toEqual([0.8]);
  });

  it('keeps original and dubbed SET request tokens independent', async () => {
    const harness = createVolumeHarness(LIVE_DUBBING_STATUS.CONNECTING_PROVIDER, {
      eventSequence: 2,
    });
    const { state } = reserveVolumeBridge(harness);
    state.volumeEventSequenceReservation = null;
    let releaseOriginal;
    let signalOriginal;
    const originalResponse = new Promise(resolve => { releaseOriginal = resolve; });
    const originalStarted = new Promise(resolve => { signalOriginal = resolve; });
    const messages = [];
    const mismatch = message => ({
      success: false,
      error: 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH',
      ignored: true,
      sessionId: message.data.sessionId,
      providerId: message.data.providerId,
      status: LIVE_DUBBING_STATUS.RUNNING,
      eventSequence: 3,
    });
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      messages.push(message);
      if (messages.length === 1) {
        signalOriginal();
        return originalResponse;
      }
      if (messages.length === 2) return mismatch(message);
      if (messages.length === 3) {
        return {
          success: true,
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
          eventSequence: 3,
          dubbedVolume: 0.8,
        };
      }
      return {
        success: true,
        sessionId: message.data.sessionId,
        providerId: message.data.providerId,
        status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
        eventSequence: 3,
        originalVolume: 0.2,
      };
    });

    const originalPromise = harness.coordinator.setOriginalVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 2, volume: 0.2 },
    });
    await originalStarted;
    await expect(harness.coordinator.setDubbedVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 2, volume: 0.8 },
    })).resolves.toMatchObject({ success: true, dubbedVolume: 0.8 });
    releaseOriginal(mismatch(messages[0]));
    await expect(originalPromise).resolves.toMatchObject({ success: true, originalVolume: 0.2 });

    expect(messages.map(message => [message.action, message.data.eventSequence, message.data.volume]))
      .toEqual([
        [LIVE_DUBBING_ACTIONS.SET_ORIGINAL_VOLUME_OFFSCREEN, 2, 0.2],
        [LIVE_DUBBING_ACTIONS.SET_DUBBED_VOLUME_OFFSCREEN, 2, 0.8],
        [LIVE_DUBBING_ACTIONS.SET_DUBBED_VOLUME_OFFSCREEN, 3, 0.8],
        [LIVE_DUBBING_ACTIONS.SET_ORIGINAL_VOLUME_OFFSCREEN, 3, 0.2],
      ]);
    expect(state.volumeSetRequestTokens).toEqual({ original: 1, dubbed: 1 });
  });

  it('does not let an original GET supersede a pending original SET token', async () => {
    const harness = createVolumeHarness(LIVE_DUBBING_STATUS.CONNECTING_PROVIDER, {
      eventSequence: 2,
    });
    const { state } = reserveVolumeBridge(harness);
    state.volumeEventSequenceReservation = null;
    let releaseSet;
    let signalSet;
    const setResponse = new Promise(resolve => { releaseSet = resolve; });
    const setStarted = new Promise(resolve => { signalSet = resolve; });
    const messages = [];
    const mismatch = message => ({
      success: false,
      error: 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH',
      ignored: true,
      sessionId: message.data.sessionId,
      providerId: message.data.providerId,
      status: LIVE_DUBBING_STATUS.RUNNING,
      eventSequence: 3,
    });
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      messages.push(message);
      if (messages.length === 1) {
        signalSet();
        return setResponse;
      }
      if (messages.length === 2) return mismatch(message);
      if (message.action === LIVE_DUBBING_ACTIONS.GET_ORIGINAL_VOLUME_OFFSCREEN) {
        return {
          success: true,
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
          eventSequence: 3,
          originalVolume: 0.5,
        };
      }
      return {
        success: true,
        sessionId: message.data.sessionId,
        providerId: message.data.providerId,
        status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
        eventSequence: 3,
        originalVolume: 0.2,
      };
    });

    const setPromise = harness.coordinator.setOriginalVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 2, volume: 0.2 },
    });
    await setStarted;
    await expect(harness.coordinator.getOriginalVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 2 },
    })).resolves.toMatchObject({ success: true, originalVolume: 0.5 });
    releaseSet(mismatch(messages[0]));
    await expect(setPromise).resolves.toMatchObject({ success: true, originalVolume: 0.2 });

    expect(messages.map(message => [message.action, message.data.eventSequence]))
      .toEqual([
        [LIVE_DUBBING_ACTIONS.SET_ORIGINAL_VOLUME_OFFSCREEN, 2],
        [LIVE_DUBBING_ACTIONS.GET_ORIGINAL_VOLUME_OFFSCREEN, 2],
        [LIVE_DUBBING_ACTIONS.GET_ORIGINAL_VOLUME_OFFSCREEN, 3],
        [LIVE_DUBBING_ACTIONS.SET_ORIGINAL_VOLUME_OFFSCREEN, 3],
      ]);
    expect(state.volumeSetRequestTokens).toEqual({ original: 1 });
  });

  it('does not carry a SET token into replacement session state', () => {
    const harness = createVolumeHarness(LIVE_DUBBING_STATUS.CONNECTING_PROVIDER, {
      eventSequence: 2,
    });
    const { descriptor, state } = reserveVolumeBridge(harness);
    state.volumeEventSequenceReservation = null;
    expect(harness.coordinator._advanceVolumeSetRequestToken(descriptor, 'original')).toBe(1);

    const replacementDescriptor = { ...descriptor, sessionId: 'replacement-session' };
    const replacementState = {
      descriptor: replacementDescriptor,
      terminalRequested: false,
    };
    harness.coordinator.sessionRegistry.setSessionState('replacement-session', replacementState);
    expect(harness.coordinator._isLatestVolumeSetRequestToken(
      replacementState,
      'original',
      1,
    )).toBe(false);
    expect(replacementState.volumeSetRequestTokens).toBeUndefined();
  });

  it.each([
    ['N+2 mismatch', response => ({ ...response, eventSequence: 4 }),
      null, 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH', 1],
    ['wrong session response', response => ({ ...response, sessionId: 'other-session' }),
      null, 'LIVE_DUBBING_SESSION_MISMATCH', 1],
    ['wrong provider response', response => ({ ...response, providerId: 'openai' }),
      null, 'LIVE_DUBBING_SESSION_MISMATCH', 1],
    ['non-RUNNING response', response => ({ ...response, status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER }),
      null, 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH', 1],
    ['non-sequence error', response => ({ ...response, error: 'LIVE_DUBBING_AUDIO_UNAVAILABLE' }),
      null, 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH', 1],
    ['terminal session', response => response,
      state => { state.terminalRequested = true; },
      'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH', 1],
    ['replacement session', response => response,
      state => {
        state.replacedBeforeReconciliation = true;
        state.terminalRequested = true;
      },
      'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH', 1],
    ['second mismatch after replay', response => response,
      null, 'LIVE_DUBBING_ORIGINAL_AUDIO_UNAVAILABLE', 2],
  ])('does not over-replay a %s volume response', async (
    _label,
    responseModifier,
    setup,
    expectedError,
    expectedCalls,
  ) => {
    const harness = createVolumeHarness(LIVE_DUBBING_STATUS.CONNECTING_PROVIDER, {
      eventSequence: 2,
    });
    const { state } = reserveVolumeBridge(harness);
    state.volumeEventSequenceReservation = null;
    setup?.(state, harness);
    const candidate = {
      success: false,
      error: 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH',
      ignored: true,
      sessionId: 'session-1',
      providerId: 'gemini',
      status: LIVE_DUBBING_STATUS.RUNNING,
      eventSequence: 3,
    };
    let calls = 0;
    harness.browserAPI.runtime.sendMessage.mockImplementation(async () => {
      calls += 1;
      if (calls === 1 && state.replacedBeforeReconciliation) {
        harness.storage.set(LIVE_DUBBING_STORAGE_KEY, {
          ...harness.storage.get(LIVE_DUBBING_STORAGE_KEY),
          sessionId: 'replacement-session',
        });
      }
      if (calls === 1) return responseModifier(candidate);
      return responseModifier(candidate);
    });

    const result = await harness.coordinator.setOriginalVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 2, volume: 0.4 },
    });
    expect(result).toMatchObject({ success: false, error: expectedError });
    expect(calls).toBe(expectedCalls);
  });

  it('clears the reservation when startup fails and when terminal/replacement ownership wins', async () => {
    const harness = createHarness({ supportsOffscreenDocument: vi.fn(() => true) });
    const storageSet = harness.browserAPI.storage.session.set;
    const defaultStorageSet = storageSet.getMockImplementation();
    storageSet.mockImplementation(async record => {
      if (record[LIVE_DUBBING_STORAGE_KEY]?.status === LIVE_DUBBING_STATUS.RUNNING) {
        throw new Error('running descriptor write failed');
      }
      return defaultStorageSet(record);
    });

    const failed = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    expect(failed.success).toBe(false);
    const failedState = harness.coordinator.sessionRegistry.getSessionState('session-1');
    expect(failedState?.volumeEventSequenceReservation ?? null).toBeNull();

    const replacementHarness = createVolumeHarness(LIVE_DUBBING_STATUS.CONNECTING_PROVIDER, {
      eventSequence: 2,
    });
    const { state } = reserveVolumeBridge(replacementHarness);
    replacementHarness.coordinator._markTerminalState(state);
    expect(state.volumeEventSequenceReservation).toBeNull();
    state.terminalRequested = false;
    replacementHarness.coordinator.sessionRegistry.setSessionState('session-1', state);
    expect(replacementHarness.coordinator._reserveVolumeEventSequence(
      state.descriptor,
      state.descriptor.eventSequence + 1,
    )).toBe(true);
    replacementHarness.coordinator._forgetSessionState('session-1', state);
    expect(replacementHarness.coordinator.sessionRegistry.getSessionState('session-1')).toBeNull();
  });

  it('accepts volume one and rejects invalid volume before reading a session', async () => {
    const harness = createVolumeHarness();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => ({
      success: true,
      sessionId: message.data.sessionId,
      providerId: message.data.providerId,
      eventSequence: message.data.eventSequence,
      status: LIVE_DUBBING_STATUS.RUNNING,
      originalVolume: 1,
    }));

    await expect(harness.coordinator.setOriginalVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 4, volume: 1 },
    })).resolves.toMatchObject({ success: true, originalVolume: 1 });
    await expect(harness.coordinator.setOriginalVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 4, volume: null },
    })).resolves.toEqual({ success: false, error: 'LIVE_DUBBING_ORIGINAL_VOLUME_INVALID' });
    expect(harness.browserAPI.storage.session.set).not.toHaveBeenCalled();
  });

  it.each([
    ['missing session', null, 'LIVE_DUBBING_SESSION_UNAVAILABLE'],
    ['stopping session', LIVE_DUBBING_STATUS.STOPPING, 'LIVE_DUBBING_SESSION_UNAVAILABLE'],
    ['error session', LIVE_DUBBING_STATUS.ERROR, 'LIVE_DUBBING_SESSION_UNAVAILABLE'],
  ])('rejects %s deterministically', async (_label, status, error) => {
    const harness = status ? createVolumeHarness(status) : createHarness();

    await expect(harness.coordinator.setOriginalVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 4, volume: 0.5 },
    })).resolves.toEqual({ success: false, error });
    expect(harness.browserAPI.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['session', { sessionId: 'other' }, 'LIVE_DUBBING_SESSION_MISMATCH'],
    ['provider', { providerId: 'openai' }, 'LIVE_DUBBING_SESSION_MISMATCH'],
    ['event sequence', { eventSequence: 3 }, 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH'],
  ])('rejects a %s fence mismatch without lifecycle mutation', async (_label, data, error) => {
    const harness = createVolumeHarness();
    const messageData = {
      sessionId: 'session-1',
      providerId: 'gemini',
      eventSequence: 4,
      volume: 0.5,
      ...data,
    };

    await expect(harness.coordinator.setOriginalVolume({ data: messageData }))
      .resolves.toEqual({ success: false, error });
    expect(harness.browserAPI.runtime.sendMessage).not.toHaveBeenCalled();
    expect(harness.browserAPI.storage.session.set).not.toHaveBeenCalled();
  });

  it('normalizes offscreen control failures without terminal mutation', async () => {
    const harness = createVolumeHarness();
    harness.browserAPI.runtime.sendMessage.mockRejectedValue(new Error('offscreen unavailable'));

    await expect(harness.coordinator.setOriginalVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 4, volume: 0.5 },
    })).resolves.toEqual({
      success: false,
      error: 'LIVE_DUBBING_ORIGINAL_AUDIO_UNAVAILABLE',
    });
    expect(harness.browserAPI.storage.session.set).not.toHaveBeenCalled();
    expect(harness.storage.has(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toBe(false);
  });

  it('fences a delayed response from an older session before reporting success', async () => {
    const harness = createVolumeHarness();
    let resolveResponse;
    harness.browserAPI.runtime.sendMessage.mockImplementation(() => new Promise(resolve => {
      resolveResponse = resolve;
    }));

    const pending = harness.coordinator.setOriginalVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 4, volume: 0.5 },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    harness.storage.set(LIVE_DUBBING_STORAGE_KEY, {
      sessionId: 'session-2',
      tabId: 42,
      providerId: 'gemini',
      targetLanguage: 'en',
      status: LIVE_DUBBING_STATUS.RUNNING,
      startedAt: 456,
      lastError: null,
      eventSequence: 0,
    });
    resolveResponse({
      success: true,
      sessionId: 'session-1',
      providerId: 'gemini',
      eventSequence: 4,
      originalVolume: 0.5,
    });

    await expect(pending).resolves.toEqual({
      success: false,
      error: 'LIVE_DUBBING_SESSION_MISMATCH',
    });
  });

  it('keeps rapid volume controls outside the lifecycle transition queue', async () => {
    const harness = createVolumeHarness();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => ({
      success: true,
      sessionId: message.data.sessionId,
      providerId: message.data.providerId,
      eventSequence: message.data.eventSequence,
      originalVolume: message.data.volume,
    }));
    const transition = harness.coordinator.transition;
    const request = data => harness.coordinator.setOriginalVolume({ data: {
      sessionId: 'session-1', providerId: 'gemini', eventSequence: 4, ...data,
    } });

    const [first, second] = await Promise.all([request({ volume: 0 }), request({ volume: 1 })]);
    expect(first).toMatchObject({ success: true, originalVolume: 0 });
    expect(second).toMatchObject({ success: true, originalVolume: 1 });
    expect(harness.coordinator.transition).toBe(transition);
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({ eventSequence: 4 });
    expect(harness.browserAPI.storage.session.set).not.toHaveBeenCalled();
  });

  it('preserves superseded latest-wins volume responses without lifecycle mutation', async () => {
    const harness = createVolumeHarness();
    harness.browserAPI.runtime.sendMessage.mockResolvedValue({
      success: true,
      ignored: true,
      superseded: true,
      sessionId: 'session-1',
      providerId: 'gemini',
      eventSequence: 4,
      status: LIVE_DUBBING_STATUS.RUNNING,
      originalVolume: 0.8,
    });

    await expect(harness.coordinator.setOriginalVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 4, volume: 0.2 },
    })).resolves.toEqual({
      success: true,
      ignored: true,
      superseded: true,
      sessionId: 'session-1',
      providerId: 'gemini',
      eventSequence: 4,
      status: LIVE_DUBBING_STATUS.RUNNING,
      originalVolume: 0.8,
    });
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({ eventSequence: 4 });
    expect(harness.browserAPI.storage.session.set).not.toHaveBeenCalled();
    expect(harness.browserAPI.storage.session.remove).not.toHaveBeenCalled();
    expect(harness.storage.has(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toBe(false);
  });

  it.each([
    LIVE_DUBBING_STATUS.PREPARING_CAPTURE,
    LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
    LIVE_DUBBING_STATUS.RUNNING,
  ])('reads the committed original volume during %s without changing lifecycle state', async status => {
    const harness = createVolumeHarness(status);
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => ({
      success: true,
      sessionId: message.data.sessionId,
      providerId: message.data.providerId,
      eventSequence: message.data.eventSequence,
      status,
      originalVolume: 0.4,
    }));

    const result = await harness.coordinator.getOriginalVolume({
      action: LIVE_DUBBING_ACTIONS.GET_ORIGINAL_VOLUME,
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 4 },
    });

    expect(result).toEqual({
      success: true,
      sessionId: 'session-1',
      providerId: 'gemini',
      eventSequence: 4,
      status,
      originalVolume: 0.4,
    });
    expect(harness.browserAPI.runtime.sendMessage).toHaveBeenCalledWith({
      target: 'offscreen',
      action: LIVE_DUBBING_ACTIONS.GET_ORIGINAL_VOLUME_OFFSCREEN,
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 4 },
    });
    expect(harness.browserAPI.storage.session.set).not.toHaveBeenCalled();
    expect(harness.browserAPI.storage.session.remove).not.toHaveBeenCalled();
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({ status, eventSequence: 4 });
    expect(harness.storage.has(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toBe(false);
  });

  it.each([
    ['missing session', null, 'LIVE_DUBBING_SESSION_UNAVAILABLE'],
    ['stopping session', LIVE_DUBBING_STATUS.STOPPING, 'LIVE_DUBBING_SESSION_UNAVAILABLE'],
    ['error session', LIVE_DUBBING_STATUS.ERROR, 'LIVE_DUBBING_SESSION_UNAVAILABLE'],
  ])('rejects volume query on %s deterministically', async (_label, status, error) => {
    const harness = status ? createVolumeHarness(status) : createHarness();

    await expect(harness.coordinator.getOriginalVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 4 },
    })).resolves.toEqual({ success: false, error });
    expect(harness.browserAPI.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['session', { sessionId: 'other' }, 'LIVE_DUBBING_SESSION_MISMATCH'],
    ['provider', { providerId: 'openai' }, 'LIVE_DUBBING_SESSION_MISMATCH'],
    ['event sequence', { eventSequence: 3 }, 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH'],
  ])('rejects a volume query %s fence mismatch without lifecycle mutation', async (_label, data, error) => {
    const harness = createVolumeHarness();
    const messageData = {
      sessionId: 'session-1',
      providerId: 'gemini',
      eventSequence: 4,
      ...data,
    };

    await expect(harness.coordinator.getOriginalVolume({ data: messageData }))
      .resolves.toEqual({ success: false, error });
    expect(harness.browserAPI.runtime.sendMessage).not.toHaveBeenCalled();
    expect(harness.browserAPI.storage.session.set).not.toHaveBeenCalled();
  });

  it('seeds a new session from persisted volume preferences without touching the descriptor', async () => {
    const harness = createHarness({
      volumePreferencesReader: async () => ({ originalVolume: 0.7, dubbedVolume: 0.3 }),
    });
    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});

    expect(result.success).toBe(true);
    const prepare = harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .find(message => message.action === 'LIVE_DUBBING_PREPARE');
    expect(prepare.data).toMatchObject({
      originalVolume: 0.7,
      dubbedVolume: 0.3,
      eventSequence: 0,
    });
    const stored = harness.storage.get(LIVE_DUBBING_STORAGE_KEY);
    expect(stored).not.toHaveProperty('originalVolume');
    expect(stored).not.toHaveProperty('dubbedVolume');
    expect(stored).not.toHaveProperty('LIVE_DUBBING_ORIGINAL_VOLUME');
    expect(stored).not.toHaveProperty('LIVE_DUBBING_DUBBED_VOLUME');
    expect(result.status.status).toBe(LIVE_DUBBING_STATUS.RUNNING);
  });

  it.each([
    ['throwing reader', async () => { throw new Error('storage boom'); }],
    ['malformed volumes', async () => ({ originalVolume: 'loud', dubbedVolume: 7 })],
    ['empty preferences', async () => ({})],
  ])('falls back to 0/1 session volumes on %s', async (_label, volumePreferencesReader) => {
    const harness = createHarness({ volumePreferencesReader });
    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});

    expect(result.success).toBe(true);
    const prepare = harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .find(message => message.action === 'LIVE_DUBBING_PREPARE');
    expect(prepare.data).toMatchObject({ originalVolume: 0, dubbedVolume: 1, eventSequence: 0 });
  });

  it('persists the accepted original volume without changing the runtime result', async () => {
    await storageManager.remove(['LIVE_DUBBING_ORIGINAL_VOLUME']);
    const harness = createVolumeHarness();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => ({
      success: true,
      sessionId: message.data.sessionId,
      providerId: message.data.providerId,
      eventSequence: message.data.eventSequence,
      status: LIVE_DUBBING_STATUS.RUNNING,
      originalVolume: message.data.volume,
    }));

    const result = await harness.coordinator.setOriginalVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 4, volume: 0.6 },
    });

    expect(result).toEqual({
      success: true,
      sessionId: 'session-1',
      providerId: 'gemini',
      eventSequence: 4,
      status: LIVE_DUBBING_STATUS.RUNNING,
      originalVolume: 0.6,
    });
    // Persistence is detached — let the coalesced writer fire before reading.
    await new Promise(resolve => setTimeout(resolve, 0));
    await expect(storageManager.get({ LIVE_DUBBING_ORIGINAL_VOLUME: null }))
      .resolves.toEqual({ LIVE_DUBBING_ORIGINAL_VOLUME: 0.6 });
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({ eventSequence: 4 });
    await storageManager.remove(['LIVE_DUBBING_ORIGINAL_VOLUME']);
  });

  it('reads persisted volume preferences via getFresh on START (cache-bypassing)', async () => {
    await storageManager.set({ LIVE_DUBBING_ORIGINAL_VOLUME: 0.25, LIVE_DUBBING_DUBBED_VOLUME: 0.8 });
    const getFreshSpy = vi.spyOn(storageManager, 'getFresh');

    const harness = createHarness({
      hasConfiguredCredentials: vi.fn(async () => true),
      supportsOffscreenDocument: vi.fn(() => true),
    });
    const originalRead = harness.coordinator._readVolumePreferences.bind(harness.coordinator);
    harness.coordinator._readVolumePreferences = vi.fn(originalRead);
    const startPromise = harness.coordinator.start({ data: { providerId: 'gemini', targetLanguage: 'en' } }, {});
    startPromise.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(harness.coordinator._readVolumePreferences).toHaveBeenCalledOnce();
    expect(getFreshSpy).toHaveBeenCalled();
    expect(getFreshSpy.mock.calls.some(([arg]) => arg
      && Object.prototype.hasOwnProperty.call(arg, 'LIVE_DUBBING_ORIGINAL_VOLUME')
      && Object.prototype.hasOwnProperty.call(arg, 'LIVE_DUBBING_DUBBED_VOLUME'))).toBe(true);
    getFreshSpy.mockRestore();
    await storageManager.remove(['LIVE_DUBBING_ORIGINAL_VOLUME', 'LIVE_DUBBING_DUBBED_VOLUME']);
  });

  it('latest-wins persistence: slower older write must not leave storage with an older value', async () => {
    await storageManager.remove(['LIVE_DUBBING_ORIGINAL_VOLUME']);
    const harness = createVolumeHarness();
    const order = [];
    let resolveSlow;
    const slowGate = new Promise(resolve => { resolveSlow = resolve; });
    const setSpy = vi.spyOn(storageManager, 'set').mockImplementation(async payload => {
      const value = payload.LIVE_DUBBING_ORIGINAL_VOLUME;
      order.push(value);
      if (value === 0.6) await slowGate;
      return { LIVE_DUBBING_ORIGINAL_VOLUME: value };
    });
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => ({
      success: true,
      sessionId: message.data.sessionId,
      providerId: message.data.providerId,
      eventSequence: message.data.eventSequence,
      status: LIVE_DUBBING_STATUS.RUNNING,
      originalVolume: message.data.volume,
    }));

    const first = harness.coordinator.setOriginalVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 4, volume: 0.6 },
    });
    const second = harness.coordinator.setOriginalVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 4, volume: 0.9 },
    });
    await second;
    resolveSlow();
    await first;
    // Persistence is detached — let the coalesced writer fire before asserting.
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(order[order.length - 1]).toBe(0.9);
    const lastPayload = setSpy.mock.calls[setSpy.mock.calls.length - 1]?.[0];
    expect(lastPayload?.LIVE_DUBBING_ORIGINAL_VOLUME).toBe(0.9);
    setSpy.mockRestore();
    await storageManager.remove(['LIVE_DUBBING_ORIGINAL_VOLUME']);
  });

  it('newest accepted Original Volume overrides stale persisted value on next START (same coordinator)', async () => {
    await storageManager.remove(['LIVE_DUBBING_ORIGINAL_VOLUME']);
    const harness = createVolumeHarness(LIVE_DUBBING_STATUS.RUNNING, {}, {
      hasConfiguredCredentials: vi.fn(async () => true),
      supportsOffscreenDocument: vi.fn(() => true),
    });
    let resolveSlow;
    const slowGate = new Promise(resolve => { resolveSlow = resolve; });
    let writeCompleted = false;
    const setSpy = vi.spyOn(storageManager, 'set').mockImplementation(async payload => {
      if (payload.LIVE_DUBBING_ORIGINAL_VOLUME === 0.4) await slowGate;
      if (payload.LIVE_DUBBING_ORIGINAL_VOLUME === 0.4) writeCompleted = true;
      return { LIVE_DUBBING_ORIGINAL_VOLUME: payload.LIVE_DUBBING_ORIGINAL_VOLUME };
    });
    // Seed an active session so the initial SET has a controllable target.
    await harness.coordinator.start({ data: { providerId: 'gemini', targetLanguage: 'en' } }, {});
    const descriptorEventSequence = harness.coordinator.descriptor?.eventSequence ?? 5;
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_PREPARE') {
        return {
          success: true,
          ack: 'READY',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          eventSequence: message.data.eventSequence,
        };
      }
      if (message.action === 'LIVE_DUBBING_CONSUME') {
        return {
          success: true,
          ack: 'MEDIA_ACQUIRED',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          eventSequence: message.data.eventSequence,
          status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
          captureReady: true,
          audioPathReady: true,
          inputPipelineReady: true,
          outputPipelineReady: true,
        };
      }
      if (message.action === 'LIVE_DUBBING_CONNECT_PROVIDER') {
        return {
          success: true,
          ack: 'PROVIDER_READY',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          eventSequence: message.data.eventSequence + 1,
          status: LIVE_DUBBING_STATUS.RUNNING,
          captureReady: true,
          audioPathReady: true,
          inputPipelineReady: true,
          outputPipelineReady: true,
          setupComplete: true,
        };
      }
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        return {
          success: true,
          ack: 'DISPOSED',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          eventSequence: message.data.eventSequence,
        };
      }
      if (message.action === LIVE_DUBBING_ACTIONS.SET_ORIGINAL_VOLUME_OFFSCREEN) {
        return {
          success: true,
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          eventSequence: message.data.eventSequence,
          status: LIVE_DUBBING_STATUS.RUNNING,
          originalVolume: message.data.volume,
        };
      }
      return { success: true };
    });
    // Drive the active session into RUNNING and accept a SET.
    const setResult = await harness.coordinator.setOriginalVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: descriptorEventSequence, volume: 0.4 },
    });
    expect(setResult.error, JSON.stringify(setResult)).toBeUndefined();
    // Persistence is detached but deliberately gated — leave it pending.
    await new Promise(resolve => setTimeout(resolve, 0));

    // STOP clears the active session; wait for STOP to complete and then
    // simulate cleanup completion by removing the terminal descriptor from
    // storage and resetting the cached stateStore so a fresh START can be
    // issued on the same coordinator instance.
    await harness.coordinator.stop({});
    await new Promise(resolve => setTimeout(resolve, 0));
    harness.storage.delete(LIVE_DUBBING_STORAGE_KEY);
    harness.coordinator.stateStore.descriptor = null;
    harness.coordinator.stateStore.storageState = 'uninitialized';
    await harness.coordinator._readDescriptor().catch(() => {});

    // Fresh START must resolve without waiting for the gated storage write,
    // and its PREPARE payload must carry the memory-override originalVolume.
    // The 0.4 storage write is still blocked on slowGate here, so awaiting
    // START proves it resolves before the blocked write without wall-clock
    // timing.
    const startResult = await harness.coordinator.start({ data: { providerId: 'gemini', targetLanguage: 'en' } }, {});
    expect(startResult).toMatchObject({ success: true });
    expect(writeCompleted).toBe(false);

    const prepareMessages = harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(message => message?.action === 'LIVE_DUBBING_PREPARE');
    const lastPrepare = prepareMessages[prepareMessages.length - 1];
    expect(lastPrepare?.data?.originalVolume).toBe(0.4);

    resolveSlow();
    await new Promise(resolve => setTimeout(resolve, 0));

    const setPayloads = setSpy.mock.calls.map(([payload]) => payload.LIVE_DUBBING_ORIGINAL_VOLUME);
    expect(setPayloads).toContain(0.4);
    setSpy.mockRestore();
    await storageManager.remove(['LIVE_DUBBING_ORIGINAL_VOLUME']);
  });

  it('clears the memory override after persistence succeeds so a later external preference wins', async () => {
    await storageManager.remove(['LIVE_DUBBING_ORIGINAL_VOLUME']);
    // Shared-storage stand-in: the injected reader observes whatever the
    // "latest persisted" value is. Real browser.storage.local.get resolves
    // undefined in this test env (so a real getFresh would always throw and
    // fall back to defaults); the getFresh call shape itself is covered by
    // the dedicated cache-bypassing test above.
    const sharedPrefs = { originalVolume: 0, dubbedVolume: 1 };
    const harness = createVolumeHarness(LIVE_DUBBING_STATUS.RUNNING, {}, {
      hasConfiguredCredentials: vi.fn(async () => true),
      supportsOffscreenDocument: vi.fn(() => true),
      volumePreferencesReader: async () => ({ ...sharedPrefs }),
    });
    // Seed an active session so the initial SET has a controllable target.
    await harness.coordinator.start({ data: { providerId: 'gemini', targetLanguage: 'en' } }, {});
    const descriptorEventSequence = harness.coordinator.descriptor?.eventSequence ?? 5;
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_PREPARE') {
        return {
          success: true,
          ack: 'READY',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          eventSequence: message.data.eventSequence,
        };
      }
      if (message.action === 'LIVE_DUBBING_CONSUME') {
        return {
          success: true,
          ack: 'MEDIA_ACQUIRED',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          eventSequence: message.data.eventSequence,
          status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
          captureReady: true,
          audioPathReady: true,
          inputPipelineReady: true,
          outputPipelineReady: true,
        };
      }
      if (message.action === 'LIVE_DUBBING_CONNECT_PROVIDER') {
        return {
          success: true,
          ack: 'PROVIDER_READY',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          eventSequence: message.data.eventSequence + 1,
          status: LIVE_DUBBING_STATUS.RUNNING,
          captureReady: true,
          audioPathReady: true,
          inputPipelineReady: true,
          outputPipelineReady: true,
          setupComplete: true,
        };
      }
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        return {
          success: true,
          ack: 'DISPOSED',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          eventSequence: message.data.eventSequence,
        };
      }
      if (message.action === LIVE_DUBBING_ACTIONS.SET_ORIGINAL_VOLUME_OFFSCREEN) {
        return {
          success: true,
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          eventSequence: message.data.eventSequence,
          status: LIVE_DUBBING_STATUS.RUNNING,
          originalVolume: message.data.volume,
        };
      }
      return { success: true };
    });
    const setResult = await harness.coordinator.setOriginalVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: descriptorEventSequence, volume: 0.4 },
    });
    expect(setResult.error, JSON.stringify(setResult)).toBeUndefined();
    // Wait for the detached persistence to flush the accepted value.
    await harness.coordinator._volumePreferenceWrites?.inflight?.catch?.(() => {});
    await new Promise(resolve => setTimeout(resolve, 0));
    await expect(storageManager.get({ LIVE_DUBBING_ORIGINAL_VOLUME: null }))
      .resolves.toEqual({ LIVE_DUBBING_ORIGINAL_VOLUME: 0.4 });
    // Memory override must be cleared once the newest accepted value persisted.
    expect(harness.coordinator._latestAcceptedOriginalVolume ?? null).toBeNull();
    // Another context later stores a newer preference in shared storage.
    sharedPrefs.originalVolume = 0.7;
    // STOP + cleanup simulation so a fresh START can be issued on the same
    // coordinator instance.
    await harness.coordinator.stop({});
    await new Promise(resolve => setTimeout(resolve, 0));
    harness.storage.delete(LIVE_DUBBING_STORAGE_KEY);
    harness.coordinator.stateStore.descriptor = null;
    harness.coordinator.stateStore.storageState = 'uninitialized';
    await harness.coordinator._readDescriptor().catch(() => {});
    const startResult = await harness.coordinator.start({ data: { providerId: 'gemini', targetLanguage: 'en' } }, {});
    expect(startResult).toMatchObject({ success: true });
    const prepareMessages = harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(message => message?.action === 'LIVE_DUBBING_PREPARE');
    const lastPrepare = prepareMessages[prepareMessages.length - 1];
    expect(lastPrepare?.data?.originalVolume).toBe(0.7);
    await storageManager.remove(['LIVE_DUBBING_ORIGINAL_VOLUME']);
  });

  it('never persists failed or superseded volume outcomes', async () => {
    await storageManager.set({ LIVE_DUBBING_ORIGINAL_VOLUME: 0.6 });
    const harness = createVolumeHarness();

    await expect(harness.coordinator.setOriginalVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 4, volume: null },
    })).resolves.toEqual({ success: false, error: 'LIVE_DUBBING_ORIGINAL_VOLUME_INVALID' });

    harness.browserAPI.runtime.sendMessage.mockResolvedValue({
      success: true,
      ignored: true,
      superseded: true,
      sessionId: 'session-1',
      providerId: 'gemini',
      eventSequence: 4,
      status: LIVE_DUBBING_STATUS.RUNNING,
      originalVolume: 0.8,
    });
    await expect(harness.coordinator.setOriginalVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 4, volume: 0.2 },
    })).resolves.toMatchObject({ success: true, superseded: true });

    await expect(storageManager.get({ LIVE_DUBBING_ORIGINAL_VOLUME: null }))
      .resolves.toEqual({ LIVE_DUBBING_ORIGINAL_VOLUME: 0.6 });
    await storageManager.remove(['LIVE_DUBBING_ORIGINAL_VOLUME']);
  });

  it('stays non-terminal when volume persistence fails', async () => {
    const harness = createVolumeHarness();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => ({
      success: true,
      sessionId: message.data.sessionId,
      providerId: message.data.providerId,
      eventSequence: message.data.eventSequence,
      status: LIVE_DUBBING_STATUS.RUNNING,
      originalVolume: message.data.volume,
    }));
    const setSpy = vi.spyOn(storageManager, 'set').mockRejectedValueOnce(new Error('storage boom'));

    await expect(harness.coordinator.setOriginalVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 4, volume: 0.6 },
    })).resolves.toEqual({
      success: true,
      sessionId: 'session-1',
      providerId: 'gemini',
      eventSequence: 4,
      status: LIVE_DUBBING_STATUS.RUNNING,
      originalVolume: 0.6,
    });
    // Persistence is detached — let the coalesced writer fire before asserting.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(setSpy).toHaveBeenCalledWith({ LIVE_DUBBING_ORIGINAL_VOLUME: 0.6 });
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
      status: LIVE_DUBBING_STATUS.RUNNING,
      eventSequence: 4,
    });
    expect(harness.storage.has(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toBe(false);
    setSpy.mockRestore();
    await storageManager.remove(['LIVE_DUBBING_ORIGINAL_VOLUME']);
  });

  it.each([
    LIVE_DUBBING_STATUS.PREPARING_CAPTURE,
    LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
    LIVE_DUBBING_STATUS.RUNNING,
  ])('sets dubbed volume during %s without changing lifecycle state', async status => {
    const harness = createVolumeHarness(status);
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => ({
      success: true,
      sessionId: message.data.sessionId,
      providerId: message.data.providerId,
      eventSequence: message.data.eventSequence,
      status,
      dubbedVolume: message.data.volume,
    }));

    const result = await harness.coordinator.setDubbedVolume({
      action: LIVE_DUBBING_ACTIONS.SET_DUBBED_VOLUME,
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence: 4,
        volume: 0.7,
      },
    });

    expect(result).toEqual({
      success: true,
      sessionId: 'session-1',
      providerId: 'gemini',
      eventSequence: 4,
      status,
      dubbedVolume: 0.7,
    });
    expect(harness.browserAPI.runtime.sendMessage).toHaveBeenCalledWith({
      target: 'offscreen',
      action: LIVE_DUBBING_ACTIONS.SET_DUBBED_VOLUME_OFFSCREEN,
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence: 4,
        volume: 0.7,
      },
    });
    expect(harness.browserAPI.storage.session.set).not.toHaveBeenCalled();
    expect(harness.browserAPI.storage.session.remove).not.toHaveBeenCalled();
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({ status, eventSequence: 4 });
    await storageManager.remove(['LIVE_DUBBING_DUBBED_VOLUME']).catch(() => {});
  });

  it('rejects invalid dubbed volume before reading a session', async () => {
    const harness = createVolumeHarness();

    await expect(harness.coordinator.setDubbedVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 4, volume: null },
    })).resolves.toEqual({ success: false, error: 'LIVE_DUBBING_DUBBED_VOLUME_INVALID' });
    await expect(harness.coordinator.setDubbedVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 4, volume: 1.5 },
    })).resolves.toEqual({ success: false, error: 'LIVE_DUBBING_DUBBED_VOLUME_INVALID' });
    expect(harness.browserAPI.runtime.sendMessage).not.toHaveBeenCalled();
    expect(harness.browserAPI.storage.session.set).not.toHaveBeenCalled();
  });

  it.each([
    ['session', { sessionId: 'other' }, 'LIVE_DUBBING_SESSION_MISMATCH'],
    ['provider', { providerId: 'openai' }, 'LIVE_DUBBING_SESSION_MISMATCH'],
    ['event sequence', { eventSequence: 3 }, 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH'],
  ])('rejects a dubbed %s fence mismatch without lifecycle mutation', async (_label, data, error) => {
    const harness = createVolumeHarness();
    const messageData = {
      sessionId: 'session-1',
      providerId: 'gemini',
      eventSequence: 4,
      volume: 0.5,
      ...data,
    };

    await expect(harness.coordinator.setDubbedVolume({ data: messageData }))
      .resolves.toEqual({ success: false, error });
    expect(harness.browserAPI.runtime.sendMessage).not.toHaveBeenCalled();
    expect(harness.browserAPI.storage.session.set).not.toHaveBeenCalled();
  });

  it('normalizes dubbed offscreen control failures without terminal mutation', async () => {
    const harness = createVolumeHarness();
    harness.browserAPI.runtime.sendMessage.mockRejectedValue(new Error('offscreen unavailable'));

    await expect(harness.coordinator.setDubbedVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 4, volume: 0.5 },
    })).resolves.toEqual({
      success: false,
      error: 'LIVE_DUBBING_DUBBED_AUDIO_UNAVAILABLE',
    });
    expect(harness.browserAPI.storage.session.set).not.toHaveBeenCalled();
    expect(harness.storage.has(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toBe(false);
  });

  it('preserves superseded dubbed latest-wins responses without persisting', async () => {
    const harness = createVolumeHarness();
    harness.browserAPI.runtime.sendMessage.mockResolvedValue({
      success: true,
      ignored: true,
      superseded: true,
      sessionId: 'session-1',
      providerId: 'gemini',
      eventSequence: 4,
      status: LIVE_DUBBING_STATUS.RUNNING,
      dubbedVolume: 0.8,
    });

    await expect(harness.coordinator.setDubbedVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 4, volume: 0.2 },
    })).resolves.toEqual({
      success: true,
      ignored: true,
      superseded: true,
      sessionId: 'session-1',
      providerId: 'gemini',
      eventSequence: 4,
      status: LIVE_DUBBING_STATUS.RUNNING,
      dubbedVolume: 0.8,
    });
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({ eventSequence: 4 });
    expect(harness.browserAPI.storage.session.set).not.toHaveBeenCalled();
    expect(harness.browserAPI.storage.session.remove).not.toHaveBeenCalled();
    expect(harness.coordinator._latestAcceptedDubbedVolume ?? null).toBeNull();
  });

  it.each([
    LIVE_DUBBING_STATUS.PREPARING_CAPTURE,
    LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
    LIVE_DUBBING_STATUS.RUNNING,
  ])('reads the committed dubbed volume during %s without changing lifecycle state', async status => {
    const harness = createVolumeHarness(status);
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => ({
      success: true,
      sessionId: message.data.sessionId,
      providerId: message.data.providerId,
      eventSequence: message.data.eventSequence,
      status,
      dubbedVolume: 0.4,
    }));

    const result = await harness.coordinator.getDubbedVolume({
      action: LIVE_DUBBING_ACTIONS.GET_DUBBED_VOLUME,
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 4 },
    });

    expect(result).toEqual({
      success: true,
      sessionId: 'session-1',
      providerId: 'gemini',
      eventSequence: 4,
      status,
      dubbedVolume: 0.4,
    });
    expect(harness.browserAPI.runtime.sendMessage).toHaveBeenCalledWith({
      target: 'offscreen',
      action: LIVE_DUBBING_ACTIONS.GET_DUBBED_VOLUME_OFFSCREEN,
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 4 },
    });
    expect(harness.browserAPI.storage.session.set).not.toHaveBeenCalled();
    expect(harness.browserAPI.storage.session.remove).not.toHaveBeenCalled();
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({ status, eventSequence: 4 });
    expect(harness.storage.has(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toBe(false);
  });

  it('persists the accepted dubbed volume independently without touching original state', async () => {
    await storageManager.remove(['LIVE_DUBBING_DUBBED_VOLUME']);
    const harness = createVolumeHarness();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => ({
      success: true,
      sessionId: message.data.sessionId,
      providerId: message.data.providerId,
      eventSequence: message.data.eventSequence,
      status: LIVE_DUBBING_STATUS.RUNNING,
      dubbedVolume: message.data.volume,
    }));

    const result = await harness.coordinator.setDubbedVolume({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 4, volume: 0.6 },
    });

    expect(result).toEqual({
      success: true,
      sessionId: 'session-1',
      providerId: 'gemini',
      eventSequence: 4,
      status: LIVE_DUBBING_STATUS.RUNNING,
      dubbedVolume: 0.6,
    });
    // Immediate next START observes the newest dubbed value: the detached
    // writer records it in memory synchronously during SET.
    expect(harness.coordinator._latestAcceptedDubbedVolume).toBe(0.6);
    // Persistence is detached — let the coalesced writer fire before reading.
    await new Promise(resolve => setTimeout(resolve, 0));
    await expect(storageManager.get({ LIVE_DUBBING_DUBBED_VOLUME: null }))
      .resolves.toEqual({ LIVE_DUBBING_DUBBED_VOLUME: 0.6 });
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({ eventSequence: 4 });
    // Original-volume memory and queue stay untouched by a dubbed SET.
    expect(harness.coordinator._latestAcceptedOriginalVolume ?? null).toBeNull();
    expect(harness.coordinator._volumePreferenceWrites?.latestValue ?? null).toBeNull();
    await storageManager.remove(['LIVE_DUBBING_DUBBED_VOLUME']);
  });

  it('uses the injected runtime gateway when platform methods are unavailable on API objects', async () => {
    const harness = createHarness();
    const platformSendMessage = harness.browserAPI.runtime.sendMessage;
    const gateway = {
      supportsTabCapture: vi.fn(() => true),
      sendMessage: vi.fn(message => platformSendMessage(message)),
      getMediaStreamId: vi.fn(async tabId => {
        expect(tabId).toBe(42);
        return 'gateway-stream-id';
      }),
      getTab: vi.fn(async tabId => ({ id: tabId })),
      getActiveTab: vi.fn(async () => ({ id: 42, url: 'https://example.test' })),
      getCapturedTabs: vi.fn(async () => []),
      isExtensionPageSender: vi.fn(() => false),
      resolveTabFromSender: vi.fn(async sender => gateway.getActiveTab(sender)),
    };
    harness.coordinator.runtimeGateway = gateway;
    delete harness.browserAPI.runtime.sendMessage;
    delete harness.browserAPI.tabs.get;
    delete harness.browserAPI.tabs.query;
    delete harness.chromeAPI.tabCapture.getMediaStreamId;
    delete harness.chromeAPI.tabCapture.getCapturedTabs;

    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});

    expect(result).toMatchObject({ success: true, status: { tabId: 42 } });
    expect(gateway.supportsTabCapture).toHaveBeenCalledOnce();
    expect(gateway.getActiveTab).toHaveBeenCalledOnce();
    expect(gateway.getMediaStreamId).toHaveBeenCalledWith(42);
    expect(gateway.sendMessage.mock.calls.map(([message]) => message.action)).toEqual([
      'LIVE_DUBBING_PREPARE',
      'LIVE_DUBBING_CONSUME',
      'LIVE_DUBBING_CONNECT_PROVIDER',
    ]);
  });

  it('acquires lease, prepares offscreen, forwards stream ID only to consume, then reports active', async () => {
    const harness = createHarness();
    const result = await harness.coordinator.start({ data: { targetLanguage: 'zh-Hans' } }, {});

    expect(result.success).toBe(true);
    expect(harness.manager.acquire).toHaveBeenCalledWith({
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'session-1',
      requiredReasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    });
    expect(harness.chromeAPI.tabCapture.getMediaStreamId).toHaveBeenCalledWith({ targetTabId: 42 });

    const messages = harness.browserAPI.runtime.sendMessage.mock.calls.map(([message]) => message);
    expect(messages.map(message => message.action)).toEqual([
      'LIVE_DUBBING_PREPARE',
      'LIVE_DUBBING_CONSUME',
      'LIVE_DUBBING_CONNECT_PROVIDER',
    ]);
    expect(messages[0].data).not.toHaveProperty('streamId');
    expect(messages[1]).toMatchObject({ target: 'offscreen', data: { streamId: 'stream-secret' } });
    expect(messages[2].data).not.toHaveProperty('streamId');
    expect(messages.map(message => message.data.eventSequence)).toEqual([0, 1, 2]);
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).not.toHaveProperty('streamId');
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY).targetLanguage).toBe('zh-Hans');
    expect(messages.map(message => message.data.targetLanguage)).toEqual(['zh-Hans', 'zh-Hans', 'zh-Hans']);
    expect(result.status.status).toBe(LIVE_DUBBING_STATUS.RUNNING);
    expect(result.status.eventSequence).toBe(3);
    expect(result.status.providerId).toBe('gemini');
    expect(result.status.targetLanguage).toBe('zh-Hans');
  });

  it('defaults START without providerId to Gemini and rejects explicit unknown providers', async () => {
    const defaultHarness = createHarness();
    const defaultResult = await defaultHarness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    expect(defaultResult).toMatchObject({ success: true, status: { providerId: 'gemini' } });

    const unknownHarness = createHarness();
    await expect(unknownHarness.coordinator.start({
      data: { providerId: 'unknown', targetLanguage: 'en' },
    }, {})).resolves.toEqual({
      success: false,
      error: 'LIVE_DUBBING_PROVIDER_UNSUPPORTED',
    });
    expect(unknownHarness.manager.acquire).not.toHaveBeenCalled();
    expect(unknownHarness.chromeAPI.tabCapture.getMediaStreamId).not.toHaveBeenCalled();

    const emptyHarness = createHarness();
    await expect(emptyHarness.coordinator.start({
      data: { providerId: '', targetLanguage: 'en' },
    }, {})).resolves.toEqual({
      success: false,
      error: 'LIVE_DUBBING_PROVIDER_UNSUPPORTED',
    });
  });

  it('fixes OpenAI provider identity at START and uses generic media readiness', async () => {
    const harness = createHarness();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      harness.calls.push(['message', message]);
      if (message.action === 'LIVE_DUBBING_PREPARE') {
        return {
          success: true,
          ack: 'READY',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          eventSequence: message.data.eventSequence,
        };
      }
      if (message.action === 'LIVE_DUBBING_CONSUME') {
        return {
          success: true,
          ack: 'MEDIA_ACQUIRED',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
          eventSequence: message.data.eventSequence,
          captureReady: true,
          audioPathReady: true,
          inputPipelineReady: false,
          outputPipelineReady: false,
        };
      }
      if (message.action === 'LIVE_DUBBING_CONNECT_PROVIDER') {
        return {
          success: true,
          ack: 'PROVIDER_READY',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          status: LIVE_DUBBING_STATUS.RUNNING,
          eventSequence: message.data.eventSequence + 1,
          captureReady: true,
          audioPathReady: true,
          inputPipelineReady: false,
          outputPipelineReady: false,
          setupComplete: true,
        };
      }
      return { success: true, ack: 'DISPOSED', sessionId: message.data.sessionId, providerId: message.data.providerId };
    });

    const result = await harness.coordinator.start({
      data: { providerId: 'openai', targetLanguage: 'de-DE' },
    }, {});

    expect(result).toMatchObject({
      success: true,
      status: {
        providerId: 'openai',
        targetLanguage: 'de-DE',
        status: LIVE_DUBBING_STATUS.RUNNING,
      },
    });
    expect(harness.manager.acquire).toHaveBeenCalledWith({
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'session-1',
      requiredReasons: ['USER_MEDIA', 'AUDIO_PLAYBACK', 'WEB_RTC'],
    });
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
      providerId: 'openai',
      targetLanguage: 'de-DE',
    });
  });

  it.each([
    ['gemini', 'de-DE'],
    ['openai', 'en_US'],
  ])('rejects invalid %s target language before descriptor and runtime side effects', async (providerId, targetLanguage) => {
    const hasConfiguredCredentials = vi.fn(async () => true);
    const harness = createHarness({ hasConfiguredCredentials });

    await expect(harness.coordinator.start({ data: { providerId, targetLanguage } }, {}))
      .resolves.toEqual({ success: false, error: 'INVALID_TARGET_LANGUAGE' });

    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
    expect(harness.browserAPI.storage.session.set).not.toHaveBeenCalled();
    expect(harness.manager.acquire).not.toHaveBeenCalled();
    expect(harness.chromeAPI.tabCapture.getMediaStreamId).not.toHaveBeenCalled();
    expect(harness.browserAPI.runtime.sendMessage).not.toHaveBeenCalled();
    expect(harness.coordinator.descriptor).toBeNull();
    expect(hasConfiguredCredentials).not.toHaveBeenCalled();
  });

  it.each([
    [LIVE_DUBBING_PROVIDER_ID, 'false', async () => false],
    [LIVE_DUBBING_PROVIDER_ID, 'rejected', async () => { throw new Error('credential read failed'); }],
    [LIVE_DUBBING_PROVIDER_ID, 'non-true', async () => 'configured'],
    [LIVE_DUBBING_OPENAI_PROVIDER_ID, 'false', async () => false],
    [LIVE_DUBBING_OPENAI_PROVIDER_ID, 'rejected', async () => { throw new Error('credential read failed'); }],
    [LIVE_DUBBING_OPENAI_PROVIDER_ID, 'non-true', async () => 'configured'],
  ])('fails %s start before side effects when credentials are %s', async (providerId, _label, credentialCheck) => {
    const hasConfiguredCredentials = vi.fn(credentialCheck);
    const harness = createHarness({ hasConfiguredCredentials });

    await expect(harness.coordinator.start({ data: { providerId, targetLanguage: providerId === 'gemini' ? 'en' : 'en-US' } }, {}))
      .resolves.toEqual({ success: false, error: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE' });

    expect(hasConfiguredCredentials).toHaveBeenCalledOnce();
    expect(hasConfiguredCredentials).toHaveBeenCalledWith(providerId);
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
    expect(harness.browserAPI.storage.session.set).not.toHaveBeenCalled();
    expect(harness.manager.acquire).not.toHaveBeenCalled();
    expect(harness.chromeAPI.tabCapture.getMediaStreamId).not.toHaveBeenCalled();
    expect(harness.browserAPI.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('preflights credentials before tab, descriptor, lease, media, and offscreen work', async () => {
    const order = [];
    const hasConfiguredCredentials = vi.fn(async () => {
      order.push('credentials');
      return true;
    });
    const harness = createHarness({ hasConfiguredCredentials });
    const gateway = harness.coordinator.runtimeGateway;
    const resolveTabFromSender = gateway.resolveTabFromSender.bind(gateway);
    vi.spyOn(gateway, 'resolveTabFromSender').mockImplementation(async sender => {
      order.push('tab');
      return resolveTabFromSender(sender);
    });
    harness.manager.supportsOffscreenDocument = vi.fn(() => {
      order.push('offscreen-capability');
      return true;
    });
    const acquire = harness.manager.acquire.getMockImplementation();
    harness.manager.acquire.mockImplementation(async lease => {
      order.push('lease');
      return acquire(lease);
    });
    const set = harness.browserAPI.storage.session.set.getMockImplementation();
    harness.browserAPI.storage.session.set.mockImplementation(async record => {
      order.push('descriptor');
      return set(record);
    });
    const getMediaStreamId = harness.chromeAPI.tabCapture.getMediaStreamId.getMockImplementation();
    harness.chromeAPI.tabCapture.getMediaStreamId.mockImplementation(async (...args) => {
      order.push('media');
      return getMediaStreamId(...args);
    });
    const sendMessage = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      order.push('offscreen');
      return sendMessage(message);
    });

    await expect(harness.coordinator.start({ data: { targetLanguage: 'en' } }, {}))
      .resolves.toMatchObject({ success: true });

    expect(order.indexOf('credentials')).toBeLessThan(order.indexOf('offscreen-capability'));
    expect(order.indexOf('credentials')).toBeLessThan(order.indexOf('tab'));
    expect(order.indexOf('credentials')).toBeLessThan(order.indexOf('descriptor'));
    expect(order.indexOf('credentials')).toBeLessThan(order.indexOf('lease'));
    expect(order.indexOf('credentials')).toBeLessThan(order.indexOf('media'));
    expect(order.indexOf('credentials')).toBeLessThan(order.indexOf('offscreen'));
  });

  it('allows a configured provider through the existing start flow', async () => {
    const hasConfiguredCredentials = vi.fn(async () => true);
    const harness = createHarness({ hasConfiguredCredentials });

    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});

    expect(result).toMatchObject({ success: true, status: { providerId: 'gemini' } });
    expect(hasConfiguredCredentials).toHaveBeenCalledOnce();
    expect(harness.manager.acquire).toHaveBeenCalledOnce();
  });

  it('does not preflight credentials for a busy start', async () => {
    const hasConfiguredCredentials = vi.fn(async () => true);
    const harness = createHarness({ hasConfiguredCredentials });
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});

    const duplicate = await harness.coordinator.start({ data: { targetLanguage: 'de' } }, {});

    expect(duplicate).toMatchObject({ success: false, busy: true });
    expect(hasConfiguredCredentials).toHaveBeenCalledOnce();
  });

  it.each([
    ['unsupported', () => false],
    ['detection throws', () => { throw new Error('offscreen probe failed'); }],
  ])('rejects %s offscreen runtimes before all start side effects', async (_label, supportsOffscreenDocument) => {
    const hasConfiguredCredentials = vi.fn(async () => true);
    const supports = vi.fn(supportsOffscreenDocument);
    const harness = createHarness({ hasConfiguredCredentials, supportsOffscreenDocument: supports });

    await expect(harness.coordinator.start({ data: { targetLanguage: 'en' } }, {}))
      .resolves.toEqual({ success: false, error: 'LIVE_DUBBING_UNSUPPORTED' });

    expect(supports).toHaveBeenCalledOnce();
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
    expect(harness.manager.acquire).not.toHaveBeenCalled();
    expect(harness.chromeAPI.tabCapture.getMediaStreamId).not.toHaveBeenCalled();
    expect(harness.browserAPI.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('preserves start behavior when offscreen support detection is absent', async () => {
    const harness = createHarness({ hasConfiguredCredentials: vi.fn(async () => true) });

    await expect(harness.coordinator.start({ data: { targetLanguage: 'en' } }, {}))
      .resolves.toMatchObject({ success: true });
  });

  it('preserves status availability when offscreen support detection is absent', async () => {
    const harness = createHarness();

    await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
      success: true,
      available: true,
    });
    expect(harness.manager.ensureDocument).not.toHaveBeenCalled();
  });

  it('cancels a pending credential preflight before tab or resource creation', async () => {
    let resolveCredentials;
    const hasConfiguredCredentials = vi.fn(() => new Promise(resolve => {
      resolveCredentials = resolve;
    }));
    const harness = createHarness({ hasConfiguredCredentials });
    const start = harness.coordinator.start({ data: { targetLanguage: 'en' } }, { tab: { id: 42 } });
    while (!resolveCredentials) await Promise.resolve();

    await expect(harness.coordinator.handleTabRemoved(42)).resolves.toMatchObject({
      pending: true,
      stopped: false,
    });
    resolveCredentials(true);

    await expect(start).resolves.toEqual({ success: false, error: 'LIVE_DUBBING_START_CANCELLED' });
    expect(harness.manager.acquire).not.toHaveBeenCalled();
    expect(harness.chromeAPI.tabCapture.getMediaStreamId).not.toHaveBeenCalled();
    expect(harness.browserAPI.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['both supported', () => true, () => true, true],
    ['tab capture unsupported', () => false, () => true, false],
    ['offscreen unsupported', () => true, () => false, false],
    ['offscreen detection throws', () => true, () => { throw new Error('offscreen probe failed'); }, false],
    ['tab capture detection throws', () => { throw new Error('capture probe failed'); }, () => true, false],
  ])('reports availability only when %s', async (_label, supportsTabCapture, supportsOffscreenDocument, available) => {
    const runtimeGateway = { supportsTabCapture: vi.fn(supportsTabCapture) };
    const harness = createHarness({ runtimeGateway, supportsOffscreenDocument: vi.fn(supportsOffscreenDocument) });

    await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
      success: true,
      available,
    });
    expect(harness.manager.ensureDocument).not.toHaveBeenCalled();
  });

  it('returns current status for duplicate start and ignores stale stop', async () => {
    const harness = createHarness();
    const first = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const duplicate = await harness.coordinator.start({ data: { targetLanguage: 'de' } }, {});
    const stale = await harness.coordinator.stop({ data: { sessionId: 'old-session' } });

    expect(first.success).toBe(true);
    expect(duplicate).toMatchObject({ success: false, busy: true, current: { sessionId: 'session-1' } });
    expect(stale).toMatchObject({ success: true, ignored: true });
    expect(harness.manager.release).not.toHaveBeenCalled();
  });

  it('clears transcript after capture START fails before releasing the exact lease', async () => {
    const harness = createHarness();
    const sendTabMessage = vi.fn().mockRejectedValue(new Error('tab closed'));
    harness.browserAPI.tabs.sendMessage = sendTabMessage;
    harness.chromeAPI.tabCapture.getMediaStreamId.mockRejectedValueOnce(new Error('capture failed'));

    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const orderedKinds = harness.calls.map(([kind]) => kind);

    expect(result).toMatchObject({ success: false, error: 'LIVE_DUBBING_START_FAILED' });
    expect(orderedKinds).toEqual(['acquire', 'message', 'message', 'release']);
    expect(harness.calls[1][1].action).toBe('LIVE_DUBBING_PREPARE');
    expect(harness.calls[2][1].action).toBe('LIVE_DUBBING_DISPOSE');
    expect(harness.manager.release).toHaveBeenCalledWith({ owner: LIVE_DUBBING_OWNER, leaseId: 'session-1' });
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
    expect(sendTabMessage).toHaveBeenCalledWith(42, {
      action: LIVE_DUBBING_ACTIONS.CLEAR_TRANSCRIPT,
      data: { sessionId: 'session-1' },
    }, { frameId: 0 });
  });

  it('logs sanitized media-stream diagnostics with preserved stage', async () => {
    const harness = createHarness();
    const failure = new Error('permission denied at https://example.test/capture');
    failure.name = 'NotAllowedError';
    harness.chromeAPI.tabCapture.getMediaStreamId.mockRejectedValueOnce(failure);

    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const diagnostic = harness.logger.warn.mock.calls
      .find(([message]) => message === 'Live dubbing capture failed')?.[1];

    expect(result).toMatchObject({ success: false, error: 'LIVE_DUBBING_START_FAILED' });
    expect(result).not.toHaveProperty('diagnostic');
    expect(diagnostic).toEqual({
      stage: 'GET_MEDIA_STREAM_ID',
      error: {
        name: 'NotAllowedError',
        message: 'permission denied at [redacted-url]',
      },
    });
    expect(JSON.stringify(diagnostic)).not.toContain('example.test');
  });

  it('attributes an unusable stream ID result to GET_MEDIA_STREAM_ID', async () => {
    const harness = createHarness({ streamId: null });

    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const diagnostic = harness.logger.warn.mock.calls
      .find(([message]) => message === 'Live dubbing capture failed')?.[1];

    expect(result).toMatchObject({ success: false, error: 'LIVE_DUBBING_START_FAILED' });
    expect(diagnostic).toMatchObject({ stage: 'GET_MEDIA_STREAM_ID' });
    expect(JSON.stringify(diagnostic)).not.toContain('stream-secret');
  });

  it('logs OFFSCREEN_PREPARE diagnostics without returning them to caller', async () => {
    const harness = createHarness();
    harness.browserAPI.runtime.sendMessage.mockImplementationOnce(async message => {
      harness.calls.push(['message', message]);
      return {
        success: false,
        error: 'LIVE_DUBBING_SESSION_BUSY',
        diagnostic: {
          stage: 'OFFSCREEN_PREPARE',
          error: {
            name: 'SessionBusyError',
            message: 'payload: stream-secret at https://example.test',
            code: 'LIVE_DUBBING_SESSION_BUSY',
          },
        },
      };
    });

    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const diagnostic = harness.logger.warn.mock.calls
      .find(([message]) => message === 'Live dubbing capture failed')?.[1];

    expect(result).toMatchObject({ success: false, error: 'LIVE_DUBBING_START_FAILED' });
    expect(result).not.toHaveProperty('diagnostic');
    expect(diagnostic).toMatchObject({
      stage: 'OFFSCREEN_PREPARE',
      error: {
        name: 'SessionBusyError',
        code: 'LIVE_DUBBING_SESSION_BUSY',
      },
    });
    expect(diagnostic.error.message).not.toContain('stream-secret');
    expect(diagnostic.error.message).not.toContain('example.test');
  });

  it('disposes the exact capture fence when pre-provider pipeline setup fails', async () => {
    const harness = createHarness();
    const track = {
      kind: 'audio',
      readyState: 'live',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      stop: vi.fn(),
    };
    const inputPipeline = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const offscreen = new LiveDubbingController({
      mediaDevices: { getUserMedia: vi.fn(async () => ({
        getAudioTracks: () => [track],
        getTracks: () => [track],
      })) },
      inputPipelineFactory: vi.fn(async () => inputPipeline),
      outputPlayerFactory: vi.fn(async () => {
        throw new Error('output pipeline setup failed');
      }),
    });
    harness.browserAPI.runtime.sendMessage.mockImplementation(message => {
      harness.calls.push(['message', message]);
      return offscreen.handle(message);
    });

    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const dispose = harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .find(message => message.action === 'LIVE_DUBBING_DISPOSE');

    expect(result).toMatchObject({ success: false, error: 'LIVE_DUBBING_START_FAILED' });
    expect(dispose).toMatchObject({ data: { sessionId: 'session-1', eventSequence: 1 } });
    expect(harness.manager.release).toHaveBeenCalledWith({
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'session-1',
    });
    expect(inputPipeline.stop).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
  });

  it('clears transcript after START times out during pre-provider pipeline setup', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const sendTabMessage = vi.fn().mockResolvedValue(undefined);
    harness.browserAPI.tabs.sendMessage = sendTabMessage;
    const track = {
      kind: 'audio',
      readyState: 'live',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      stop: vi.fn(),
    };
    let resolveInputStart;
    const inputPipeline = {
      start: vi.fn(() => new Promise(resolve => { resolveInputStart = resolve; })),
      stop: vi.fn(async () => {}),
    };
    const outputPlayer = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      clear: vi.fn(),
    };
    const offscreen = new LiveDubbingController({
      mediaDevices: { getUserMedia: vi.fn(async () => ({
        getAudioTracks: () => [track],
        getTracks: () => [track],
      })) },
      inputPipelineFactory: vi.fn(async () => inputPipeline),
      outputPlayerFactory: vi.fn(async () => outputPlayer),
    });
    harness.browserAPI.runtime.sendMessage.mockImplementation(message => {
      harness.calls.push(['message', message]);
      return offscreen.handle(message);
    });

    const startPromise = harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    while (!resolveInputStart) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(LIVE_DUBBING_START_TIMEOUT);
    const result = await startPromise;
    const dispose = harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .find(message => message.action === 'LIVE_DUBBING_DISPOSE');

    expect(result).toEqual({ success: false, error: 'LIVE_DUBBING_START_TIMEOUT' });
    expect(dispose).toMatchObject({ data: { sessionId: 'session-1', eventSequence: 1 } });
    expect(harness.manager.release).toHaveBeenCalledWith({
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'session-1',
    });
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
    expect(sendTabMessage).toHaveBeenCalledWith(42, {
      action: LIVE_DUBBING_ACTIONS.CLEAR_TRANSCRIPT,
      data: { sessionId: 'session-1' },
    }, { frameId: 0 });

    resolveInputStart();
    await Promise.resolve();
    vi.useRealTimers();
  });

  it('bounds START timeout cleanup when lease acquisition is slow/delayed', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      let resolveLease;
      const lease = new Promise(resolve => { resolveLease = resolve; });
      harness.manager.acquire.mockImplementationOnce(() => lease);

      const start = harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
      while (!resolveLease) await Promise.resolve();

      await vi.advanceTimersByTimeAsync(LIVE_DUBBING_START_TIMEOUT + LIVE_DUBBING_STOP_TIMEOUT);
      await expect(start).resolves.toMatchObject({
        success: false,
        error: 'LIVE_DUBBING_START_TIMEOUT',
        retryable: true,
        cleanupPending: true,
        status: { sessionId: 'session-1' },
      });
      expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
        sessionId: 'session-1',
      });
      expect(harness.browserAPI.runtime.sendMessage.mock.calls
        .map(([message]) => message)
        .filter(message => message.action === 'LIVE_DUBBING_DISPOSE'))
        .toHaveLength(1);
      expect(harness.manager.release).not.toHaveBeenCalled();

      await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
        success: true,
        status: { sessionId: 'session-1' },
      });

      resolveLease(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.manager.release).toHaveBeenCalledWith({
        owner: LIVE_DUBBING_OWNER,
        leaseId: 'session-1',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds reconciliation cleanup and leaves the transition queue available', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        stored: {
          sessionId: 'old-session',
          tabId: 42,
          targetLanguage: 'en',
          status: LIVE_DUBBING_STATUS.ERROR,
          startedAt: 1,
          lastError: 'START_FAILED',
          eventSequence: 1,
        },
        documentExists: true,
        statusResponse: {
          success: true,
          active: false,
          sessionId: 'old-session',
          status: LIVE_DUBBING_STATUS.ERROR,
        },
      });
      harness.manager.activeLeases = [{ owner: LIVE_DUBBING_OWNER, leaseId: 'old-session' }];
      const originalSendMessage = harness.browserAPI.runtime.sendMessage.getMockImplementation();
      let disposeAttempts = 0;
      let resolveFirstDispose;
      let resolveSecondDispose;
      harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
        if (message.action === 'LIVE_DUBBING_DISPOSE') {
          disposeAttempts += 1;
          return new Promise(resolve => {
            if (disposeAttempts === 1) resolveFirstDispose = resolve;
            else resolveSecondDispose = resolve;
          });
        }
        return originalSendMessage(message);
      });

      const reconcile = harness.coordinator.reconcile();
      while (!resolveFirstDispose) await Promise.resolve();

      await vi.advanceTimersByTimeAsync(LIVE_DUBBING_STOP_TIMEOUT);
      await expect(reconcile).resolves.toMatchObject({
        success: false,
        retryable: true,
        cleanupPending: true,
        status: { sessionId: 'old-session' },
      });
      await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
        success: true,
        status: { sessionId: 'old-session' },
      });
      expect(harness.manager.release).not.toHaveBeenCalled();

      const retry = harness.coordinator.reconcile();
      while (!resolveSecondDispose) await Promise.resolve();
      expect(disposeAttempts).toBe(2);
      resolveSecondDispose({
        success: true,
        ack: 'DISPOSED',
        sessionId: 'old-session',
        providerId: 'gemini',
      });
      await expect(retry).resolves.toMatchObject({ success: true, status: null });
      expect(resolveFirstDispose).toEqual(expect.any(Function));
      expect(harness.manager.release).toHaveBeenCalledWith({
        owner: LIVE_DUBBING_OWNER,
        leaseId: 'old-session',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when storage becomes unreadable while a session is active', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    harness.browserAPI.storage.session.get.mockRejectedValueOnce(new Error('temporary storage failure'));

    const blocked = await harness.coordinator.start({ data: { targetLanguage: 'de' } }, {});

    expect(blocked).toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_STORAGE_UNREADABLE',
      retryable: true,
      status: { sessionId: 'session-1', status: LIVE_DUBBING_STATUS.RUNNING },
    });
    expect(harness.coordinator.storageState).toBe(LIVE_DUBBING_STORAGE_STATE.UNREADABLE);
    expect(harness.manager.acquire).toHaveBeenCalledOnce();
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
      sessionId: 'session-1',
      status: LIVE_DUBBING_STATUS.RUNNING,
    });

    const retry = await harness.coordinator.start({ data: { targetLanguage: 'de' } }, {});
    expect(retry).toMatchObject({ busy: true, current: { sessionId: 'session-1' } });
    expect(harness.manager.acquire).toHaveBeenCalledOnce();
  });

  it('uses active sender tab, and never trusts a popup tab ID payload', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en', tabId: 999 } }, {
      tab: { id: 42 },
    });

    expect(harness.browserAPI.tabs.query).not.toHaveBeenCalled();
    expect(harness.chromeAPI.tabCapture.getMediaStreamId).toHaveBeenCalledWith({ targetTabId: 42 });
  });

  it('stops on matching session, repeated stop is idempotent, and tab events ignore other tabs', async () => {
    const harness = createHarness();
    const started = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});

    const otherTab = await harness.coordinator.handleTabRemoved(99);
    const stopped = await harness.coordinator.stop({ data: { sessionId: started.status.sessionId } });
    const repeated = await harness.coordinator.stop({ data: { sessionId: started.status.sessionId } });
    const actions = harness.browserAPI.runtime.sendMessage.mock.calls.map(([message]) => message.action);

    expect(otherTab).toMatchObject({ ignored: true, stopped: false });
    expect(stopped).toMatchObject({ success: true, stopped: true });
    expect(repeated).toMatchObject({ success: true, idempotent: true });
    expect(harness.coordinator.sessionRegistry.getSessionState(started.status.sessionId)).toBeNull();
    expect(actions).toEqual([
      'LIVE_DUBBING_PREPARE',
      'LIVE_DUBBING_CONSUME',
      'LIVE_DUBBING_CONNECT_PROVIDER',
      'LIVE_DUBBING_DISPOSE',
    ]);
  });

  it('retains terminal ownership when descriptor clear fails after exact disposal and release', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    harness.browserAPI.storage.session.remove.mockRejectedValueOnce(new Error('storage unavailable'));

    const failed = await harness.coordinator.stop({ data: { sessionId: 'session-1' } });
    const retried = await harness.coordinator.stop({ data: { sessionId: 'session-1' } });
    const disposeMessages = harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(message => message.action === 'LIVE_DUBBING_DISPOSE');

    expect(failed).toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_STORAGE_CLEAR_FAILED',
      retryable: true,
      cleanupPending: true,
      status: { sessionId: 'session-1', status: LIVE_DUBBING_STATUS.STOPPING },
    });
    expect(failed).not.toHaveProperty('ignored');
    expect(failed).not.toHaveProperty('stopped', true);
    expect(retried).toMatchObject({ success: true, stopped: true, status: null });
    expect(disposeMessages).toHaveLength(1);
    expect(harness.manager.release).toHaveBeenCalledTimes(1);
    expect(harness.manager.release).toHaveBeenCalledWith({
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'session-1',
    });
    expect(harness.coordinator.sessionRegistry.getSessionState('session-1')).toBeNull();
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
  });

  it('continues exact cleanup when STOPPING persistence fails', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const originalSet = harness.browserAPI.storage.session.set.getMockImplementation();
    harness.browserAPI.storage.session.set.mockImplementation(async record => {
      if (record[LIVE_DUBBING_STORAGE_KEY]?.status === LIVE_DUBBING_STATUS.STOPPING) {
        throw new Error('STOPPING persistence unavailable');
      }
      return originalSet(record);
    });

    const result = await harness.coordinator.stop({ data: { sessionId: 'session-1' } });

    expect(result).toMatchObject({ success: true, stopped: true, status: null });
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .filter(([message]) => message.action === 'LIVE_DUBBING_DISPOSE')).toHaveLength(1);
    expect(harness.manager.release).toHaveBeenCalledOnce();
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
  });

  it('joins a cleanup retry after STOPPING persistence failure without duplicate disposal or release', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const originalSet = harness.browserAPI.storage.session.set.getMockImplementation();
    harness.browserAPI.storage.session.set.mockImplementation(async record => {
      if (record[LIVE_DUBBING_STORAGE_KEY]?.status === LIVE_DUBBING_STATUS.STOPPING) {
        throw new Error('STOPPING persistence unavailable');
      }
      return originalSet(record);
    });
    let resolveDispose;
    const originalSendMessage = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        return new Promise(resolve => { resolveDispose = resolve; });
      }
      return originalSendMessage(message);
    });

    const firstStop = harness.coordinator.stop({ data: { sessionId: 'session-1' } });
    while (!resolveDispose) await Promise.resolve();
    const retry = harness.coordinator.stop({ data: { sessionId: 'session-1' } });
    resolveDispose({ success: false });

    await expect(firstStop).resolves.toMatchObject({
      success: false,
      error: 'STOP_FAILED',
      retryable: true,
      cleanupPending: true,
    });
    await expect(retry).resolves.toMatchObject({
      success: false,
      error: 'STOP_FAILED',
      retryable: true,
      cleanupPending: true,
    });
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .filter(([message]) => message.action === 'LIVE_DUBBING_DISPOSE')).toHaveLength(1);
    expect(harness.manager.release).not.toHaveBeenCalled();
  });

  it('fences fallback ERROR persistence against the original descriptor after STOPPING write failure', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const writes = [];
    const originalSet = harness.browserAPI.storage.session.set.getMockImplementation();
    harness.browserAPI.storage.session.set.mockImplementation(async record => {
      const descriptor = record[LIVE_DUBBING_STORAGE_KEY];
      if (descriptor) writes.push(descriptor.status);
      if (descriptor?.status === LIVE_DUBBING_STATUS.STOPPING) {
        throw new Error('STOPPING persistence unavailable');
      }
      return originalSet(record);
    });
    const originalSendMessage = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_DISPOSE') return { success: false };
      return originalSendMessage(message);
    });

    const result = await harness.coordinator.stop({ data: { sessionId: 'session-1' } });

    expect(result).toMatchObject({
      success: false,
      error: 'STOP_FAILED',
      retryable: true,
      cleanupPending: true,
      status: { status: LIVE_DUBBING_STATUS.ERROR },
    });
    expect(writes).toEqual([LIVE_DUBBING_STATUS.STOPPING, LIVE_DUBBING_STATUS.ERROR]);
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
      sessionId: 'session-1',
      status: LIVE_DUBBING_STATUS.ERROR,
      lastError: 'STOP_FAILED',
    });
  });

  it('does not clean up when the STOPPING write loses its readable descriptor fence', async () => {
    const descriptor = {
      sessionId: 'session-a',
      tabId: 42,
      providerId: 'gemini',
      targetLanguage: 'en',
      status: LIVE_DUBBING_STATUS.RUNNING,
      startedAt: 1,
      lastError: null,
      eventSequence: 3,
    };
    const newer = {
      ...descriptor,
      sessionId: 'session-b',
      startedAt: 2,
      eventSequence: 4,
    };
    const harness = createHarness({ stored: descriptor });
    const originalGet = harness.browserAPI.storage.session.get.getMockImplementation();
    let descriptorReads = 0;
    harness.browserAPI.storage.session.get.mockImplementation(async key => {
      const result = await originalGet(key);
      if (key === LIVE_DUBBING_STORAGE_KEY && descriptorReads++ === 1) {
        harness.storage.set(LIVE_DUBBING_STORAGE_KEY, newer);
        return { [LIVE_DUBBING_STORAGE_KEY]: newer };
      }
      return result;
    });

    const result = await harness.coordinator.stop({ data: { sessionId: 'session-a' } });

    expect(result).toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_STORAGE_UNWRITABLE',
      retryable: true,
      status: newer,
    });
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toEqual(newer);
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .some(([message]) => message.action === 'LIVE_DUBBING_DISPOSE')).toBe(false);
    expect(harness.manager.release).not.toHaveBeenCalled();
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toBeUndefined();
  });

  it('retries a new STOP after failed persistence and cleanup without double release', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const originalSet = harness.browserAPI.storage.session.set.getMockImplementation();
    let stoppingWriteFailed = true;
    harness.browserAPI.storage.session.set.mockImplementation(async record => {
      if (stoppingWriteFailed
        && record[LIVE_DUBBING_STORAGE_KEY]?.status === LIVE_DUBBING_STATUS.STOPPING) {
        stoppingWriteFailed = false;
        throw new Error('STOPPING persistence unavailable');
      }
      return originalSet(record);
    });
    let disposeAttempts = 0;
    const originalSendMessage = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        disposeAttempts += 1;
        if (disposeAttempts === 1) return { success: false };
      }
      return originalSendMessage(message);
    });

    const firstStop = await harness.coordinator.stop({ data: { sessionId: 'session-1' } });

    expect(firstStop).toMatchObject({
      success: false,
      error: 'STOP_FAILED',
      retryable: true,
      cleanupPending: true,
    });
    expect(disposeAttempts).toBe(1);
    expect(harness.manager.release).not.toHaveBeenCalled();
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
      sessionId: 'session-1',
      status: LIVE_DUBBING_STATUS.ERROR,
    });

    const retry = await harness.coordinator.stop({ data: { sessionId: 'session-1' } });

    expect(retry).toMatchObject({ success: true, stopped: true, status: null });
    expect(disposeAttempts).toBe(2);
    expect(harness.manager.release).toHaveBeenCalledOnce();
    expect(harness.manager.release).toHaveBeenCalledWith({
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'session-1',
    });
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
  });

  it('bounds STOP while canonical disposal is pending and releases only after it settles', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const originalSendMessage = harness.browserAPI.runtime.sendMessage.getMockImplementation();
      let resolveDispose;
      harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
        if (message.action === 'LIVE_DUBBING_DISPOSE') {
          return new Promise(resolve => { resolveDispose = resolve; });
        }
        return originalSendMessage(message);
      });

      await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
      const firstStop = harness.coordinator.stop({ data: { sessionId: 'session-1' } });
      while (!resolveDispose) await Promise.resolve();

      await vi.advanceTimersByTimeAsync(LIVE_DUBBING_STOP_TIMEOUT);
      await expect(firstStop).resolves.toMatchObject({
        success: false,
        error: 'LIVE_DUBBING_STOP_TIMEOUT',
        retryable: true,
        cleanupPending: true,
        status: { sessionId: 'session-1', status: LIVE_DUBBING_STATUS.STOPPING },
      });
      expect(harness.manager.release).not.toHaveBeenCalled();
      expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
        sessionId: 'session-1',
        status: LIVE_DUBBING_STATUS.STOPPING,
      });

      const secondStop = harness.coordinator.stop({ data: { sessionId: 'session-1' } });
      await vi.advanceTimersByTimeAsync(LIVE_DUBBING_STOP_TIMEOUT);
      await expect(secondStop).resolves.toMatchObject({
        success: false,
        error: 'LIVE_DUBBING_STOP_TIMEOUT',
        cleanupPending: true,
      });
      expect(harness.browserAPI.runtime.sendMessage.mock.calls
        .map(([message]) => message)
        .filter(message => message.action === 'LIVE_DUBBING_DISPOSE'))
        .toHaveLength(2);

      resolveDispose({
        success: true,
        ack: 'DISPOSED',
        sessionId: 'session-1',
        providerId: 'gemini',
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(harness.manager.release).toHaveBeenCalledOnce();
      expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
      await expect(harness.coordinator.stop({ data: { sessionId: 'session-1' } }))
        .resolves.toMatchObject({ success: true, idempotent: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves STATUS immediately while START is pending without joining its queue', async () => {
    const harness = createHarness();
    const originalSendMessage = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    let resolvePrepare;
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_PREPARE') {
        return new Promise(resolve => { resolvePrepare = resolve; });
      }
      return originalSendMessage(message);
    });

    const startPromise = harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    while (!resolvePrepare) await Promise.resolve();

    // A reopened popup recovers from this authoritative snapshot instead of
    // waiting behind the pending START mutation.
    let statusSettled = false;
    const statusPromise = harness.coordinator.getStatus().then(result => {
      statusSettled = true;
      return result;
    });
    for (let i = 0; i < 10 && !statusSettled; i += 1) await Promise.resolve();
    expect(statusSettled).toBe(true);
    await expect(statusPromise).resolves.toMatchObject({
      success: true,
      status: { sessionId: 'session-1', status: LIVE_DUBBING_STATUS.PREPARING_CAPTURE },
    });

    resolvePrepare({
      success: true,
      ack: 'READY',
      sessionId: 'session-1',
      providerId: 'gemini',
      eventSequence: 0,
    });
    await expect(startPromise).resolves.toMatchObject({ success: true });
  });

  it('cancels a pending START via authoritative STOP with cleanup, release, and no late RUNNING', async () => {
    const harness = createHarness();
    const originalSendMessage = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    let resolveConsume;
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_PREPARE') {
        return {
          success: true,
          ack: 'READY',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          eventSequence: message.data.eventSequence,
        };
      }
      if (message.action === 'LIVE_DUBBING_CONSUME') {
        return new Promise(resolve => { resolveConsume = resolve; });
      }
      return originalSendMessage(message);
    });

    const startPromise = harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    while (!resolveConsume) await Promise.resolve();

    const stopped = await harness.coordinator.stop({ data: { sessionId: 'session-1' } });
    expect(stopped).toMatchObject({ success: true, stopped: true, status: null });
    expect(harness.manager.release).toHaveBeenCalledOnce();
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);

    resolveConsume({
      success: true,
      ack: 'MEDIA_ACQUIRED',
      sessionId: 'session-1',
      providerId: 'gemini',
      status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
      eventSequence: 1,
      captureReady: true,
      audioPathReady: true,
      inputPipelineReady: true,
      outputPipelineReady: true,
    });
    const started = await startPromise;
    expect(started.success).toBe(false);
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
    const persistedStatuses = harness.browserAPI.storage.session.set.mock.calls
      .flatMap(([record]) => Object.values(record))
      .filter(value => value && typeof value === 'object' && typeof value.status === 'string')
      .map(value => value.status);
    expect(persistedStatuses).not.toContain(LIVE_DUBBING_STATUS.RUNNING);
    expect(harness.manager.release).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed START with pending cleanup stoppable and reconstructs it from STATUS', async () => {
    const harness = createHarness();
    const originalSendMessage = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    let disposeCalls = 0;
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_CONSUME') {
        return { success: false, error: 'LIVE_DUBBING_OFFSCREEN_BUSY' };
      }
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        disposeCalls += 1;
        if (disposeCalls === 1) return { success: false, error: 'DISPOSE_TRANSPORT_FAILED' };
      }
      return originalSendMessage(message);
    });

    const failed = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    expect(failed).toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_START_FAILED',
      retryable: true,
      cleanupPending: true,
    });
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
      sessionId: 'session-1',
      status: LIVE_DUBBING_STATUS.ERROR,
    });
    expect(harness.manager.release).not.toHaveBeenCalled();

    await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
      success: true,
      status: { sessionId: 'session-1', status: LIVE_DUBBING_STATUS.ERROR },
    });

    const stopped = await harness.coordinator.stop({ data: { sessionId: 'session-1' } });
    expect(stopped).toMatchObject({ success: true, stopped: true, status: null });
    expect(disposeCalls).toBe(2);
    expect(harness.manager.release).toHaveBeenCalledOnce();
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
  });

  it('bounds STOP retries while controller physical teardown is slow/delayed', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const track = {
        kind: 'audio',
        readyState: 'live',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        stop: vi.fn(),
      };
      let resolveProviderDispose;
      const providerDispose = vi.fn(() => new Promise(resolve => { resolveProviderDispose = resolve; }));
      const inputPipeline = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
      const outputPlayer = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), clear: vi.fn() };
      const providerClient = { connect: vi.fn(async () => {}), dispose: providerDispose, close: vi.fn() };
      const sender = {
        id: 'extension-id',
        url: 'chrome-extension://extension-id/src/html/offscreen.html',
      };
      const offscreen = new LiveDubbingController({
        mediaDevices: { getUserMedia: vi.fn(async () => ({
          getAudioTracks: () => [track],
          getTracks: () => [track],
        })) },
        inputPipelineFactory: vi.fn(async () => inputPipeline),
        outputPlayerFactory: vi.fn(async () => outputPlayer),
        providerClient,
        requestBootstrap: request => harness.coordinator.authorizeOffscreenControlMessage(request, sender, { type: 'bootstrap' })
          .then(descriptor => descriptor
            ? {
              success: true,
              providerId: descriptor.providerId,
              targetLanguage: descriptor.targetLanguage,
              bootstrap: { accessToken: 'handler-token' },
            }
            : { success: false }),
        notify: vi.fn(),
      });
      harness.browserAPI.runtime.sendMessage.mockImplementation(message => {
        harness.calls.push(['message', message]);
        return offscreen.handle(message);
      });

      const started = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
      expect(started).toMatchObject({ success: true, status: { sessionId: 'session-1' } });

      // First STOP: the single physical teardown starts but is slow/delayed.
      // The externally visible wait is bounded; ownership is retained.
      const firstStop = harness.coordinator.stop({ data: { sessionId: 'session-1' } });
      while (!resolveProviderDispose) await Promise.resolve();
      expect(providerDispose).toHaveBeenCalledOnce();
      expect(offscreen.prepare('session-2', 'gemini', 'en', 0)).toMatchObject({
        success: false,
        error: 'LIVE_DUBBING_SESSION_DISPOSED',
        ignored: true,
      });

      await vi.advanceTimersByTimeAsync(LIVE_DUBBING_STOP_TIMEOUT);
      await expect(firstStop).resolves.toMatchObject({
        success: false,
        retryable: true,
        cleanupPending: true,
        status: { sessionId: 'session-1' },
      });
      expect(harness.manager.release).not.toHaveBeenCalled();
      expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({ sessionId: 'session-1' });

      // Second attempt: fresh transport delivery joins the same canonical
      // physical promise. No concurrent duplicate teardown, no false success.
      const secondStop = harness.coordinator.stop({ data: { sessionId: 'session-1' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(providerDispose).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(LIVE_DUBBING_STOP_TIMEOUT);
      await expect(secondStop).resolves.toMatchObject({
        success: false,
        retryable: true,
        cleanupPending: true,
        status: { sessionId: 'session-1' },
      });
      expect(providerDispose).toHaveBeenCalledOnce();
      expect(harness.manager.release).not.toHaveBeenCalled();
      expect(offscreen.prepare('session-2', 'gemini', 'en', 0)).toMatchObject({
        success: false,
        error: 'LIVE_DUBBING_SESSION_DISPOSED',
      });

      // Authoritative success: resolving the single physical teardown lets a
      // fresh exact DISPOSE acknowledge exactly once. Stale pending results
      // never became DISPOSED on their own and never corrupted a new session.
      resolveProviderDispose();
      await vi.advanceTimersByTimeAsync(0);

      const thirdStop = harness.coordinator.stop({ data: { sessionId: 'session-1' } });
      await expect(thirdStop).resolves.toMatchObject({ success: true, stopped: true, status: null });
      expect(providerDispose).toHaveBeenCalledOnce();
      expect(harness.manager.release).toHaveBeenCalledOnce();
      expect(harness.manager.release).toHaveBeenCalledWith({
        owner: LIVE_DUBBING_OWNER,
        leaseId: 'session-1',
      });
      expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
      expect(offscreen.prepare('session-2', 'gemini', 'en', 0)).toMatchObject({
        success: true,
        sessionId: 'session-2',
      });
      expect(offscreen.currentSession).toMatchObject({ sessionId: 'session-2' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers permanently hung physical teardown via offscreen recreation and reconciliation', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const track = {
        kind: 'audio',
        readyState: 'live',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        stop: vi.fn(),
      };
      // NEVER resolved by design: the old physical teardown stays pending
      // forever. No resolver is captured and nothing resolves it below.
      const providerDispose = vi.fn(() => new Promise(() => {}));
      const inputPipeline = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
      const outputPlayer = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), clear: vi.fn() };
      const providerClient = { connect: vi.fn(async () => {}), dispose: providerDispose, close: vi.fn() };
      const sender = {
        id: 'extension-id',
        url: 'chrome-extension://extension-id/src/html/offscreen.html',
      };
      const authorizeBootstrap = request => harness.coordinator.authorizeOffscreenControlMessage(request, sender, { type: 'bootstrap' })
        .then(descriptor => descriptor
          ? {
            success: true,
            providerId: descriptor.providerId,
            targetLanguage: descriptor.targetLanguage,
            bootstrap: { accessToken: 'handler-token' },
          }
          : { success: false });
      const oldNotify = vi.fn();
      const oldController = new LiveDubbingController({
        mediaDevices: { getUserMedia: vi.fn(async () => ({
          getAudioTracks: () => [track],
          getTracks: () => [track],
        })) },
        inputPipelineFactory: vi.fn(async () => inputPipeline),
        outputPlayerFactory: vi.fn(async () => outputPlayer),
        providerClient,
        requestBootstrap: authorizeBootstrap,
        notify: oldNotify,
      });
      harness.browserAPI.runtime.sendMessage.mockImplementation(message => {
        harness.calls.push(['message', message]);
        return oldController.handle(message);
      });

      const started = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
      expect(started).toMatchObject({ success: true, status: { sessionId: 'session-1' } });

      const firstStop = harness.coordinator.stop({ data: { sessionId: 'session-1' } });
      while (providerDispose.mock.calls.length === 0) await Promise.resolve();
      expect(providerDispose).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(LIVE_DUBBING_STOP_TIMEOUT);
      await expect(firstStop).resolves.toMatchObject({
        success: false,
        retryable: true,
        cleanupPending: true,
        status: { sessionId: 'session-1' },
      });
      expect(harness.manager.release).not.toHaveBeenCalled();
      expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({ sessionId: 'session-1' });

      const secondStop = harness.coordinator.stop({ data: { sessionId: 'session-1' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(providerDispose).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(LIVE_DUBBING_STOP_TIMEOUT);
      await expect(secondStop).resolves.toMatchObject({
        success: false,
        retryable: true,
        cleanupPending: true,
        status: { sessionId: 'session-1' },
      });
      expect(providerDispose).toHaveBeenCalledOnce();
      expect(harness.manager.release).not.toHaveBeenCalled();
      expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({ sessionId: 'session-1' });

      // Simulate offscreen destruction/recreation: swap in a fresh controller
      // with healthy doubles. The old permanently pending physical promise is
      // abandoned by design; it is never resolved and never retried
      // concurrently.
      const freshTrack = {
        kind: 'audio',
        readyState: 'live',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        stop: vi.fn(),
      };
      const freshInputPipeline = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
      const freshOutputPlayer = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), clear: vi.fn() };
      const freshProvider = { connect: vi.fn(async () => {}), dispose: vi.fn(async () => {}), close: vi.fn() };
      const freshController = new LiveDubbingController({
        mediaDevices: { getUserMedia: vi.fn(async () => ({
          getAudioTracks: () => [freshTrack],
          getTracks: () => [freshTrack],
        })) },
        inputPipelineFactory: vi.fn(async () => freshInputPipeline),
        outputPlayerFactory: vi.fn(async () => freshOutputPlayer),
        providerClient: freshProvider,
        requestBootstrap: authorizeBootstrap,
        notify: vi.fn(),
      });
      harness.browserAPI.runtime.sendMessage.mockImplementation(message => {
        harness.calls.push(['message', message]);
        return freshController.handle(message);
      });
      harness.manager.documentExists = true;

      expect(oldController.disposedSession.cleanupComplete).toBe(false);
      expect(freshController.currentSession).toBeNull();
      expect(freshController.disposedSession).toBeNull();

      // Existing production recovery path, no new contract.
      const reconciled = await harness.coordinator.reconcile();
      expect(reconciled).toMatchObject({ success: true, status: null, stale: true, retryable: false });
      expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
      expect(harness.manager.release).toHaveBeenCalledTimes(1);
      expect(harness.manager.release).toHaveBeenCalledWith({
        owner: LIVE_DUBBING_OWNER,
        leaseId: 'session-1',
      });

      // No false provider/session inference: exactly one STATUS probe for the
      // exact old session/provider.
      const statusProbes = harness.browserAPI.runtime.sendMessage.mock.calls
        .map(([message]) => message)
        .filter(message => message.action === 'LIVE_DUBBING_STATUS');
      expect(statusProbes).toHaveLength(1);
      expect(statusProbes[0]).toMatchObject({ data: { sessionId: 'session-1', providerId: 'gemini' } });

      // Abandoned old-controller callbacks cannot affect cleared state.
      const oldSession = oldController.disposedSession.session;
      oldController._handleTrackEnded(oldSession);
      providerClient.onError?.(new Error('abandoned old controller'));
      providerClient.onClose?.({ code: 1000, wasClean: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
      expect(harness.manager.release).toHaveBeenCalledTimes(1);
      expect(freshController.currentSession).toBeNull();
      expect(oldNotify).not.toHaveBeenCalled();

      // New session works after recovery.
      expect(freshController.prepare('session-2', 'gemini', 'en', 0)).toMatchObject({
        success: true,
        sessionId: 'session-2',
      });
      await freshController.dispose('session-2', 'gemini');
      harness.coordinator.uuid = () => 'session-3';
      const restarted = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
      expect(restarted).toMatchObject({ success: true, status: { sessionId: 'session-3' } });
      expect(providerDispose).toHaveBeenCalledOnce();
      expect(freshProvider.dispose).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pre-capture start before creating a descriptor', async () => {
    const harness = createHarness();
    let resolveTabs;
    harness.browserAPI.tabs.query.mockImplementationOnce(() => new Promise(resolve => {
      resolveTabs = resolve;
    }));
    const startPromise = harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});

    while (!resolveTabs) await Promise.resolve();
    const pendingStop = await harness.coordinator.stop({ data: { sessionId: 'session-1' } });
    resolveTabs([{ id: 42, url: 'https://example.test' }]);

    const failedStart = await startPromise;
    expect(pendingStop).toMatchObject({ success: true, pending: true, stopped: false });
    expect(failedStart).toEqual({ success: false, error: 'LIVE_DUBBING_START_CANCELLED' });
    expect(harness.coordinator.sessionRegistry.getSessionState('session-1')).toBeNull();
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
    expect(harness.manager.acquire).not.toHaveBeenCalled();
    expect(harness.browserAPI.runtime.sendMessage).not.toHaveBeenCalled();

    const retried = await harness.coordinator.stop({ data: { sessionId: 'session-1' } });

    expect(retried).toMatchObject({ success: true, idempotent: true, status: null });
    expect(harness.coordinator.sessionRegistry.getSessionState('session-1')).toBeNull();
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
    expect(harness.manager.release).not.toHaveBeenCalled();
    expect(harness.browserAPI.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('only cancels a pending start for its exact tab during tab resolution', async () => {
    const harness = createHarness();
    let resolveTab;
    harness.browserAPI.tabs.get.mockImplementationOnce(() => new Promise(resolve => {
      resolveTab = resolve;
    }));
    const startPromise = harness.coordinator.start({ data: { targetLanguage: 'en' } }, {
      tab: { id: 42 },
      url: 'https://example.test',
    });

    while (!resolveTab) await Promise.resolve();

    await expect(harness.coordinator.handleTabRemoved(99)).resolves.toMatchObject({
      success: true,
      ignored: true,
    });
    await expect(harness.coordinator.handleTopLevelNavigation(99)).resolves.toMatchObject({
      success: true,
      ignored: true,
    });
    expect(harness.coordinator.sessionRegistry.listPendingStarts()[0].terminalRequested).toBe(false);

    await expect(harness.coordinator.handleTopLevelNavigation(42)).resolves.toMatchObject({
      success: true,
      pending: true,
      stopped: false,
      reason: 'TOP_LEVEL_NAVIGATION',
    });
    resolveTab({ id: 42, url: 'https://example.test' });

    await expect(startPromise).resolves.toEqual({
      success: false,
      error: 'LIVE_DUBBING_START_CANCELLED',
    });
    expect(harness.manager.acquire).not.toHaveBeenCalled();
    expect(harness.browserAPI.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['TAB_REMOVED', 'TOP_LEVEL_NAVIGATION'])('cancels an extension-sender start only when the delayed authoritative tab matches (%s)', async event => {
      const harness = createHarness();
      let resolveTabs;
      harness.browserAPI.tabs.query.mockImplementationOnce(() => new Promise(resolve => {
        resolveTabs = resolve;
      }));
      const startPromise = harness.coordinator.start({ data: { targetLanguage: 'en' } }, {
        id: 'extension-id',
        url: 'chrome-extension://extension-id/src/html/popup.html',
      });

      while (!resolveTabs) await Promise.resolve();

      await expect(harness.coordinator.handleTabRemoved(99)).resolves.toMatchObject({
        success: true,
        pending: true,
        stopped: false,
      });
      await expect(harness.coordinator.handleTopLevelNavigation(99)).resolves.toMatchObject({
        success: true,
        pending: true,
        stopped: false,
      });
      expect(harness.coordinator.sessionRegistry.listPendingStarts()[0].terminalRequested).toBe(false);

      const matchingEvent = event === 'TAB_REMOVED'
        ? harness.coordinator.handleTabRemoved(42)
        : harness.coordinator.handleTopLevelNavigation(42);
      await expect(matchingEvent).resolves.toMatchObject({
        success: true,
        pending: true,
        stopped: false,
      });
      expect(harness.coordinator.sessionRegistry.listPendingStarts()[0].terminalRequested).toBe(false);

      resolveTabs([{ id: 42, url: 'https://example.test' }]);

      await expect(startPromise).resolves.toEqual({
        success: false,
        error: 'LIVE_DUBBING_START_CANCELLED',
      });
      expect(harness.browserAPI.tabs.query).toHaveBeenCalledOnce();
      expect(harness.manager.acquire).not.toHaveBeenCalled();
      expect(harness.chromeAPI.tabCapture.getMediaStreamId).not.toHaveBeenCalled();
      expect(harness.browserAPI.runtime.sendMessage).not.toHaveBeenCalled();
    });

  it.each(['TAB_REMOVED', 'TOP_LEVEL_NAVIGATION'])('records delayed tab events for queued unresolved starts after a different known start (%s)', async event => {
      const harness = createHarness();
      harness.coordinator.uuid = vi.fn()
        .mockReturnValueOnce('session-a')
        .mockReturnValueOnce('session-b');
      let resolveKnownTab;
      harness.browserAPI.tabs.get.mockImplementationOnce(() => new Promise(resolve => {
        resolveKnownTab = resolve;
      }));

      const startA = harness.coordinator.start({ data: { targetLanguage: 'en' } }, {
        tab: { id: 41 },
        url: 'https://example.test',
      });
      while (!resolveKnownTab) await Promise.resolve();

      const startB = harness.coordinator.start({ data: { targetLanguage: 'en' } }, {
        id: 'extension-id',
        url: 'chrome-extension://extension-id/src/html/popup.html',
      });
      const pendingB = harness.coordinator.sessionRegistry.listPendingStarts()
        .find(pending => pending.sessionId === 'session-b');

      const tabEvent = event === 'TAB_REMOVED'
        ? harness.coordinator.handleTabRemoved(42)
        : harness.coordinator.handleTopLevelNavigation(42);
      await expect(tabEvent).resolves.toMatchObject({
        success: true,
        pending: true,
        stopped: false,
        reason: event,
      });
      expect(pendingB.terminalRequested).toBe(false);
      expect(pendingB.tabEventIds).toContain(42);

      await expect(harness.coordinator.stop({ data: { sessionId: 'session-a' } })).resolves.toMatchObject({
        success: true,
        pending: true,
        stopped: false,
      });
      resolveKnownTab({ id: 41, url: 'https://example.test' });

      await expect(startA).resolves.toEqual({
        success: false,
        error: 'LIVE_DUBBING_START_CANCELLED',
      });
      await expect(startB).resolves.toEqual({
        success: false,
        error: 'LIVE_DUBBING_START_CANCELLED',
      });
      expect(harness.browserAPI.tabs.query).toHaveBeenCalledOnce();
      expect(harness.manager.acquire).not.toHaveBeenCalled();
      expect(harness.chromeAPI.tabCapture.getMediaStreamId).not.toHaveBeenCalled();
      expect(harness.browserAPI.runtime.sendMessage).not.toHaveBeenCalled();
    });

  it('does not release lease after stale ignored dispose response', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    harness.browserAPI.runtime.sendMessage.mockImplementationOnce(async message => {
      harness.calls.push(['message', message]);
      return {
        success: true,
        ack: 'DISPOSED',
        disposed: true,
        ignored: true,
        sessionId: 'stale-session',
      };
    });

    const result = await harness.coordinator.stop({ data: { sessionId: 'session-1' } });

    expect(result).toMatchObject({
      success: false,
      error: 'STOP_FAILED',
      retryable: true,
      cleanupPending: true,
    });
    expect(harness.manager.release).not.toHaveBeenCalled();
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
      sessionId: 'session-1',
      status: LIVE_DUBBING_STATUS.ERROR,
    });
  });

  it('persists CONNECTING_PROVIDER and fences a late provider response after stop', async () => {
    const harness = createHarness();
    let resolveProvider;
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      harness.calls.push(['message', message]);
      if (message.action === 'LIVE_DUBBING_PREPARE') {
        return {
          success: true,
          ack: 'READY',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          eventSequence: message.data.eventSequence,
        };
      }
      if (message.action === 'LIVE_DUBBING_CONSUME') {
        return {
          success: true,
          ack: 'MEDIA_ACQUIRED',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
          eventSequence: message.data.eventSequence,
          captureReady: true,
          audioPathReady: true,
          inputPipelineReady: true,
       outputPipelineReady: true,
        };
      }
      if (message.action === 'LIVE_DUBBING_CONNECT_PROVIDER') {
        return new Promise(resolve => { resolveProvider = resolve; });
      }
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        return {
          success: true,
          ack: 'DISPOSED',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
        };
      }
      return { success: true };
    });

    const startPromise = harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    while (!resolveProvider) await Promise.resolve();
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
      status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
    });

    const stop = await harness.coordinator.stop({ data: { sessionId: 'session-1' } });
    expect(stop).toMatchObject({ success: true, stopped: true });
    resolveProvider({
      success: true,
      ack: 'PROVIDER_READY',
      sessionId: 'session-1',
      providerId: 'gemini',
      status: LIVE_DUBBING_STATUS.RUNNING,
      eventSequence: 3,
      captureReady: true,
      audioPathReady: true,
      inputPipelineReady: true,
      outputPipelineReady: true,
      setupComplete: true,
    });

    await expect(startPromise).resolves.toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_START_FAILED',
    });
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
  });

  it('returns and logs a close-only provider diagnostic through START_FAILED', async () => {
    const harness = createHarness();
    const track = {
      kind: 'audio',
      readyState: 'live',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      stop: vi.fn(),
    };
    const inputPipeline = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const outputPlayer = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      clear: vi.fn(),
    };
    const provider = {
      connect: vi.fn(() => provider.onClose(
        { code: 1006, wasClean: false },
        {
          stage: 'REMOTE_ERROR',
          code: 'GEMINI_LIVE_PROVIDER_CLOSED',
          closeCode: 1006,
          wasClean: false,
          terminalCategory: 'SOCKET_CLOSED',
          wsOpen: true,
          setupSent: true,
          setupComplete: false,
          message: 'provider-body-secret',
          key: 'secret-key',
        },
      )),
      close: vi.fn(),
    };
    const offscreen = new LiveDubbingController({
      mediaDevices: { getUserMedia: vi.fn(async () => ({
        getAudioTracks: () => [track],
        getTracks: () => [track],
      })) },
      inputPipeline,
      outputPlayer,
      providerClient: provider,
      requestBootstrap: vi.fn().mockResolvedValue({
        success: true,
        providerId: 'gemini',
        targetLanguage: 'en',
        bootstrap: { accessToken: 'test-token' },
      }),
      notify: vi.fn(),
    });
    harness.browserAPI.runtime.sendMessage.mockImplementation(message => {
      harness.calls.push(['message', message]);
      return offscreen.handle(message);
    });

    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});

    expect(result).toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_PROVIDER_SETUP_FAILED',
      providerDiagnostic: {
        stage: 'CONNECT_PROVIDER',
        code: 'GEMINI_LIVE_PROVIDER_CLOSED',
        closeCode: 1006,
        wasClean: false,
        terminalCategory: 'SOCKET_CLOSED',
        wsOpen: true,
        setupSent: true,
        setupComplete: false,
      },
    });
    expect(harness.logger.warn).toHaveBeenCalledWith(
      'Live dubbing provider startup failed',
      result.providerDiagnostic,
    );
    expect(JSON.stringify(harness.logger.warn.mock.calls)).not.toContain('provider-body-secret');
    expect(provider.close).toHaveBeenCalledOnce();
    expect(inputPipeline.stop).toHaveBeenCalledOnce();
    expect(outputPlayer.stop).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(harness.manager.release).toHaveBeenCalledWith({
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'session-1',
    });
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
  });

  it('accepts an earlier-sequence Offscreen terminal while provider setup is connecting', async () => {
    const harness = createHarness();
    let resolveProvider;
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      harness.calls.push(['message', message]);
      if (message.action === 'LIVE_DUBBING_PREPARE') {
        return {
          success: true,
          ack: 'READY',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          eventSequence: message.data.eventSequence,
        };
      }
      if (message.action === 'LIVE_DUBBING_CONSUME') {
        return {
          success: true,
          ack: 'MEDIA_ACQUIRED',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
          eventSequence: message.data.eventSequence,
          captureReady: true,
          audioPathReady: true,
          inputPipelineReady: true,
       outputPipelineReady: true,
        };
      }
      if (message.action === 'LIVE_DUBBING_CONNECT_PROVIDER') {
        return new Promise(resolve => { resolveProvider = resolve; });
      }
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        return {
          success: true,
          ack: 'DISPOSED',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
        };
      }
      return { success: true };
    });

    const startPromise = harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    while (!resolveProvider) await Promise.resolve();

    const terminal = harness.coordinator.handleOffscreenTerminal({
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence: 1,
        event: 'TRACK_ENDED',
        providerDiagnostic: {
          stage: 'CONNECT_PROVIDER',
          code: 'GEMINI_LIVE_REMOTE_ERROR',
          closeCode: 1011,
          wasClean: false,
          terminalCategory: 'REMOTE_ERROR',
          wsOpen: true,
          setupSent: true,
          setupComplete: false,
        },
      },
    }, {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    });
    await expect(terminal).resolves.toMatchObject({ success: true, stopped: true });

    resolveProvider({
      success: true,
      ack: 'PROVIDER_READY',
      sessionId: 'session-1',
      providerId: 'gemini',
      status: LIVE_DUBBING_STATUS.RUNNING,
      eventSequence: 3,
      captureReady: true,
      audioPathReady: true,
      inputPipelineReady: true,
      outputPipelineReady: true,
      setupComplete: true,
      providerDiagnostic: {
        stage: 'CONNECT_PROVIDER',
        code: 'STALE_PROVIDER_ERROR',
        closeCode: 1006,
        wasClean: false,
        terminalCategory: 'STALE_RESPONSE',
        wsOpen: true,
        setupSent: true,
        setupComplete: false,
      },
    });
    await expect(startPromise).resolves.toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_PROVIDER_SETUP_FAILED',
      providerDiagnostic: {
        code: 'GEMINI_LIVE_REMOTE_ERROR',
        terminalCategory: 'REMOTE_ERROR',
      },
    });
    expect(harness.logger.warn).toHaveBeenCalledWith(
      'Live dubbing provider startup failed',
      expect.objectContaining({
        stage: 'CONNECT_PROVIDER',
        code: 'GEMINI_LIVE_REMOTE_ERROR',
      }),
    );
    expect(harness.manager.release).toHaveBeenCalledWith({
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'session-1',
    });
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
  });

  it('fences a terminal event before RUNNING persistence and never stores stale RUNNING state', async () => {
    const harness = createHarness();
    let resolveProvider;
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      harness.calls.push(['message', message]);
      if (message.action === 'LIVE_DUBBING_PREPARE') {
        return {
          success: true,
          ack: 'READY',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          eventSequence: message.data.eventSequence,
        };
      }
      if (message.action === 'LIVE_DUBBING_CONSUME') {
        return {
          success: true,
          ack: 'MEDIA_ACQUIRED',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
          eventSequence: message.data.eventSequence,
          captureReady: true,
          audioPathReady: true,
          inputPipelineReady: true,
       outputPipelineReady: true,
        };
      }
      if (message.action === 'LIVE_DUBBING_CONNECT_PROVIDER') {
        return new Promise(resolve => { resolveProvider = resolve; });
      }
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        return {
          success: true,
          ack: 'DISPOSED',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
        };
      }
      return { success: true };
    });

    const startPromise = harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    while (!resolveProvider) await Promise.resolve();

    const terminalPromise = harness.coordinator.handleOffscreenTerminal({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 3, event: 'TRACK_ENDED' },
    }, {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    });
    resolveProvider({
      success: true,
      ack: 'PROVIDER_READY',
      sessionId: 'session-1',
      providerId: 'gemini',
      status: LIVE_DUBBING_STATUS.RUNNING,
      eventSequence: 3,
      captureReady: true,
      audioPathReady: true,
      inputPipelineReady: true,
      outputPipelineReady: true,
      setupComplete: true,
    });

    await expect(terminalPromise).resolves.toMatchObject({ success: true, stopped: true });
    await expect(startPromise).resolves.toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_START_FAILED',
    });
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)?.status)
      .not.toBe(LIVE_DUBBING_STATUS.RUNNING);
  });

  it('services the bootstrap request during provider setup without transition deadlock', async () => {
    const harness = createHarness();
    const sender = {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    };
    const track = {
      kind: 'audio',
      readyState: 'live',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      stop: vi.fn(),
    };
    const inputPipeline = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const outputPlayer = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      clear: vi.fn(),
    };
    const providerClient = { connect: vi.fn(async () => {}) };
    let bootstrapRequest;
    const offscreen = new LiveDubbingController({
      mediaDevices: { getUserMedia: vi.fn(async () => ({
        getAudioTracks: () => [track],
        getTracks: () => [track],
      })) },
      inputPipelineFactory: vi.fn(async () => inputPipeline),
      outputPlayerFactory: vi.fn(async () => outputPlayer),
      providerClient,
      requestBootstrap: request => {
        bootstrapRequest = request;
        return harness.coordinator.authorizeOffscreenControlMessage(request, sender, { type: 'bootstrap' })
          .then(descriptor => descriptor
            ? {
              success: true,
              providerId: descriptor.providerId,
              targetLanguage: descriptor.targetLanguage,
              bootstrap: { accessToken: 'handler-token' },
            }
            : { success: false });
      },
    });
    harness.browserAPI.runtime.sendMessage.mockImplementation(message => {
      harness.calls.push(['message', message]);
      return offscreen.handle(message);
    });

    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});

    expect(result).toMatchObject({ success: true, status: { status: LIVE_DUBBING_STATUS.RUNNING } });
    expect(bootstrapRequest).toMatchObject({
      action: 'LIVE_DUBBING_REQUEST_PROVIDER_BOOTSTRAP',
      data: { sessionId: 'session-1', providerId: 'gemini', targetLanguage: 'en', eventSequence: 2 },
    });
    expect(providerClient.connect).toHaveBeenCalledWith({
      bootstrap: { accessToken: 'handler-token' },
      targetLanguage: 'en',
    });
  });

  it('rejects stale and stop-fenced bootstrap requests without claiming transition ownership', async () => {
    const harness = createHarness();
    let resolveProvider;
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      harness.calls.push(['message', message]);
      if (message.action === 'LIVE_DUBBING_PREPARE') {
        return {
          success: true,
          ack: 'READY',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          eventSequence: message.data.eventSequence,
        };
      }
      if (message.action === 'LIVE_DUBBING_CONSUME') {
        return {
          success: true,
          ack: 'MEDIA_ACQUIRED',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
          eventSequence: message.data.eventSequence,
          captureReady: true,
          audioPathReady: true,
          inputPipelineReady: true,
       outputPipelineReady: true,
        };
      }
      if (message.action === 'LIVE_DUBBING_CONNECT_PROVIDER') {
        return new Promise(resolve => { resolveProvider = resolve; });
      }
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        return {
          success: true,
          ack: 'DISPOSED',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
        };
      }
      return { success: true };
    });

    const startPromise = harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    while (!resolveProvider) await Promise.resolve();

    const sender = {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    };
    const staleRequest = {
      action: 'LIVE_DUBBING_REQUEST_PROVIDER_BOOTSTRAP',
      data: { sessionId: 'stale-session', providerId: 'gemini', targetLanguage: 'en', eventSequence: 2 },
    };
    const transition = harness.coordinator.transition;
    await expect(harness.coordinator.authorizeOffscreenControlMessage(
      staleRequest,
      sender,
      { type: 'bootstrap' },
    )).resolves.toBeNull();
    expect(harness.coordinator.transition).toBe(transition);

    const request = {
      action: 'LIVE_DUBBING_REQUEST_PROVIDER_BOOTSTRAP',
      data: { sessionId: 'session-1', providerId: 'gemini', targetLanguage: 'en', eventSequence: 2 },
    };
    const authorized = await harness.coordinator.authorizeOffscreenControlMessage(
      request,
      sender,
      { type: 'bootstrap' },
    );
    expect(authorized).toMatchObject({ sessionId: 'session-1', status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER });

    const stopResult = await harness.coordinator.stop({ data: { sessionId: 'session-1' } });
    expect(stopResult).toEqual({ success: true, stopped: true, status: null, reason: 'STOP_REQUESTED' });
    expect(harness.coordinator.isBootstrapRequestStillAuthorized(authorized)).toBe(false);

    resolveProvider({
      success: true,
      ack: 'PROVIDER_READY',
      sessionId: 'session-1',
      providerId: 'gemini',
      status: LIVE_DUBBING_STATUS.RUNNING,
      eventSequence: 3,
      captureReady: true,
      audioPathReady: true,
      inputPipelineReady: true,
      outputPipelineReady: true,
      setupComplete: true,
    });
    await expect(startPromise).resolves.toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_START_FAILED',
    });
  });

  it('stops matching session on top-level navigation', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});

    const result = await harness.coordinator.handleTopLevelNavigation(42);

    expect(result).toMatchObject({ success: true, stopped: true, reason: 'TOP_LEVEL_NAVIGATION' });
    expect(harness.manager.release).toHaveBeenCalledOnce();
  });

  it('does not serialize tab teardown behind pending offscreen capture', async () => {
    const harness = createHarness();
    let resolveConsume;
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      harness.calls.push(['message', message]);
      if (message.action === 'LIVE_DUBBING_PREPARE') {
        return {
          success: true,
          ack: 'READY',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          eventSequence: message.data.eventSequence,
        };
      }
      if (message.action === 'LIVE_DUBBING_CONSUME') {
        return new Promise(resolve => { resolveConsume = resolve; });
      }
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        return {
          success: true,
          ack: 'DISPOSED',
          disposed: true,
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
        };
      }
      return { success: true };
    });

    const startPromise = harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    while (!resolveConsume) await Promise.resolve();

    const stopResult = await harness.coordinator.handleTabRemoved(42);
    expect(stopResult).toMatchObject({ success: true, stopped: true, reason: 'TAB_REMOVED' });
    expect(harness.manager.release).toHaveBeenCalledOnce();

    resolveConsume({
      success: true,
      ack: 'MEDIA_ACQUIRED',
      sessionId: 'session-1',
      providerId: 'gemini',
    });
    await expect(startPromise).resolves.toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_START_FAILED',
    });

    const disposeMessages = harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(message => message.action === 'LIVE_DUBBING_DISPOSE');
    expect(disposeMessages).toHaveLength(1);
  });

  it('handles fenced offscreen terminal notification with one dispose and release', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});

    const result = await harness.coordinator.handleOffscreenTerminal({
      data: { sessionId: 'session-1', providerId: 'gemini', event: 'TRACK_ENDED' },
    });

    expect(result).toMatchObject({ success: true, stopped: true });
    expect(harness.manager.release).toHaveBeenCalledOnce();
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
  });

  it.each(['stopped', 'error'])('turns a matching RUNNING capture %s into one OFFSCREEN_LOST outcome', async status => {
    const harness = createHarness({ documentExists: true });
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    harness.chromeAPI.tabCapture.getCapturedTabs.mockResolvedValue([]);
    const originalSendMessage = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_STATUS') {
        return {
          success: true,
          active: false,
          sessionId: 'session-1',
          providerId: 'gemini',
          status: 'IDLE',
        };
      }
      return originalSendMessage(message);
    });

    const result = await harness.coordinator.handleCaptureStatusChanged({ tabId: 42, status });

    expect(result).toMatchObject({ success: true, stopped: true });
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toEqual({
      sourceSessionId: 'session-1',
      providerId: 'gemini',
      error: 'LIVE_DUBBING_OFFSCREEN_LOST',
      occurredAt: 123,
      providerDiagnostic: null,
    });
    expect(harness.manager.release).toHaveBeenCalledOnce();
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .some(([message]) => message.action === 'LIVE_DUBBING_DISPOSE')).toBe(false);
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .filter(([message]) => message.action === 'LIVE_DUBBING_TERMINAL_OUTCOME')).toEqual([[
        expect.objectContaining({
          action: 'LIVE_DUBBING_TERMINAL_OUTCOME',
          data: {
            providerId: 'gemini',
            error: 'LIVE_DUBBING_OFFSCREEN_LOST',
            occurredAt: 123,
            providerDiagnostic: null,
          },
        }),
      ]]);
  });

  it.each(['active', 'pending'])('ignores an old capture event while current capture is %s', async captureStatus => {
    const current = {
      sessionId: 'session-b',
      tabId: 42,
      providerId: 'gemini',
      targetLanguage: 'en',
      status: LIVE_DUBBING_STATUS.RUNNING,
      startedAt: 2,
      lastError: null,
      eventSequence: 4,
    };
    const harness = createHarness({ stored: current });
    harness.chromeAPI.tabCapture.getCapturedTabs.mockResolvedValue([
      { tabId: 42, status: captureStatus },
    ]);

    const result = await harness.coordinator.handleCaptureStatusChanged({ tabId: 42, status: 'stopped' });

    expect(result).toMatchObject({
      success: true,
      stopped: false,
      ignored: true,
      status: current,
    });
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toEqual(current);
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toBeUndefined();
    expect(harness.manager.release).not.toHaveBeenCalled();
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .some(([message]) => message.action === 'LIVE_DUBBING_DISPOSE')).toBe(false);
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .some(([message]) => message.action === 'LIVE_DUBBING_TERMINAL_OUTCOME')).toBe(false);
  });

  it('does not let an active capture on another tab protect the stopped tab', async () => {
    const harness = createHarness({
      stored: {
        sessionId: 'session-1',
        tabId: 42,
        providerId: 'gemini',
        targetLanguage: 'en',
        status: LIVE_DUBBING_STATUS.RUNNING,
        startedAt: 1,
        lastError: null,
        eventSequence: 3,
      },
      documentExists: true,
      statusResponse: {
        success: true,
        active: false,
        sessionId: 'session-1',
        providerId: 'gemini',
        status: 'IDLE',
      },
    });
    harness.manager.activeLeases = [{ owner: LIVE_DUBBING_OWNER, leaseId: 'session-1' }];
    harness.chromeAPI.tabCapture.getCapturedTabs.mockResolvedValue([
      { tabId: 99, status: 'active' },
    ]);

    const result = await harness.coordinator.handleCaptureStatusChanged({ tabId: 42, status: 'stopped' });

    expect(result).toMatchObject({ success: true, stopped: true });
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toMatchObject({
      sourceSessionId: 'session-1',
      error: 'LIVE_DUBBING_OFFSCREEN_LOST',
    });
    expect(harness.manager.release).toHaveBeenCalledOnce();
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .some(([message]) => message.action === 'LIVE_DUBBING_DISPOSE')).toBe(false);
  });

  it.each(['unavailable', 'rejecting'])('falls back to capture-loss handling when getCapturedTabs is %s', async mode => {
    const harness = createHarness({
      stored: {
        sessionId: 'session-1',
        tabId: 42,
        providerId: 'gemini',
        targetLanguage: 'en',
        status: LIVE_DUBBING_STATUS.RUNNING,
        startedAt: 1,
        lastError: null,
        eventSequence: 3,
      },
      documentExists: true,
      statusResponse: {
        success: true,
        active: false,
        sessionId: 'session-1',
        providerId: 'gemini',
        status: 'IDLE',
      },
    });
    harness.manager.activeLeases = [{ owner: LIVE_DUBBING_OWNER, leaseId: 'session-1' }];
    if (mode === 'unavailable') {
      delete harness.chromeAPI.tabCapture.getCapturedTabs;
    } else {
      harness.chromeAPI.tabCapture.getCapturedTabs.mockRejectedValueOnce(new Error('capture API unavailable'));
    }

    const result = await harness.coordinator.handleCaptureStatusChanged({ tabId: 42, status: 'error' });

    expect(result).toMatchObject({ success: true, stopped: true });
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toMatchObject({
      sourceSessionId: 'session-1',
      error: 'LIVE_DUBBING_OFFSCREEN_LOST',
    });
    expect(harness.manager.release).toHaveBeenCalledOnce();
  });

  it('uses normal tab teardown when capture stops after the owner tab disappears', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    harness.browserAPI.tabs.get.mockRejectedValueOnce(new Error('tab not found'));

    const result = await harness.coordinator.handleCaptureStatusChanged({ tabId: 42, status: 'stopped' });

    expect(result).toMatchObject({ success: true, stopped: true, reason: 'TAB_REMOVED' });
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toBeNull();
    expect(harness.manager.release).toHaveBeenCalledOnce();
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .filter(([message]) => message.action === 'LIVE_DUBBING_TERMINAL_OUTCOME')).toHaveLength(0);

    await expect(harness.coordinator.handleTabRemoved(42)).resolves.toMatchObject({
      success: true,
      stopped: false,
      ignored: true,
    });
    expect(harness.manager.release).toHaveBeenCalledOnce();
  });

  it('does not emit OFFSCREEN_LOST when tab removal already owns held DISPOSE cleanup', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    let resolveDispose;
    const originalSendMessage = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        return new Promise(resolve => { resolveDispose = resolve; });
      }
      return originalSendMessage(message);
    });

    const removal = harness.coordinator.handleTabRemoved(42);
    while (!resolveDispose) await Promise.resolve();
    const capture = await harness.coordinator.handleCaptureStatusChanged({ tabId: 42, status: 'stopped' });

    expect(capture).toMatchObject({ success: true, stopped: false, ignored: true });
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toBeNull();
    expect(harness.coordinator.sessionRegistry.hasTerminalOperation('session-1')).toBe(true);

    resolveDispose({
      success: true,
      ack: 'DISPOSED',
      sessionId: 'session-1',
      providerId: 'gemini',
    });
    await expect(removal).resolves.toMatchObject({ success: true, stopped: true, reason: 'TAB_REMOVED' });
    expect(harness.manager.release).toHaveBeenCalledOnce();
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .filter(([message]) => message.action === 'LIVE_DUBBING_DISPOSE')).toHaveLength(1);
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .filter(([message]) => message.action === 'LIVE_DUBBING_TERMINAL_OUTCOME')).toHaveLength(0);
  });

  it('releases a matching stale lease after proven document loss without DISPOSE', async () => {
    const harness = createHarness({ documentExists: false });
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});

    const result = await harness.coordinator.handleCaptureStatusChanged({ tabId: 42, status: 'stopped' });

    expect(result).toMatchObject({ success: true, stopped: true });
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .some(([message]) => message.action === 'LIVE_DUBBING_DISPOSE')).toBe(false);
    expect(harness.manager.release).toHaveBeenCalledOnce();
    expect(harness.manager.release).toHaveBeenCalledWith({
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'session-1',
    });
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toMatchObject({
      sourceSessionId: 'session-1',
      providerId: 'gemini',
      error: 'LIVE_DUBBING_OFFSCREEN_LOST',
    });
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .filter(([message]) => message.action === 'LIVE_DUBBING_TERMINAL_OUTCOME')).toHaveLength(1);
  });

  it('retains ERROR and outcome when proven-absence lease release fails', async () => {
    const harness = createHarness({ documentExists: false });
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    harness.manager.release.mockResolvedValueOnce(false);

    const result = await harness.coordinator.handleCaptureStatusChanged({ tabId: 42, status: 'error' });

    expect(result).toMatchObject({
      success: false,
      error: 'STOP_FAILED',
      retryable: true,
      cleanupPending: true,
      status: { sessionId: 'session-1', status: LIVE_DUBBING_STATUS.ERROR },
    });
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
      sessionId: 'session-1',
      status: LIVE_DUBBING_STATUS.ERROR,
      lastError: 'STOP_FAILED',
    });
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(true);
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toMatchObject({
      sourceSessionId: 'session-1',
      error: 'LIVE_DUBBING_OFFSCREEN_LOST',
    });
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .some(([message]) => message.action === 'LIVE_DUBBING_DISPOSE')).toBe(false);
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .filter(([message]) => message.action === 'LIVE_DUBBING_TERMINAL_OUTCOME')).toHaveLength(1);
  });

  it('terminalizes capture loss with unknown runtime status and retains ERROR after DISPOSE failure', async () => {
    const harness = createHarness({ documentExists: true });
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const originalSendMessage = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_STATUS') return null;
      if (message.action === 'LIVE_DUBBING_DISPOSE') return { success: false };
      return originalSendMessage(message);
    });

    const result = await harness.coordinator.handleCaptureStatusChanged({ tabId: 42, status: 'stopped' });

    expect(result).toMatchObject({
      success: false,
      error: 'STOP_FAILED',
      retryable: true,
      cleanupPending: true,
      status: { sessionId: 'session-1', status: LIVE_DUBBING_STATUS.ERROR },
    });
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
      status: LIVE_DUBBING_STATUS.ERROR,
      lastError: 'STOP_FAILED',
    });
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toMatchObject({
      sourceSessionId: 'session-1',
      error: 'LIVE_DUBBING_OFFSCREEN_LOST',
    });
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .filter(([message]) => message.action === 'LIVE_DUBBING_DISPOSE')).toHaveLength(1);
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .filter(([message]) => message.action === 'LIVE_DUBBING_TERMINAL_OUTCOME')).toHaveLength(1);
  });

  it('lets an explicit STOP that already owns cleanup win over a concurrent capture event', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const originalSendMessage = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    let resolveDispose;
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        return new Promise(resolve => { resolveDispose = resolve; });
      }
      return originalSendMessage(message);
    });

    const stop = harness.coordinator.stop({ data: { sessionId: 'session-1' } });
    while (!resolveDispose) await Promise.resolve();
    const capture = await harness.coordinator.handleCaptureStatusChanged({ tabId: 42, status: 'stopped' });

    expect(capture).toMatchObject({ success: true, stopped: false, ignored: true });
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toBeNull();
    expect(harness.coordinator.sessionRegistry.hasTerminalOperation('session-1')).toBe(true);

    resolveDispose({
      success: true,
      ack: 'DISPOSED',
      sessionId: 'session-1',
      providerId: 'gemini',
    });
    await expect(stop).resolves.toMatchObject({ success: true, stopped: true });
    expect(harness.manager.release).toHaveBeenCalledOnce();
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .filter(([message]) => message.action === 'LIVE_DUBBING_DISPOSE')).toHaveLength(1);
  });

  it('clears proven capture loss after outcome persistence fails without notifying it', async () => {
    const harness = createHarness({ documentExists: false });
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const originalSet = harness.browserAPI.storage.session.set.getMockImplementation();
    harness.browserAPI.storage.session.set.mockImplementation(async record => {
      if (record[LIVE_DUBBING_OUTCOME_STORAGE_KEY]) throw new Error('outcome storage unavailable');
      return originalSet(record);
    });

    const result = await harness.coordinator.handleCaptureStatusChanged({ tabId: 42, status: 'stopped' });

    expect(result).toMatchObject({ success: true, stopped: true });
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
    expect(harness.manager.release).toHaveBeenCalledOnce();
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toBeNull();
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .some(([message]) => message.action === 'LIVE_DUBBING_TERMINAL_OUTCOME')).toBe(false);
  });

  it('fences a stale capture event before a newer RUNNING session can be stopped', async () => {
    const harness = createHarness({ stored: {
      sessionId: 'old-session',
      tabId: 42,
      providerId: 'gemini',
      targetLanguage: 'en',
      status: LIVE_DUBBING_STATUS.RUNNING,
      startedAt: 1,
      lastError: null,
      eventSequence: 3,
    } });
    const newer = {
      sessionId: 'new-session',
      tabId: 42,
      providerId: 'gemini',
      targetLanguage: 'en',
      status: LIVE_DUBBING_STATUS.RUNNING,
      startedAt: 2,
      lastError: null,
      eventSequence: 4,
    };
    let descriptorRead = 0;
    const originalGet = harness.browserAPI.storage.session.get.getMockImplementation();
    harness.browserAPI.storage.session.get.mockImplementation(async key => {
      const result = await originalGet(key);
      if (key === LIVE_DUBBING_STORAGE_KEY && descriptorRead++ === 1) {
        harness.storage.set(LIVE_DUBBING_STORAGE_KEY, newer);
        return { [LIVE_DUBBING_STORAGE_KEY]: newer };
      }
      return result;
    });

    const result = await harness.coordinator.handleCaptureStatusChanged({ tabId: 42, status: 'stopped' });

    expect(result).toMatchObject({ success: true, stopped: false, ignored: true });
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toEqual(newer);
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toBeUndefined();
    expect(harness.manager.release).not.toHaveBeenCalled();
  });

  it('revalidates the descriptor after the awaited current-capture lookup', async () => {
    const harness = createHarness({ stored: {
      sessionId: 'old-session',
      tabId: 42,
      providerId: 'gemini',
      targetLanguage: 'en',
      status: LIVE_DUBBING_STATUS.RUNNING,
      startedAt: 1,
      lastError: null,
      eventSequence: 3,
    } });
    const newer = {
      sessionId: 'new-session',
      tabId: 42,
      providerId: 'gemini',
      targetLanguage: 'en',
      status: LIVE_DUBBING_STATUS.RUNNING,
      startedAt: 2,
      lastError: null,
      eventSequence: 4,
    };
    let resolveCapturedTabs;
    harness.chromeAPI.tabCapture.getCapturedTabs.mockImplementation(
      () => new Promise(resolve => { resolveCapturedTabs = resolve; }),
    );

    const capture = harness.coordinator.handleCaptureStatusChanged({ tabId: 42, status: 'stopped' });
    while (!resolveCapturedTabs) await Promise.resolve();
    harness.storage.set(LIVE_DUBBING_STORAGE_KEY, newer);
    resolveCapturedTabs([]);

    const result = await capture;

    expect(result).toMatchObject({
      success: true,
      stopped: false,
      ignored: true,
      status: newer,
    });
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toEqual(newer);
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toBeUndefined();
    expect(harness.manager.release).not.toHaveBeenCalled();
  });

  it.each(['explicit STOP', 'tab removal'])('does not emit OFFSCREEN_LOST when %s wins during current-capture lookup', async event => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    let resolveCapturedTabs;
    harness.chromeAPI.tabCapture.getCapturedTabs.mockImplementation(
      () => new Promise(resolve => { resolveCapturedTabs = resolve; }),
    );
    const originalSendMessage = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    let resolveDispose;
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        return new Promise(resolve => { resolveDispose = resolve; });
      }
      return originalSendMessage(message);
    });

    const capture = harness.coordinator.handleCaptureStatusChanged({ tabId: 42, status: 'stopped' });
    while (!resolveCapturedTabs) await Promise.resolve();
    const terminal = event === 'explicit STOP'
      ? harness.coordinator.stop({ data: { sessionId: 'session-1' } })
      : harness.coordinator.handleTabRemoved(42);
    while (!resolveDispose) await Promise.resolve();
    resolveCapturedTabs([]);

    await expect(capture).resolves.toMatchObject({ success: true, stopped: false, ignored: true });
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toBeNull();

    resolveDispose({
      success: true,
      ack: 'DISPOSED',
      sessionId: 'session-1',
      providerId: 'gemini',
    });
    await expect(terminal).resolves.toMatchObject({ success: true, stopped: true });
    expect(harness.manager.release).toHaveBeenCalledOnce();
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .filter(([message]) => message.action === 'LIVE_DUBBING_DISPOSE')).toHaveLength(1);
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .filter(([message]) => message.action === 'LIVE_DUBBING_TERMINAL_OUTCOME')).toHaveLength(0);
  });

  it('single-flights duplicate capture loss events across cleanup, outcome, and notification', async () => {
    const harness = createHarness({ documentExists: true });
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const originalSendMessage = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_STATUS') {
        return {
          success: true,
          active: false,
          sessionId: 'session-1',
          providerId: 'gemini',
          status: 'DISPOSED',
          disposed: true,
        };
      }
      return originalSendMessage(message);
    });

    const results = await Promise.all([
      harness.coordinator.handleCaptureStatusChanged({ tabId: 42, status: 'stopped' }),
      harness.coordinator.handleCaptureStatusChanged({ tabId: 42, status: 'stopped' }),
      harness.coordinator.handleCaptureStatusChanged({ tabId: 42, status: 'error' }),
    ]);

    expect(results.filter(result => result.stopped === true)).toHaveLength(3);
    expect(harness.manager.release).toHaveBeenCalledOnce();
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .some(([message]) => message.action === 'LIVE_DUBBING_DISPOSE')).toBe(false);
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .filter(([message]) => message.action === 'LIVE_DUBBING_TERMINAL_OUTCOME')).toHaveLength(1);
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toMatchObject({
      sourceSessionId: 'session-1',
      providerId: 'gemini',
      error: 'LIVE_DUBBING_OFFSCREEN_LOST',
    });
  });

  it('lets explicit STOP win over a later capture loss event without an outcome', async () => {
    const harness = createHarness({ documentExists: true });
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    await expect(harness.coordinator.stop({ data: { sessionId: 'session-1' } }))
      .resolves.toMatchObject({ success: true, stopped: true });

    await expect(harness.coordinator.handleCaptureStatusChanged({ tabId: 42, status: 'stopped' }))
      .resolves.toMatchObject({ success: true, stopped: false, ignored: true });
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toBeNull();
    expect(harness.manager.release).toHaveBeenCalledOnce();
  });

  it('persists a public-safe runtime error outcome before clearing the descriptor', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});

    const result = await harness.coordinator.handleOffscreenTerminal({
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        status: LIVE_DUBBING_STATUS.ERROR,
        error: 'GEMINI_LIVE_REMOTE_ERROR',
        providerDiagnostic: {
          code: 'GEMINI_LIVE_REMOTE_ERROR',
          closeCode: 1011,
          wasClean: false,
          terminalCategory: 'REMOTE_ERROR',
          wsOpen: true,
          setupSent: true,
          setupComplete: false,
          payload: 'private-payload',
        },
      },
    }, {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    });

    expect(result).toMatchObject({ success: true, stopped: true });
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toEqual({
      sourceSessionId: 'session-1',
      providerId: 'gemini',
      error: 'GEMINI_LIVE_REMOTE_ERROR',
      occurredAt: 123,
      providerDiagnostic: {
        stage: 'CONNECT_PROVIDER',
        code: 'GEMINI_LIVE_REMOTE_ERROR',
        closeCode: 1011,
        wasClean: false,
        terminalCategory: 'REMOTE_ERROR',
        malformedAt: null,
        wsOpen: true,
        setupSent: true,
        setupComplete: false,
      },
    });

    await expect(harness.coordinator.getStatus()).resolves.toEqual({
      success: true,
      available: true,
      status: null,
      transcriptDeliveryUnavailable: false,
      terminalOutcome: {
        providerId: 'gemini',
        error: 'GEMINI_LIVE_REMOTE_ERROR',
        occurredAt: 123,
        providerDiagnostic: expect.objectContaining({
          stage: 'CONNECT_PROVIDER',
          code: 'GEMINI_LIVE_REMOTE_ERROR',
        }),
      },
    });
    const notifications = harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(message => message.action === 'LIVE_DUBBING_TERMINAL_OUTCOME');
    expect(notifications).toEqual([{
      action: 'LIVE_DUBBING_TERMINAL_OUTCOME',
      data: expect.objectContaining({
        providerId: 'gemini',
        error: 'GEMINI_LIVE_REMOTE_ERROR',
      }),
    }]);
    expect(notifications[0].data).not.toHaveProperty('sourceSessionId');
  });

  it('starts terminal cleanup before deferred outcome storage settles', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const originalSet = harness.browserAPI.storage.session.set.getMockImplementation();
    let resolveOutcome;
    let outcomeSettled = false;
    harness.browserAPI.storage.session.set.mockImplementation(async record => {
      if (record[LIVE_DUBBING_OUTCOME_STORAGE_KEY]) {
        return new Promise(resolve => {
          resolveOutcome = () => {
            outcomeSettled = true;
            resolve(originalSet(record));
          };
        });
      }
      return originalSet(record);
    });

    const terminal = harness.coordinator.handleOffscreenTerminal({
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        status: LIVE_DUBBING_STATUS.ERROR,
        error: 'LIVE_DUBBING_PROVIDER_ERROR',
      },
    }, {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    });

    while (!harness.browserAPI.runtime.sendMessage.mock.calls
      .some(([message]) => message.action === 'LIVE_DUBBING_DISPOSE')) await Promise.resolve();
    expect(resolveOutcome).toEqual(expect.any(Function));
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message.action)).toContain('LIVE_DUBBING_DISPOSE');
    while (harness.manager.release.mock.calls.length === 0) await Promise.resolve();
    expect(harness.manager.release).toHaveBeenCalledOnce();
    expect(outcomeSettled).toBe(false);

    await expect(terminal).resolves.toMatchObject({ success: true, stopped: true });
    // Notification must not be sent while outcome persistence is still pending;
    // otherwise Popup could read terminalOutcome:null before the write lands.
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message.action)).not.toContain('LIVE_DUBBING_TERMINAL_OUTCOME');
    // A racing popup read must not observe the outcome before it is persisted.
    await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
      success: true,
      status: null,
      terminalOutcome: null,
    });
    resolveOutcome();
    await harness.coordinator.stateStore.awaitOutcomeMutations();
    // Notification is chained after outcome persistence; flush that microtask chain.
    await Promise.resolve();
    await Promise.resolve();
    expect(outcomeSettled).toBe(true);
    const notifications = harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(message => message.action === 'LIVE_DUBBING_TERMINAL_OUTCOME');
    expect(notifications).toHaveLength(1);
    expect(notifications[0].data).toMatchObject({
      providerId: 'gemini',
      error: 'LIVE_DUBBING_PROVIDER_ERROR',
    });
    await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
      success: true,
      status: null,
      terminalOutcome: {
        providerId: 'gemini',
        error: 'LIVE_DUBBING_PROVIDER_ERROR',
      },
    });
  });

  it('notifies only after failed outcome write settles, leaving idle status without false retained session and without unhandled rejection', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const originalSet = harness.browserAPI.storage.session.set.getMockImplementation();
    let rejectOutcome;
    let outcomeSettled = false;
    harness.browserAPI.storage.session.set.mockImplementation(async record => {
      if (record[LIVE_DUBBING_OUTCOME_STORAGE_KEY]) {
        return new Promise((_, reject) => {
          rejectOutcome = () => {
            outcomeSettled = true;
            reject(new Error('outcome storage unavailable'));
          };
        });
      }
      return originalSet(record);
    });

    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    const terminal = harness.coordinator.handleOffscreenTerminal({
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        status: LIVE_DUBBING_STATUS.ERROR,
        error: 'LIVE_DUBBING_PROVIDER_ERROR',
      },
    }, {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    });

    while (!harness.browserAPI.runtime.sendMessage.mock.calls
      .some(([message]) => message.action === 'LIVE_DUBBING_DISPOSE')) await Promise.resolve();
    while (harness.manager.release.mock.calls.length === 0) await Promise.resolve();
    expect(outcomeSettled).toBe(false);

    await expect(terminal).resolves.toMatchObject({ success: true, stopped: true });
    // Cleanup success is independent of outcome I/O; notification must still wait.
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message.action)).not.toContain('LIVE_DUBBING_TERMINAL_OUTCOME');
    expect(harness.coordinator.stateStore.awaitOutcomeMutations).toEqual(expect.any(Function));

    rejectOutcome();
    await harness.coordinator.stateStore.awaitOutcomeMutations();
    // Notification is chained after outcome persistence; flush that microtask chain.
    await Promise.resolve();
    await Promise.resolve();
    expect(outcomeSettled).toBe(true);

    const notifications = harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(message => message.action === 'LIVE_DUBBING_TERMINAL_OUTCOME');
    expect(notifications).toHaveLength(1);
    expect(harness.coordinator.outcomeStorageState).toBe(LIVE_DUBBING_OUTCOME_STORAGE_STATE.WRITE_FAILED);
    await expect(harness.coordinator.getStatus()).resolves.toEqual({
      success: true,
      available: true,
      status: null,
      transcriptDeliveryUnavailable: false,
      terminalOutcome: null,
    });
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toBeNull();
    // No duplicate and no unhandled rejection from deferred outcome.
    await Promise.resolve();
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .filter(([message]) => message.action === 'LIVE_DUBBING_TERMINAL_OUTCOME')).toHaveLength(1);
    expect(unhandled).toHaveLength(0);
    process.off('unhandledRejection', onUnhandled);
  });

  it('defers notification and avoids duplicates when cleanup is pending, preserving cleanupPending ordering', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const originalSet = harness.browserAPI.storage.session.set.getMockImplementation();
    let resolveOutcome;
    harness.browserAPI.storage.session.set.mockImplementation(async record => {
      if (record[LIVE_DUBBING_OUTCOME_STORAGE_KEY]) {
        return new Promise(resolve => {
          resolveOutcome = () => resolve(originalSet(record));
        });
      }
      return originalSet(record);
    });
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_DISPOSE') return { success: false };
      return { success: true };
    });

    const terminal = harness.coordinator.handleOffscreenTerminal({
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        status: LIVE_DUBBING_STATUS.ERROR,
        error: 'LIVE_DUBBING_PROVIDER_ERROR',
      },
    }, {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    });

    while (!harness.browserAPI.runtime.sendMessage.mock.calls
      .some(([message]) => message.action === 'LIVE_DUBBING_DISPOSE')) await Promise.resolve();
    expect(resolveOutcome).toEqual(expect.any(Function));
    // Cleanup is pending/failing but outcome is still deferred: no notification yet.
    await Promise.resolve();
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message.action)).not.toContain('LIVE_DUBBING_TERMINAL_OUTCOME');

    resolveOutcome();
    await harness.coordinator.stateStore.awaitOutcomeMutations();
    await Promise.resolve();
    await Promise.resolve();
    const pendingResult = await terminal;
    expect(pendingResult).toMatchObject({ success: false, cleanupPending: true });
    const notifications = harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(message => message.action === 'LIVE_DUBBING_TERMINAL_OUTCOME');
    expect(notifications).toHaveLength(1);
    expect(notifications[0].data).toMatchObject({ error: 'LIVE_DUBBING_PROVIDER_ERROR' });
    // cleanupPending keeps descriptor and outcome observable as pending state.
    await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
      success: true,
      status: { sessionId: 'session-1', status: LIVE_DUBBING_STATUS.ERROR },
      terminalOutcome: { error: 'LIVE_DUBBING_PROVIDER_ERROR' },
    });
    // No duplicate on microtask flush.
    await Promise.resolve();
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .filter(([message]) => message.action === 'LIVE_DUBBING_TERMINAL_OUTCOME')).toHaveLength(1);
  });

  it.each([
    ['user stop', harness => harness.coordinator.stop({ data: { sessionId: 'session-1' } })],
    ['tab removal', harness => harness.coordinator.handleTabRemoved(42)],
    ['top-level navigation', harness => harness.coordinator.handleTopLevelNavigation(42)],
  ])('does not create an outcome for %s', async (_label, stop) => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});

    await stop(harness);

    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toBeNull();
  });

  it('retains a terminal outcome and descriptor when cleanup is pending', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_DISPOSE') return { success: false };
      return { success: true };
    });

    const result = await harness.coordinator.handleOffscreenTerminal({
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        status: LIVE_DUBBING_STATUS.ERROR,
        error: 'LIVE_DUBBING_PROVIDER_ERROR',
      },
    }, {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    });

    expect(result).toMatchObject({ success: false, cleanupPending: true });
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
      sessionId: 'session-1',
      status: LIVE_DUBBING_STATUS.ERROR,
    });
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toMatchObject({
      sourceSessionId: 'session-1',
      error: 'LIVE_DUBBING_PROVIDER_ERROR',
    });
    await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
      success: true,
      status: { sessionId: 'session-1' },
      terminalOutcome: { error: 'LIVE_DUBBING_PROVIDER_ERROR' },
    });
  });

  it('clears an old outcome atomically only after a successful future START', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    await harness.coordinator.handleOffscreenTerminal({
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        status: LIVE_DUBBING_STATUS.ERROR,
        error: 'LIVE_DUBBING_PROVIDER_ERROR',
      },
    }, {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    });

    harness.coordinator.uuid = () => 'session-2';
    const started = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});

    expect(started).toMatchObject({ success: true, status: { sessionId: 'session-2' } });
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toBeNull();
    expect(harness.browserAPI.storage.session.set.mock.calls.some(([record]) => (
      record[LIVE_DUBBING_STORAGE_KEY]?.sessionId === 'session-2'
      && record[LIVE_DUBBING_OUTCOME_STORAGE_KEY] === null
    ))).toBe(true);
  });

  it('retains an old outcome when a future START fails before RUNNING commit', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    await harness.coordinator.handleOffscreenTerminal({
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        status: LIVE_DUBBING_STATUS.ERROR,
        error: 'LIVE_DUBBING_PROVIDER_ERROR',
      },
    }, {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    });

    harness.coordinator.uuid = () => 'session-2';
    harness.chromeAPI.tabCapture.getMediaStreamId.mockRejectedValueOnce(new Error('capture failed'));
    await expect(harness.coordinator.start({ data: { targetLanguage: 'en' } }, {}))
      .resolves.toMatchObject({ success: false });

    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toMatchObject({
      sourceSessionId: 'session-1',
      error: 'LIVE_DUBBING_PROVIDER_ERROR',
    });
  });

  it('does not let an old terminal overwrite a newer descriptor or outcome', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    await harness.browserAPI.storage.session.set({
      [LIVE_DUBBING_STORAGE_KEY]: {
        sessionId: 'new-session',
        tabId: 42,
        providerId: 'gemini',
        targetLanguage: 'en',
        status: LIVE_DUBBING_STATUS.RUNNING,
        startedAt: 2,
        lastError: null,
        eventSequence: 1,
      },
      [LIVE_DUBBING_OUTCOME_STORAGE_KEY]: {
        sourceSessionId: 'new-session',
        providerId: 'gemini',
        error: 'NEW_SESSION_ERROR',
        occurredAt: 456,
        providerDiagnostic: null,
      },
    });

    const result = await harness.coordinator.handleOffscreenTerminal({
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        status: LIVE_DUBBING_STATUS.ERROR,
        error: 'OLD_SESSION_ERROR',
      },
    }, {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    });

    expect(result).toMatchObject({ success: true, ignored: true });
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({ sessionId: 'new-session' });
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toMatchObject({
      sourceSessionId: 'new-session',
      error: 'NEW_SESSION_ERROR',
    });
  });

  it('reads a stored outcome after coordinator reconstruction', async () => {
    const harness = createHarness({ outcome: {
      sourceSessionId: 'old-session',
      providerId: 'gemini',
      error: 'LIVE_DUBBING_PROVIDER_ERROR',
      occurredAt: 123,
      providerDiagnostic: null,
    } });

    await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
      success: true,
      status: null,
      terminalOutcome: {
        providerId: 'gemini',
        error: 'LIVE_DUBBING_PROVIDER_ERROR',
        occurredAt: 123,
      },
    });
    expect((await harness.coordinator.getStatus()).terminalOutcome).not.toHaveProperty('sourceSessionId');
  });

  it('hides an older stored outcome behind a newer active descriptor', async () => {
    const harness = createHarness({
      stored: {
        sessionId: 'new-session',
        tabId: 42,
        providerId: 'gemini',
        targetLanguage: 'en',
        status: LIVE_DUBBING_STATUS.RUNNING,
        startedAt: 456,
        lastError: null,
        eventSequence: 1,
      },
      outcome: {
        sourceSessionId: 'old-session',
        providerId: 'gemini',
        error: 'OLD_SESSION_ERROR',
        occurredAt: 123,
        providerDiagnostic: null,
      },
    });

    await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
      success: true,
      status: { sessionId: 'new-session' },
      terminalOutcome: null,
    });
    expect(harness.browserAPI.storage.session.get).toHaveBeenCalledWith([
      LIVE_DUBBING_STORAGE_KEY,
      LIVE_DUBBING_OUTCOME_STORAGE_KEY,
    ]);
  });

  it('continues terminal cleanup when outcome storage cannot be written', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const originalSet = harness.browserAPI.storage.session.set.getMockImplementation();
    harness.browserAPI.storage.session.set.mockImplementation(async record => {
      if (record[LIVE_DUBBING_OUTCOME_STORAGE_KEY]) throw new Error('outcome storage unavailable');
      return originalSet(record);
    });

    const result = await harness.coordinator.handleOffscreenTerminal({
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        status: LIVE_DUBBING_STATUS.ERROR,
        error: 'LIVE_DUBBING_PROVIDER_ERROR',
      },
    }, {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    });

    expect(result).toMatchObject({ success: true, stopped: true });
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
    expect(harness.coordinator.storageState).toBe(LIVE_DUBBING_STORAGE_STATE.ABSENT);
    expect(harness.coordinator.outcomeStorageState).toBe(LIVE_DUBBING_OUTCOME_STORAGE_STATE.WRITE_FAILED);
    await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
      success: true,
      status: null,
      terminalOutcome: null,
    });
  });

  it('logs a sanitized cleanup summary once after valid terminal release', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});

    const result = await harness.coordinator.handleOffscreenTerminal({
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        event: 'PROVIDER_ERROR',
        cleanupDiagnostic: {
          cleanupCause: 'LIVE_DUBBING_PROVIDER_ERROR',
          capturedFrames: 7,
          inputSentFrames: 3,
          inputPendingFrames: 2,
          providerLastSendReason: 'BACKPRESSURE',
          providerAudioChunks: 4,
          playbackAccepted: false,
          outputSafetyDrops: 1,
          interruptions: 6,
          providerTerminalCategory: 'PROVIDER_ERROR',
          sessionId: 'session-secret',
          streamId: 'stream-secret',
          pcm: 'AQ==',
        },
      },
    }, {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    });

    expect(result).toMatchObject({ success: true, stopped: true });
    expect(harness.logger.warn).toHaveBeenCalledOnce();
    expect(harness.logger.warn).toHaveBeenCalledWith(
      'Live dubbing ended without translated playback',
      {
        cleanupCause: 'LIVE_DUBBING_PROVIDER_ERROR',
        capturedFrames: 7,
        inputSentFrames: 3,
        inputPendingFrames: 2,
        providerLastSendReason: 'BACKPRESSURE',
        providerAudioChunks: 4,
        playbackAccepted: false,
        outputSafetyDrops: 1,
        interruptions: 6,
        providerTerminalCategory: 'PROVIDER_ERROR',
      },
    );
    expect(harness.logger.warn.mock.invocationCallOrder[0])
      .toBeGreaterThan(harness.manager.release.mock.invocationCallOrder[0]);
    const storagePayload = JSON.stringify([...harness.storage.values()]);
    expect(storagePayload).not.toContain('cleanupDiagnostic');
    expect(storagePayload).not.toContain('session-secret');
    expect(storagePayload).not.toContain('stream-secret');
    expect(storagePayload).not.toContain('AQ==');
  });

  it('latches and logs a sanitized provider terminal before cleanup', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const providerDiagnostic = {
      stage: 'REMOTE_ERROR',
      code: 'GEMINI_LIVE_MALFORMED_MESSAGE',
      closeCode: 1006,
      wasClean: false,
      terminalCategory: 'MALFORMED_MESSAGE',
      malformedAt: 'INLINE_AUDIO_SHAPE',
      wsOpen: true,
      setupSent: true,
      setupComplete: false,
      message: 'provider-body-secret',
      streamId: 'stream-secret',
    };
    const forgetSessionState = vi.spyOn(harness.coordinator, '_forgetSessionState');

    const result = await harness.coordinator.handleOffscreenTerminal({
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        event: 'PROVIDER_ERROR',
        providerDiagnostic,
        cleanupDiagnostic: {
          cleanupCause: 'LIVE_DUBBING_PROVIDER_ERROR',
          playbackAccepted: false,
        },
      },
    }, {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    });

    expect(result).toMatchObject({ success: true, stopped: true });
    expect(harness.logger.warn).toHaveBeenNthCalledWith(1, 'Live dubbing provider terminal', {
      stage: 'CONNECT_PROVIDER',
      code: 'GEMINI_LIVE_MALFORMED_MESSAGE',
      closeCode: 1006,
      wasClean: false,
      terminalCategory: 'MALFORMED_MESSAGE',
      malformedAt: 'INLINE_AUDIO_SHAPE',
      wsOpen: true,
      setupSent: true,
      setupComplete: false,
    });
    expect(harness.logger.warn).toHaveBeenNthCalledWith(
      2,
      'Live dubbing ended without translated playback',
      expect.objectContaining({ playbackAccepted: false }),
    );
    expect(JSON.stringify(harness.logger.warn.mock.calls)).not.toContain('provider-body-secret');
    expect(JSON.stringify(harness.logger.warn.mock.calls)).not.toContain('stream-secret');
    expect(forgetSessionState).toHaveBeenCalledOnce();
    expect(harness.logger.warn.mock.invocationCallOrder[0])
      .toBeLessThan(forgetSessionState.mock.invocationCallOrder[0]);
  });

  it('does not let rejected or senderless terminals inject provider diagnostics', async () => {
    const diagnostic = {
      code: 'GEMINI_LIVE_MALFORMED_MESSAGE',
      terminalCategory: 'MALFORMED_MESSAGE',
      malformedAt: 'INLINE_AUDIO_SHAPE',
    };
    const sender = {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    };

    const wrongSenderHarness = createHarness();
    await wrongSenderHarness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    await wrongSenderHarness.coordinator.handleOffscreenTerminal({
      data: { sessionId: 'session-1', providerId: 'gemini', providerDiagnostic: diagnostic },
    }, { ...sender, tab: { id: 42 } });
    expect(wrongSenderHarness.coordinator.sessionRegistry.getSessionState('session-1').providerDiagnostic)
      .toBeNull();
    expect(wrongSenderHarness.logger.warn).not.toHaveBeenCalled();

    const wrongSessionHarness = createHarness();
    await wrongSessionHarness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    await wrongSessionHarness.coordinator.handleOffscreenTerminal({
      data: { sessionId: 'other-session', providerDiagnostic: diagnostic },
    }, sender);
    expect(wrongSessionHarness.coordinator.sessionRegistry.getSessionState('session-1').providerDiagnostic)
      .toBeNull();
    expect(wrongSessionHarness.logger.warn).not.toHaveBeenCalled();

    const senderlessHarness = createHarness();
    await senderlessHarness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const stopForSession = vi.spyOn(senderlessHarness.coordinator, '_stopForSession')
      .mockResolvedValue({ success: true, stopped: true });
    await senderlessHarness.coordinator.handleOffscreenTerminal({
      data: { sessionId: 'session-1', providerId: 'gemini', providerDiagnostic: diagnostic },
    });
    expect(stopForSession).toHaveBeenCalledOnce();
    expect(senderlessHarness.coordinator.sessionRegistry.getSessionState('session-1').providerDiagnostic)
      .toBeNull();
    expect(senderlessHarness.logger.warn).not.toHaveBeenCalled();

    const invalidHarness = createHarness();
    await invalidHarness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const firstDiagnostic = invalidHarness.coordinator.sessionRegistry.getSessionState('session-1');
    invalidHarness.coordinator._latchProviderDiagnostic(firstDiagnostic, diagnostic);
    vi.spyOn(invalidHarness.coordinator, '_stopForSession').mockResolvedValue({
      success: true,
      stopped: true,
    });
    await invalidHarness.coordinator.handleOffscreenTerminal({
      data: { sessionId: 'session-1', providerId: 'gemini', providerDiagnostic: new Error('provider-body-secret') },
    }, sender);
    expect(firstDiagnostic.providerDiagnostic).toMatchObject({
      code: 'GEMINI_LIVE_MALFORMED_MESSAGE',
      malformedAt: 'INLINE_AUDIO_SHAPE',
    });
    expect(invalidHarness.logger.warn).not.toHaveBeenCalled();
  });

  it('preserves the first provider diagnostic when a duplicate terminal replays later data', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const sender = {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    };
    const first = {
      code: 'GEMINI_LIVE_MALFORMED_MESSAGE',
      terminalCategory: 'MALFORMED_MESSAGE',
      malformedAt: 'INLINE_AUDIO_SHAPE',
    };
    const later = {
      code: 'GEMINI_LIVE_REMOTE_ERROR',
      terminalCategory: 'REMOTE_ERROR',
      malformedAt: 'BINARY_BLOB_MESSAGE',
    };
    let resolveStop;
    const stopForSession = vi.spyOn(harness.coordinator, '_stopForSession')
      .mockImplementation(() => new Promise(resolve => { resolveStop = resolve; }));

    const firstTerminal = harness.coordinator.handleOffscreenTerminal({
      data: { sessionId: 'session-1', providerId: 'gemini', providerDiagnostic: first },
    }, sender);
    await expect(harness.coordinator.handleOffscreenTerminal({
      data: { sessionId: 'session-1', providerId: 'gemini', providerDiagnostic: later },
    }, sender)).resolves.toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_UNAUTHORIZED',
    });

    expect(harness.coordinator.sessionRegistry.getSessionState('session-1').providerDiagnostic)
      .toMatchObject({
        code: 'GEMINI_LIVE_MALFORMED_MESSAGE',
        terminalCategory: 'MALFORMED_MESSAGE',
        malformedAt: 'INLINE_AUDIO_SHAPE',
      });
    expect(harness.logger.warn).toHaveBeenCalledOnce();
    expect(harness.logger.warn).toHaveBeenCalledWith(
      'Live dubbing provider terminal',
      expect.objectContaining({
        code: 'GEMINI_LIVE_MALFORMED_MESSAGE',
        terminalCategory: 'MALFORMED_MESSAGE',
        malformedAt: 'INLINE_AUDIO_SHAPE',
      }),
    );

    resolveStop({ success: true, stopped: true });
    await expect(firstTerminal).resolves.toMatchObject({ success: true, stopped: true });
    expect(stopForSession).toHaveBeenCalledOnce();
  });

  it('does not log cleanup summaries for unauthenticated, wrong-session, duplicate, or senderless terminals', async () => {
    const summary = {
      cleanupCause: 'EXPLICIT_DISPOSE',
      playbackAccepted: false,
    };
    const sender = {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    };

    const wrongSenderHarness = createHarness();
    await wrongSenderHarness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    await expect(wrongSenderHarness.coordinator.handleOffscreenTerminal({
      data: { sessionId: 'session-1', providerId: 'gemini', cleanupDiagnostic: summary },
    }, { ...sender, tab: { id: 42 } })).resolves.toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_UNAUTHORIZED',
    });
    expect(wrongSenderHarness.logger.warn).not.toHaveBeenCalled();

    const wrongSessionHarness = createHarness();
    await wrongSessionHarness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    await expect(wrongSessionHarness.coordinator.handleOffscreenTerminal({
      data: { sessionId: 'other-session', cleanupDiagnostic: summary },
    }, sender)).resolves.toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_UNAUTHORIZED',
    });
    expect(wrongSessionHarness.logger.warn).not.toHaveBeenCalled();

    const duplicateHarness = createHarness();
    await duplicateHarness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    await duplicateHarness.coordinator.handleOffscreenTerminal({
      data: { sessionId: 'session-1', providerId: 'gemini', cleanupDiagnostic: { ...summary, playbackAccepted: true } },
    }, sender);
    await expect(duplicateHarness.coordinator.handleOffscreenTerminal({
      data: { sessionId: 'session-1', providerId: 'gemini', cleanupDiagnostic: summary },
    }, sender)).resolves.toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_UNAUTHORIZED',
    });
    expect(duplicateHarness.logger.warn).not.toHaveBeenCalled();

    const senderlessHarness = createHarness();
    await senderlessHarness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    await senderlessHarness.coordinator.handleOffscreenTerminal({
      data: { sessionId: 'session-1', providerId: 'gemini', cleanupDiagnostic: summary },
    });
    expect(senderlessHarness.logger.warn).not.toHaveBeenCalled();
  });

  it('accepts stale-sequence terminals only for the exact Offscreen session', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const sender = {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    };

    await expect(harness.coordinator.handleOffscreenTerminal({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 3, event: 'TRACK_ENDED' },
    }, sender)).resolves.toMatchObject({
      success: true,
      stopped: true,
    });
    await expect(harness.coordinator.handleOffscreenTerminal({
      data: { sessionId: 'session-1', providerId: 'gemini', eventSequence: 0, event: 'TRACK_ENDED' },
    }, { ...sender, tab: { id: 42 } })).resolves.toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_UNAUTHORIZED',
    });
    await expect(harness.coordinator.handleOffscreenTerminal({
      data: { sessionId: 'other-session', eventSequence: 3, event: 'TRACK_ENDED' },
    }, sender)).resolves.toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_UNAUTHORIZED',
    });
    expect(harness.manager.release).toHaveBeenCalledOnce();
  });

  it('authorizes one bootstrap request only for the exact connecting session event', async () => {
    const harness = createHarness();
    const started = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const connecting = harness.coordinator._advance(
      started.status,
      LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
    );
    expect(await harness.coordinator._writeDescriptor(
      connecting,
      started.status.sessionId,
      started.status,
    )).toBe(true);
    harness.coordinator.sessionRegistry.getSessionState(started.status.sessionId).descriptor = connecting;
    const sender = {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    };
    const request = {
      action: 'LIVE_DUBBING_REQUEST_PROVIDER_BOOTSTRAP',
      data: {
        sessionId: started.status.sessionId,
        providerId: 'gemini',
        targetLanguage: 'en',
        eventSequence: connecting.eventSequence,
      },
    };

    await expect(harness.coordinator.authorizeOffscreenControlMessage(
      request,
      sender,
      { type: 'bootstrap' },
    )).resolves.toMatchObject({ sessionId: 'session-1', status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER });
    await expect(harness.coordinator.authorizeOffscreenControlMessage(
      request,
      sender,
      { type: 'bootstrap' },
    )).resolves.toBeNull();
    expect(JSON.stringify(harness.storage.get(LIVE_DUBBING_STORAGE_KEY))).not.toContain('secret');
  });

  it('clears bootstrap request ownership across terminal cleanup and a repeated session', async () => {
    const harness = createHarness();
    const sender = {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    };

    const stageConnecting = async () => {
      const current = harness.coordinator.descriptor;
      const connecting = harness.coordinator._advance(
        current,
        LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
      );
      expect(await harness.coordinator._writeDescriptor(
        connecting,
        current.sessionId,
        current,
      )).toBe(true);
      harness.coordinator.sessionRegistry.getSessionState(current.sessionId).descriptor = connecting;
      return connecting;
    };
    const bootstrapRequest = eventSequence => ({
      action: 'LIVE_DUBBING_REQUEST_PROVIDER_BOOTSTRAP',
      data: { sessionId: 'session-1', providerId: 'gemini', targetLanguage: 'en', eventSequence },
    });

    const first = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const firstConnecting = await stageConnecting();
    await expect(harness.coordinator.authorizeOffscreenControlMessage(
      bootstrapRequest(firstConnecting.eventSequence),
      sender,
      { type: 'bootstrap' },
    )).resolves.toMatchObject({ sessionId: 'session-1' });
    expect(harness.coordinator.sessionRegistry.hasBootstrapSession('session-1')).toBe(true);

    await expect(harness.coordinator.handleOffscreenTerminal({
      data: { sessionId: first.status.sessionId, providerId: 'gemini', eventSequence: 0, event: 'TRACK_ENDED' },
    }, sender)).resolves.toMatchObject({ success: true, stopped: true });
    expect(harness.coordinator.sessionRegistry.hasBootstrapSession('session-1')).toBe(false);

    const second = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const secondConnecting = await stageConnecting();
    await expect(harness.coordinator.authorizeOffscreenControlMessage(
      bootstrapRequest(secondConnecting.eventSequence),
      sender,
      { type: 'bootstrap' },
    )).resolves.toMatchObject({ sessionId: second.status.sessionId });
  });

  it('retains a RUNNING descriptor when matching-lease status is incomplete', async () => {
    const stored = {
      sessionId: 'old-session',
      tabId: 42,
      targetLanguage: 'en',
      status: LIVE_DUBBING_STATUS.RUNNING,
      startedAt: 1,
      lastError: null,
      eventSequence: 2,
    };
    const harness = createHarness({ stored });
    harness.manager.activeLeases = [{
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'old-session',
      requiredReasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    }];

    const result = await harness.coordinator.reconcile();
    const actions = harness.browserAPI.runtime.sendMessage.mock.calls.map(([message]) => message.action);

    expect(result).toMatchObject({
      success: false,
      stale: true,
      recovered: false,
      retryable: true,
      status: { sessionId: 'old-session', status: LIVE_DUBBING_STATUS.RUNNING },
    });
    expect(actions).toEqual(['LIVE_DUBBING_STATUS']);
    expect(harness.manager.release).not.toHaveBeenCalled();
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
      sessionId: 'old-session',
      status: LIVE_DUBBING_STATUS.RUNNING,
    });
  });

  it('ignores a status response from a different provider identity', async () => {
    const harness = createHarness({ stored: {
      sessionId: 'old-session',
      tabId: 42,
      targetLanguage: 'en',
      status: LIVE_DUBBING_STATUS.RUNNING,
      startedAt: 1,
      lastError: null,
      eventSequence: 2,
    }, statusResponse: {
      success: true,
      active: true,
      sessionId: 'old-session',
      providerId: 'other-provider',
      status: LIVE_DUBBING_STATUS.RUNNING,
    } });

    const result = await harness.coordinator.reconcile();

    expect(result).toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_SESSION_MISMATCH',
      retryable: true,
      isolated: true,
    });
    expect(harness.manager.release).not.toHaveBeenCalled();
    expect(harness.browserAPI.runtime.sendMessage).toHaveBeenCalledOnce();
  });

  it('cleans up PREPARING_CAPTURE descriptor when status has no recoverable state', async () => {
    const stored = {
      sessionId: 'old-session',
      tabId: 42,
      targetLanguage: 'en',
      status: LIVE_DUBBING_STATUS.PREPARING_CAPTURE,
      startedAt: 1,
      lastError: null,
      eventSequence: 0,
    };
    const harness = createHarness({ stored, statusResponse: {
      success: true,
      sessionId: 'old-session',
    } });
    harness.manager.activeLeases = [{ owner: LIVE_DUBBING_OWNER, leaseId: 'old-session' }];

    const result = await harness.coordinator.reconcile();
    const actions = harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message.action);

    expect(result).toMatchObject({ success: true, stale: true, status: null });
    expect(actions).toEqual(['LIVE_DUBBING_STATUS', 'LIVE_DUBBING_DISPOSE']);
    expect(harness.manager.release).toHaveBeenCalledWith({
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'old-session',
    });
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
  });

  it('does not recover a capture-only offscreen session after worker restart', async () => {
    const stored = {
      sessionId: 'old-session',
      tabId: 42,
      targetLanguage: 'en',
      status: LIVE_DUBBING_STATUS.PREPARING_CAPTURE,
      startedAt: 1,
      lastError: null,
      eventSequence: 0,
    };
    const harness = createHarness({ stored, statusResponse: {
      success: true,
      active: true,
      sessionId: 'old-session',
      status: LIVE_DUBBING_INTERNAL_STATUS.CAPTURING,
    } });
    harness.manager.activeLeases = [{ owner: LIVE_DUBBING_OWNER, leaseId: 'old-session' }];

    const result = await harness.coordinator.reconcile();
    const actions = harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message.action);

    expect(result).toMatchObject({ success: true, stale: true, status: null });
    expect(actions).toEqual(['LIVE_DUBBING_STATUS', 'LIVE_DUBBING_DISPOSE']);
    expect(harness.manager.release).toHaveBeenCalledWith({
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'old-session',
    });
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
  });

  it('reconciles a pre-provider session after service-worker recovery', async () => {
    const track = {
      kind: 'audio',
      readyState: 'live',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      stop: vi.fn(),
    };
    const offscreen = new LiveDubbingController({
      mediaDevices: { getUserMedia: vi.fn(async () => ({
        getAudioTracks: () => [track],
        getTracks: () => [track],
      })) },
    });
    offscreen.prepare('old-session', 'gemini', 'en', 0);
    await offscreen.consume('old-session', 'gemini', 'stream-secret', 1);

    const harness = createHarness({ stored: {
      sessionId: 'old-session',
      tabId: 42,
      targetLanguage: 'en',
      status: LIVE_DUBBING_STATUS.PREPARING_CAPTURE,
      startedAt: 1,
      lastError: null,
      eventSequence: 1,
    } });
    harness.manager.activeLeases = [{
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'old-session',
      requiredReasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    }];
    harness.browserAPI.runtime.sendMessage.mockImplementation(message => {
      harness.calls.push(['message', message]);
      return offscreen.handle(message);
    });

    const result = await harness.coordinator.reconcile();
    const actions = harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message.action);

    expect(result).toMatchObject({ success: true, stale: true, status: null });
    expect(actions).toEqual(['LIVE_DUBBING_STATUS', 'LIVE_DUBBING_DISPOSE']);
    expect(harness.manager.release).toHaveBeenCalledWith({
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'old-session',
    });
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it('reacquires exact lease before adopting active offscreen capture', async () => {
    const stored = {
      sessionId: 'old-session',
      tabId: 42,
      targetLanguage: 'en',
      status: LIVE_DUBBING_STATUS.RUNNING,
      startedAt: 1,
      lastError: null,
      eventSequence: 2,
    };
    const harness = createHarness({ stored, statusResponse: {
      success: true,
      active: true,
      sessionId: 'old-session',
      status: LIVE_DUBBING_STATUS.RUNNING,
      captureReady: true,
      audioPathReady: true,
      inputPipelineReady: true,
      outputPipelineReady: true,
      setupComplete: true,
    } });

    const result = await harness.coordinator.reconcile();

    expect(result).toMatchObject({ success: true, recovered: true });
    expect(harness.manager.acquire).toHaveBeenCalledWith({
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'old-session',
      requiredReasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    });
    expect(harness.browserAPI.runtime.sendMessage).toHaveBeenCalledOnce();
    expect(harness.browserAPI.runtime.sendMessage.mock.calls[0][0].action)
      .toBe('LIVE_DUBBING_STATUS');
  });

  it('preserves OpenAI provider identity and lease reasons during recovery', async () => {
    const harness = createHarness({ stored: {
      sessionId: 'openai-session',
      tabId: 42,
      providerId: 'openai',
      targetLanguage: 'en-US',
      status: LIVE_DUBBING_STATUS.RUNNING,
      startedAt: 1,
      lastError: null,
      eventSequence: 2,
    }, statusResponse: {
      success: true,
      active: true,
      sessionId: 'openai-session',
      providerId: 'openai',
      status: LIVE_DUBBING_STATUS.RUNNING,
      captureReady: true,
      audioPathReady: true,
      setupComplete: true,
    } });

    const result = await harness.coordinator.reconcile();

    expect(result).toMatchObject({ success: true, recovered: true, status: { providerId: 'openai' } });
    expect(harness.manager.acquire).toHaveBeenCalledWith({
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'openai-session',
      requiredReasons: ['USER_MEDIA', 'AUDIO_PLAYBACK', 'WEB_RTC'],
    });
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({ providerId: 'openai' });
  });

  it('reconciles a foreign Gemini lease without borrowing the active OpenAI identity', async () => {
    const harness = createHarness({ stored: {
      sessionId: 'openai-session',
      tabId: 42,
      providerId: 'openai',
      targetLanguage: 'en-US',
      status: LIVE_DUBBING_STATUS.RUNNING,
      startedAt: 1,
      lastError: null,
      eventSequence: 2,
    } });
    const leases = [
      {
        owner: LIVE_DUBBING_OWNER,
        leaseId: 'openai-session',
        requiredReasons: ['USER_MEDIA', 'AUDIO_PLAYBACK', 'WEB_RTC'],
      },
      {
        owner: LIVE_DUBBING_OWNER,
        leaseId: 'orphan-session',
        requiredReasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      },
    ];
    harness.manager.activeLeases = leases;
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      harness.calls.push(['message', message]);
      const { sessionId, providerId } = message.data;
      if (message.action === 'LIVE_DUBBING_STATUS') {
        if (sessionId === 'openai-session') {
          return {
            success: true,
            active: true,
            sessionId,
            providerId,
            status: LIVE_DUBBING_STATUS.RUNNING,
            captureReady: true,
            audioPathReady: true,
            setupComplete: true,
          };
        }
        return {
          success: true,
          active: true,
          sessionId,
          providerId: 'gemini',
          status: LIVE_DUBBING_STATUS.RUNNING,
          captureReady: true,
          audioPathReady: true,
          setupComplete: true,
        };
      }
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        return { success: true, ack: 'DISPOSED', sessionId, providerId };
      }
      return { success: true };
    });

    const result = await harness.coordinator.reconcile();
    const messages = harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message);

    expect(result).toMatchObject({
      success: true,
      recovered: true,
      status: { sessionId: 'openai-session', providerId: 'openai' },
    });
    expect(messages).toEqual([
      expect.objectContaining({
        action: 'LIVE_DUBBING_STATUS',
        data: expect.objectContaining({ sessionId: 'openai-session', providerId: 'openai' }),
      }),
      expect.objectContaining({
        action: 'LIVE_DUBBING_STATUS',
        data: expect.objectContaining({ sessionId: 'orphan-session', providerId: 'gemini' }),
      }),
      expect.objectContaining({
        action: 'LIVE_DUBBING_STATUS',
        data: expect.objectContaining({ sessionId: 'orphan-session', providerId: 'openai' }),
      }),
      expect.objectContaining({
        action: 'LIVE_DUBBING_DISPOSE',
        data: expect.objectContaining({ sessionId: 'orphan-session', providerId: 'gemini' }),
      }),
    ]);
    expect(harness.manager.release).toHaveBeenCalledWith({
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'orphan-session',
    });
    expect(harness.manager.activeLeases).toEqual([leases[0]]);
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
      sessionId: 'openai-session',
      providerId: 'openai',
    });
  });

  it('does not report recovered capture when lease reacquisition fails', async () => {
    const stored = {
      sessionId: 'old-session',
      tabId: 42,
      targetLanguage: 'en',
      status: LIVE_DUBBING_STATUS.RUNNING,
      startedAt: 1,
      lastError: null,
      eventSequence: 2,
    };
    const harness = createHarness({ stored, statusResponse: {
      success: true,
      active: true,
      sessionId: 'old-session',
      status: LIVE_DUBBING_STATUS.RUNNING,
      captureReady: true,
      audioPathReady: true,
      inputPipelineReady: true,
      outputPipelineReady: true,
      setupComplete: true,
    } });
    harness.manager.acquire.mockResolvedValueOnce(false);

    const result = await harness.coordinator.reconcile();

    expect(result).toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_LEASE_ACQUIRE_FAILED',
      recovered: false,
      retryable: true,
      status: { status: LIVE_DUBBING_STATUS.ERROR },
    });
    expect(harness.browserAPI.runtime.sendMessage).toHaveBeenCalledOnce();
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
      sessionId: 'old-session',
      status: LIVE_DUBBING_STATUS.ERROR,
    });
    expect(harness.manager.release).not.toHaveBeenCalled();
  });

  it('clears descriptor when exact offscreen session and lease are both absent', async () => {
    const stored = {
      sessionId: 'old-session',
      tabId: 42,
      targetLanguage: 'en',
      status: LIVE_DUBBING_STATUS.ERROR,
      startedAt: 1,
      lastError: 'START_FAILED',
      eventSequence: 1,
    };
    const harness = createHarness({ stored, statusResponse: {
      success: true,
      active: false,
      sessionId: 'old-session',
      status: 'IDLE',
    } });

    const result = await harness.coordinator.reconcile();
    const actions = harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message.action);

    expect(result).toMatchObject({ success: true, stale: true, status: null });
    expect(actions).toEqual(['LIVE_DUBBING_STATUS']);
    expect(harness.manager.release).not.toHaveBeenCalled();
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
  });

  it('clears an inactive persisted OpenAI descriptor without probing Gemini', async () => {
    const harness = createHarness({ stored: {
      sessionId: 'openai-session',
      tabId: 42,
      providerId: LIVE_DUBBING_OPENAI_PROVIDER_ID,
      targetLanguage: 'en-US',
      status: LIVE_DUBBING_STATUS.ERROR,
      startedAt: 1,
      lastError: 'START_FAILED',
      eventSequence: 1,
    }, statusResponse: {
      success: true,
      active: false,
      sessionId: 'openai-session',
      providerId: LIVE_DUBBING_OPENAI_PROVIDER_ID,
      status: 'IDLE',
    } });

    const result = await harness.coordinator.reconcile();
    const messages = harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message);

    expect(result).toMatchObject({ success: true, stale: true, status: null });
    expect(messages).toEqual([
      expect.objectContaining({
        action: 'LIVE_DUBBING_STATUS',
        data: expect.objectContaining({
          sessionId: 'openai-session',
          providerId: LIVE_DUBBING_OPENAI_PROVIDER_ID,
        }),
      }),
    ]);
    expect(harness.manager.release).not.toHaveBeenCalled();
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
  });

  it('isolates a persisted OpenAI descriptor from a Gemini status mismatch', async () => {
    const harness = createHarness({ stored: {
      sessionId: 'openai-session',
      tabId: 42,
      providerId: LIVE_DUBBING_OPENAI_PROVIDER_ID,
      targetLanguage: 'en-US',
      status: LIVE_DUBBING_STATUS.RUNNING,
      startedAt: 1,
      lastError: null,
      eventSequence: 2,
    }, statusResponse: {
      success: true,
      active: false,
      sessionId: 'openai-session',
      providerId: 'gemini',
      status: 'IDLE',
    } });

    const result = await harness.coordinator.reconcile();

    expect(result).toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_SESSION_MISMATCH',
      isolated: true,
      retryable: true,
    });
    expect(harness.browserAPI.runtime.sendMessage).toHaveBeenCalledOnce();
    expect(harness.manager.release).not.toHaveBeenCalled();
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
      sessionId: 'openai-session',
      providerId: LIVE_DUBBING_OPENAI_PROVIDER_ID,
    });
  });

  it('clears descriptor after crash before lease acquisition when offscreen document is absent', async () => {
    const stored = {
      sessionId: 'old-session',
      tabId: 42,
      targetLanguage: 'en',
      status: LIVE_DUBBING_STATUS.PREPARING_CAPTURE,
      startedAt: 1,
      lastError: null,
      eventSequence: 0,
    };
    const harness = createHarness({ stored, documentExists: false });

    const result = await harness.coordinator.reconcile();

    expect(result).toMatchObject({ success: true, stale: true, status: null });
    expect(harness.browserAPI.runtime.sendMessage).not.toHaveBeenCalled();
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
  });

  it('clears error descriptor after offscreen document and matching lease disappear', async () => {
    const stored = {
      sessionId: 'old-session',
      tabId: 42,
      targetLanguage: 'en',
      status: LIVE_DUBBING_STATUS.ERROR,
      startedAt: 1,
      lastError: 'START_FAILED',
      eventSequence: 1,
    };
    const harness = createHarness({ stored, documentExists: false, statusResponse: null });

    const result = await harness.coordinator.reconcile();

    expect(result).toMatchObject({ success: true, stale: true, status: null });
    expect(harness.browserAPI.runtime.sendMessage).not.toHaveBeenCalled();
    expect(harness.manager.release).not.toHaveBeenCalled();
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
  });

  it('retries reconciliation after transient dispose failure', async () => {
    const stored = {
      sessionId: 'old-session',
      tabId: 42,
      targetLanguage: 'en',
      status: LIVE_DUBBING_STATUS.PREPARING_CAPTURE,
      startedAt: 1,
      lastError: null,
      eventSequence: 0,
    };
    const harness = createHarness({ stored, statusResponse: {
      success: true,
      active: false,
      sessionId: 'old-session',
      status: 'ERROR',
    } });
    harness.manager.activeLeases = [{ owner: LIVE_DUBBING_OWNER, leaseId: 'old-session' }];
    harness.browserAPI.runtime.sendMessage
      .mockImplementationOnce(async message => {
        harness.calls.push(['message', message]);
        return {
          success: true,
          active: false,
          sessionId: 'old-session',
          providerId: 'gemini',
          status: 'ERROR',
        };
      })
      .mockImplementationOnce(async message => {
        harness.calls.push(['message', message]);
        expect(message.action).toBe('LIVE_DUBBING_DISPOSE');
        return { success: false, sessionId: 'old-session', providerId: 'gemini' };
      });

    const failed = await harness.coordinator.reconcile();
    const retried = await harness.coordinator.reconcile();

    expect(failed).toMatchObject({ success: false, cleanupPending: true, retryable: true });
    expect(retried).toMatchObject({ success: true, stale: true, status: null });
    expect(harness.manager.release).toHaveBeenCalledOnce();
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
  });

  it('retries reconciliation after transient lease release failure', async () => {
    const stored = {
      sessionId: 'old-session',
      tabId: 42,
      targetLanguage: 'en',
      status: LIVE_DUBBING_STATUS.PREPARING_CAPTURE,
      startedAt: 1,
      lastError: null,
      eventSequence: 0,
    };
    const harness = createHarness({ stored, statusResponse: {
      success: true,
      active: false,
      sessionId: 'old-session',
      status: 'ERROR',
    } });
    harness.manager.activeLeases = [{ owner: LIVE_DUBBING_OWNER, leaseId: 'old-session' }];
    harness.manager.release.mockRejectedValueOnce(new Error('release failed'));

    const failed = await harness.coordinator.reconcile();
    const retried = await harness.coordinator.reconcile();

    expect(failed).toMatchObject({ success: false, cleanupPending: true, retryable: true });
    expect(retried).toMatchObject({ success: true, stale: true, status: null });
    expect(harness.manager.release).toHaveBeenCalledTimes(2);
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
  });

  it('does not clean up or release when reconciliation status belongs to another session', async () => {
    const stored = {
      sessionId: 'old-session',
      tabId: 42,
      targetLanguage: 'en',
      status: LIVE_DUBBING_STATUS.RUNNING,
      startedAt: 1,
      lastError: null,
      eventSequence: 2,
    };
    const harness = createHarness({ stored, statusResponse: {
      success: true,
      active: true,
      sessionId: 'old-session',
      requestedSessionId: 'old-session',
      actualSessionId: 'other-session',
    } });
    harness.manager.activeLeases = [{ owner: LIVE_DUBBING_OWNER, leaseId: 'old-session' }];

    const result = await harness.coordinator.reconcile();

    expect(result).toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_SESSION_MISMATCH',
      recovered: false,
      status: { sessionId: 'old-session' },
      isolated: true,
      retryable: true,
    });
    expect(result).not.toHaveProperty('actualSessionId');
    expect(result).not.toHaveProperty('requestedSessionId');
    expect(harness.manager.release).not.toHaveBeenCalled();
    expect(harness.browserAPI.runtime.sendMessage).toHaveBeenCalledOnce();
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
      sessionId: 'old-session',
      status: LIVE_DUBBING_STATUS.RUNNING,
    });
  });

  it('isolates reconciliation when offscreen owns a different session (real controller status)', async () => {
    const stored = {
      sessionId: 'session-A',
      tabId: 42,
      targetLanguage: 'en',
      status: LIVE_DUBBING_STATUS.RUNNING,
      startedAt: 1,
      lastError: null,
      eventSequence: 2,
    };
    // Offscreen currently owns session B. The status query for A must return
    // the real controller mismatch shape, not a hand-mocked status object.
    const offscreen = new LiveDubbingController();
    offscreen.prepare('session-B', 'gemini', 'en', 0);

    const harness = createHarness({ stored });
    harness.manager.activeLeases = [{ owner: LIVE_DUBBING_OWNER, leaseId: 'session-A' }];
    const dispose = vi.spyOn(harness.coordinator.cleanupManager, 'disposeAndRelease');
    harness.browserAPI.runtime.sendMessage.mockImplementation(message => {
      harness.calls.push(['message', message]);
      return offscreen.handle(message);
    });

    // Prove the real controller response carries explicit session + provider proof.
    const direct = offscreen.status('session-A', 'gemini');
    expect(direct).toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_SESSION_MISMATCH',
      ignored: true,
      sessionId: 'session-A',
      providerId: 'gemini',
      requestedSessionId: 'session-A',
      actualSessionId: 'session-B',
      requestedProviderId: 'gemini',
      actualProviderId: 'gemini',
    });

    const result = await harness.coordinator.reconcile();
    const actions = harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message.action);

    expect(result).toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_SESSION_MISMATCH',
      recovered: false,
      isolated: true,
      retryable: true,
      status: { sessionId: 'session-A' },
    });
    expect(actions).toEqual(['LIVE_DUBBING_STATUS']);
    expect(dispose).not.toHaveBeenCalled();
    expect(harness.manager.release).not.toHaveBeenCalled();
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
      sessionId: 'session-A',
      status: LIVE_DUBBING_STATUS.RUNNING,
    });
  });

  it('does not let stale terminal cleanup clear a newer session descriptor', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});

    let resolveDispose;
    const originalSendMessage = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        return new Promise(resolve => { resolveDispose = resolve; });
      }
      return originalSendMessage(message);
    });

    const stopPromise = harness.coordinator.stop({ data: { sessionId: 'session-1' } });
    while (!resolveDispose) await Promise.resolve();

    await harness.browserAPI.storage.session.set({
      [LIVE_DUBBING_STORAGE_KEY]: {
        sessionId: 'new-session',
        tabId: 84,
        providerId: 'gemini',
        targetLanguage: 'de',
        status: LIVE_DUBBING_STATUS.RUNNING,
        startedAt: 2,
        lastError: null,
        eventSequence: 1,
      },
    });
    resolveDispose({
      success: true,
      ack: 'DISPOSED',
      sessionId: 'session-1',
      providerId: 'gemini',
    });

    const result = await stopPromise;

    expect(result).toMatchObject({ success: true, stopped: false, ignored: true });
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
      sessionId: 'new-session',
    });
    expect(harness.manager.release).toHaveBeenCalledWith({
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'session-1',
    });
  });

  it('fences a late first cleanup attempt after a newer session takes ownership', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
      let resolveDispose;
      const originalSendMessage = harness.browserAPI.runtime.sendMessage.getMockImplementation();
      harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
        if (message.action === 'LIVE_DUBBING_DISPOSE') {
          return new Promise(resolve => { resolveDispose = resolve; });
        }
        return originalSendMessage(message);
      });

      const stop = harness.coordinator.stop({ data: { sessionId: 'session-1' } });
      while (!resolveDispose) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(LIVE_DUBBING_STOP_TIMEOUT);
      await expect(stop).resolves.toMatchObject({
        success: false,
        error: 'LIVE_DUBBING_STOP_TIMEOUT',
        cleanupPending: true,
      });

      harness.manager.activeLeases = [
        { owner: LIVE_DUBBING_OWNER, leaseId: 'session-1' },
        { owner: LIVE_DUBBING_OWNER, leaseId: 'new-session' },
      ];
      await harness.browserAPI.storage.session.set({
        [LIVE_DUBBING_STORAGE_KEY]: {
          sessionId: 'new-session',
          tabId: 84,
          providerId: 'gemini',
          targetLanguage: 'de',
          status: LIVE_DUBBING_STATUS.RUNNING,
          startedAt: 2,
          lastError: null,
          eventSequence: 1,
        },
      });
      resolveDispose({
        success: true,
        ack: 'DISPOSED',
        sessionId: 'session-1',
        providerId: 'gemini',
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
        sessionId: 'new-session',
      });
      expect(harness.manager.activeLeases).toEqual([
        { owner: LIVE_DUBBING_OWNER, leaseId: 'new-session' },
      ]);
      expect(harness.manager.release).toHaveBeenCalledWith({
        owner: LIVE_DUBBING_OWNER,
        leaseId: 'session-1',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a foreign-provider terminal without impacting the active OpenAI session', async () => {
    const harness = createHarness();
    const started = await harness.coordinator.start({
      data: { providerId: 'openai', targetLanguage: 'en-US' },
    }, {});
    const sender = {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    };

    const result = await harness.coordinator.handleOffscreenTerminal({
      data: { sessionId: started.status.sessionId, providerId: 'gemini', event: 'STALE_TERMINAL' },
    }, sender);

    expect(result).toMatchObject({ success: false, error: 'LIVE_DUBBING_UNAUTHORIZED', ignored: true });
    expect(harness.manager.release).not.toHaveBeenCalled();
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
      providerId: 'openai',
      sessionId: started.status.sessionId,
    });
  });

  it.each([
    ['Gemini-looking', ['USER_MEDIA', 'AUDIO_PLAYBACK']],
    ['OpenAI-looking', ['USER_MEDIA', 'AUDIO_PLAYBACK', 'WEB_RTC']],
  ])('probes every canonical provider for a descriptorless %s orphan', async (
    _label,
    requiredReasons,
  ) => {
    const harness = createHarness({ statusResponse: {
      success: true,
      active: false,
      sessionId: 'orphan-session',
      status: 'IDLE',
    } });
    harness.manager.activeLeases = [{
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'orphan-session',
      requiredReasons,
    }];

    const result = await harness.coordinator.reconcile();
    const messages = harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message);
    const expectedProviderIds = [...LIVE_DUBBING_PROVIDER_IDS];

    expect(result).toMatchObject({ success: true, stale: true, status: null });
    expect(messages).toEqual([
      expect.objectContaining({
        action: 'LIVE_DUBBING_STATUS',
        data: { sessionId: 'orphan-session', providerId: expectedProviderIds[0] },
      }),
      expect.objectContaining({
        action: 'LIVE_DUBBING_STATUS',
        data: { sessionId: 'orphan-session', providerId: expectedProviderIds[1] },
      }),
      expect.objectContaining({
        action: 'LIVE_DUBBING_DISPOSE',
        data: expect.objectContaining({ sessionId: 'orphan-session', providerId: expectedProviderIds[0] }),
      }),
    ]);
    expect(harness.manager.release).toHaveBeenCalledWith({
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'orphan-session',
    });
    expect(harness.manager.activeLeases).toEqual([]);
  });

  it('ignores foreign-owner leases during reconciliation', async () => {
    const harness = createHarness();
    const foreignLease = { owner: 'other-owner', leaseId: 'foreign-session' };
    harness.manager.activeLeases = [foreignLease];

    const result = await harness.coordinator.reconcile();

    expect(result).toEqual({
      success: true,
      status: null,
      recovered: false,
      stale: false,
    });
    expect(harness.browserAPI.runtime.sendMessage).not.toHaveBeenCalled();
    expect(harness.manager.release).not.toHaveBeenCalled();
    expect(harness.manager.activeLeases).toEqual([foreignLease]);
  });

  it('releases an untrusted lease only after an exact provider probe proves it is inactive', async () => {
    const harness = createHarness();
    harness.manager.activeLeases = [{
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'untrusted-session',
      requiredReasons: ['WORKERS'],
    }];
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      harness.calls.push(['message', message]);
      const { sessionId, providerId } = message.data;
      if (message.action === 'LIVE_DUBBING_STATUS' && providerId === 'openai') {
        return { success: true, active: false, sessionId, providerId, status: 'IDLE' };
      }
      if (message.action === 'LIVE_DUBBING_STATUS') {
        return {
          success: false,
          error: 'LIVE_DUBBING_SESSION_MISMATCH',
          sessionId,
          providerId,
        };
      }
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        return { success: true, ack: 'DISPOSED', sessionId, providerId };
      }
      return { success: true };
    });

    const result = await harness.coordinator.reconcile();
    const messages = harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message);

    expect(result).toMatchObject({ success: true, stale: true });
    expect(messages.map(message => [message.action, message.data.providerId])).toEqual([
      ['LIVE_DUBBING_STATUS', 'gemini'],
      ['LIVE_DUBBING_STATUS', 'openai'],
      ['LIVE_DUBBING_DISPOSE', 'openai'],
    ]);
    expect(harness.manager.release).toHaveBeenCalledWith({
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'untrusted-session',
    });
  });

  it.each([
    ['Gemini-looking', ['USER_MEDIA', 'AUDIO_PLAYBACK'], 'openai'],
    ['OpenAI-looking', ['USER_MEDIA', 'AUDIO_PLAYBACK', 'WEB_RTC'], 'gemini'],
  ])('uses authoritative %s orphan status instead of lease reasons', async (
    _label,
    requiredReasons,
    authoritativeProviderId,
  ) => {
    const harness = createHarness();
    harness.manager.activeLeases = [{
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'orphan-session',
      requiredReasons,
    }];
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      harness.calls.push(['message', message]);
      const { sessionId, providerId } = message.data;
      if (message.action === 'LIVE_DUBBING_STATUS') {
        if (providerId === authoritativeProviderId) {
          return {
            success: true,
            active: true,
            sessionId,
            providerId,
            status: LIVE_DUBBING_STATUS.RUNNING,
          };
        }
        return {
          success: false,
          error: 'LIVE_DUBBING_SESSION_MISMATCH',
          sessionId,
          providerId,
          requestedSessionId: sessionId,
          actualSessionId: sessionId,
          requestedProviderId: providerId,
          actualProviderId: authoritativeProviderId,
        };
      }
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        return { success: true, ack: 'DISPOSED', sessionId, providerId };
      }
      return { success: true };
    });

    const result = await harness.coordinator.reconcile();
    const messages = harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message);

    expect(result).toMatchObject({ success: true, stale: true, status: null });
    expect(messages.map(message => [message.action, message.data.providerId])).toEqual([
      ...LIVE_DUBBING_PROVIDER_IDS.map(providerId => ['LIVE_DUBBING_STATUS', providerId]),
      ['LIVE_DUBBING_DISPOSE', authoritativeProviderId],
    ]);
    expect(harness.manager.release).toHaveBeenCalledWith({
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'orphan-session',
    });
  });

  it('uses only the valid descriptor provider during recovery', async () => {
    const harness = createHarness({ stored: {
      sessionId: 'openai-session',
      tabId: 42,
      providerId: LIVE_DUBBING_OPENAI_PROVIDER_ID,
      targetLanguage: 'en-US',
      status: LIVE_DUBBING_STATUS.RUNNING,
      startedAt: 1,
      lastError: null,
      eventSequence: 2,
    }, statusResponse: {
      success: true,
      active: true,
      sessionId: 'openai-session',
      providerId: LIVE_DUBBING_OPENAI_PROVIDER_ID,
      status: LIVE_DUBBING_STATUS.RUNNING,
      captureReady: true,
      audioPathReady: true,
      setupComplete: true,
    } });
    harness.manager.activeLeases = [{
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'openai-session',
      requiredReasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    }];

    const result = await harness.coordinator.reconcile();
    const messages = harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message);

    expect(result).toMatchObject({ success: true, recovered: true, status: {
      providerId: LIVE_DUBBING_OPENAI_PROVIDER_ID,
    } });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      action: 'LIVE_DUBBING_STATUS',
      data: { sessionId: 'openai-session', providerId: LIVE_DUBBING_OPENAI_PROVIDER_ID },
    });
  });

  it('persists OFFSCREEN_LOST before clearing a persisted RUNNING descriptor after document loss', async () => {
    const harness = createHarness({
      stored: {
        sessionId: 'old-session',
        tabId: 42,
        targetLanguage: 'en',
        status: LIVE_DUBBING_STATUS.RUNNING,
        startedAt: 1,
        lastError: null,
        eventSequence: 2,
      },
      documentExists: false,
    });

    const result = await harness.coordinator.reconcile();

    expect(result).toEqual({
      success: true,
      status: null,
      stale: true,
      recovered: false,
      retryable: false,
    });
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toEqual({
      sourceSessionId: 'old-session',
      providerId: 'gemini',
      error: 'LIVE_DUBBING_OFFSCREEN_LOST',
      occurredAt: 123,
      providerDiagnostic: null,
    });
    expect(harness.manager.release).not.toHaveBeenCalled();
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message.action)).toEqual(['LIVE_DUBBING_TERMINAL_OUTCOME']);
  });

  it('releases a matching stale lease during document-loss reconciliation without DISPOSE', async () => {
    const harness = createHarness({
      stored: {
        sessionId: 'old-session',
        tabId: 42,
        targetLanguage: 'en',
        status: LIVE_DUBBING_STATUS.RUNNING,
        startedAt: 1,
        lastError: null,
        eventSequence: 2,
      },
      documentExists: false,
    });
    harness.manager.activeLeases = [{ owner: LIVE_DUBBING_OWNER, leaseId: 'old-session' }];

    const result = await harness.coordinator.reconcile();

    expect(result).toMatchObject({ success: true, status: null, stale: true, recovered: false });
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .some(([message]) => message.action === 'LIVE_DUBBING_DISPOSE')).toBe(false);
    expect(harness.manager.release).toHaveBeenCalledOnce();
    expect(harness.manager.release).toHaveBeenCalledWith({
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'old-session',
    });
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toMatchObject({
      sourceSessionId: 'old-session',
      providerId: 'gemini',
      error: 'LIVE_DUBBING_OFFSCREEN_LOST',
    });
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .filter(([message]) => message.action === 'LIVE_DUBBING_TERMINAL_OUTCOME')).toHaveLength(1);
  });

  it('ordinarily cleans an exact ERROR status for a persisted RUNNING descriptor', async () => {
    const harness = createHarness({
      stored: {
        sessionId: 'old-session',
        tabId: 42,
        targetLanguage: 'en',
        status: LIVE_DUBBING_STATUS.RUNNING,
        startedAt: 1,
        lastError: null,
        eventSequence: 2,
      },
      documentExists: true,
      statusResponse: {
        success: true,
        active: false,
        sessionId: 'old-session',
        providerId: 'gemini',
        status: LIVE_DUBBING_STATUS.ERROR,
      },
    });
    harness.manager.activeLeases = [{ owner: LIVE_DUBBING_OWNER, leaseId: 'old-session' }];

    const result = await harness.coordinator.reconcile();

    expect(result).toMatchObject({ success: true, status: null, stale: true, retryable: false });
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([message]) => message.action)).toEqual([
      'LIVE_DUBBING_STATUS',
      'LIVE_DUBBING_DISPOSE',
    ]);
    expect(harness.manager.release).toHaveBeenCalledOnce();
    expect(harness.manager.release).toHaveBeenCalledWith({
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'old-session',
    });
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toBeUndefined();
  });

  it.each(['IDLE', 'MISSING', 'DISPOSED'])('persists OFFSCREEN_LOST before clearing a recreated document with exact %s status', async status => {
      const harness = createHarness({
        stored: {
          sessionId: 'old-session',
          tabId: 42,
          targetLanguage: 'en',
          status: LIVE_DUBBING_STATUS.RUNNING,
          startedAt: 1,
          lastError: null,
          eventSequence: 2,
        },
        documentExists: true,
        statusResponse: {
          success: true,
          active: false,
          sessionId: 'old-session',
          status,
          ...(status === 'DISPOSED' ? { disposed: true } : {}),
        },
      });
      harness.manager.activeLeases = [{ owner: LIVE_DUBBING_OWNER, leaseId: 'old-session' }];

      const result = await harness.coordinator.reconcile();

      expect(result).toMatchObject({
        success: true,
        status: null,
        stale: true,
        recovered: false,
        retryable: false,
      });
      expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
      expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toMatchObject({
        sourceSessionId: 'old-session',
        providerId: 'gemini',
        error: 'LIVE_DUBBING_OFFSCREEN_LOST',
        providerDiagnostic: null,
      });
      expect(harness.manager.release).toHaveBeenCalledOnce();
      expect(harness.manager.release).toHaveBeenCalledWith({
        owner: LIVE_DUBBING_OWNER,
        leaseId: 'old-session',
      });
      expect(harness.browserAPI.runtime.sendMessage.mock.calls
        .map(([message]) => message.action)).toEqual([
        'LIVE_DUBBING_STATUS',
        'LIVE_DUBBING_TERMINAL_OUTCOME',
      ]);
    });

  it.each([
    ['unknown status', { success: true, active: false, sessionId: 'old-session' }, null],
    ['null response', null, null],
    ['unknown status with known document', { success: true, active: false, sessionId: 'old-session' }, true],
  ])('does not clear or create an outcome for an ambiguous RUNNING reconciliation (%s)', async (_label, statusResponse, documentExists) => {
    const harness = createHarness({
      stored: {
        sessionId: 'old-session',
        tabId: 42,
        targetLanguage: 'en',
        status: LIVE_DUBBING_STATUS.RUNNING,
        startedAt: 1,
        lastError: null,
        eventSequence: 2,
      },
      documentExists,
      statusResponse: statusResponse || {},
    });
    harness.manager.activeLeases = [{ owner: LIVE_DUBBING_OWNER, leaseId: 'old-session' }];
    if (statusResponse === null) {
      const originalSendMessage = harness.browserAPI.runtime.sendMessage.getMockImplementation();
      harness.browserAPI.runtime.sendMessage.mockImplementation(async message => (
        message.action === 'LIVE_DUBBING_STATUS' ? null : originalSendMessage(message)
      ));
    }

    const result = await harness.coordinator.reconcile();

    expect(result).toMatchObject({
      success: false,
      stale: true,
      recovered: false,
      retryable: true,
      status: { sessionId: 'old-session', status: LIVE_DUBBING_STATUS.RUNNING },
    });
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({
      sessionId: 'old-session',
      status: LIVE_DUBBING_STATUS.RUNNING,
    });
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toBeUndefined();
    expect(harness.manager.release).not.toHaveBeenCalled();
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .some(([message]) => message.action === 'LIVE_DUBBING_TERMINAL_OUTCOME')).toBe(false);
  });

  it('fails closed when an untrusted lease has ambiguous active provider probes', async () => {
    const harness = createHarness();
    harness.manager.activeLeases = [{
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'ambiguous-session',
      requiredReasons: ['WORKERS'],
    }];
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      harness.calls.push(['message', message]);
      return {
        success: true,
        active: true,
        sessionId: message.data.sessionId,
        providerId: message.data.providerId,
        status: LIVE_DUBBING_STATUS.RUNNING,
      };
    });

    const result = await harness.coordinator.reconcile();

    expect(result).toMatchObject({
      success: false,
      stale: true,
      retryable: true,
      providerIdentityRequired: true,
    });
    expect(harness.manager.release).not.toHaveBeenCalled();
    expect(harness.browserAPI.runtime.sendMessage).toHaveBeenCalledTimes(2);
  });

  // ---- lifecycle policy ownership (Coordinator, not Store) ----
  it('prevents terminalRequested session from committing non-terminal transition', async () => {
    const harness = createHarness({
      stored: {
        sessionId: 'session-1',
        tabId: 42,
        targetLanguage: 'en',
        status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
        startedAt: 123,
        lastError: null,
        eventSequence: 2,
      },
    });
    await harness.coordinator._readStatusSnapshot();
    const descriptor = harness.coordinator.descriptor;
    // ensure session state exists for terminalRequested check
    const state = { descriptor, terminalRequested: false, leaseAcquired: true, prepared: true, cleanupCompleted: false, providerDiagnostic: null, cleanupFacts: null };
    harness.coordinator.sessionRegistry.setSessionState(descriptor.sessionId, state);
    state.terminalRequested = true;

    const attempt = { ...descriptor, status: LIVE_DUBBING_STATUS.RUNNING, eventSequence: descriptor.eventSequence + 1 };
    const ok = await harness.coordinator._writeDescriptor(attempt, descriptor.sessionId, descriptor);
    expect(ok).toBe(false);
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY).eventSequence).toBe(2);
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY).status).toBe(LIVE_DUBBING_STATUS.CONNECTING_PROVIDER);
    // terminal states are allowed
    const stopping = { ...descriptor, status: LIVE_DUBBING_STATUS.STOPPING, eventSequence: descriptor.eventSequence + 1 };
    const okStopping = await harness.coordinator._writeDescriptor(stopping, descriptor.sessionId, descriptor);
    expect(okStopping).toBe(true);
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY).status).toBe(LIVE_DUBBING_STATUS.STOPPING);
  });

  it('prevents STOPPING from regressing to RUNNING without STOPPING expectedDescriptor', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    const descriptor = harness.coordinator.descriptor;
    const stopping = { ...descriptor, status: LIVE_DUBBING_STATUS.STOPPING, eventSequence: descriptor.eventSequence + 1 };
    expect(await harness.coordinator._writeDescriptor(stopping, descriptor.sessionId, descriptor)).toBe(true);
    harness.coordinator.sessionRegistry.getSessionState(descriptor.sessionId).descriptor = stopping;
    // now try to regress to RUNNING with expectedDescriptor not STOPPING
    const running = { ...stopping, status: LIVE_DUBBING_STATUS.RUNNING, eventSequence: stopping.eventSequence + 1 };
    const regress = await harness.coordinator._writeDescriptor(running, descriptor.sessionId, descriptor);
    expect(regress).toBe(false);
    // with STOPPING expectedDescriptor it is allowed (internal ERROR transition)
    const errorFromStopping = { ...stopping, status: LIVE_DUBBING_STATUS.ERROR, eventSequence: stopping.eventSequence + 1, lastError: 'STOP_FAILED' };
    const okError = await harness.coordinator._writeDescriptor(errorFromStopping, descriptor.sessionId, stopping);
    expect(okError).toBe(true);
  });

  it('successful RUNNING clears previous outcome atomically via Coordinator', async () => {
    const outcome = {
      sourceSessionId: 'session-1',
      providerId: 'gemini',
      error: 'LIVE_DUBBING_PROVIDER_ERROR',
      occurredAt: 123,
      providerDiagnostic: null,
    };
    const harness = createHarness({
      stored: {
        sessionId: 'session-1',
        tabId: 42,
        targetLanguage: 'en',
        status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
        startedAt: 123,
        lastError: null,
        eventSequence: 2,
      },
      outcome,
    });
    // hydrate outcome into store
    await harness.coordinator._readStatusSnapshot();
    expect(harness.coordinator.terminalOutcome).toMatchObject({ sourceSessionId: 'session-1' });
    const state = harness.coordinator.sessionRegistry.getSessionState('session-1') || { descriptor: harness.coordinator.descriptor, terminalRequested: false, leaseAcquired: true, prepared: true, cleanupCompleted: false, providerDiagnostic: null, cleanupFacts: null };
    if (!harness.coordinator.sessionRegistry.getSessionState('session-1')) harness.coordinator.sessionRegistry.setSessionState('session-1', state);
    state.descriptor = harness.coordinator.descriptor;
    const running = { ...harness.coordinator.descriptor, status: LIVE_DUBBING_STATUS.RUNNING, eventSequence: 3 };
    const ok = await harness.coordinator._writeDescriptor(running, 'session-1', harness.coordinator.descriptor, { clearOutcome: true });
    expect(ok).toBe(true);
    expect(harness.coordinator.terminalOutcome).toBeNull();
    expect(harness.coordinator.outcomeStorageState).toBe(LIVE_DUBBING_OUTCOME_STORAGE_STATE.ABSENT);
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toBeNull();
    expect(harness.browserAPI.storage.session.set).toHaveBeenCalledWith(expect.objectContaining({
      [LIVE_DUBBING_STORAGE_KEY]: expect.objectContaining({ status: LIVE_DUBBING_STATUS.RUNNING }),
      [LIVE_DUBBING_OUTCOME_STORAGE_KEY]: null,
    }));
  });

  it('terminal racing outcome mutation cannot commit RUNNING', async () => {
    const harness = createHarness({
      stored: {
        sessionId: 'session-1',
        tabId: 42,
        targetLanguage: 'en',
        status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
        startedAt: 123,
        lastError: null,
        eventSequence: 2,
      },
    });
    await harness.coordinator._readStatusSnapshot();
    const descriptor = harness.coordinator.descriptor;
    const state = { descriptor, terminalRequested: false, leaseAcquired: true, prepared: true, cleanupCompleted: false, providerDiagnostic: null, cleanupFacts: null };
    harness.coordinator.sessionRegistry.setSessionState(descriptor.sessionId, state);
    // queue a long outcome mutation
    let resolveMutation;
    const pending = harness.coordinator._queueOutcomeMutation(() => new Promise(resolve => { resolveMutation = resolve; }));
    await Promise.resolve();
    // prepare RUNNING commit that will await the mutation
    const running = { ...descriptor, status: LIVE_DUBBING_STATUS.RUNNING, eventSequence: descriptor.eventSequence + 1 };
    const commit = harness.coordinator._writeDescriptor(running, descriptor.sessionId, descriptor, { clearOutcome: true });
    // before mutation settles, mark terminalRequested (simulates OFFSCREEN_TERMINAL racing)
    state.terminalRequested = true;
    resolveMutation(true);
    await pending;
    const ok = await commit;
    expect(ok).toBe(false);
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY).eventSequence).toBe(2);
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY).status).toBe(LIVE_DUBBING_STATUS.CONNECTING_PROVIDER);
  });

  it('exposes public storage failure responses with retryable/cleanupPending/status', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    harness.browserAPI.storage.session.get.mockRejectedValueOnce(new Error('unreadable'));
    const readFail = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    expect(readFail).toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_STORAGE_UNREADABLE',
      retryable: true,
      status: { sessionId: 'session-1' },
    });
    // descriptor invalid
    harness.browserAPI.storage.session.get.mockResolvedValueOnce({
      [LIVE_DUBBING_STORAGE_KEY]: { sessionId: 'bad', tabId: 'not-a-number', providerId: 'gemini', targetLanguage: 'en', status: 'RUNNING', startedAt: 1, lastError: null, eventSequence: 0 },
    });
    const bad = await harness.coordinator.stop({ data: { sessionId: 'bad' } });
    expect(bad).toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_STORAGE_DESCRIPTOR_INVALID',
      retryable: true,
    });
    // clear failure cleanupPending
    harness.browserAPI.storage.session.remove.mockRejectedValueOnce(new Error('clear failed'));
    const clearFail = await harness.coordinator.stop({ data: { sessionId: 'session-1' } });
    expect(clearFail).toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_STORAGE_CLEAR_FAILED',
      retryable: true,
      cleanupPending: true,
      status: expect.objectContaining({ sessionId: 'session-1' }),
    });
  });

  // ---- race tests for explicit snapshot API (A-E) ----

  it('A: terminalRequested flips during authoritative read rejects non-terminal write', async () => {
    const harness = createHarness({
      stored: {
        sessionId: 'session-1',
        tabId: 42,
        targetLanguage: 'en',
        status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
        startedAt: 123,
        lastError: null,
        eventSequence: 2,
      },
    });
    await harness.coordinator._readStatusSnapshot();
    const descriptor = harness.coordinator.descriptor;
    const state = { descriptor, terminalRequested: false, leaseAcquired: true, prepared: true, cleanupCompleted: false, providerDiagnostic: null, cleanupFacts: null };
    harness.coordinator.sessionRegistry.setSessionState(descriptor.sessionId, state);
    harness.browserAPI.storage.session.set.mockClear();
    let resolveGet;
    const deferred = new Promise(resolve => { resolveGet = resolve; });
    harness.browserAPI.storage.session.get.mockImplementation(() => deferred);
    const attempt = { ...descriptor, status: LIVE_DUBBING_STATUS.RUNNING, eventSequence: descriptor.eventSequence + 1 };
    const promise = harness.coordinator._writeDescriptor(attempt, descriptor.sessionId, descriptor);
    // flip while read pending
    state.terminalRequested = true;
    resolveGet({ [LIVE_DUBBING_STORAGE_KEY]: { ...descriptor, providerId: 'gemini' } });
    const ok = await promise;
    expect(ok).toBe(false);
    expect(harness.browserAPI.storage.session.set).not.toHaveBeenCalled();
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY).status).toBe(LIVE_DUBBING_STATUS.CONNECTING_PROVIDER);
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY).eventSequence).toBe(2);
  });

  it('B: STOPPING appears during authoritative read rejects RUNNING', async () => {
    const harness = createHarness({
      stored: {
        sessionId: 'session-1',
        tabId: 42,
        targetLanguage: 'en',
        status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
        startedAt: 123,
        lastError: null,
        eventSequence: 2,
      },
    });
    await harness.coordinator._readStatusSnapshot();
    const descriptor = harness.coordinator.descriptor;
    const state = { descriptor, terminalRequested: false, leaseAcquired: true, prepared: true, cleanupCompleted: false, providerDiagnostic: null, cleanupFacts: null };
    harness.coordinator.sessionRegistry.setSessionState(descriptor.sessionId, state);
    harness.browserAPI.storage.session.set.mockClear();
    let resolveGet;
    const deferred = new Promise(resolve => { resolveGet = resolve; });
    harness.browserAPI.storage.session.get.mockImplementation(() => deferred);
    const running = { ...descriptor, status: LIVE_DUBBING_STATUS.RUNNING, eventSequence: descriptor.eventSequence + 1 };
    const promise = harness.coordinator._writeDescriptor(running, descriptor.sessionId, descriptor);
    // mutate persisted to STOPPING while read pending
    const stoppingPersisted = { ...descriptor, providerId: 'gemini', status: LIVE_DUBBING_STATUS.STOPPING, eventSequence: descriptor.eventSequence + 1 };
    harness.storage.set(LIVE_DUBBING_STORAGE_KEY, stoppingPersisted);
    resolveGet({ [LIVE_DUBBING_STORAGE_KEY]: stoppingPersisted });
    const ok = await promise;
    expect(ok).toBe(false);
    expect(harness.browserAPI.storage.session.set).not.toHaveBeenCalled();
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY).status).toBe(LIVE_DUBBING_STATUS.STOPPING);
  });

  it('C: normal fenced non-clearOutcome uses exactly one authoritative read before set', async () => {
    const harness = createHarness({
      stored: {
        sessionId: 'session-1',
        tabId: 42,
        targetLanguage: 'en',
        status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
        startedAt: 123,
        lastError: null,
        eventSequence: 2,
      },
    });
    await harness.coordinator._readStatusSnapshot();
    const descriptor = harness.coordinator.descriptor;
    const state = { descriptor, terminalRequested: false, leaseAcquired: true, prepared: true, cleanupCompleted: false, providerDiagnostic: null, cleanupFacts: null };
    harness.coordinator.sessionRegistry.setSessionState(descriptor.sessionId, state);
    harness.browserAPI.storage.session.get.mockClear();
    harness.browserAPI.storage.session.set.mockClear();
    const attempt = { ...descriptor, status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER, eventSequence: 3 };
    const ok = await harness.coordinator._writeDescriptor(attempt, descriptor.sessionId, descriptor);
    expect(ok).toBe(true);
    expect(harness.browserAPI.storage.session.get).toHaveBeenCalledTimes(1);
    expect(harness.browserAPI.storage.session.get).toHaveBeenCalledWith(LIVE_DUBBING_STORAGE_KEY);
    expect(harness.browserAPI.storage.session.set).toHaveBeenCalledTimes(1);
  });

  it('D1: clearOutcome race - terminalRequested flips during awaitOutcomeMutations prevents RUNNING+clear', async () => {
    const harness = createHarness({
      stored: {
        sessionId: 'session-1',
        tabId: 42,
        targetLanguage: 'en',
        status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
        startedAt: 123,
        lastError: null,
        eventSequence: 2,
      },
    });
    await harness.coordinator._readStatusSnapshot();
    const descriptor = harness.coordinator.descriptor;
    const state = { descriptor, terminalRequested: false, leaseAcquired: true, prepared: true, cleanupCompleted: false, providerDiagnostic: null, cleanupFacts: null };
    harness.coordinator.sessionRegistry.setSessionState(descriptor.sessionId, state);
    harness.browserAPI.storage.session.set.mockClear();
    let resolveMutation;
    const pending = harness.coordinator._queueOutcomeMutation(() => new Promise(resolve => { resolveMutation = resolve; }));
    await Promise.resolve();
    let resolveAuthoritativeRead;
    const authoritativeRead = new Promise(resolve => { resolveAuthoritativeRead = resolve; });
    harness.browserAPI.storage.session.get.mockImplementationOnce(() => authoritativeRead);
    let resolveAwaitEntered;
    const awaitEntered = new Promise(resolve => { resolveAwaitEntered = resolve; });
    const awaitOutcomeMutations = harness.coordinator.stateStore.awaitOutcomeMutations.bind(
      harness.coordinator.stateStore,
    );
    harness.coordinator.stateStore.awaitOutcomeMutations = vi.fn(async () => {
      resolveAwaitEntered();
      await awaitOutcomeMutations();
    });
    const running = { ...descriptor, status: LIVE_DUBBING_STATUS.RUNNING, eventSequence: descriptor.eventSequence + 1 };
    const commit = harness.coordinator._writeDescriptor(running, descriptor.sessionId, descriptor, { clearOutcome: true });
    resolveAuthoritativeRead({ [LIVE_DUBBING_STORAGE_KEY]: { ...descriptor } });
    await awaitEntered;
    // flip after the first read and while awaiting outcome mutations
    state.terminalRequested = true;
    resolveMutation(true);
    await pending;
    const ok = await commit;
    expect(ok).toBe(false);
    expect(harness.browserAPI.storage.session.set).not.toHaveBeenCalledWith(expect.objectContaining({ [LIVE_DUBBING_OUTCOME_STORAGE_KEY]: null }));
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY).status).toBe(LIVE_DUBBING_STATUS.CONNECTING_PROVIDER);
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY).eventSequence).toBe(2);
  });

  it('D2: clearOutcome race - STOPPING appears during awaitOutcomeMutations prevents RUNNING+clear', async () => {
    const harness = createHarness({
      stored: {
        sessionId: 'session-1',
        tabId: 42,
        targetLanguage: 'en',
        status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
        startedAt: 123,
        lastError: null,
        eventSequence: 2,
      },
    });
    await harness.coordinator._readStatusSnapshot();
    const descriptor = harness.coordinator.descriptor;
    const state = { descriptor, terminalRequested: false, leaseAcquired: true, prepared: true, cleanupCompleted: false, providerDiagnostic: null, cleanupFacts: null };
    harness.coordinator.sessionRegistry.setSessionState(descriptor.sessionId, state);
    harness.browserAPI.storage.session.set.mockClear();
    let resolveMutation;
    const pending = harness.coordinator._queueOutcomeMutation(() => new Promise(resolve => { resolveMutation = resolve; }));
    await Promise.resolve();
    const running = { ...descriptor, status: LIVE_DUBBING_STATUS.RUNNING, eventSequence: descriptor.eventSequence + 1 };
    const commit = harness.coordinator._writeDescriptor(running, descriptor.sessionId, descriptor, { clearOutcome: true });
    // mutate persisted to STOPPING while awaiting
    const stoppingPersisted = { ...descriptor, providerId: 'gemini', status: LIVE_DUBBING_STATUS.STOPPING, eventSequence: 3 };
    // delay mutation until commit has started awaiting, then set storage before second read
    // We mutate the map now; second read will see STOPPING
    harness.storage.set(LIVE_DUBBING_STORAGE_KEY, stoppingPersisted);
    resolveMutation(true);
    await pending;
    const ok = await commit;
    expect(ok).toBe(false);
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY).status).toBe(LIVE_DUBBING_STATUS.STOPPING);
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY).status).not.toBe(LIVE_DUBBING_STATUS.RUNNING);
  });

  it('E: valid transitions still succeed (CONNECTING_PROVIDER->RUNNING, STOPPING->ERROR, terminal->STOPPING/ERROR)', async () => {
    // CONNECTING_PROVIDER -> RUNNING with clearOutcome
    const harness = createHarness({
      stored: {
        sessionId: 'session-1',
        tabId: 42,
        targetLanguage: 'en',
        status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
        startedAt: 123,
        lastError: null,
        eventSequence: 2,
      },
    });
    await harness.coordinator._readStatusSnapshot();
    let descriptor = harness.coordinator.descriptor;
    let state = { descriptor, terminalRequested: false, leaseAcquired: true, prepared: true, cleanupCompleted: false, providerDiagnostic: null, cleanupFacts: null };
    harness.coordinator.sessionRegistry.setSessionState(descriptor.sessionId, state);
    const running = { ...descriptor, status: LIVE_DUBBING_STATUS.RUNNING, eventSequence: 3 };
    const okRunning = await harness.coordinator._writeDescriptor(running, descriptor.sessionId, descriptor, { clearOutcome: true });
    expect(okRunning).toBe(true);
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY).status).toBe(LIVE_DUBBING_STATUS.RUNNING);

    // STOPPING -> ERROR with matching expectedDescriptor
    const harness2 = createHarness({
      stored: {
        sessionId: 'session-2',
        tabId: 42,
        targetLanguage: 'en',
        status: LIVE_DUBBING_STATUS.STOPPING,
        startedAt: 123,
        lastError: null,
        eventSequence: 3,
      },
    });
    await harness2.coordinator._readStatusSnapshot();
    const stopping = harness2.coordinator.descriptor;
    const state2 = { descriptor: stopping, terminalRequested: false, leaseAcquired: true, prepared: true, cleanupCompleted: false, providerDiagnostic: null, cleanupFacts: null };
    harness2.coordinator.sessionRegistry.setSessionState(stopping.sessionId, state2);
    const error = { ...stopping, status: LIVE_DUBBING_STATUS.ERROR, eventSequence: 4, lastError: 'STOP_FAILED' };
    const okError = await harness2.coordinator._writeDescriptor(error, stopping.sessionId, stopping);
    expect(okError).toBe(true);
    expect(harness2.storage.get(LIVE_DUBBING_STORAGE_KEY).status).toBe(LIVE_DUBBING_STATUS.ERROR);

    // terminalRequested may still go to STOPPING/ERROR
    const harness3 = createHarness({
      stored: {
        sessionId: 'session-3',
        tabId: 42,
        targetLanguage: 'en',
        status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
        startedAt: 123,
        lastError: null,
        eventSequence: 2,
      },
    });
    await harness3.coordinator._readStatusSnapshot();
    const desc3 = harness3.coordinator.descriptor;
    const state3 = { descriptor: desc3, terminalRequested: true, leaseAcquired: true, prepared: true, cleanupCompleted: false, providerDiagnostic: null, cleanupFacts: null };
    harness3.coordinator.sessionRegistry.setSessionState(desc3.sessionId, state3);
    const stopping3 = { ...desc3, status: LIVE_DUBBING_STATUS.STOPPING, eventSequence: 3 };
    const okStoppingTerminal = await harness3.coordinator._writeDescriptor(stopping3, desc3.sessionId, desc3);
    expect(okStoppingTerminal).toBe(true);
    // update state to reflect new persisted stopping
    state3.descriptor = stopping3;
    const error3 = { ...stopping3, status: LIVE_DUBBING_STATUS.ERROR, eventSequence: 4, lastError: 'STOP_FAILED' };
    const okErrorTerminal = await harness3.coordinator._writeDescriptor(error3, desc3.sessionId, stopping3);
    expect(okErrorTerminal).toBe(true);
    // but RUNNING should still be rejected when terminalRequested
    const harness4 = createHarness({
      stored: {
        sessionId: 'session-4',
        tabId: 42,
        targetLanguage: 'en',
        status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
        startedAt: 123,
        lastError: null,
        eventSequence: 2,
      },
    });
    await harness4.coordinator._readStatusSnapshot();
    const desc4 = harness4.coordinator.descriptor;
    const state4 = { descriptor: desc4, terminalRequested: true, leaseAcquired: true, prepared: true, cleanupCompleted: false, providerDiagnostic: null, cleanupFacts: null };
    harness4.coordinator.sessionRegistry.setSessionState(desc4.sessionId, state4);
    const running4 = { ...desc4, status: LIVE_DUBBING_STATUS.RUNNING, eventSequence: 3 };
    const okRunningTerminal = await harness4.coordinator._writeDescriptor(running4, desc4.sessionId, desc4);
    expect(okRunningTerminal).toBe(false);
  });

  it('START Gemini bootstrap unavailable is classified as BOOTSTRAP_UNAVAILABLE with diagnostic preserved', async () => {
    const harness = createHarness();
    const original = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_CONNECT_PROVIDER') {
        return {
          success: false,
          error: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
          providerDiagnostic: {
            stage: 'CONNECT_PROVIDER',
            code: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE',
            terminalCategory: 'BOOTSTRAP_UNAVAILABLE',
            wsOpen: false,
            setupSent: false,
            setupComplete: false,
          },
        };
      }
      return original(message);
    });
    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    expect(result).toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE',
      providerDiagnostic: expect.objectContaining({ code: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE' }),
    });
    expect(result.providerDiagnostic.code).toBe('LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE');
    // descriptor cleared after successful cleanup, but no prior outcome to clear; check storage has no descriptor
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
    // No credentials leaked
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('token');
  });

  it('START OpenAI bootstrap unavailable is classified as BOOTSTRAP_UNAVAILABLE', async () => {
    const harness = createHarness();
    const original = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_CONNECT_PROVIDER') {
        return {
          success: false,
          error: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE',
          sessionId: message.data.sessionId,
          providerId: 'openai',
          status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
          providerDiagnostic: {
            stage: 'CONNECT_PROVIDER',
            code: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE',
            terminalCategory: 'BOOTSTRAP_UNAVAILABLE',
          },
        };
      }
      return original(message);
    });
    const result = await harness.coordinator.start({ data: { providerId: 'openai', targetLanguage: 'en-US' } }, {});
    expect(result).toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE',
      providerDiagnostic: expect.objectContaining({ code: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE' }),
    });
    expect(harness.storage.has(LIVE_DUBBING_STORAGE_KEY)).toBe(false);
  });

  it('START Gemini setup timeout is classified as PROVIDER_SETUP_FAILED with diagnostic preserved', async () => {
    const harness = createHarness();
    const original = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_CONNECT_PROVIDER') {
        return {
          success: false,
          error: 'GEMINI_LIVE_SETUP_TIMEOUT',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
          providerDiagnostic: {
            stage: 'CONNECT_PROVIDER',
            code: 'GEMINI_LIVE_SETUP_TIMEOUT',
            terminalCategory: 'SETUP_TIMEOUT',
            wsOpen: true,
            setupSent: true,
            setupComplete: false,
          },
        };
      }
      return original(message);
    });
    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    expect(result).toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_PROVIDER_SETUP_FAILED',
      providerDiagnostic: expect.objectContaining({ code: 'GEMINI_LIVE_SETUP_TIMEOUT' }),
    });
    expect(result.providerDiagnostic.code).not.toBe('LIVE_DUBBING_PROVIDER_SETUP_FAILED');
    expect(result.error).toBe('LIVE_DUBBING_PROVIDER_SETUP_FAILED');
  });

  it('START OpenAI setup failure is classified as PROVIDER_SETUP_FAILED', async () => {
    const harness = createHarness();
    const original = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_CONNECT_PROVIDER') {
        return {
          success: false,
          error: 'OPENAI_REALTIME_SDP_EXCHANGE_FAILED',
          sessionId: message.data.sessionId,
          providerId: 'openai',
          status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
          providerDiagnostic: {
            stage: 'CONNECT_PROVIDER',
            code: 'OPENAI_REALTIME_SDP_EXCHANGE_FAILED',
            terminalCategory: 'SETUP_FAILED',
          },
        };
      }
      return original(message);
    });
    const result = await harness.coordinator.start({ data: { providerId: 'openai', targetLanguage: 'en-US' } }, {});
    expect(result).toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_PROVIDER_SETUP_FAILED',
      providerDiagnostic: expect.objectContaining({ code: 'OPENAI_REALTIME_SDP_EXCHANGE_FAILED' }),
    });
  });

  it('START capture failure is classified as START_FAILED', async () => {
    const harness = createHarness();
    harness.chromeAPI.tabCapture.getMediaStreamId.mockRejectedValueOnce(new Error('capture failed'));
    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    expect(result).toMatchObject({ success: false, error: 'LIVE_DUBBING_START_FAILED' });
    expect(result).not.toHaveProperty('providerDiagnostic');
    // descriptor should be cleared after successful cleanup, lastError is START_FAILED
    // Check that providerDiagnostic not present and error is generic
    expect(result.error).toBe('LIVE_DUBBING_START_FAILED');
  });

  it('START bootstrap failure with cleanupPending retains classified error in descriptor and response', async () => {
    const harness = createHarness();
    const original = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_CONNECT_PROVIDER') {
        return {
          success: false,
          error: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          providerDiagnostic: {
            stage: 'CONNECT_PROVIDER',
            code: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE',
          },
        };
      }
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        return { success: false, error: 'DISPOSE_FAILED' };
      }
      return original(message);
    });
    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    expect(result).toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE',
      retryable: true,
      cleanupPending: true,
      providerDiagnostic: expect.objectContaining({ code: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE' }),
    });
    const stored = harness.storage.get(LIVE_DUBBING_STORAGE_KEY);
    expect(stored).toMatchObject({ status: LIVE_DUBBING_STATUS.ERROR, lastError: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE' });
    expect(stored.lastError).toBe(result.error);
  });

  it('START setup failure with cleanupPending retains classified error in descriptor and response', async () => {
    const harness = createHarness();
    const original = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_CONNECT_PROVIDER') {
        return {
          success: false,
          error: 'GEMINI_LIVE_SETUP_TIMEOUT',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          providerDiagnostic: {
            stage: 'CONNECT_PROVIDER',
            code: 'GEMINI_LIVE_SETUP_TIMEOUT',
          },
        };
      }
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        return { success: false };
      }
      return original(message);
    });
    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    expect(result).toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_PROVIDER_SETUP_FAILED',
      retryable: true,
      cleanupPending: true,
      providerDiagnostic: expect.objectContaining({ code: 'GEMINI_LIVE_SETUP_TIMEOUT' }),
    });
    const stored = harness.storage.get(LIVE_DUBBING_STORAGE_KEY);
    expect(stored.lastError).toBe('LIVE_DUBBING_PROVIDER_SETUP_FAILED');
    expect(stored.lastError).toBe(result.error);
  });

  it('successful START clears previous terminal outcome', async () => {
    const harness = createHarness();
    await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    await harness.coordinator.handleOffscreenTerminal({
      data: { sessionId: 'session-1', providerId: 'gemini', status: LIVE_DUBBING_STATUS.ERROR, error: 'LIVE_DUBBING_PROVIDER_ERROR' },
    }, { id: 'extension-id', url: 'chrome-extension://extension-id/src/html/offscreen.html' });
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).not.toBeNull();
    harness.coordinator.uuid = () => 'session-2';
    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    expect(result.success).toBe(true);
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toBeNull();
  });

  it('failed START does not clear previous terminal outcome', async () => {
    const harness = createHarness({
      outcome: {
        sourceSessionId: 'old-session',
        providerId: 'gemini',
        error: 'LIVE_DUBBING_PROVIDER_ERROR',
        occurredAt: 123,
        providerDiagnostic: null,
      },
    });
    harness.chromeAPI.tabCapture.getMediaStreamId.mockRejectedValueOnce(new Error('capture failed'));
    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    expect(result).toMatchObject({ success: false, error: 'LIVE_DUBBING_START_FAILED' });
    expect(harness.storage.get(LIVE_DUBBING_OUTCOME_STORAGE_KEY)).toMatchObject({
      sourceSessionId: 'old-session',
      error: 'LIVE_DUBBING_PROVIDER_ERROR',
    });
  });

  // Finding 4 integration: startup terminal race with real controller and DISPOSE failure retains startup classification
  it('integration: bootstrap unavailable terminal race retains BOOTSTRAP_UNAVAILABLE on cleanup failure (real controller)', async () => {
    const harness = createHarness();
    const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/src/html/offscreen.html' };
    const track = {
      kind: 'audio',
      readyState: 'live',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      stop: vi.fn(),
    };
    const inputPipeline = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const outputPlayer = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), clear: vi.fn() };
    const providerClient = { connect: vi.fn(async () => {}), dispose: vi.fn(async () => {}), close: vi.fn() };
    const controller = new LiveDubbingController({
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getAudioTracks: () => [track], getTracks: () => [track] })) },
      inputPipelineFactory: vi.fn(async () => inputPipeline),
      outputPlayerFactory: vi.fn(async () => outputPlayer),
      providerClient,
      requestBootstrap: async () => ({ success: false }),
      notify: (msg) => harness.coordinator.handleOffscreenTerminal(msg, sender),
    });
    harness.browserAPI.runtime.sendMessage.mockImplementation(async (message) => {
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        return { success: false, error: 'DISPOSE_FAILED' };
      }
      return controller.handle(message);
    });

    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});

    expect(result).toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE',
      retryable: true,
      cleanupPending: true,
    });
    const stored = harness.storage.get(LIVE_DUBBING_STORAGE_KEY);
    expect(stored).toMatchObject({
      status: LIVE_DUBBING_STATUS.ERROR,
      lastError: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE',
    });
    expect(stored.lastError).toBe(result.error);
    expect(stored.lastError).not.toBe('STOP_FAILED');
    // Ensure terminal outcome was not lost due to overwrite
    await harness.coordinator.getStatus(); // ensure descriptor readable
  });

  it('integration: Gemini setup timeout terminal race retains SETUP_FAILED with detailed diagnostic (real controller)', async () => {
    const harness = createHarness();
    const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/src/html/offscreen.html' };
    const track = {
      kind: 'audio',
      readyState: 'live',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      stop: vi.fn(),
    };
    const inputPipeline = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const outputPlayer = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), clear: vi.fn() };
    const setupError = Object.assign(new Error('Gemini setup timeout'), {
      code: 'GEMINI_LIVE_SETUP_TIMEOUT',
      providerDiagnostic: {
        stage: 'CONNECT_PROVIDER',
        code: 'GEMINI_LIVE_SETUP_TIMEOUT',
        terminalCategory: 'SETUP_TIMEOUT',
        wsOpen: true,
        setupSent: true,
        setupComplete: false,
      },
    });
    const providerClient = {
      connect: vi.fn(async () => { throw setupError; }),
      dispose: vi.fn(async () => {}),
      close: vi.fn(),
    };
    const controller = new LiveDubbingController({
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getAudioTracks: () => [track], getTracks: () => [track] })) },
      inputPipelineFactory: vi.fn(async () => inputPipeline),
      outputPlayerFactory: vi.fn(async () => outputPlayer),
      providerClient,
      requestBootstrap: (request) => harness.coordinator.authorizeOffscreenControlMessage(request, sender, { type: 'bootstrap' }).then((desc) => (desc ? { success: true, providerId: desc.providerId, targetLanguage: desc.targetLanguage, bootstrap: { accessToken: 'tok' } } : { success: false })),
      notify: (msg) => harness.coordinator.handleOffscreenTerminal(msg, sender),
    });
    harness.browserAPI.runtime.sendMessage.mockImplementation(async (message) => {
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        return { success: false, error: 'DISPOSE_FAILED' };
      }
      return controller.handle(message);
    });

    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});

    expect(result).toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_PROVIDER_SETUP_FAILED',
      retryable: true,
      cleanupPending: true,
      providerDiagnostic: expect.objectContaining({ code: 'GEMINI_LIVE_SETUP_TIMEOUT' }),
    });
    expect(result.providerDiagnostic.code).toBe('GEMINI_LIVE_SETUP_TIMEOUT');
    const stored = harness.storage.get(LIVE_DUBBING_STORAGE_KEY);
    expect(stored).toMatchObject({
      status: LIVE_DUBBING_STATUS.ERROR,
      lastError: 'LIVE_DUBBING_PROVIDER_SETUP_FAILED',
    });
    expect(stored.lastError).toBe('LIVE_DUBBING_PROVIDER_SETUP_FAILED');
    expect(stored.lastError).not.toBe('STOP_FAILED');
  });

  it('integration: RUNNING runtime terminal with cleanup failure does NOT become SETUP_FAILED (real controller)', async () => {
    const harness = createHarness();
    const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/src/html/offscreen.html' };
    const track = {
      kind: 'audio',
      readyState: 'live',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      stop: vi.fn(),
    };
    const inputPipeline = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const outputPlayer = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), clear: vi.fn() };
    const providerClient = { connect: vi.fn(async () => {}), dispose: vi.fn(async () => {}), close: vi.fn() };
    const controller = new LiveDubbingController({
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getAudioTracks: () => [track], getTracks: () => [track] })) },
      inputPipelineFactory: vi.fn(async () => inputPipeline),
      outputPlayerFactory: vi.fn(async () => outputPlayer),
      providerClient,
      requestBootstrap: (request) => harness.coordinator.authorizeOffscreenControlMessage(request, sender, { type: 'bootstrap' }).then((desc) => (desc ? { success: true, providerId: desc.providerId, targetLanguage: desc.targetLanguage, bootstrap: { accessToken: 'tok' } } : { success: false })),
      notify: vi.fn(),
    });
    harness.browserAPI.runtime.sendMessage.mockImplementation((message) => controller.handle(message));

    const started = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    expect(started).toMatchObject({ success: true, status: { status: LIVE_DUBBING_STATUS.RUNNING } });

    // Now make DISPOSE fail for the terminal cleanup
    harness.browserAPI.runtime.sendMessage.mockImplementation(async (message) => {
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        return { success: false, error: 'DISPOSE_FAILED' };
      }
      return controller.handle(message);
    });
    // Wire notify to coordinator for this terminal (not needed for this test, we call handleOffscreenTerminal directly)
    const descriptor = harness.coordinator.descriptor;
    expect(descriptor.status).toBe(LIVE_DUBBING_STATUS.RUNNING);
    const terminalResult = await harness.coordinator.handleOffscreenTerminal({
      data: {
        sessionId: descriptor.sessionId,
        providerId: descriptor.providerId,
        eventSequence: descriptor.eventSequence,
        status: LIVE_DUBBING_STATUS.ERROR,
        error: 'GEMINI_LIVE_SETUP_TIMEOUT',
        event: 'PROVIDER_ERROR',
        providerDiagnostic: {
          stage: 'CONNECT_PROVIDER',
          code: 'GEMINI_LIVE_SETUP_TIMEOUT',
          terminalCategory: 'SETUP_TIMEOUT',
          wsOpen: true,
          setupSent: true,
          setupComplete: false,
        },
      },
    }, sender);

    expect(terminalResult).toMatchObject({ success: false, error: 'STOP_FAILED', retryable: true, cleanupPending: true });
    const stored = harness.storage.get(LIVE_DUBBING_STORAGE_KEY);
    expect(stored).toMatchObject({ status: LIVE_DUBBING_STATUS.ERROR, lastError: 'STOP_FAILED' });
    expect(stored.lastError).not.toBe('LIVE_DUBBING_PROVIDER_SETUP_FAILED');
    expect(stored.lastError).toBe('STOP_FAILED');
  });

  it('integration: explicit STOP with cleanup failure keeps STOP semantics (real controller)', async () => {
    const harness = createHarness();
    const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/src/html/offscreen.html' };
    const track = {
      kind: 'audio',
      readyState: 'live',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      stop: vi.fn(),
    };
    const inputPipeline = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const outputPlayer = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), clear: vi.fn() };
    const providerClient = { connect: vi.fn(async () => {}), dispose: vi.fn(async () => {}), close: vi.fn() };
    const controller = new LiveDubbingController({
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getAudioTracks: () => [track], getTracks: () => [track] })) },
      inputPipelineFactory: vi.fn(async () => inputPipeline),
      outputPlayerFactory: vi.fn(async () => outputPlayer),
      providerClient,
      requestBootstrap: (request) => harness.coordinator.authorizeOffscreenControlMessage(request, sender, { type: 'bootstrap' }).then((desc) => (desc ? { success: true, providerId: desc.providerId, targetLanguage: desc.targetLanguage, bootstrap: { accessToken: 'tok' } } : { success: false })),
      notify: vi.fn(),
    });
    harness.browserAPI.runtime.sendMessage.mockImplementation((message) => controller.handle(message));

    const started = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    expect(started).toMatchObject({ success: true, status: { status: LIVE_DUBBING_STATUS.RUNNING } });

    harness.browserAPI.runtime.sendMessage.mockImplementation(async (message) => {
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        return { success: false, error: 'DISPOSE_FAILED' };
      }
      return controller.handle(message);
    });

    const stopResult = await harness.coordinator.stop({ data: { sessionId: started.status.sessionId } });
    expect(stopResult).toMatchObject({ success: false, error: 'STOP_FAILED', retryable: true, cleanupPending: true });
    const stored = harness.storage.get(LIVE_DUBBING_STORAGE_KEY);
    expect(stored).toMatchObject({ status: LIVE_DUBBING_STATUS.ERROR, lastError: 'STOP_FAILED' });
    expect(stored.lastError).toBe('STOP_FAILED');
  });

  // Finding 4: narrow SETUP_FAILED classification – Controller-local pipeline/audio failures must not be SETUP_FAILED
  it('Finding4: INPUT_PIPELINE_ERROR while CONNECTING_PROVIDER is classified as START_FAILED not SETUP_FAILED (structured diagnostic)', async () => {
    const harness = createHarness();
    const original = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_CONNECT_PROVIDER') {
        return {
          success: false,
          error: 'LIVE_DUBBING_INPUT_PIPELINE_ERROR',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
          providerDiagnostic: {
            stage: 'CONNECT_PROVIDER',
            code: 'GEMINI_LIVE_SETUP_TIMEOUT',
            terminalCategory: 'INPUT_PIPELINE_ERROR',
            wsOpen: true,
            setupSent: true,
            setupComplete: false,
          },
        };
      }
      return original(message);
    });
    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    expect(result).toMatchObject({ success: false, error: 'LIVE_DUBBING_START_FAILED' });
    expect(result.error).not.toBe('LIVE_DUBBING_PROVIDER_SETUP_FAILED');
    expect(result.providerDiagnostic).toMatchObject({ terminalCategory: 'INPUT_PIPELINE_ERROR', setupComplete: false });
  });

  it('Finding4: OUTPUT_PIPELINE_ERROR while CONNECTING_PROVIDER is classified as START_FAILED', async () => {
    const harness = createHarness();
    const original = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_CONNECT_PROVIDER') {
        return {
          success: false,
          error: 'LIVE_DUBBING_OUTPUT_PIPELINE_ERROR',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
          providerDiagnostic: {
            stage: 'CONNECT_PROVIDER',
            code: 'OPENAI_REALTIME_SDP_EXCHANGE_FAILED',
            terminalCategory: 'OUTPUT_PIPELINE_ERROR',
            setupComplete: false,
          },
        };
      }
      return original(message);
    });
    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    expect(result).toMatchObject({ success: false, error: 'LIVE_DUBBING_START_FAILED' });
    expect(result.error).not.toBe('LIVE_DUBBING_PROVIDER_SETUP_FAILED');
  });

  it.each([
    'INPUT_PIPELINE_ERROR',
    'INPUT_SEND_ERROR',
    'INVALID_OUTPUT_AUDIO',
    'OUTPUT_AUDIO_ERROR',
    'OUTPUT_PIPELINE_ERROR',
  ])('Finding4: excluded terminalCategory %s while CONNECTING_PROVIDER → START_FAILED', async (terminalCategory) => {
    const harness = createHarness();
    const original = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_CONNECT_PROVIDER') {
        return {
          success: false,
          error: `LIVE_DUBBING_${terminalCategory}`,
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          providerDiagnostic: {
            stage: 'CONNECT_PROVIDER',
            code: 'GEMINI_LIVE_SETUP_TIMEOUT',
            terminalCategory,
            setupComplete: false,
          },
        };
      }
      return original(message);
    });
    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    expect(result.error).toBe('LIVE_DUBBING_START_FAILED');
    expect(result.providerDiagnostic.terminalCategory).toBe(terminalCategory);
  });

  it('Finding4: INPUT_PIPELINE_ERROR via real Controller path while CONNECTING_PROVIDER → START_FAILED (genuine pipeline callback)', async () => {
    const harness = createHarness();
    const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/src/html/offscreen.html' };
    const track = {
      kind: 'audio',
      readyState: 'live',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      stop: vi.fn(),
    };
    const inputPipeline = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const outputPlayer = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), clear: vi.fn() };
    let providerConnectReject;
    const providerConnectPromise = new Promise((_, reject) => { providerConnectReject = reject; });
    const providerClient = {
      connect: vi.fn(() => providerConnectPromise),
      dispose: vi.fn(async () => {}),
      close: vi.fn(),
    };
    const controller = new LiveDubbingController({
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getAudioTracks: () => [track], getTracks: () => [track] })) },
      inputPipelineFactory: vi.fn(async () => inputPipeline),
      outputPlayerFactory: vi.fn(async () => outputPlayer),
      providerClient,
      requestBootstrap: (request) => harness.coordinator.authorizeOffscreenControlMessage(request, sender, { type: 'bootstrap' }).then(desc => desc ? { success: true, providerId: desc.providerId, targetLanguage: desc.targetLanguage, bootstrap: { accessToken: 'tok' } } : { success: false }),
      notify: (msg) => harness.coordinator.handleOffscreenTerminal(msg, sender),
    });
    harness.browserAPI.runtime.sendMessage.mockImplementation(async (message) => {
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        return { success: false, error: 'DISPOSE_FAILED' };
      }
      return controller.handle(message);
    });

    const startPromise = harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});

    for (let i = 0; i < 200 && providerClient.connect.mock.calls.length === 0; i++) {
      await new Promise(r => setTimeout(r, 0));
      await Promise.resolve();
    }
    expect(providerClient.connect).toHaveBeenCalled();
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({ status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER });
    expect(typeof inputPipeline.onError).toBe('function');

    inputPipeline.onError(Object.assign(new Error('input pipeline failed'), { code: 'LIVE_DUBBING_INPUT_PIPELINE_ERROR' }));

    await new Promise(r => setTimeout(r, 0));
    await Promise.resolve();
    await Promise.resolve();

    providerConnectReject(Object.assign(new Error('provider connect aborted'), { code: 'LIVE_DUBBING_PROVIDER_SETUP_FAILED' }));
    await new Promise(r => setTimeout(r, 0));

    const result = await startPromise;
    expect(result).toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_START_FAILED',
      retryable: true,
      cleanupPending: true,
    });
    expect(result.error).not.toBe('LIVE_DUBBING_PROVIDER_SETUP_FAILED');
    expect(result.error).not.toBe('STOP_FAILED');
    const stored = harness.storage.get(LIVE_DUBBING_STORAGE_KEY);
    expect(stored).toMatchObject({
      status: LIVE_DUBBING_STATUS.ERROR,
      lastError: 'LIVE_DUBBING_START_FAILED',
    });
    expect(stored.lastError).not.toBe('LIVE_DUBBING_PROVIDER_SETUP_FAILED');
    expect(stored.lastError).not.toBe('STOP_FAILED');
  });

  it('Finding4: setupComplete:true terminal while CONNECTING_PROVIDER with cleanup failure retains START_FAILED', async () => {
    const harness = createHarness();
    const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/src/html/offscreen.html' };
    const track = {
      kind: 'audio',
      readyState: 'live',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      stop: vi.fn(),
    };
    const inputPipeline = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const outputPlayer = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), clear: vi.fn() };
    let providerConnectReject;
    const providerConnectPromise = new Promise((_, reject) => { providerConnectReject = reject; });
    const providerClient = {
      connect: vi.fn(() => providerConnectPromise),
      dispose: vi.fn(async () => {}),
      close: vi.fn(),
    };
    const controller = new LiveDubbingController({
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getAudioTracks: () => [track], getTracks: () => [track] })) },
      inputPipelineFactory: vi.fn(async () => inputPipeline),
      outputPlayerFactory: vi.fn(async () => outputPlayer),
      providerClient,
      requestBootstrap: (request) => harness.coordinator.authorizeOffscreenControlMessage(request, sender, { type: 'bootstrap' }).then(desc => desc ? { success: true, providerId: desc.providerId, targetLanguage: desc.targetLanguage, bootstrap: { accessToken: 'tok' } } : { success: false }),
      notify: (msg) => harness.coordinator.handleOffscreenTerminal(msg, sender),
    });
    harness.browserAPI.runtime.sendMessage.mockImplementation(async (message) => {
      if (message.action === 'LIVE_DUBBING_DISPOSE') {
        return { success: false, error: 'DISPOSE_FAILED' };
      }
      return controller.handle(message);
    });

    const startPromise = harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    for (let i = 0; i < 200 && providerClient.connect.mock.calls.length === 0; i++) {
      await new Promise(r => setTimeout(r, 0));
      await Promise.resolve();
    }
    expect(harness.storage.get(LIVE_DUBBING_STORAGE_KEY)).toMatchObject({ status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER });

    const terminalResult = await harness.coordinator.handleOffscreenTerminal({
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence: harness.storage.get(LIVE_DUBBING_STORAGE_KEY).eventSequence,
        status: LIVE_DUBBING_STATUS.ERROR,
        error: 'GEMINI_LIVE_SETUP_TIMEOUT',
        event: 'PROVIDER_ERROR',
        providerDiagnostic: {
          stage: 'CONNECT_PROVIDER',
          code: 'GEMINI_LIVE_SETUP_TIMEOUT',
          terminalCategory: 'SETUP_TIMEOUT',
          wsOpen: true,
          setupSent: true,
          setupComplete: true,
        },
      },
    }, sender);

    expect(terminalResult).toMatchObject({ success: false, retryable: true, cleanupPending: true });
    expect(terminalResult.error).toBe('STOP_FAILED');
    const storedAfterTerminal = harness.storage.get(LIVE_DUBBING_STORAGE_KEY);
    expect(storedAfterTerminal).toMatchObject({ status: LIVE_DUBBING_STATUS.ERROR, lastError: 'LIVE_DUBBING_START_FAILED' });
    expect(storedAfterTerminal.lastError).not.toBe('LIVE_DUBBING_PROVIDER_SETUP_FAILED');
    expect(storedAfterTerminal.lastError).not.toBe('STOP_FAILED');

    providerConnectReject(Object.assign(new Error('aborted'), { code: 'LIVE_DUBBING_PROVIDER_SETUP_FAILED' }));
    await new Promise(r => setTimeout(r, 0));
    const startResult = await startPromise;
    expect(startResult).toMatchObject({ success: false, error: 'LIVE_DUBBING_START_FAILED', retryable: true, cleanupPending: true });
    const stored = harness.storage.get(LIVE_DUBBING_STORAGE_KEY);
    expect(stored.lastError).toBe('LIVE_DUBBING_START_FAILED');
    expect(stored.lastError).not.toBe('LIVE_DUBBING_PROVIDER_SETUP_FAILED');
  });

  it('Finding4: setupComplete:true with provider-looking code while CONNECTING_PROVIDER → START_FAILED not SETUP_FAILED', async () => {
    const harness = createHarness();
    const original = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_CONNECT_PROVIDER') {
        return {
          success: false,
          error: 'GEMINI_LIVE_SETUP_TIMEOUT',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          providerDiagnostic: {
            stage: 'CONNECT_PROVIDER',
            code: 'GEMINI_LIVE_SETUP_TIMEOUT',
            terminalCategory: 'SETUP_TIMEOUT',
            setupComplete: true,
          },
        };
      }
      return original(message);
    });
    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    expect(result.error).toBe('LIVE_DUBBING_START_FAILED');
    expect(result.providerDiagnostic.setupComplete).toBe(true);
    expect(result.error).not.toBe('LIVE_DUBBING_PROVIDER_SETUP_FAILED');
  });

  it('Finding4: setupComplete:true with OPENAI code → START_FAILED', async () => {
    const harness = createHarness();
    const original = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_CONNECT_PROVIDER') {
        return {
          success: false,
          error: 'OPENAI_REALTIME_SDP_EXCHANGE_FAILED',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          providerDiagnostic: {
            stage: 'CONNECT_PROVIDER',
            code: 'OPENAI_REALTIME_SDP_EXCHANGE_FAILED',
            terminalCategory: 'SETUP_FAILED',
            setupComplete: true,
          },
        };
      }
      return original(message);
    });
    const result = await harness.coordinator.start({ data: { providerId: 'openai', targetLanguage: 'en-US' } }, {});
    expect(result.error).toBe('LIVE_DUBBING_START_FAILED');
  });

  it('Finding4: bootstrap highest priority over pipeline category and setupComplete:true', async () => {
    const harness = createHarness();
    const original = harness.browserAPI.runtime.sendMessage.getMockImplementation();
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_CONNECT_PROVIDER') {
        return {
          success: false,
          error: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          providerDiagnostic: {
            stage: 'CONNECT_PROVIDER',
            code: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE',
            terminalCategory: 'INPUT_PIPELINE_ERROR',
            setupComplete: true,
          },
        };
      }
      return original(message);
    });
    const result = await harness.coordinator.start({ data: { targetLanguage: 'en' } }, {});
    expect(result.error).toBe('LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE');
  });

  it('Finding4: direct _classifyStartFailure – excluded categories → START_FAILED, valid setup → SETUP_FAILED', () => {
    const harness = createHarness();
    const coordinator = harness.coordinator;
    // Valid setup: should be SETUP_FAILED
    expect(coordinator._classifyStartFailure({
      error: { error: 'GEMINI_LIVE_SETUP_TIMEOUT' },
      providerDiagnostic: { stage: 'CONNECT_PROVIDER', code: 'GEMINI_LIVE_SETUP_TIMEOUT', terminalCategory: 'SETUP_TIMEOUT', setupComplete: false },
      providerStartAttempted: true,
    })).toBe('LIVE_DUBBING_PROVIDER_SETUP_FAILED');

    expect(coordinator._classifyStartFailure({
      error: {},
      providerDiagnostic: { stage: 'CONNECT_PROVIDER', code: 'OPENAI_REALTIME_SDP_EXCHANGE_FAILED', terminalCategory: 'SETUP_FAILED', setupComplete: false },
      providerStartAttempted: true,
    })).toBe('LIVE_DUBBING_PROVIDER_SETUP_FAILED');

    // Excluded categories → START_FAILED even with providerStartAttempted true
    for (const cat of ['INPUT_PIPELINE_ERROR', 'INPUT_SEND_ERROR', 'INVALID_OUTPUT_AUDIO', 'OUTPUT_AUDIO_ERROR', 'OUTPUT_PIPELINE_ERROR']) {
      expect(coordinator._classifyStartFailure({
        error: {},
        providerDiagnostic: { stage: 'CONNECT_PROVIDER', code: 'GEMINI_LIVE_SETUP_TIMEOUT', terminalCategory: cat, setupComplete: false },
        providerStartAttempted: true,
      })).toBe('LIVE_DUBBING_START_FAILED');
    }

    // setupComplete true → START_FAILED
    expect(coordinator._classifyStartFailure({
      error: {},
      providerDiagnostic: { stage: 'CONNECT_PROVIDER', code: 'GEMINI_LIVE_SETUP_TIMEOUT', terminalCategory: 'SETUP_TIMEOUT', setupComplete: true },
      providerStartAttempted: true,
    })).toBe('LIVE_DUBBING_START_FAILED');

    // providerStartAttempted false → START_FAILED
    expect(coordinator._classifyStartFailure({
      error: {},
      providerDiagnostic: { stage: 'CONNECT_PROVIDER', code: 'GEMINI_LIVE_SETUP_TIMEOUT', terminalCategory: 'SETUP_TIMEOUT', setupComplete: false },
      providerStartAttempted: false,
    })).toBe('LIVE_DUBBING_START_FAILED');

    // No code → START_FAILED
    expect(coordinator._classifyStartFailure({
      error: {},
      providerDiagnostic: { stage: 'CONNECT_PROVIDER', code: null, terminalCategory: 'SETUP_TIMEOUT', setupComplete: false },
      providerStartAttempted: true,
    })).toBe('LIVE_DUBBING_START_FAILED');

    // Bootstrap priority
    expect(coordinator._classifyStartFailure({
      error: { code: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE' },
      providerDiagnostic: { stage: 'CONNECT_PROVIDER', code: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE', terminalCategory: 'BOOTSTRAP_UNAVAILABLE', setupComplete: false },
      providerStartAttempted: true,
    })).toBe('LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE');

    expect(coordinator._classifyStartFailure({
      error: {},
      providerDiagnostic: { stage: 'CONNECT_PROVIDER', code: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE', terminalCategory: 'INPUT_PIPELINE_ERROR', setupComplete: true },
      providerStartAttempted: true,
    })).toBe('LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE');
  });

  it('Finding4: no message substring matching – error.message containing provider string does not affect classification', async () => {
    const harness = createHarness();
    // Simulate error.message containing GEMINI_LIVE_SETUP_TIMEOUT but no structured code; should remain START_FAILED
    harness.browserAPI.runtime.sendMessage.mockImplementation(async message => {
      if (message.action === 'LIVE_DUBBING_CONNECT_PROVIDER') {
        // Return no providerDiagnostic code, only message substring
        return {
          success: false,
          error: 'LIVE_DUBBING_START_FAILED',
          sessionId: message.data.sessionId,
          providerId: message.data.providerId,
          // providerDiagnostic has no code, but message-like field would contain substring if we matched it – we don't
          providerDiagnostic: {
            stage: 'CONNECT_PROVIDER',
            code: null,
            terminalCategory: null,
            setupComplete: false,
          },
          // Also test error object with message substring
          diagnostic: { stage: 'CONNECT_PROVIDER', error: { message: 'GEMINI_LIVE_SETUP_TIMEOUT occurred', name: 'Error' } },
        };
      }
      if (message.action === 'LIVE_DUBBING_PREPARE' || message.action === 'LIVE_DUBBING_CONSUME' || message.action === 'LIVE_DUBBING_DISPOSE') {
        // delegate to original behavior for other stages
        // fallback: return success for prepare/consume
        if (message.action === 'LIVE_DUBBING_PREPARE') return { success: true, ack: 'READY', sessionId: message.data.sessionId, providerId: message.data.providerId, eventSequence: message.data.eventSequence };
        if (message.action === 'LIVE_DUBBING_CONSUME') return { success: true, ack: 'MEDIA_ACQUIRED', sessionId: message.data.sessionId, providerId: message.data.providerId, status: LIVE_DUBBING_STATUS.CONNECTING_PROVIDER, eventSequence: message.data.eventSequence, captureReady: true, audioPathReady: true };
        if (message.action === 'LIVE_DUBBING_DISPOSE') return { success: true, ack: 'DISPOSED', sessionId: message.data.sessionId, providerId: message.data.providerId };
      }
      return { success: true };
    });
    // For this isolated substring test, use direct classify to prove no substring logic
    const direct = harness.coordinator._classifyStartFailure({
      error: { message: 'GEMINI_LIVE_SETUP_TIMEOUT failed badly', error: 'LIVE_DUBBING_START_FAILED' },
      providerDiagnostic: { stage: 'CONNECT_PROVIDER', code: null, terminalCategory: null, setupComplete: false },
      providerStartAttempted: true,
    });
    expect(direct).toBe('LIVE_DUBBING_START_FAILED');
    // Also ensure normal provider code still classifies correctly (not via substring)
    const setup = harness.coordinator._classifyStartFailure({
      error: {},
      providerDiagnostic: { stage: 'CONNECT_PROVIDER', code: 'GEMINI_LIVE_SETUP_TIMEOUT', terminalCategory: 'SETUP_TIMEOUT', setupComplete: false },
      providerStartAttempted: true,
    });
    expect(setup).toBe('LIVE_DUBBING_PROVIDER_SETUP_FAILED');
  });

  it('authorizes and relays only the current translated transcript to the top frame', async () => {
    const harness = createVolumeHarness(LIVE_DUBBING_STATUS.RUNNING);
    const sendTabMessage = vi.fn(async () => undefined);
    harness.browserAPI.tabs.sendMessage = sendTabMessage;
    const sender = {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    };
    const message = {
      action: LIVE_DUBBING_ACTIONS.TRANSLATED_TRANSCRIPT,
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence: 4,
        transcriptSequence: 1,
        transcript: { kind: 'translated', text: 'bonjour' },
      },
    };

    await expect(harness.coordinator.handleOffscreenTranslatedTranscript(message, sender))
      .resolves.toEqual({ success: true });
    expect(sendTabMessage).toHaveBeenCalledWith(42, {
      action: LIVE_DUBBING_ACTIONS.TRANSCRIPT,
      data: message.data,
    }, { frameId: 0 });

    await expect(harness.coordinator.handleOffscreenOriginalTranscript({
      action: LIVE_DUBBING_ACTIONS.ORIGINAL_TRANSCRIPT,
      data: {
        ...message.data,
        transcriptSequence: 2,
        transcript: { kind: 'source', text: 'hello' },
      },
    }, sender)).resolves.toEqual({ success: true });
    expect(sendTabMessage).toHaveBeenLastCalledWith(42, {
      action: LIVE_DUBBING_ACTIONS.ORIGINAL_TRANSCRIPT,
      data: {
        ...message.data,
        transcriptSequence: 2,
        transcript: { kind: 'source', text: 'hello' },
      },
    }, { frameId: 0 });

    await expect(harness.coordinator.handleOffscreenTranslatedTranscript({
      ...message,
      data: { ...message.data, eventSequence: 3 },
    }, sender)).resolves.toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_UNAUTHORIZED',
    });
    await expect(harness.coordinator.handleOffscreenTranslatedTranscript(message, {
      ...sender,
      url: 'chrome-extension://extension-id/src/html/popup.html',
    })).resolves.toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_UNAUTHORIZED',
    });
  });

  it('accepts the reserved running event sequence before the RUNNING commit', async () => {
    const harness = createVolumeHarness(LIVE_DUBBING_STATUS.CONNECTING_PROVIDER, {
      eventSequence: 4,
    });
    const sendTabMessage = vi.fn(async () => undefined);
    harness.browserAPI.tabs.sendMessage = sendTabMessage;
    const sender = {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    };
    const message = {
      action: LIVE_DUBBING_ACTIONS.TRANSLATED_TRANSCRIPT,
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence: 5,
        transcriptSequence: 1,
        transcript: { kind: 'translated', text: 'bonjour' },
      },
    };

    await expect(harness.coordinator.handleOffscreenTranslatedTranscript(message, sender))
      .resolves.toEqual({ success: true });
    expect(sendTabMessage).toHaveBeenCalledWith(42, {
      action: LIVE_DUBBING_ACTIONS.TRANSCRIPT,
      data: {
        ...message.data,
        eventSequence: 4,
      },
    }, { frameId: 0 });

    await expect(harness.coordinator.handleOffscreenTranslatedTranscript({
      ...message,
      data: { ...message.data, eventSequence: 3, transcriptSequence: 2 },
    }, sender)).resolves.toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_UNAUTHORIZED',
      ignored: true,
    });
  });

  it('swallows translated transcript tab delivery failures', async () => {
    const harness = createVolumeHarness(LIVE_DUBBING_STATUS.RUNNING);
    harness.browserAPI.tabs.sendMessage = vi.fn().mockRejectedValue(new Error('tab closed'));
    await expect(harness.coordinator.handleOffscreenTranslatedTranscript({
      action: LIVE_DUBBING_ACTIONS.TRANSLATED_TRANSCRIPT,
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence: 4,
        transcriptSequence: 1,
        transcript: { kind: 'translated', text: 'bonjour' },
      },
    }, {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    })).resolves.toEqual({ success: true });
    await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
      success: true,
      transcriptDeliveryUnavailable: true,
    });
  });

  it('flags transcript delivery unavailable on tab failure without leaking error details', async () => {
    const harness = createVolumeHarness(LIVE_DUBBING_STATUS.RUNNING);
    harness.browserAPI.tabs.sendMessage = vi.fn()
      .mockRejectedValue(new Error('tab closed https://secret.test'));
    const sender = {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    };
    const message = {
      action: LIVE_DUBBING_ACTIONS.TRANSLATED_TRANSCRIPT,
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence: 4,
        transcriptSequence: 1,
        transcript: { kind: 'translated', text: 'bonjour' },
      },
    };

    await expect(harness.coordinator.handleOffscreenTranslatedTranscript(message, sender))
      .resolves.toEqual({ success: true });

    const status = await harness.coordinator.getStatus();
    expect(status.status.status).toBe(LIVE_DUBBING_STATUS.RUNNING);
    expect(status.transcriptDeliveryUnavailable).toBe(true);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('tab closed');
    expect(serialized).not.toContain('secret.test');

    const notifyCalls = harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([sent]) => sent)
      .filter(sent => sent?.action === LIVE_DUBBING_ACTIONS.TRANSCRIPT_DELIVERY_CHANGED);
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]).toEqual({
      action: LIVE_DUBBING_ACTIONS.TRANSCRIPT_DELIVERY_CHANGED,
      data: { sessionId: 'session-1' },
    });
    expect(JSON.stringify(notifyCalls)).not.toContain('tab closed');
    expect(JSON.stringify(notifyCalls)).not.toContain('secret.test');
  });

  it('notifies transcript delivery state only once across consecutive failures', async () => {
    const harness = createVolumeHarness(LIVE_DUBBING_STATUS.RUNNING);
    harness.browserAPI.tabs.sendMessage = vi.fn()
      .mockRejectedValue(new Error('tab closed https://secret.test'));
    const sender = {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    };
    const messageFor = transcriptSequence => ({
      action: LIVE_DUBBING_ACTIONS.TRANSLATED_TRANSCRIPT,
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence: 4,
        transcriptSequence,
        transcript: { kind: 'translated', text: 'bonjour' },
      },
    });
    const deliveryNotifies = () => harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([sent]) => sent)
      .filter(sent => sent?.action === LIVE_DUBBING_ACTIONS.TRANSCRIPT_DELIVERY_CHANGED);

    await expect(harness.coordinator.handleOffscreenTranslatedTranscript(messageFor(1), sender))
      .resolves.toEqual({ success: true });
    await expect(harness.coordinator.handleOffscreenTranslatedTranscript(messageFor(2), sender))
      .resolves.toEqual({ success: true });

    await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
      success: true,
      transcriptDeliveryUnavailable: true,
    });
    expect(deliveryNotifies()).toHaveLength(1);
  });

  it('clears transcript delivery unavailability on later successful delivery', async () => {
    const harness = createVolumeHarness(LIVE_DUBBING_STATUS.RUNNING);
    const sendTabMessage = vi.fn()
      .mockRejectedValueOnce(new Error('tab closed https://secret.test'))
      .mockResolvedValue(undefined);
    harness.browserAPI.tabs.sendMessage = sendTabMessage;
    const sender = {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    };
    const messageFor = transcriptSequence => ({
      action: LIVE_DUBBING_ACTIONS.TRANSLATED_TRANSCRIPT,
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence: 4,
        transcriptSequence,
        transcript: { kind: 'translated', text: 'bonjour' },
      },
    });
    const deliveryNotifies = () => harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([sent]) => sent)
      .filter(sent => sent?.action === LIVE_DUBBING_ACTIONS.TRANSCRIPT_DELIVERY_CHANGED);

    await expect(harness.coordinator.handleOffscreenTranslatedTranscript(messageFor(1), sender))
      .resolves.toEqual({ success: true });
    await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
      transcriptDeliveryUnavailable: true,
    });

    await expect(harness.coordinator.handleOffscreenTranslatedTranscript(messageFor(2), sender))
      .resolves.toEqual({ success: true });
    await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
      success: true,
      transcriptDeliveryUnavailable: false,
    });
    expect(deliveryNotifies()).toHaveLength(2);
  });

  it('scopes transcript delivery unavailability to the failing session', async () => {
    const harness = createVolumeHarness(LIVE_DUBBING_STATUS.RUNNING);
    harness.browserAPI.tabs.sendMessage = vi.fn()
      .mockRejectedValue(new Error('tab closed https://secret.test'));
    const sender = {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    };
    const sessionMessage = {
      action: LIVE_DUBBING_ACTIONS.TRANSLATED_TRANSCRIPT,
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence: 4,
        transcriptSequence: 1,
        transcript: { kind: 'translated', text: 'bonjour' },
      },
    };

    await expect(harness.coordinator.handleOffscreenTranslatedTranscript(sessionMessage, sender))
      .resolves.toEqual({ success: true });
    await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
      transcriptDeliveryUnavailable: true,
    });

    harness.storage.set(LIVE_DUBBING_STORAGE_KEY, {
      providerId: 'gemini',
      sessionId: 'session-2',
      tabId: 42,
      targetLanguage: 'en',
      status: LIVE_DUBBING_STATUS.RUNNING,
      startedAt: 123,
      lastError: null,
      eventSequence: 7,
    });
    await harness.coordinator._readDescriptor();

    await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
      success: true,
      transcriptDeliveryUnavailable: false,
    });

    await expect(harness.coordinator.handleOffscreenTranslatedTranscript(sessionMessage, sender))
      .resolves.toMatchObject({ success: false, error: 'LIVE_DUBBING_UNAUTHORIZED', ignored: true });
    await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
      success: true,
      transcriptDeliveryUnavailable: false,
    });
  });

  it('keeps transcript delivery available on successful tab delivery', async () => {
    const harness = createVolumeHarness(LIVE_DUBBING_STATUS.RUNNING);
    const sendTabMessage = vi.fn(async () => undefined);
    harness.browserAPI.tabs.sendMessage = sendTabMessage;
    const sender = {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    };
    const message = {
      action: LIVE_DUBBING_ACTIONS.TRANSLATED_TRANSCRIPT,
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence: 4,
        transcriptSequence: 1,
        transcript: { kind: 'translated', text: 'bonjour' },
      },
    };

    await expect(harness.coordinator.handleOffscreenTranslatedTranscript(message, sender))
      .resolves.toEqual({ success: true });
    expect(sendTabMessage).toHaveBeenCalledWith(42, {
      action: LIVE_DUBBING_ACTIONS.TRANSCRIPT,
      data: {
        ...message.data,
        eventSequence: 4,
      },
    }, { frameId: 0 });
    await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
      success: true,
      transcriptDeliveryUnavailable: false,
    });
    expect(harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([sent]) => sent)
      .filter(sent => sent?.action === LIVE_DUBBING_ACTIONS.TRANSCRIPT_DELIVERY_CHANGED))
      .toHaveLength(0);
  });

  it('ignores a stale same-session failure when a newer transcript already succeeded', async () => {
    const harness = createVolumeHarness(LIVE_DUBBING_STATUS.RUNNING);
    let rejectSeq1;
    const seq1Gate = new Promise((_, reject) => { rejectSeq1 = reject; });
    harness.browserAPI.tabs.sendMessage = vi.fn(async (...args) => {
      if (args[1]?.data?.transcriptSequence === 1) return seq1Gate;
      return undefined;
    });
    const sender = {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    };
    const messageFor = transcriptSequence => ({
      action: LIVE_DUBBING_ACTIONS.TRANSLATED_TRANSCRIPT,
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence: 4,
        transcriptSequence,
        transcript: { kind: 'translated', text: 'bonjour' },
      },
    });
    const deliveryNotifies = () => harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([sent]) => sent)
      .filter(sent => sent?.action === LIVE_DUBBING_ACTIONS.TRANSCRIPT_DELIVERY_CHANGED);

    const pendingSeq1 = harness.coordinator.handleOffscreenTranslatedTranscript(messageFor(1), sender);
    await expect(harness.coordinator.handleOffscreenTranslatedTranscript(messageFor(2), sender))
      .resolves.toEqual({ success: true });
    await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
      success: true,
      transcriptDeliveryUnavailable: false,
    });

    rejectSeq1(new Error('tab closed https://secret.test'));
    await expect(pendingSeq1).resolves.toEqual({ success: true });

    await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
      success: true,
      transcriptDeliveryUnavailable: false,
    });
    expect(deliveryNotifies()).toHaveLength(0);
    expect(JSON.stringify(await harness.coordinator.getStatus())).not.toContain('secret.test');
  });

  it('does not let a stale pending failure restore unavailability after recovery', async () => {
    const harness = createVolumeHarness(LIVE_DUBBING_STATUS.RUNNING);
    let rejectSeq2;
    const seq2Gate = new Promise((_, reject) => { rejectSeq2 = reject; });
    harness.browserAPI.tabs.sendMessage = vi.fn(async (...args) => {
      const seq = args[1]?.data?.transcriptSequence;
      if (seq === 1) return Promise.reject(new Error('tab closed https://secret.test'));
      if (seq === 2) return seq2Gate;
      return undefined;
    });
    const sender = {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    };
    const messageFor = transcriptSequence => ({
      action: LIVE_DUBBING_ACTIONS.TRANSLATED_TRANSCRIPT,
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence: 4,
        transcriptSequence,
        transcript: { kind: 'translated', text: 'bonjour' },
      },
    });
    const deliveryNotifies = () => harness.browserAPI.runtime.sendMessage.mock.calls
      .map(([sent]) => sent)
      .filter(sent => sent?.action === LIVE_DUBBING_ACTIONS.TRANSCRIPT_DELIVERY_CHANGED);

    await expect(harness.coordinator.handleOffscreenTranslatedTranscript(messageFor(1), sender))
      .resolves.toEqual({ success: true });
    await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
      success: true,
      transcriptDeliveryUnavailable: true,
    });
    expect(deliveryNotifies()).toHaveLength(1);

    const pendingSeq2 = harness.coordinator.handleOffscreenTranslatedTranscript(messageFor(2), sender);
    await expect(harness.coordinator.handleOffscreenTranslatedTranscript(messageFor(3), sender))
      .resolves.toEqual({ success: true });
    await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
      success: true,
      transcriptDeliveryUnavailable: false,
    });
    expect(deliveryNotifies()).toHaveLength(2);

    rejectSeq2(new Error('tab closed https://secret.test'));
    await expect(pendingSeq2).resolves.toEqual({ success: true });

    await expect(harness.coordinator.getStatus()).resolves.toMatchObject({
      success: true,
      transcriptDeliveryUnavailable: false,
    });
    expect(deliveryNotifies()).toHaveLength(2);
    expect(JSON.stringify(await harness.coordinator.getStatus())).not.toContain('secret.test');
  });

  it('rejects duplicate transcript sequences for the exact active descriptor', async () => {
    const harness = createVolumeHarness(LIVE_DUBBING_STATUS.RUNNING);
    const sender = {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    };
    const message = {
      action: LIVE_DUBBING_ACTIONS.TRANSLATED_TRANSCRIPT,
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence: 4,
        transcriptSequence: 1,
        transcript: { kind: 'translated', text: 'bonjour' },
      },
    };

    await expect(harness.coordinator.handleOffscreenTranslatedTranscript(message, sender))
      .resolves.toEqual({ success: true });
    await expect(harness.coordinator.handleOffscreenTranslatedTranscript(message, sender))
      .resolves.toMatchObject({
        success: false,
        error: 'LIVE_DUBBING_UNAUTHORIZED',
        ignored: true,
      });

    await expect(harness.coordinator.handleOffscreenTranslatedTranscript({
      ...message,
      data: { ...message.data, transcriptSequence: 2 },
    }, sender)).resolves.toEqual({ success: true });
    await expect(harness.coordinator.handleOffscreenTranslatedTranscript({
      ...message,
      data: { ...message.data, transcriptSequence: 1 },
    }, sender)).resolves.toMatchObject({
      success: false,
      error: 'LIVE_DUBBING_UNAUTHORIZED',
      ignored: true,
    });
  });

  it('keeps transcript relay bookkeeping out of restart lifecycle state and preserves STOP lease recovery', async () => {
    const harness = createVolumeHarness(LIVE_DUBBING_STATUS.RUNNING);
    harness.manager.activeLeases = [{ owner: LIVE_DUBBING_OWNER, leaseId: 'session-1' }];
    harness.browserAPI.tabs.sendMessage = vi.fn(async () => undefined);
    const sender = {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    };
    const transcript = {
      action: LIVE_DUBBING_ACTIONS.TRANSLATED_TRANSCRIPT,
      data: {
        sessionId: 'session-1',
        providerId: 'gemini',
        eventSequence: 4,
        transcriptSequence: 1,
        transcript: { kind: 'translated', text: 'after restart' },
      },
    };

    expect(harness.coordinator.sessionRegistry.getSessionState('session-1')).toBeNull();
    await expect(harness.coordinator.handleOffscreenTranslatedTranscript(transcript, sender))
      .resolves.toEqual({ success: true });
    expect(harness.coordinator.sessionRegistry.getSessionState('session-1')).toBeNull();

    await expect(harness.coordinator.stop({ data: { sessionId: 'session-1' } }))
      .resolves.toMatchObject({ success: true, stopped: true });
    expect(harness.manager.release).toHaveBeenCalledOnce();
    expect(harness.manager.release).toHaveBeenCalledWith({
      owner: LIVE_DUBBING_OWNER,
      leaseId: 'session-1',
    });
    expect(harness.calls.some(([, message]) => (
      message?.action === LIVE_DUBBING_ACTIONS.DISPOSE
    ))).toBe(true);
  });

  it('relays one session-scoped clear after stop without making delivery terminal', async () => {
    const harness = createVolumeHarness(LIVE_DUBBING_STATUS.RUNNING);
    const sendTabMessage = vi.fn().mockRejectedValue(new Error('tab closed'));
    harness.browserAPI.tabs.sendMessage = sendTabMessage;

    await expect(harness.coordinator.stop({ data: { sessionId: 'session-1' } }))
      .resolves.toMatchObject({ success: true, stopped: true });
    expect(sendTabMessage).toHaveBeenCalledOnce();
    expect(sendTabMessage).toHaveBeenCalledWith(42, {
      action: LIVE_DUBBING_ACTIONS.CLEAR_TRANSCRIPT,
      data: { sessionId: 'session-1' },
    }, { frameId: 0 });

    await expect(harness.coordinator.stop({ data: { sessionId: 'session-1' } }))
      .resolves.toMatchObject({ success: true, stopped: false });
    expect(sendTabMessage).toHaveBeenCalledOnce();
  });
});
