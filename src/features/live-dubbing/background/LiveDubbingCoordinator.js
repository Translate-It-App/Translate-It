import browser from 'webextension-polyfill';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { offscreenRuntimeLeaseManager } from '@/shared/runtime/OffscreenRuntimeLeaseManager.js';
import {
  LIVE_DUBBING_ACTIONS,
  LIVE_DUBBING_ACTION_TIMEOUTS,
  LIVE_DUBBING_CAPTURE_STAGES,
  LIVE_DUBBING_LEASE_REASONS,
  LIVE_DUBBING_OPENAI_PROVIDER_ID,
  LIVE_DUBBING_ORIGINAL_TRANSCRIPT_KIND,
  LIVE_DUBBING_OWNER,
  LIVE_DUBBING_PROVIDER_IDS,
  LIVE_DUBBING_PROVIDER_ID,
  LIVE_DUBBING_STATUS,
  LIVE_DUBBING_STORAGE_STATE,
  LIVE_DUBBING_START_TIMEOUT,
  LIVE_DUBBING_STOP_TIMEOUT,
} from '../constants.js';
import {
  cloneDescriptor,
  createLiveDubbingDiagnostic,
  createLiveDubbingTerminalOutcome,
  createLiveDubbingProviderDiagnostic,
  createLiveDubbingTranscriptClearMessage,
  createConsumeMessage,
  createDescriptor,
  createDubbedVolumeMessage,
  createDubbedVolumeQueryMessage,
  createOriginalVolumeMessage,
  createOriginalVolumeQueryMessage,
  normalizeLiveDubbingVolume,
  createProviderConnectMessage,
  createPrepareMessage,
  createSessionMessage,
  createStatusMessage,
  hasExactSessionEvent,
  isValidLiveDubbingTranscriptSequence,
  isAuthorizedOffscreenSender,
  isAcknowledgedForSession,
  isExactSessionResponse,
  isLiveDubbingProviderId,
  normalizeProviderTargetLanguage,
  safeFailureCode,
  sanitizeLiveDubbingDiagnostic,
  sanitizeLiveDubbingCleanupDiagnostic,
  sanitizeLiveDubbingProviderDiagnostic,
  sanitizeLiveDubbingTranscript,
  toPublicLiveDubbingTerminalOutcome,
} from '../contracts.js';
import { LiveDubbingStateStore, LIVE_DUBBING_CLEAR_OUTCOMES } from './LiveDubbingStateStore.js';
import { LiveDubbingCleanupManager } from './LiveDubbingCleanupManager.js';
import { LiveDubbingRuntimeGateway } from './LiveDubbingRuntimeGateway.js';
import { LiveDubbingSessionRegistry } from './LiveDubbingSessionRegistry.js';

const logger = getScopedLogger(LOG_COMPONENTS.LIVE_DUBBING, 'LiveDubbingCoordinator');

// Explicit Coordinator-owned allowlist: Controller-local pipeline/audio failures
// must never be misclassified as provider setup, even during CONNECTING_PROVIDER.
const NON_PROVIDER_SETUP_TERMINAL_CATEGORIES = new Set([
  'INPUT_PIPELINE_ERROR',
  'INPUT_SEND_ERROR',
  'INVALID_OUTPUT_AUDIO',
  'OUTPUT_AUDIO_ERROR',
  'OUTPUT_PIPELINE_ERROR',
]);

export { LIVE_DUBBING_CLEAR_OUTCOMES };

function createCaptureStageFailure(stage, error, diagnostic = null) {
  const failure = new Error('Live dubbing capture failed');
  const sanitized = diagnostic
    ? sanitizeLiveDubbingDiagnostic(diagnostic)
    : createLiveDubbingDiagnostic(stage, error);
  failure.captureDiagnostic = { ...sanitized, stage };
  return failure;
}

function createResponseDiagnostic(stage, response, sensitiveValues = []) {
  const sanitized = sanitizeLiveDubbingDiagnostic(response?.diagnostic, { sensitiveValues });
  return sanitized
    ? { ...sanitized, stage }
    : createLiveDubbingDiagnostic(stage, {
      name: 'OffscreenCaptureError',
      message: typeof response?.error === 'string'
        ? response.error
        : 'Offscreen capture request failed',
      code: typeof response?.error === 'string' ? response.error : undefined,
    }, { sensitiveValues });
}

function defaultUuid() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  hex[12] = '4';
  hex[16] = (8 + Math.floor(Math.random() * 4)).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function getStartProviderId(message) {
  const data = message?.data && typeof message.data === 'object' ? message.data : null;
  if (data && Object.prototype.hasOwnProperty.call(data, 'providerId')) return data.providerId;
  if (message && Object.prototype.hasOwnProperty.call(message, 'providerId')) return message.providerId;
  return LIVE_DUBBING_PROVIDER_ID;
}

// Lease reasons describe acquisition capabilities only; lease snapshots do
// not provide trusted provider identity for recovery.
function getLeaseReasons(providerId) {
  return providerId === LIVE_DUBBING_OPENAI_PROVIDER_ID
    ? [...LIVE_DUBBING_LEASE_REASONS, 'WEB_RTC']
    : [...LIVE_DUBBING_LEASE_REASONS];
}

async function defaultHasConfiguredCredentials(providerId) {
  try {
    if (providerId === LIVE_DUBBING_OPENAI_PROVIDER_ID) {
      const { openAIRealtimeBootstrapService } = await import('./OpenAIRealtimeBootstrapService.js');
      return (await openAIRealtimeBootstrapService.hasConfiguredCredentials()) === true;
    }
    if (providerId === LIVE_DUBBING_PROVIDER_ID) {
      const { geminiLiveBootstrapService } = await import('./GeminiLiveBootstrapService.js');
      return (await geminiLiveBootstrapService.hasConfiguredCredentials()) === true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Read persisted live-dubbing volume preferences through the shared storage
 * path. Always bypasses cache so START from any context observes the latest
 * persisted preference; every failure falls back to the persisted defaults.
 * Dynamic import keeps this module loadable where extension storage is
 * unavailable.
 * @returns {Promise<{originalVolume: number, dubbedVolume: number}>}
 */
async function readPersistedVolumePreferences() {
  try {
    const { storageManager } = await import('@/shared/storage/core/StorageCore.js');
    const stored = await storageManager.getFresh({
      LIVE_DUBBING_ORIGINAL_VOLUME: 0,
      LIVE_DUBBING_DUBBED_VOLUME: 1,
    });
    return {
      originalVolume: normalizeLiveDubbingVolume(stored?.LIVE_DUBBING_ORIGINAL_VOLUME, 0),
      dubbedVolume: normalizeLiveDubbingVolume(stored?.LIVE_DUBBING_DUBBED_VOLUME, 1),
    };
  } catch {
    return { originalVolume: 0, dubbedVolume: 1 };
  }
}

/**
 * Owns one Chrome tab-capture control-plane session.
 * No media, provider bootstrap, transcript, WebSocket URL, or stream ID is
 * placed in descriptor storage or returned to UI callers.
 */
export class LiveDubbingCoordinator {
  constructor(options = {}) {
    this.browserAPI = options.browserAPI || browser;
    this.chromeAPI = options.chromeAPI || globalThis.chrome || this.browserAPI;
    this.runtimeGateway = options.runtimeGateway
      || new LiveDubbingRuntimeGateway({
        browserAPI: this.browserAPI,
        chromeAPI: this.chromeAPI,
      });
    this.leaseManager = options.leaseManager || offscreenRuntimeLeaseManager;
    this.now = options.now || (() => Date.now());
    this.uuid = options.uuid || defaultUuid;
    this.log = options.logger || logger;
    this.hasConfiguredCredentials = typeof options.hasConfiguredCredentials === 'function'
      ? options.hasConfiguredCredentials
      : defaultHasConfiguredCredentials;
    this.sessionRegistry = options.sessionRegistry || new LiveDubbingSessionRegistry();
    this.volumePreferencesReader = options.volumePreferencesReader || readPersistedVolumePreferences;
    this.stateStore = options.stateStore
      || new LiveDubbingStateStore({ browserAPI: this.browserAPI });
    this.transition = Promise.resolve();
    this.transcriptRelayRecord = null;
    this.cleanupManager = options.cleanupManager
      || new LiveDubbingCleanupManager({
        leaseManager: this.leaseManager,
        sendOffscreen: this._sendOffscreen.bind(this),
        getSessionState: (sessionId) => this.sessionRegistry.getSessionState(sessionId),
        logger: this.log,
      });
  }

  get descriptor() { return this.stateStore.descriptor; }
  set descriptor(value) { this.stateStore.descriptor = value; }
  get storageState() { return this.stateStore.storageState; }
  set storageState(value) { this.stateStore.storageState = value; }
  get terminalOutcome() { return this.stateStore.terminalOutcome; }
  set terminalOutcome(value) { this.stateStore.terminalOutcome = value; }
  get outcomeStorageState() { return this.stateStore.outcomeStorageState; }
  set outcomeStorageState(value) { this.stateStore.outcomeStorageState = value; }

  start(message = {}, sender = {}) {
    const requestedProviderId = getStartProviderId(message);
    const pendingStart = {
      sessionId: this.uuid(),
      tabId: this._getPendingStartTabId(sender),
      tabEventIds: new Set(),
      providerId: isLiveDubbingProviderId(requestedProviderId) ? requestedProviderId : null,
      terminalRequested: false,
      startedAt: this.now(),
    };
    this.sessionRegistry.addPendingStart(pendingStart);
    const operation = this._enqueue(() => this._start(message, sender, pendingStart));
    void operation.then(
      () => this.sessionRegistry.deletePendingStart(pendingStart),
      () => this.sessionRegistry.deletePendingStart(pendingStart),
    );
    return operation;
  }

  stop(message = {}) {
    return this._stop(message);
  }

  /**
   * Read-only authoritative status snapshot. Intentionally independent of the
   * serialized START/STOP mutation queue: a reopened popup must recover the
   * preparing/connecting/pending/stopping/cleanupPending descriptor
   * immediately even while a START is still pending. Only reads storage and
   * the in-memory cache; never writes storage and never touches session,
   * cleanup, or terminal state, so mutation serialization is unaffected.
   */
  async getStatus() {
    let tabCaptureAvailable = false;
    try {
      tabCaptureAvailable = this.runtimeGateway.supportsTabCapture() === true;
    } catch {
      tabCaptureAvailable = false;
    }
    let offscreenAvailable = true;
    if (typeof this.leaseManager.supportsOffscreenDocument === 'function') {
      try {
        offscreenAvailable = this.leaseManager.supportsOffscreenDocument() === true;
      } catch {
        offscreenAvailable = false;
      }
    }
    const available = tabCaptureAvailable && offscreenAvailable;
    await this._readStatusSnapshot();
    if (this._storageReadFailed()) return this._storageReadFailure();
    if (this._storageDescriptorInvalid()) return this._storageDescriptorFailure();
    const terminalOutcome = this._getStatusTerminalOutcome();
    return {
      success: true,
      available,
      status: cloneDescriptor(this.descriptor),
      terminalOutcome,
      transcriptDeliveryUnavailable: this._isTranscriptDeliveryUnavailable(),
    };
  }

  /**
   * Apply original-audio gain without entering the lifecycle mutation queue.
   * Public ingress uses the authoritative descriptor fence. The transient
   * provider-ready bridge changes only the internal offscreen transport fence.
   */
  async setOriginalVolume(message = {}) {
    const data = message?.data && typeof message.data === 'object'
      ? message.data
      : message;
    const volume = data?.volume;
    const volumeValid = typeof volume === 'number'
      && Number.isFinite(volume)
      && volume >= 0
      && volume <= 1;
    if (!volumeValid) {
      return { success: false, error: 'LIVE_DUBBING_ORIGINAL_VOLUME_INVALID' };
    }

    const descriptor = await this._readDescriptor();
    const controllableStatuses = [
      LIVE_DUBBING_STATUS.PREPARING_CAPTURE,
      LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
      LIVE_DUBBING_STATUS.RUNNING,
    ];
    if (!descriptor || this._storageReadFailed() || this._storageDescriptorInvalid()
      || !controllableStatuses.includes(descriptor.status)) {
      return { success: false, error: 'LIVE_DUBBING_SESSION_UNAVAILABLE' };
    }

    if (data?.sessionId !== descriptor.sessionId || data?.providerId !== descriptor.providerId) {
      return { success: false, error: 'LIVE_DUBBING_SESSION_MISMATCH' };
    }
    if (!hasExactSessionEvent(message, descriptor)) {
      return { success: false, error: 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH' };
    }
    const setRequestToken = this._advanceVolumeSetRequestToken(descriptor, 'original');
    let transportDescriptor = this._resolveVolumeTransportDescriptor(descriptor);

    let response;
    try {
      response = await this._sendOriginalVolume(
        createOriginalVolumeMessage(transportDescriptor, volume),
      );
      ({ response, transportDescriptor } = await this._reconcileVolumeSequenceMismatch({
        descriptor,
        response,
        transportDescriptor,
        setRequestToken,
        setRequestLane: 'original',
        createMessage: transport => createOriginalVolumeMessage(transport, volume),
        sendMessage: messageToSend => this._sendOriginalVolume(messageToSend),
      }));
    } catch {
      return { success: false, error: 'LIVE_DUBBING_ORIGINAL_AUDIO_UNAVAILABLE' };
    }

    const responseData = response?.data && typeof response.data === 'object'
      ? response.data
      : response;
    const hasResponseIdentity = responseData
      && responseData.sessionId !== undefined
      && responseData.providerId !== undefined;
    if (hasResponseIdentity
      && this._isSessionMismatch(responseData, transportDescriptor.sessionId, transportDescriptor.providerId)) {
      return { success: false, error: 'LIVE_DUBBING_SESSION_MISMATCH' };
    }
    if (hasResponseIdentity) {
      if (responseData.eventSequence !== undefined
        && responseData.eventSequence !== transportDescriptor.eventSequence) {
        return { success: false, error: 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH' };
      }
    }

    if (!responseData
      || responseData.success === false
      || !isExactSessionResponse(responseData, transportDescriptor.sessionId, transportDescriptor.providerId)
      || !hasExactSessionEvent(response, transportDescriptor)
      || typeof responseData.originalVolume !== 'number'
      || !Number.isFinite(responseData.originalVolume)
      || responseData.originalVolume < 0
      || responseData.originalVolume > 1) {
      return { success: false, error: 'LIVE_DUBBING_ORIGINAL_AUDIO_UNAVAILABLE' };
    }

    const current = await this._readDescriptor();
    if (!current || this._storageReadFailed() || this._storageDescriptorInvalid()) {
      return { success: false, error: 'LIVE_DUBBING_SESSION_UNAVAILABLE' };
    }
    if (current.sessionId !== descriptor.sessionId || current.providerId !== descriptor.providerId) {
      return { success: false, error: 'LIVE_DUBBING_SESSION_MISMATCH' };
    }
    const currentTransportDescriptor = this._resolveVolumeTransportDescriptor(current);
    if (!hasExactSessionEvent({ data: responseData }, currentTransportDescriptor)) {
      return { success: false, error: 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH' };
    }
    if (!controllableStatuses.includes(current.status)) {
      return { success: false, error: 'LIVE_DUBBING_SESSION_UNAVAILABLE' };
    }

    const isSupersededVolume = responseData?.superseded === true;
    if (!isSupersededVolume) {
      // Persist only the latest-wins winner. Failed, stale, and superseded
      // outcomes never persist; persistence itself is best effort, detached
      // from the runtime SET response so a slow storage write can never block
      // or delay runtime control.
      this._persistOriginalVolumePreference(responseData.originalVolume);
    }
    return {
      success: true,
      sessionId: current.sessionId,
      providerId: current.providerId,
      eventSequence: current.eventSequence,
      status: current.status,
      originalVolume: responseData.originalVolume,
      ...(isSupersededVolume ? { ignored: true, superseded: true } : {}),
    };
  }

  /**
   * Apply dubbed-audio gain without entering the lifecycle mutation queue.
   * Public ingress uses the authoritative descriptor fence. The transient
   * provider-ready bridge changes only the internal offscreen transport fence.
   */
  async setDubbedVolume(message = {}) {
    const data = message?.data && typeof message.data === 'object'
      ? message.data
      : message;
    const volume = data?.volume;
    const volumeValid = typeof volume === 'number'
      && Number.isFinite(volume)
      && volume >= 0
      && volume <= 1;
    if (!volumeValid) {
      return { success: false, error: 'LIVE_DUBBING_DUBBED_VOLUME_INVALID' };
    }

    const descriptor = await this._readDescriptor();
    const controllableStatuses = [
      LIVE_DUBBING_STATUS.PREPARING_CAPTURE,
      LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
      LIVE_DUBBING_STATUS.RUNNING,
    ];
    if (!descriptor || this._storageReadFailed() || this._storageDescriptorInvalid()
      || !controllableStatuses.includes(descriptor.status)) {
      return { success: false, error: 'LIVE_DUBBING_SESSION_UNAVAILABLE' };
    }

    if (data?.sessionId !== descriptor.sessionId || data?.providerId !== descriptor.providerId) {
      return { success: false, error: 'LIVE_DUBBING_SESSION_MISMATCH' };
    }
    if (!hasExactSessionEvent(message, descriptor)) {
      return { success: false, error: 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH' };
    }
    const setRequestToken = this._advanceVolumeSetRequestToken(descriptor, 'dubbed');
    let transportDescriptor = this._resolveVolumeTransportDescriptor(descriptor);

    let response;
    try {
      response = await this._sendDubbedVolume(
        createDubbedVolumeMessage(transportDescriptor, volume),
      );
      ({ response, transportDescriptor } = await this._reconcileVolumeSequenceMismatch({
        descriptor,
        response,
        transportDescriptor,
        setRequestToken,
        setRequestLane: 'dubbed',
        createMessage: transport => createDubbedVolumeMessage(transport, volume),
        sendMessage: messageToSend => this._sendDubbedVolume(messageToSend),
      }));
    } catch {
      return { success: false, error: 'LIVE_DUBBING_DUBBED_AUDIO_UNAVAILABLE' };
    }

    const responseData = response?.data && typeof response.data === 'object'
      ? response.data
      : response;
    const hasResponseIdentity = responseData
      && responseData.sessionId !== undefined
      && responseData.providerId !== undefined;
    if (hasResponseIdentity
      && this._isSessionMismatch(responseData, transportDescriptor.sessionId, transportDescriptor.providerId)) {
      return { success: false, error: 'LIVE_DUBBING_SESSION_MISMATCH' };
    }
    if (hasResponseIdentity) {
      if (responseData.eventSequence !== undefined
        && responseData.eventSequence !== transportDescriptor.eventSequence) {
        return { success: false, error: 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH' };
      }
    }

    if (!responseData
      || responseData.success === false
      || !isExactSessionResponse(responseData, transportDescriptor.sessionId, transportDescriptor.providerId)
      || !hasExactSessionEvent(response, transportDescriptor)
      || typeof responseData.dubbedVolume !== 'number'
      || !Number.isFinite(responseData.dubbedVolume)
      || responseData.dubbedVolume < 0
      || responseData.dubbedVolume > 1) {
      return { success: false, error: 'LIVE_DUBBING_DUBBED_AUDIO_UNAVAILABLE' };
    }

    const current = await this._readDescriptor();
    if (!current || this._storageReadFailed() || this._storageDescriptorInvalid()) {
      return { success: false, error: 'LIVE_DUBBING_SESSION_UNAVAILABLE' };
    }
    if (current.sessionId !== descriptor.sessionId || current.providerId !== descriptor.providerId) {
      return { success: false, error: 'LIVE_DUBBING_SESSION_MISMATCH' };
    }
    const currentTransportDescriptor = this._resolveVolumeTransportDescriptor(current);
    if (!hasExactSessionEvent({ data: responseData }, currentTransportDescriptor)) {
      return { success: false, error: 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH' };
    }
    if (!controllableStatuses.includes(current.status)) {
      return { success: false, error: 'LIVE_DUBBING_SESSION_UNAVAILABLE' };
    }

    const isSupersededVolume = responseData?.superseded === true;
    if (!isSupersededVolume) {
      // Persist only the latest-wins winner. Failed, stale, and superseded
      // outcomes never persist; persistence itself is best effort, detached
      // from the runtime SET response so a slow storage write can never block
      // or delay runtime control.
      this._persistDubbedVolumePreference(responseData.dubbedVolume);
    }
    return {
      success: true,
      sessionId: current.sessionId,
      providerId: current.providerId,
      eventSequence: current.eventSequence,
      status: current.status,
      dubbedVolume: responseData.dubbedVolume,
      ...(isSupersededVolume ? { ignored: true, superseded: true } : {}),
    };
  }

  /**
   * Read persisted volume preferences fresh for session init. Never throws:
   * any reader or storage failure falls back to the persisted defaults.
   * Layers the coordinator-memory newest accepted Original and Dubbed Volumes
   * on top of the fresh storage read only while each value is not yet safely
   * persisted, so an immediate subsequent START observes the user's latest
   * accepted values even while persistence is still in flight, without ever
   * waiting on storage. Once a newest accepted value has persisted, fresh
   * storage is authoritative again for cross-context synchronization.
   */
  async _readVolumePreferences() {
    let persisted = { originalVolume: 0, dubbedVolume: 1 };
    try {
      const preferences = await this.volumePreferencesReader();
      if (preferences && typeof preferences === 'object') {
        persisted = {
          originalVolume: normalizeLiveDubbingVolume(preferences.originalVolume, 0),
          dubbedVolume: normalizeLiveDubbingVolume(preferences.dubbedVolume, 1),
        };
      }
    } catch {
      // Fall through to defaults below.
    }
    const originalOverride = this._latestAcceptedOriginalVolume;
    if (Number.isFinite(originalOverride) && originalOverride >= 0 && originalOverride <= 1) {
      persisted.originalVolume = originalOverride;
    }
    const dubbedOverride = this._latestAcceptedDubbedVolume;
    if (Number.isFinite(dubbedOverride) && dubbedOverride >= 0 && dubbedOverride <= 1) {
      persisted.dubbedVolume = dubbedOverride;
    }
    return persisted;
  }

  /**
   * Best-effort persistence of the accepted original volume. Never throws,
   * never terminalizes, and never changes runtime fencing or results.
   *
   * Coalesces accepted SETs: a newer accepted volume supersedes any in-flight
   * write, so a slow older completion cannot leave storage with an older
   * value. Each accepted SET bumps a sequence number; before storage is
   * touched the queue confirms its sequence is still the latest and aborts
   * the superseded write without writing. Persistence failures are swallowed
   * and never reach the runtime result. The writer is detached from the
   * runtime SET path so a slow or hanging storage write can never block or
   * delay runtime control; the accepted value is also recorded in memory so
   * an immediate subsequent START observes the latest user choice while
   * persistence is still in flight.
   */
  _persistOriginalVolumePreference(volume) {
    return this._persistVolumePreference('original', volume);
  }

  /**
   * Best-effort persistence of the accepted dubbed volume. Same latest-wins,
   * detached, non-terminal semantics as the original-volume path.
   */
  _persistDubbedVolumePreference(volume) {
    return this._persistVolumePreference('dubbed', volume);
  }

  /**
   * Single generalized volume-preference writer serving both Original and
   * Dubbed Volume. `kind` is 'original' or 'dubbed'; each kind owns an
   * independent coalescing queue, memory override, and storage key so a
   * dubbed SET can never disturb an original write and vice versa.
   * @param {'original'|'dubbed'} kind
   * @param {number} volume normalized 0..1 gain
   */
  _persistVolumePreference(kind, volume) {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) return;
    const isDubbed = kind === 'dubbed';
    const storageKey = isDubbed ? 'LIVE_DUBBING_DUBBED_VOLUME' : 'LIVE_DUBBING_ORIGINAL_VOLUME';
    const queueField = isDubbed ? '_dubbedVolumePreferenceWrites' : '_volumePreferenceWrites';
    const memoryField = isDubbed ? '_latestAcceptedDubbedVolume' : '_latestAcceptedOriginalVolume';
    const seqField = isDubbed ? '_latestAcceptedDubbedVolumeSeq' : '_latestAcceptedOriginalVolumeSeq';
    const pending = this[queueField] || (this[queueField] = {
      seq: 0,
      latestSeq: 0,
      latestValue: null,
      inflight: null,
    });
    pending.latestSeq = ++pending.seq;
    pending.latestValue = volume;
    this[memoryField] = volume;
    this[seqField] = pending.latestSeq;
    if (pending.inflight) return;
    pending.inflight = (async () => {
      try {
        const { storageManager } = await import('@/shared/storage/core/StorageCore.js');
        while (pending.latestSeq !== 0) {
          const seq = pending.latestSeq;
          const value = pending.latestValue;
          pending.latestSeq = 0;
          pending.latestValue = null;
          if (seq !== pending.seq) {
            // A newer accepted SET superseded this one before its write began.
            continue;
          }
          try {
            await storageManager.set({ [storageKey]: value });
            // Memory override lives only until the newest accepted value is
            // safely persisted. Clear it only when this completed write still
            // represents the current latest accepted sequence/value; an older
            // write finishing after a newer SET, a failed write, or a stale
            // value must leave the newer memory override intact.
            if (seq === pending.seq
              && seq === this[seqField]
              && value === this[memoryField]) {
              this[memoryField] = null;
              this[seqField] = 0;
            }
          } catch {
            // Runtime state stays authoritative when persistence is unavailable.
            // Keep the memory override so a subsequent START still observes
            // the newest accepted value.
          }
        }
      } catch {
        // Defensive: never let the detached writer reject.
      } finally {
        pending.inflight = null;
      }
    })();
    pending.inflight.catch(() => {});
  }

  /**
   * Read the committed original-audio gain without entering the lifecycle
   * mutation queue and without changing any descriptor state. The descriptor
   * identity and authoritative event sequence are the public request fence;
   * any bridge sequence is used only for the internal offscreen transport.
   * The offscreen read never creates or starts audio resources.
   */
  async getOriginalVolume(message = {}) {
    const descriptor = await this._readDescriptor();
    const controllableStatuses = [
      LIVE_DUBBING_STATUS.PREPARING_CAPTURE,
      LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
      LIVE_DUBBING_STATUS.RUNNING,
    ];
    if (!descriptor || this._storageReadFailed() || this._storageDescriptorInvalid()
      || !controllableStatuses.includes(descriptor.status)) {
      return { success: false, error: 'LIVE_DUBBING_SESSION_UNAVAILABLE' };
    }

    const data = message?.data && typeof message.data === 'object'
      ? message.data
      : message;
    if (data?.sessionId !== descriptor.sessionId || data?.providerId !== descriptor.providerId) {
      return { success: false, error: 'LIVE_DUBBING_SESSION_MISMATCH' };
    }
    if (!hasExactSessionEvent(message, descriptor)) {
      return { success: false, error: 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH' };
    }
    let transportDescriptor = this._resolveVolumeTransportDescriptor(descriptor);

    let response;
    try {
      response = await this._sendOriginalVolumeQuery(
        createOriginalVolumeQueryMessage(transportDescriptor),
      );
      ({ response, transportDescriptor } = await this._reconcileVolumeSequenceMismatch({
        descriptor,
        response,
        transportDescriptor,
        createMessage: transport => createOriginalVolumeQueryMessage(transport),
        sendMessage: messageToSend => this._sendOriginalVolumeQuery(messageToSend),
      }));
    } catch {
      return { success: false, error: 'LIVE_DUBBING_ORIGINAL_AUDIO_UNAVAILABLE' };
    }

    const responseData = response?.data && typeof response.data === 'object'
      ? response.data
      : response;
    const hasResponseIdentity = responseData
      && responseData.sessionId !== undefined
      && responseData.providerId !== undefined;
    if (hasResponseIdentity
      && this._isSessionMismatch(responseData, transportDescriptor.sessionId, transportDescriptor.providerId)) {
      return { success: false, error: 'LIVE_DUBBING_SESSION_MISMATCH' };
    }
    if (hasResponseIdentity) {
      if (responseData.eventSequence !== undefined
        && responseData.eventSequence !== transportDescriptor.eventSequence) {
        return { success: false, error: 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH' };
      }
    }

    if (!responseData
      || responseData.success === false
      || !isExactSessionResponse(responseData, transportDescriptor.sessionId, transportDescriptor.providerId)
      || !hasExactSessionEvent(response, transportDescriptor)
      || typeof responseData.originalVolume !== 'number'
      || !Number.isFinite(responseData.originalVolume)
      || responseData.originalVolume < 0
      || responseData.originalVolume > 1) {
      return { success: false, error: 'LIVE_DUBBING_ORIGINAL_AUDIO_UNAVAILABLE' };
    }

    const current = await this._readDescriptor();
    if (!current || this._storageReadFailed() || this._storageDescriptorInvalid()) {
      return { success: false, error: 'LIVE_DUBBING_SESSION_UNAVAILABLE' };
    }
    if (current.sessionId !== descriptor.sessionId || current.providerId !== descriptor.providerId) {
      return { success: false, error: 'LIVE_DUBBING_SESSION_MISMATCH' };
    }
    const currentTransportDescriptor = this._resolveVolumeTransportDescriptor(current);
    if (!hasExactSessionEvent({ data: responseData }, currentTransportDescriptor)) {
      return { success: false, error: 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH' };
    }
    if (!controllableStatuses.includes(current.status)) {
      return { success: false, error: 'LIVE_DUBBING_SESSION_UNAVAILABLE' };
    }

    return {
      success: true,
      sessionId: current.sessionId,
      providerId: current.providerId,
      eventSequence: current.eventSequence,
      status: current.status,
      originalVolume: responseData.originalVolume,
    };
  }

  /**
   * Read the committed dubbed-audio gain without entering the lifecycle
   * mutation queue and without changing any descriptor state. The descriptor
   * identity and authoritative event sequence are the public request fence;
   * any bridge sequence is used only for the internal offscreen transport.
   * The offscreen read never creates or starts audio resources.
   */
  async getDubbedVolume(message = {}) {
    const descriptor = await this._readDescriptor();
    const controllableStatuses = [
      LIVE_DUBBING_STATUS.PREPARING_CAPTURE,
      LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
      LIVE_DUBBING_STATUS.RUNNING,
    ];
    if (!descriptor || this._storageReadFailed() || this._storageDescriptorInvalid()
      || !controllableStatuses.includes(descriptor.status)) {
      return { success: false, error: 'LIVE_DUBBING_SESSION_UNAVAILABLE' };
    }

    const data = message?.data && typeof message.data === 'object'
      ? message.data
      : message;
    if (data?.sessionId !== descriptor.sessionId || data?.providerId !== descriptor.providerId) {
      return { success: false, error: 'LIVE_DUBBING_SESSION_MISMATCH' };
    }
    if (!hasExactSessionEvent(message, descriptor)) {
      return { success: false, error: 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH' };
    }
    let transportDescriptor = this._resolveVolumeTransportDescriptor(descriptor);

    let response;
    try {
      response = await this._sendDubbedVolumeQuery(
        createDubbedVolumeQueryMessage(transportDescriptor),
      );
      ({ response, transportDescriptor } = await this._reconcileVolumeSequenceMismatch({
        descriptor,
        response,
        transportDescriptor,
        createMessage: transport => createDubbedVolumeQueryMessage(transport),
        sendMessage: messageToSend => this._sendDubbedVolumeQuery(messageToSend),
      }));
    } catch {
      return { success: false, error: 'LIVE_DUBBING_DUBBED_AUDIO_UNAVAILABLE' };
    }

    const responseData = response?.data && typeof response.data === 'object'
      ? response.data
      : response;
    const hasResponseIdentity = responseData
      && responseData.sessionId !== undefined
      && responseData.providerId !== undefined;
    if (hasResponseIdentity
      && this._isSessionMismatch(responseData, transportDescriptor.sessionId, transportDescriptor.providerId)) {
      return { success: false, error: 'LIVE_DUBBING_SESSION_MISMATCH' };
    }
    if (hasResponseIdentity) {
      if (responseData.eventSequence !== undefined
        && responseData.eventSequence !== transportDescriptor.eventSequence) {
        return { success: false, error: 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH' };
      }
    }

    if (!responseData
      || responseData.success === false
      || !isExactSessionResponse(responseData, transportDescriptor.sessionId, transportDescriptor.providerId)
      || !hasExactSessionEvent(response, transportDescriptor)
      || typeof responseData.dubbedVolume !== 'number'
      || !Number.isFinite(responseData.dubbedVolume)
      || responseData.dubbedVolume < 0
      || responseData.dubbedVolume > 1) {
      return { success: false, error: 'LIVE_DUBBING_DUBBED_AUDIO_UNAVAILABLE' };
    }

    const current = await this._readDescriptor();
    if (!current || this._storageReadFailed() || this._storageDescriptorInvalid()) {
      return { success: false, error: 'LIVE_DUBBING_SESSION_UNAVAILABLE' };
    }
    if (current.sessionId !== descriptor.sessionId || current.providerId !== descriptor.providerId) {
      return { success: false, error: 'LIVE_DUBBING_SESSION_MISMATCH' };
    }
    const currentTransportDescriptor = this._resolveVolumeTransportDescriptor(current);
    if (!hasExactSessionEvent({ data: responseData }, currentTransportDescriptor)) {
      return { success: false, error: 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH' };
    }
    if (!controllableStatuses.includes(current.status)) {
      return { success: false, error: 'LIVE_DUBBING_SESSION_UNAVAILABLE' };
    }

    return {
      success: true,
      sessionId: current.sessionId,
      providerId: current.providerId,
      eventSequence: current.eventSequence,
      status: current.status,
      dubbedVolume: responseData.dubbedVolume,
    };
  }

  handleTabRemoved(tabId) {
    return this._stopForTab(tabId, 'TAB_REMOVED');
  }

  handleTopLevelNavigation(tabId) {
    return this._stopForTab(tabId, 'TOP_LEVEL_NAVIGATION');
  }

  async handleCaptureStatusChanged({ tabId, status } = {}) {
    if (!Number.isInteger(tabId) || tabId < 0) {
      return { success: false, error: 'INVALID_TAB_ID', ignored: true };
    }
    if (status !== 'stopped' && status !== 'error') {
      return { success: false, error: 'INVALID_CAPTURE_STATUS', ignored: true };
    }

    const descriptor = await this._readDescriptor();
    if (this._storageReadFailed()) return this._storageReadFailure();
    if (this._storageDescriptorInvalid()) return this._storageDescriptorFailure();
    if (descriptor?.status !== LIVE_DUBBING_STATUS.RUNNING || descriptor.tabId !== tabId) {
      return { success: true, stopped: false, ignored: true };
    }

    // Capture events carry no session identity. Keep an immutable fence and
    // re-read it before any terminal work so a reused tab cannot stop a newer
    // session.
    const expectedDescriptor = cloneDescriptor(descriptor);
    const expectedState = this.sessionRegistry.getSessionState(descriptor.sessionId);
    const current = await this._readDescriptor();
    if (this._storageReadFailed()) return this._storageReadFailure();
    if (this._storageDescriptorInvalid()) return this._storageDescriptorFailure();
    if (!this._isSameDescriptorFence(current, expectedDescriptor)) {
      return { success: true, stopped: false, ignored: true };
    }

    const fencedState = this.sessionRegistry.getSessionState(expectedDescriptor.sessionId);
    const terminalOperation = this.sessionRegistry.getTerminalOperation(expectedDescriptor.sessionId);
    if (fencedState?.terminalRequested
      || (terminalOperation?.providerId === expectedDescriptor.providerId
        && terminalOperation.state === fencedState)) {
      return {
        success: true,
        stopped: false,
        ignored: true,
        status: cloneDescriptor(current),
      };
    }

    const tabPresent = await this.runtimeGateway.probeTabPresence(tabId);
    const revalidated = await this._readDescriptor();
    if (this._storageReadFailed()) return this._storageReadFailure();
    if (this._storageDescriptorInvalid()) return this._storageDescriptorFailure();
    if (!this._isSameDescriptorFence(revalidated, expectedDescriptor)) {
      return {
        success: true,
        stopped: false,
        ignored: true,
        status: cloneDescriptor(revalidated),
      };
    }

    const revalidatedState = this.sessionRegistry.getSessionState(expectedDescriptor.sessionId);
    const revalidatedTerminalOperation = this.sessionRegistry.getTerminalOperation(expectedDescriptor.sessionId);
    if (revalidatedState?.terminalRequested
      || (revalidatedTerminalOperation?.providerId === expectedDescriptor.providerId
        && revalidatedTerminalOperation.state === revalidatedState)) {
      return {
        success: true,
        stopped: false,
        ignored: true,
        status: cloneDescriptor(revalidated),
      };
    }

    if (tabPresent === false) {
      return this._stopForSession(
        expectedDescriptor.sessionId,
        'TAB_REMOVED',
        expectedDescriptor,
        expectedState,
      );
    }

    const currentCaptureState = await this.runtimeGateway.getCurrentCaptureState(tabId);
    const captureRevalidated = await this._readDescriptor();
    if (this._storageReadFailed()) return this._storageReadFailure();
    if (this._storageDescriptorInvalid()) return this._storageDescriptorFailure();
    if (!this._isSameDescriptorFence(captureRevalidated, expectedDescriptor)
      || captureRevalidated?.status !== LIVE_DUBBING_STATUS.RUNNING
      || captureRevalidated?.tabId !== tabId) {
      return {
        success: true,
        stopped: false,
        ignored: true,
        status: cloneDescriptor(captureRevalidated),
      };
    }

    const captureState = this.sessionRegistry.getSessionState(expectedDescriptor.sessionId);
    const captureTerminalOperation = this.sessionRegistry.getTerminalOperation(expectedDescriptor.sessionId);
    if (captureState?.terminalRequested
      || (captureTerminalOperation?.providerId === expectedDescriptor.providerId
        && captureTerminalOperation.state === captureState)) {
      return {
        success: true,
        stopped: false,
        ignored: true,
        status: cloneDescriptor(captureRevalidated),
      };
    }

    if (currentCaptureState === true) {
      return {
        success: true,
        stopped: false,
        ignored: true,
        status: cloneDescriptor(captureRevalidated),
      };
    }

    // Capture loss is terminal proof. Runtime absence only selects the safe
    // lease-release path; it must not gate terminalization itself. An
    // unavailable tab API leaves this path unchanged instead of guessing that
    // the tab was removed.
    const runtimeAbsent = await this._isRuntimeAbsent(expectedDescriptor);

    return this._stopForSession(
      expectedDescriptor.sessionId,
      'CAPTURE_STATUS_CHANGED',
      expectedDescriptor,
      expectedState,
      {
        terminalizeRuntimeLoss: true,
        runtimeAbsent,
        skipCleanup: runtimeAbsent && !this._hasLiveLease(expectedDescriptor.sessionId),
      },
    );
  }

  async handleOffscreenTerminal(message = {}, sender = null) {
    const sessionId = message?.data?.sessionId || message?.sessionId;
    const providerId = message?.data?.providerId || message?.providerId;
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return Promise.resolve({ success: false, error: 'INVALID_SESSION_ID' });
    }
    if (!isLiveDubbingProviderId(providerId)) {
      return Promise.resolve({ success: false, error: 'LIVE_DUBBING_UNAUTHORIZED', ignored: true });
    }

    if (sender) {
      if (!isAuthorizedOffscreenSender(sender, this.browserAPI)) {
        return Promise.resolve({ success: false, error: 'LIVE_DUBBING_UNAUTHORIZED', ignored: true });
      }
      const authorized = this._authorizeTerminalRequest(message);
      if (!authorized) {
        return Promise.resolve({ success: false, error: 'LIVE_DUBBING_UNAUTHORIZED', ignored: true });
      }

      const providerDiagnostic = sanitizeLiveDubbingProviderDiagnostic(
        message?.data?.providerDiagnostic || message?.providerDiagnostic,
      );
      const state = this.sessionRegistry.getSessionState(sessionId);
      const latchedProviderDiagnostic = this._latchProviderDiagnostic(state, providerDiagnostic);
      if (providerDiagnostic) this.log.warn('Live dubbing provider terminal', providerDiagnostic);

      const data = message?.data || message;
      let startupFailureCode = null;
      if (authorized.status === LIVE_DUBBING_STATUS.CONNECTING_PROVIDER) {
        const candidate = this._classifyStartFailure({
          error: data,
          providerDiagnostic: latchedProviderDiagnostic,
          providerStartAttempted: true,
        });
        if (candidate === 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE'
          || candidate === 'LIVE_DUBBING_PROVIDER_SETUP_FAILED'
          || candidate === 'LIVE_DUBBING_START_FAILED') {
          startupFailureCode = candidate;
        }
      }
      const outcome = data.status === LIVE_DUBBING_STATUS.ERROR
        ? createLiveDubbingTerminalOutcome({
          sourceSessionId: sessionId,
          providerId,
          error: data.error,
          occurredAt: this.now(),
          providerDiagnostic: latchedProviderDiagnostic,
        })
        : null;
      const publicOutcome = toPublicLiveDubbingTerminalOutcome(outcome);
      const outcomeMutation = outcome ? this._queueOutcomeMutation(() => this._writeTerminalOutcome(outcome)) : null;

      const cleanupDiagnostic = sanitizeLiveDubbingCleanupDiagnostic(
        message?.data?.cleanupDiagnostic || message?.cleanupDiagnostic,
      );
      return this._stopForSession(
        sessionId,
        message?.data?.event || 'OFFSCREEN_TERMINAL',
        authorized,
        this.sessionRegistry.getSessionState(sessionId),
        { cleanupFailureError: startupFailureCode },
      ).then(result => {
        if (result?.success === true && result.stopped === true
          && cleanupDiagnostic?.playbackAccepted === false) {
          this.log.warn('Live dubbing ended without translated playback', cleanupDiagnostic);
        }
        if (publicOutcome && (result?.stopped === true || result?.cleanupPending === true)) {
          void outcomeMutation?.then(() => this._notifyTerminalOutcome(publicOutcome));
        }
        return result;
      });
    }

    if (this.descriptor && this.descriptor.sessionId === sessionId
      && this.descriptor.providerId !== providerId) {
      return Promise.resolve({ success: false, error: 'LIVE_DUBBING_UNAUTHORIZED', ignored: true });
    }

    return this._stopForSession(sessionId, message?.data?.event || 'OFFSCREEN_TERMINAL');
  }

  async handleOffscreenTranslatedTranscript(message = {}, sender = null) {
    return this.handleOffscreenTranscript(message, sender);
  }

  async handleOffscreenOriginalTranscript(message = {}, sender = null) {
    return this.handleOffscreenTranscript(message, sender);
  }

  async handleOffscreenTranscript(message = {}, sender = null) {
    if (!sender || !isAuthorizedOffscreenSender(sender, this.browserAPI)
      || ![
        LIVE_DUBBING_ACTIONS.TRANSLATED_TRANSCRIPT,
        LIVE_DUBBING_ACTIONS.ORIGINAL_TRANSCRIPT,
      ].includes(message?.action)) {
      return { success: false, error: 'LIVE_DUBBING_UNAUTHORIZED', ignored: true };
    }

    const descriptor = await this._readDescriptor();
    const data = message?.data;
    const transcript = sanitizeLiveDubbingTranscript(data?.transcript);
    const relayRecord = this._syncTranscriptRelayRecord(descriptor);
    const transcriptSequence = data?.transcriptSequence;
    const hasCurrentEvent = hasExactSessionEvent(message, descriptor);
    const hasReservedRunningEvent = descriptor?.status === LIVE_DUBBING_STATUS.CONNECTING_PROVIDER
      && data?.sessionId === descriptor.sessionId
      && data?.providerId === descriptor.providerId
      && Number.isSafeInteger(data?.eventSequence)
      && data.eventSequence === descriptor.eventSequence + 1;
    const actionMatchesKind = transcript
      && ((message.action === LIVE_DUBBING_ACTIONS.ORIGINAL_TRANSCRIPT
        && transcript.kind === LIVE_DUBBING_ORIGINAL_TRANSCRIPT_KIND)
        || (message.action === LIVE_DUBBING_ACTIONS.TRANSLATED_TRANSCRIPT
          && transcript.kind !== LIVE_DUBBING_ORIGINAL_TRANSCRIPT_KIND));
    if (this._storageReadFailed()
      || this._storageDescriptorInvalid()
      || !descriptor
      || ![LIVE_DUBBING_STATUS.CONNECTING_PROVIDER, LIVE_DUBBING_STATUS.RUNNING]
        .includes(descriptor.status)
      || !transcript
      || !actionMatchesKind
      || (!hasCurrentEvent && !hasReservedRunningEvent)
      || !isValidLiveDubbingTranscriptSequence(transcriptSequence)
      || (Number.isSafeInteger(relayRecord?.lastTranscriptSequence)
        && transcriptSequence <= relayRecord.lastTranscriptSequence)) {
      return { success: false, error: 'LIVE_DUBBING_UNAUTHORIZED', ignored: true };
    }

    relayRecord.lastTranscriptSequence = transcriptSequence;
    const relaySessionId = descriptor.sessionId;
    // Latest-wins settlement fence: overlapping tab sends settle in promise
    // order, so an older transcript settling late must not overwrite newer
    // delivery state. Only the still-latest accepted transcript may mutate it.
    const relayTranscriptSequence = transcriptSequence;

    try {
      const deliveryResponse = await this.runtimeGateway.sendTabMessage(descriptor.tabId, {
        action: message.action,
        data: {
          sessionId: descriptor.sessionId,
          providerId: descriptor.providerId,
          eventSequence: descriptor.eventSequence,
          transcriptSequence,
          transcript,
        },
      }, { frameId: 0 });
      // Only an explicitly accepted Content response confirms delivery. A
      // content rejection (accepted:false, or any non-accepted shape) is
      // unavailable delivery, handled exactly like a send failure below.
      // Only boolean acceptance is observed; the raw response never enters
      // state, logs, notifications, or persistence.
      const deliveryAccepted = deliveryResponse?.accepted === true;
      const isStillLatest = this.transcriptRelayRecord?.sessionId === relaySessionId
        && this.transcriptRelayRecord.lastTranscriptSequence === relayTranscriptSequence;
      if (deliveryAccepted) {
        if (isStillLatest && this.transcriptRelayRecord.deliveryUnavailable === true) {
          this.transcriptRelayRecord.deliveryUnavailable = false;
          void this._notifyTranscriptDeliveryChanged(relaySessionId);
        }
      } else if (isStillLatest && this.transcriptRelayRecord.deliveryUnavailable !== true) {
        this.transcriptRelayRecord.deliveryUnavailable = true;
        void this._notifyTranscriptDeliveryChanged(relaySessionId);
      }
    } catch {
      // Tab delivery is best effort and cannot affect the session lifecycle.
      if (this.transcriptRelayRecord?.sessionId === relaySessionId
        && this.transcriptRelayRecord.lastTranscriptSequence === relayTranscriptSequence
        && this.transcriptRelayRecord.deliveryUnavailable !== true) {
        this.transcriptRelayRecord.deliveryUnavailable = true;
        void this._notifyTranscriptDeliveryChanged(relaySessionId);
      }
    }

    return { success: true };
  }

  /**
   * Authorize messages emitted by the offscreen document before terminal or
   * bootstrap work reaches session coordination. Terminal events use the
   * owned session identity; bootstrap requests use the descriptor sequence
   * and are one-time per session.
   */
  async authorizeOffscreenControlMessage(message = {}, sender, { type = 'terminal' } = {}) {
    if (!isAuthorizedOffscreenSender(sender, this.browserAPI)) return null;

    if (type === 'terminal') return this._authorizeTerminalRequest(message);

    // Bootstrap requests are part of the provider response currently awaited
    // by start(). They must use the already-persisted in-memory fence instead
    // of waiting behind that same transition.
    if (type === 'bootstrap') return this._authorizeBootstrapRequest(message);

    return this._enqueue(async () => {
      const descriptor = await this._readDescriptor();
      if (this._storageReadFailed() || this._storageDescriptorInvalid()) return null;
      if (!hasExactSessionEvent(message, descriptor)) return null;

      return cloneDescriptor(descriptor);
    });
  }

  /**
   * Terminal events are fenced by the owned session identity only. Offscreen
   * terminal notifications can arrive from an earlier audio event sequence;
   * stop ownership, not that sequence, decides whether they are actionable.
   */
  _authorizeTerminalRequest(message) {
    const descriptor = this.descriptor;
    const data = message?.data || message;
    if (this.storageState !== LIVE_DUBBING_STORAGE_STATE.PRESENT
      || !descriptor
      || data.sessionId !== descriptor.sessionId
      || data.providerId !== descriptor.providerId
      || this.sessionRegistry.hasTerminalOperation(descriptor.sessionId)) {
      return null;
    }

    let state = this.sessionRegistry.getSessionState(descriptor.sessionId);
    if (state?.terminalRequested) return null;
    if (!state) {
      state = {
        descriptor,
        leasePromise: null,
        leaseAcquired: this._hasLiveLease(descriptor.sessionId),
        prepared: true,
        terminalRequested: false,
        cleanupCompleted: false,
        providerDiagnostic: null,
      };
      this.sessionRegistry.setSessionState(descriptor.sessionId, state);
    }

    this._markTerminalState(state);
    return cloneDescriptor(descriptor);
  }

  /**
   * Validate and reserve the one bootstrap request without entering the
   * transition queue. This synchronous section is the atomic active-session
   * fence for the CONNECTING_PROVIDER start transaction.
   */
  _authorizeBootstrapRequest(message) {
    const descriptor = this.descriptor;
    const data = message?.data || message;
    const state = descriptor?.sessionId
      ? this.sessionRegistry.getSessionState(descriptor.sessionId)
      : null;

    if (this.storageState !== LIVE_DUBBING_STORAGE_STATE.PRESENT
      || !descriptor
      || message?.action !== LIVE_DUBBING_ACTIONS.REQUEST_PROVIDER_BOOTSTRAP
      || descriptor.status !== LIVE_DUBBING_STATUS.CONNECTING_PROVIDER
      || !state
      || state.terminalRequested
      || this.sessionRegistry.hasTerminalOperation(descriptor.sessionId)
      || !this._isSameDescriptorFence(state.descriptor, descriptor)
      || !hasExactSessionEvent(message, descriptor)
      || data.providerId !== descriptor.providerId
      || data.targetLanguage !== descriptor.targetLanguage
      || this.sessionRegistry.hasBootstrapSession(descriptor.sessionId)) {
      return null;
    }

    this.sessionRegistry.reserveBootstrapSession(descriptor.sessionId);
    return cloneDescriptor(descriptor);
  }

  /**
   * Recheck the fence after bootstrap resolution. A stop or terminal event
   * can win while the key manager is awaiting, so the key must not be sent
   * after ownership has changed.
   */
  isBootstrapRequestStillAuthorized(descriptor) {
    if (!descriptor?.sessionId) return false;

    const current = this.descriptor;
    const state = this.sessionRegistry.getSessionState(descriptor.sessionId);
    return this.storageState === LIVE_DUBBING_STORAGE_STATE.PRESENT
      && current?.status === LIVE_DUBBING_STATUS.CONNECTING_PROVIDER
      && this._isSameDescriptorFence(current, descriptor)
      && this._isSameDescriptorFence(state?.descriptor, descriptor)
      && !state?.terminalRequested
      && !this.sessionRegistry.hasTerminalOperation(descriptor.sessionId)
      && isLiveDubbingProviderId(descriptor.providerId)
      && this.sessionRegistry.hasBootstrapSession(descriptor.sessionId);
  }

  /**
   * Reconcile session metadata after service-worker restart.
   * Cleanup always uses a concrete session identity.
   */
  reconcile() {
    return this._enqueue(() => this._reconcile());
  }

  _enqueue(operation) {
    const next = this.transition.then(operation, operation);
    this.transition = next.catch(() => {});
    return next;
  }

  async _start(message, sender, pendingStart) {
    let timeoutId;
    const transaction = this._startTransaction(message, sender, pendingStart);
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        pendingStart.terminalRequested = true;
        const state = this.sessionRegistry.getSessionState(pendingStart.sessionId);
        if (state) this._markTerminalState(state);
        reject(new Error('LIVE_DUBBING_START_TIMEOUT'));
      }, LIVE_DUBBING_START_TIMEOUT);
    });

    try {
      return await Promise.race([transaction, timeout]);
    } catch (error) {
      if (error?.message !== 'LIVE_DUBBING_START_TIMEOUT') throw error;
      const state = this.sessionRegistry.getSessionState(pendingStart.sessionId);
      if (!state) return { success: false, error: 'LIVE_DUBBING_START_TIMEOUT' };

      const cleanupDescriptor = state.descriptor;
      if (this.descriptor?.sessionId === cleanupDescriptor.sessionId) {
        this._relayTranscriptClear(cleanupDescriptor);
      }
      const cleanup = await this._awaitCleanup(
        this.cleanupManager.disposeAndRelease(cleanupDescriptor),
        cleanupDescriptor,
      );
      if (!cleanup.success) {
        return {
          success: false,
          error: 'LIVE_DUBBING_START_TIMEOUT',
          retryable: true,
          cleanupPending: true,
          status: cloneDescriptor(this.descriptor || state.descriptor),
        };
      }
      const cleared = await this._clearDescriptor(state.descriptor.sessionId);
      if (cleared.outcome === LIVE_DUBBING_CLEAR_OUTCOMES.STORAGE_FAILURE) {
        return this._storageClearFailure(state.descriptor, 'LIVE_DUBBING_START_TIMEOUT');
      }
      if (cleared.outcome === LIVE_DUBBING_CLEAR_OUTCOMES.SESSION_MISMATCH) {
        this._forgetSessionState(state.descriptor.sessionId, state);
        return {
          success: false,
          error: 'LIVE_DUBBING_START_TIMEOUT',
          ignored: true,
          status: cloneDescriptor(this.descriptor),
        };
      }
      this._forgetSessionState(state.descriptor.sessionId, state);
      return { success: false, error: 'LIVE_DUBBING_START_TIMEOUT' };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async _startTransaction(message, sender, pendingStart) {
    const providerId = pendingStart.providerId;
    if (!isLiveDubbingProviderId(providerId)) {
      return { success: false, error: 'LIVE_DUBBING_PROVIDER_UNSUPPORTED' };
    }

    const targetLanguage = this._getTargetLanguage(message);
    let normalizedLanguage;
    try {
      normalizedLanguage = normalizeProviderTargetLanguage(providerId, targetLanguage);
    } catch {
      return { success: false, error: 'INVALID_TARGET_LANGUAGE' };
    }

    const current = await this._readDescriptor();
    if (this._storageReadFailed()) return this._storageReadFailure();
    if (this._storageDescriptorInvalid()) return this._storageDescriptorFailure();
    if (current) {
      return {
        success: false,
        busy: true,
        status: cloneDescriptor(current),
        current: cloneDescriptor(current),
      };
    }

    // Complete any terminal outcome write before a new lifecycle can start.
    // This keeps a late old write ahead of the final RUNNING+clear commit.
    await this.stateStore.awaitOutcomeMutations();
    const currentAfterOutcome = await this._readDescriptor();
    if (this._storageReadFailed()) return this._storageReadFailure();
    if (this._storageDescriptorInvalid()) return this._storageDescriptorFailure();
    if (currentAfterOutcome) {
      return {
        success: false,
        busy: true,
        status: cloneDescriptor(currentAfterOutcome),
        current: cloneDescriptor(currentAfterOutcome),
      };
    }

    if (pendingStart.terminalRequested) {
      return { success: false, error: 'LIVE_DUBBING_START_CANCELLED' };
    }

    let credentialsConfigured = false;
    try {
      credentialsConfigured = await this.hasConfiguredCredentials(providerId);
    } catch {
      credentialsConfigured = false;
    }
    if (credentialsConfigured !== true) {
      return { success: false, error: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE' };
    }
    if (pendingStart.terminalRequested) {
      return { success: false, error: 'LIVE_DUBBING_START_CANCELLED' };
    }

    let offscreenSupported = true;
    if (typeof this.leaseManager.supportsOffscreenDocument === 'function') {
      try {
        offscreenSupported = this.leaseManager.supportsOffscreenDocument() === true;
      } catch {
        offscreenSupported = false;
      }
    }
    if (!offscreenSupported) {
      return { success: false, error: 'LIVE_DUBBING_UNSUPPORTED' };
    }

    const tab = await this.runtimeGateway.resolveTabFromSender(sender);
    if (pendingStart && Number.isInteger(tab?.id) && tab.id >= 0) {
      pendingStart.tabId = tab.id;
      if (pendingStart.tabEventIds.has(tab.id)) pendingStart.terminalRequested = true;
    }
    if (pendingStart.terminalRequested) {
      return { success: false, error: 'LIVE_DUBBING_START_CANCELLED' };
    }
    if (!tab || !Number.isInteger(tab.id) || tab.id < 0) {
      return { success: false, error: 'TARGET_TAB_UNAVAILABLE' };
    }

    if (!this.runtimeGateway.supportsTabCapture()) {
      return { success: false, error: 'TAB_CAPTURE_UNAVAILABLE' };
    }

    const descriptor = createDescriptor({
      sessionId: pendingStart.sessionId,
      tabId: tab.id,
      providerId,
      targetLanguage: normalizedLanguage,
      startedAt: pendingStart.startedAt,
    });
    const sessionState = {
      descriptor,
      leasePromise: null,
      leaseAcquired: false,
      prepared: false,
      terminalRequested: false,
      cleanupCompleted: false,
      providerDiagnostic: null,
    };
    this.sessionRegistry.setSessionState(descriptor.sessionId, sessionState);
    if (!await this._writeDescriptor(descriptor)) {
      this._forgetSessionState(descriptor.sessionId, sessionState);
      return this._storageWriteFailure();
    }

    if (pendingStart.terminalRequested || sessionState.terminalRequested) {
      this._markTerminalState(sessionState);
      sessionState.cleanupCompleted = true;
      const cleared = await this._clearDescriptor(descriptor.sessionId);
      if (cleared.outcome === LIVE_DUBBING_CLEAR_OUTCOMES.CLEARED) {
        this._forgetSessionState(descriptor.sessionId, sessionState);
        return { success: false, error: 'LIVE_DUBBING_START_CANCELLED' };
      }
      if (cleared.outcome === LIVE_DUBBING_CLEAR_OUTCOMES.SESSION_MISMATCH) {
        this._forgetSessionState(descriptor.sessionId, sessionState);
        return {
          success: false,
          error: 'LIVE_DUBBING_START_CANCELLED',
          ignored: true,
          status: cloneDescriptor(this.descriptor),
        };
      }
      return this._storageClearFailure(descriptor);
    }

    let leaseAcquired = false;
    let providerStartAttempted = false;
    try {
      sessionState.leasePromise = Promise.resolve(this.leaseManager.acquire({
        owner: LIVE_DUBBING_OWNER,
        leaseId: descriptor.sessionId,
        requiredReasons: getLeaseReasons(descriptor.providerId),
      }));
      leaseAcquired = await sessionState.leasePromise;
      sessionState.leaseAcquired = leaseAcquired;
      if (!leaseAcquired) throw new Error('offscreen lease unavailable');

      if (sessionState.terminalRequested) throw new Error('live dubbing terminal requested');
      // Fresh persisted volume preferences seed the offscreen session's
      // runtime authorities. Read here (never from a UI store) so START from
      // any context observes the latest values; volumes stay out of the
      // persisted descriptor and never move the event sequence.
      const initialVolumes = await this._readVolumePreferences();
      const prepareResponse = await this._sendCaptureStage(
        LIVE_DUBBING_CAPTURE_STAGES.OFFSCREEN_PREPARE,
        createPrepareMessage(descriptor, initialVolumes),
      );
      if (!isAcknowledgedForSession(prepareResponse, 'READY', descriptor.sessionId, descriptor.providerId)) {
        throw createCaptureStageFailure(
          LIVE_DUBBING_CAPTURE_STAGES.OFFSCREEN_PREPARE,
          null,
          createResponseDiagnostic(LIVE_DUBBING_CAPTURE_STAGES.OFFSCREEN_PREPARE, prepareResponse),
        );
      }
      if (prepareResponse.eventSequence !== descriptor.eventSequence) {
        throw createCaptureStageFailure(
          LIVE_DUBBING_CAPTURE_STAGES.OFFSCREEN_PREPARE,
          null,
          createResponseDiagnostic(LIVE_DUBBING_CAPTURE_STAGES.OFFSCREEN_PREPARE, {
            error: 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH',
          }),
        );
      }
      sessionState.prepared = true;
      if (sessionState.terminalRequested) throw new Error('live dubbing terminal requested');

      // Reserve the capture fence before offscreen starts getUserMedia or
      // pipeline setup. The offscreen controller adopts this next sequence
      // atomically at the start of CONSUME.
      const captureDescriptor = this._advance(descriptor, LIVE_DUBBING_STATUS.PREPARING_CAPTURE);
      if (!await this._writeDescriptor(captureDescriptor, descriptor.sessionId, descriptor)) {
        throw new Error('Live dubbing descriptor persistence failed');
      }
      sessionState.descriptor = captureDescriptor;
      if (sessionState.terminalRequested) throw new Error('live dubbing terminal requested');

      // Keep stream ID ephemeral. It is forwarded in exactly one targeted message.
      let streamId;
      try {
        streamId = await this.runtimeGateway.getMediaStreamId(captureDescriptor.tabId);
        if (typeof streamId !== 'string' || !streamId) {
          throw new TypeError('getMediaStreamId returned no stream ID');
        }
      } catch (error) {
        throw createCaptureStageFailure(
          LIVE_DUBBING_CAPTURE_STAGES.GET_MEDIA_STREAM_ID,
          error,
        );
      }
      if (sessionState.terminalRequested) throw new Error('live dubbing terminal requested');
      const consumeMessage = createConsumeMessage(captureDescriptor, streamId);
      const consumeResponse = await this._sendCaptureStage(
        LIVE_DUBBING_CAPTURE_STAGES.OFFSCREEN_GET_USER_MEDIA,
        consumeMessage,
        [streamId],
      );
      if (!isAcknowledgedForSession(consumeResponse, 'MEDIA_ACQUIRED', descriptor.sessionId, descriptor.providerId)) {
        throw createCaptureStageFailure(
          LIVE_DUBBING_CAPTURE_STAGES.OFFSCREEN_GET_USER_MEDIA,
          null,
          createResponseDiagnostic(
            LIVE_DUBBING_CAPTURE_STAGES.OFFSCREEN_GET_USER_MEDIA,
            consumeResponse,
            [streamId],
          ),
        );
      }
      if (sessionState.terminalRequested) throw new Error('live dubbing terminal requested');

      // Stage 2 returns CONNECTING_PROVIDER only after capture and both local
      // graphs exist. Persist that fence before the offscreen document asks
      // background for the short-lived provider bootstrap.
      const integratedPipelines = consumeResponse.status === LIVE_DUBBING_STATUS.CONNECTING_PROVIDER
        && consumeResponse.captureReady === true
        && consumeResponse.audioPathReady === true
        && consumeResponse.eventSequence === captureDescriptor.eventSequence;
      let activeDescriptor = descriptor;
      if (integratedPipelines) {
        const connectingDescriptor = this._advance(
          captureDescriptor,
          LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
          null,
          captureDescriptor.eventSequence + 1,
        );
        if (!await this._writeDescriptor(
          connectingDescriptor,
          descriptor.sessionId,
          captureDescriptor,
        )) {
          throw new Error('Live dubbing descriptor persistence failed');
        }
        sessionState.descriptor = connectingDescriptor;
        if (sessionState.terminalRequested) throw new Error('live dubbing terminal requested');

        providerStartAttempted = true;
        const providerResponse = await this._sendOffscreen(createProviderConnectMessage(connectingDescriptor));
        this._latchProviderDiagnostic(sessionState, providerResponse?.providerDiagnostic);
        const providerReady = isAcknowledgedForSession(
          providerResponse,
          'PROVIDER_READY',
          descriptor.sessionId,
          descriptor.providerId,
        )
          && providerResponse.status === LIVE_DUBBING_STATUS.RUNNING
          && providerResponse.captureReady === true
          && providerResponse.audioPathReady === true
          && providerResponse.setupComplete === true
          && providerResponse.eventSequence === connectingDescriptor.eventSequence + 1;
        if (!providerReady) {
          this._latchProviderDiagnostic(sessionState, createLiveDubbingProviderDiagnostic({
            code: typeof providerResponse?.error === 'string'
              ? providerResponse.error
              : 'LIVE_DUBBING_PROVIDER_SETUP_FAILED',
            terminalCategory: 'PROVIDER_SETUP_FAILED',
            setupComplete: providerResponse?.setupComplete === true,
          }));
          throw new Error('Live dubbing provider setup failed');
        }
        if (sessionState.terminalRequested) throw new Error('live dubbing terminal requested');
        activeDescriptor = this._advance(
          connectingDescriptor,
          LIVE_DUBBING_STATUS.RUNNING,
          null,
          providerResponse.eventSequence,
        );
        if (!this._reserveVolumeEventSequence(
          connectingDescriptor,
          providerResponse.eventSequence,
        )) {
          throw new Error('Live dubbing volume sequence reservation failed');
        }
      } else {
        throw new Error('Live dubbing audio pipelines are not ready');
      }
      try {
        if (!await this._writeDescriptor(
          activeDescriptor,
          descriptor.sessionId,
          sessionState.descriptor,
          { clearOutcome: true },
        )) {
          throw new Error('Live dubbing descriptor persistence failed');
        }
        sessionState.descriptor = activeDescriptor;
      } finally {
        this._clearVolumeEventSequenceReservation(
          descriptor.sessionId,
          descriptor.providerId,
        );
      }
      if (sessionState.terminalRequested) throw new Error('live dubbing terminal requested');
      return { success: true, status: cloneDescriptor(activeDescriptor) };
    } catch (error) {
      this._clearVolumeEventSequenceReservation(descriptor.sessionId, descriptor.providerId);
      const diagnostic = error?.captureDiagnostic || null;
      let providerDiagnostic = this._latchProviderDiagnostic(
        sessionState,
        error?.providerDiagnostic,
      );
      if (providerStartAttempted && !providerDiagnostic && !sessionState.terminalRequested) {
        providerDiagnostic = this._latchProviderDiagnostic(
          sessionState,
          createLiveDubbingProviderDiagnostic({
            code: 'LIVE_DUBBING_PROVIDER_START_FAILED',
            terminalCategory: 'PROVIDER_START_FAILED',
          }),
        );
      }
      if (diagnostic) this.log.warn('Live dubbing capture failed', diagnostic);
      if (providerDiagnostic) {
        this.log.warn('Live dubbing provider startup failed', providerDiagnostic);
      }
      const failureCode = this._classifyStartFailure({ error, providerDiagnostic, providerStartAttempted });
      if (!sessionState.terminalRequested) {
        const failedBase = sessionState.descriptor || descriptor;
        const failedDescriptor = this._advance(failedBase, LIVE_DUBBING_STATUS.ERROR, failureCode);
        await this._writeDescriptor(
          failedDescriptor,
          descriptor.sessionId,
          failedBase,
        ).catch(() => {});
      }

      const cleanupDescriptor = sessionState.descriptor || descriptor;
      if (this.descriptor?.sessionId === cleanupDescriptor.sessionId) {
        this._relayTranscriptClear(cleanupDescriptor);
      }
      const cleanup = sessionState.cleanupCompleted
        ? { success: true }
        : leaseAcquired || sessionState.prepared || sessionState.terminalRequested
        ? await this._awaitCleanup(
          this.cleanupManager.disposeAndRelease(cleanupDescriptor),
          cleanupDescriptor,
        )
        : { success: true };

      if (!cleanup.success) {
        this.log.warn('Live dubbing cleanup remains pending');
        return {
          success: false,
          error: failureCode,
          retryable: true,
          cleanupPending: true,
          ...(providerDiagnostic ? { providerDiagnostic } : {}),
        };
      }

      const cleared = await this._clearDescriptor(descriptor.sessionId);
      if (cleared.outcome === LIVE_DUBBING_CLEAR_OUTCOMES.STORAGE_FAILURE) {
        return {
          ...this._storageClearFailure(descriptor, failureCode),
          ...(providerDiagnostic ? { providerDiagnostic } : {}),
        };
      }
      if (cleared.outcome === LIVE_DUBBING_CLEAR_OUTCOMES.SESSION_MISMATCH) {
        this._forgetSessionState(descriptor.sessionId, sessionState);
        return {
          success: false,
          error: failureCode,
          ignored: true,
          status: cloneDescriptor(this.descriptor),
          ...(providerDiagnostic ? { providerDiagnostic } : {}),
        };
      }
      this._forgetSessionState(descriptor.sessionId, sessionState);
      return {
        success: false,
        error: failureCode,
        ...(providerDiagnostic ? { providerDiagnostic } : {}),
      };
    } finally {
      if (this.sessionRegistry.isSessionState(descriptor.sessionId, sessionState)) {
        sessionState.leasePromise = null;
      }
    }
  }

  async _stop(message) {
    const current = await this._readDescriptor();
    if (this._storageReadFailed()) return this._storageReadFailure();
    if (this._storageDescriptorInvalid()) return this._storageDescriptorFailure();
    const sessionId = message?.data?.sessionId || message?.sessionId;
    if (!current) {
      const pending = this._findPendingStart(sessionId);
      if (pending) {
        pending.terminalRequested = true;
        return { success: true, stopped: false, pending: true, status: null };
      }
      return { success: true, stopped: false, idempotent: true, status: null };
    }

    if (sessionId !== current.sessionId) {
      return { success: true, stopped: false, ignored: true, status: cloneDescriptor(current) };
    }

    return this._stopDescriptor(current, 'STOP_REQUESTED');
  }

  async _stopForSession(sessionId, reason, expectedDescriptor = null, expectedState = null, options = {}) {
    const current = await this._readDescriptor();
    if (this._storageReadFailed()) return this._storageReadFailure();
    if (this._storageDescriptorInvalid()) return this._storageDescriptorFailure();
    if (!current) {
      if (expectedDescriptor || expectedState) {
        return { success: true, stopped: false, ignored: true, status: null, reason };
      }
      const pending = this._findPendingStart(sessionId);
      if (pending) {
        pending.terminalRequested = true;
        return { success: true, stopped: false, pending: true, status: null, reason };
      }
      return { success: true, stopped: false, ignored: true, status: null };
    }

    if (current.sessionId !== sessionId) {
      return { success: true, stopped: false, ignored: true, status: cloneDescriptor(current) };
    }

    if ((expectedState && !this.sessionRegistry.isSessionState(sessionId, expectedState))
      || (expectedDescriptor && !this._isSameDescriptorFence(current, expectedDescriptor))) {
      return { success: true, stopped: false, ignored: true, status: cloneDescriptor(current), reason };
    }

    return this._stopDescriptor(current, reason, options);
  }

  async _stopForTab(tabId, reason) {
    if (!Number.isInteger(tabId) || tabId < 0) return { success: true, stopped: false };

    const current = await this._readDescriptor();
    if (this._storageReadFailed()) return this._storageReadFailure();
    if (this._storageDescriptorInvalid()) return this._storageDescriptorFailure();
    if (!current || current.tabId !== tabId) {
      if (!current) {
        const pending = this._findPendingStart(null, tabId);
        if (pending) {
          pending.terminalRequested = true;
        }
        const unresolved = this.sessionRegistry.listUnresolvedPendingStarts();
        for (const pendingStart of unresolved) {
          pendingStart.tabEventIds.add(tabId);
        }
        if (pending || unresolved.length > 0) {
          return { success: true, stopped: false, pending: true, status: null, reason };
        }
      }
      return { success: true, stopped: false, ignored: true };
    }

    return this._stopDescriptor(current, reason);
  }

  async _stopDescriptor(descriptor, reason, options = {}) {
    const cleanupFailureError = options?.cleanupFailureError || null;
    const terminalizeRuntimeLoss = options?.terminalizeRuntimeLoss === true;
    const allowedStartupCodes = new Set([
      'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE',
      'LIVE_DUBBING_PROVIDER_SETUP_FAILED',
      'LIVE_DUBBING_START_FAILED',
    ]);
    const retainedStartupError = allowedStartupCodes.has(cleanupFailureError) ? cleanupFailureError : null;
    const currentState = this.sessionRegistry.getSessionState(descriptor.sessionId);
    const existingTerminal = this.sessionRegistry.getTerminalOperation(descriptor.sessionId);
    if (existingTerminal?.providerId === descriptor.providerId
      && existingTerminal.state === currentState) {
      return this._awaitStop(existingTerminal, descriptor, reason);
    }

    let state = currentState;
    if (!state) {
      state = {
        descriptor,
        leasePromise: null,
        leaseAcquired: this._hasLiveLease(descriptor.sessionId),
        prepared: true,
        terminalRequested: false,
        cleanupCompleted: false,
        providerDiagnostic: null,
      };
      this.sessionRegistry.setSessionState(descriptor.sessionId, state);
    }
    this._markTerminalState(state);

    const terminalRecord = {
      sessionId: descriptor.sessionId,
      providerId: descriptor.providerId,
      state,
      cleanupAttempt: null,
      promise: null,
    };
    const terminalOperation = (async () => {
      let notifyRuntimeLossOutcome = null;
      if (terminalizeRuntimeLoss) {
        if (!state.runtimeLossOutcomePersisted) {
          const outcome = createLiveDubbingTerminalOutcome({
            sourceSessionId: descriptor.sessionId,
            providerId: descriptor.providerId,
            error: 'LIVE_DUBBING_OFFSCREEN_LOST',
            occurredAt: this.now(),
            providerDiagnostic: null,
          });
          const persisted = await this._queueOutcomeMutation(
            () => this._writeTerminalOutcome(outcome),
          );
          if (persisted) state.runtimeLossOutcomePersisted = true;
        }

        if (state.runtimeLossOutcomePersisted) {
          notifyRuntimeLossOutcome = async () => {
            if (state.runtimeLossOutcomeNotified) return;
            state.runtimeLossOutcomeNotified = true;
            await this._notifyTerminalOutcome(
              toPublicLiveDubbingTerminalOutcome(this.terminalOutcome),
            );
          };
        }
      }

      const clearTerminalDescriptor = async () => {
        this._relayTranscriptClear(descriptor);
        const cleared = await this._clearDescriptor(descriptor.sessionId);
        if (cleared.outcome === LIVE_DUBBING_CLEAR_OUTCOMES.CLEARED) {
          await notifyRuntimeLossOutcome?.();
          this._forgetSessionState(descriptor.sessionId, state);
          return { success: true, stopped: true, status: null, reason };
        }
        if (cleared.outcome === LIVE_DUBBING_CLEAR_OUTCOMES.SESSION_MISMATCH) {
          this._forgetSessionState(descriptor.sessionId, state);
          return {
            success: true,
            stopped: false,
            ignored: true,
            status: cloneDescriptor(this.descriptor),
            reason,
          };
        }
        await notifyRuntimeLossOutcome?.();
        return this._storageClearFailure(descriptor);
      };

      if (state.cleanupCompleted) {
        if (!this.sessionRegistry.isSessionState(descriptor.sessionId, state)) {
          return {
            success: true,
            stopped: false,
            ignored: true,
            status: cloneDescriptor(this.descriptor),
            reason,
          };
        }
        return clearTerminalDescriptor();
      }

      const provenAbsenceLease = terminalizeRuntimeLoss
        && options.runtimeAbsent === true
        && this._hasLiveLease(descriptor.sessionId);
      if (terminalizeRuntimeLoss
        && !provenAbsenceLease
        && (options.skipCleanup === true || options.runtimeAbsent === true)) {
        state.cleanupCompleted = true;
        return clearTerminalDescriptor();
      }

      const stopping = this._advance(descriptor, LIVE_DUBBING_STATUS.STOPPING);
      // STOPPING is an observability marker; actual storage failure cannot block
      // exact cleanup, while a readable fence rejection must remain a no-op.
      const stoppingPersisted = await this._writeDescriptor(stopping, descriptor.sessionId, descriptor);
      if (!stoppingPersisted && !this._storageReadFailed()) return this._storageWriteFailure();
      const cleanupPromise = provenAbsenceLease
        ? this.cleanupManager.releaseAfterProvenAbsence(descriptor, { releaseLease: true })
        : this.cleanupManager.disposeAndRelease(descriptor, {
          releaseLease: state ? undefined : this._hasLiveLease(descriptor.sessionId),
        });
      terminalRecord.cleanupAttempt = this.cleanupManager.getAttempt(descriptor.sessionId) || null;
      const cleanup = await cleanupPromise;
      if (!this.sessionRegistry.isSessionState(descriptor.sessionId, state)) {
        return {
          success: true,
          stopped: false,
          ignored: true,
          status: cloneDescriptor(this.descriptor),
          reason,
        };
      }
      if (!cleanup.success) {
        const failedLastError = retainedStartupError || 'STOP_FAILED';
        const cleanupFence = stoppingPersisted ? stopping : descriptor;
        const failed = this._advance(cleanupFence, LIVE_DUBBING_STATUS.ERROR, failedLastError);
        await this._writeDescriptor(failed, descriptor.sessionId, cleanupFence).catch(() => {});
        await notifyRuntimeLossOutcome?.();
        return {
          success: false,
          error: 'STOP_FAILED',
          retryable: true,
          cleanupPending: true,
          status: cloneDescriptor(this.descriptor || stopping),
        };
      }

      return clearTerminalDescriptor();
    })();

    terminalRecord.promise = terminalOperation;
    this.sessionRegistry.setTerminalOperation(descriptor.sessionId, terminalRecord);
    terminalOperation.then(
      () => {
        this.sessionRegistry.deleteTerminalOperation(descriptor.sessionId, terminalRecord);
      },
      () => {
        this.sessionRegistry.deleteTerminalOperation(descriptor.sessionId, terminalRecord);
      },
    );
    return this._awaitStop(terminalRecord, descriptor, reason);
  }

  _awaitStop(record, descriptor, reason) {
    const operation = record.promise;
    let timeoutId;
    const timeout = new Promise(resolve => {
      timeoutId = setTimeout(() => {
        this.sessionRegistry.deleteTerminalOperation(descriptor.sessionId, record);
        const cleanup = record.cleanupAttempt;
        if (cleanup) {
          this.cleanupManager.abandonAttempt(descriptor.sessionId, cleanup);
        }
        resolve({
          success: false,
          error: 'LIVE_DUBBING_STOP_TIMEOUT',
          retryable: true,
          cleanupPending: true,
          status: cloneDescriptor(this.descriptor || descriptor),
          reason,
        });
      }, LIVE_DUBBING_STOP_TIMEOUT);
    });

    return Promise.race([operation, timeout]).finally(() => clearTimeout(timeoutId));
  }

  _awaitCleanup(operation, descriptor) {
    const attempt = descriptor ? this.cleanupManager.getAttempt(descriptor.sessionId) : null;
    let timeoutId;
    const timeout = new Promise(resolve => {
      timeoutId = setTimeout(() => {
        if (attempt?.promise === operation) {
          this.cleanupManager.abandonAttempt(descriptor.sessionId, attempt);
        }
        resolve({
          success: false,
          retryable: true,
          cleanupPending: true,
        });
      }, LIVE_DUBBING_STOP_TIMEOUT);
    });

    return Promise.race([operation, timeout]).finally(() => clearTimeout(timeoutId));
  }

  async _reconcileRuntimeLoss(descriptor) {
    const current = await this._readDescriptor();
    if (this._storageReadFailed()) return this._storageReadFailure();
    if (this._storageDescriptorInvalid()) return this._storageDescriptorFailure();
    if (!this._isSameDescriptorFence(current, descriptor)) {
      return {
        success: true,
        stopped: false,
        ignored: true,
        status: cloneDescriptor(current),
        stale: true,
        recovered: false,
      };
    }

    const result = await this._stopDescriptor(current, 'RECONCILE_OFFSCREEN_LOST', {
      terminalizeRuntimeLoss: true,
      runtimeAbsent: true,
      skipCleanup: true,
    });
    if (result.success === true && result.stopped === true) {
      return {
        success: true,
        status: null,
        stale: true,
        recovered: false,
        retryable: false,
      };
    }
    return {
      ...result,
      stale: true,
      recovered: false,
    };
  }

  async _reconcile() {
    const descriptor = await this._readDescriptor();
    if (this._storageReadFailed()) return this._storageReadFailure();
    if (this._storageDescriptorInvalid()) return this._storageDescriptorFailure();
    const terminalState = descriptor && this.sessionRegistry.getSessionState(descriptor.sessionId);
    if (terminalState?.terminalRequested && terminalState.cleanupCompleted) {
      const cleanupRetry = await this._stopDescriptor(descriptor, 'RECONCILE_CLEANUP');
      return {
        ...cleanupRetry,
        stale: cleanupRetry.success || cleanupRetry.cleanupPending === true,
        recovered: false,
      };
    }
    try {
      await this.leaseManager.ensureDocument?.();
    } catch {
      // Reconciliation is best effort; retain descriptor for next worker start.
    }

    const snapshot = this.leaseManager.getSnapshot?.() || { activeLeases: [] };
    const leases = snapshot.activeLeases || snapshot.leases || [];

    const liveLeases = leases.filter(item => item.owner === LIVE_DUBBING_OWNER
      && typeof item.leaseId === 'string' && item.leaseId.trim());

    if (!descriptor) {
      let cleaned = true;
      let cleanupPending = false;
      for (const lease of liveLeases) {
        const result = await this._reconcileLease(lease, true);
        cleaned = result.success === true && cleaned;
        cleanupPending = cleanupPending || result.cleanupPending === true;
      }
      return {
        success: cleaned,
        status: null,
        recovered: false,
        stale: liveLeases.length > 0,
        ...(liveLeases.length > 0 && !cleaned
          ? {
            providerIdentityRequired: true,
            retryable: true,
            ...(cleanupPending ? { cleanupPending: true } : {}),
          }
          : {}),
      };
    }

    let matchingLease = liveLeases.find(item => item.leaseId === descriptor.sessionId);
    if (snapshot.documentExists === false && descriptor.status === LIVE_DUBBING_STATUS.RUNNING) {
      return this._reconcileRuntimeLoss(descriptor);
    }
    if (snapshot.documentExists === false && !matchingLease) {
      const cleared = await this._clearDescriptor(descriptor.sessionId);
      if (cleared.outcome === LIVE_DUBBING_CLEAR_OUTCOMES.CLEARED) {
        this._forgetSessionState(descriptor.sessionId);
        return {
          success: true,
          status: null,
          stale: true,
          recovered: false,
          retryable: false,
        };
      }
      if (cleared.outcome === LIVE_DUBBING_CLEAR_OUTCOMES.SESSION_MISMATCH) {
        this._forgetSessionState(descriptor.sessionId);
        return {
          success: true,
          stopped: false,
          ignored: true,
          status: cloneDescriptor(this.descriptor),
          stale: true,
          recovered: false,
        };
      }
      return {
        success: false,
        status: cloneDescriptor(this.descriptor || descriptor),
        stale: true,
        recovered: false,
        retryable: true,
        cleanupPending: true,
      };
    }

    const descriptorStatus = await this._queryStatus(
      descriptor,
      descriptor.sessionId,
      descriptor.providerId,
    );
    if (this._isSessionMismatch(descriptorStatus, descriptor.sessionId, descriptor.providerId)) {
      // Never dispose or release while offscreen reports another session.
      return {
        success: false,
        error: 'LIVE_DUBBING_SESSION_MISMATCH',
        status: cloneDescriptor(descriptor),
        recovered: false,
        retryable: true,
        isolated: true,
      };
    }

    if (this._isRecoverableRunningStatus(
      descriptorStatus,
      descriptor.sessionId,
      descriptor.providerId,
    )) {
      if (!matchingLease) {
        const acquired = await this._acquireRecoveryLease(descriptor);
        if (!acquired) {
          this._rememberReconciledSession(descriptor, false);
          const failed = this._advance(
            descriptor,
            LIVE_DUBBING_STATUS.ERROR,
            'LIVE_DUBBING_LEASE_ACQUIRE_FAILED',
          );
          await this._writeDescriptor(failed, descriptor.sessionId).catch(() => {});
          return {
            success: false,
            error: 'LIVE_DUBBING_LEASE_ACQUIRE_FAILED',
            status: cloneDescriptor(failed),
            recovered: false,
            retryable: true,
          };
        }
        matchingLease = {
          owner: LIVE_DUBBING_OWNER,
          leaseId: descriptor.sessionId,
        };
      }

      const activeDescriptor = descriptor.status === LIVE_DUBBING_STATUS.RUNNING
        ? descriptor
        : this._advance(descriptor, LIVE_DUBBING_STATUS.RUNNING);
      this._rememberReconciledSession(activeDescriptor, Boolean(matchingLease));

      const persisted = descriptor.status === LIVE_DUBBING_STATUS.RUNNING
        || await this._writeDescriptor(activeDescriptor, descriptor.sessionId);
      if (!persisted) {
        return {
          success: false,
          status: cloneDescriptor(descriptor),
          recovered: false,
          retryable: true,
        };
      }

      let unmatchedCleaned = true;
      let unmatchedCleanupPending = false;
      for (const lease of liveLeases.filter(item => item.leaseId !== descriptor.sessionId)) {
        const result = await this._reconcileLease(lease, true);
        unmatchedCleaned = result.success === true && unmatchedCleaned;
        unmatchedCleanupPending = unmatchedCleanupPending || result.cleanupPending === true;
      }
      if (!unmatchedCleaned) {
        return {
          success: false,
          status: cloneDescriptor(activeDescriptor),
          recovered: true,
          providerIdentityRequired: true,
          retryable: true,
          ...(unmatchedCleanupPending ? { cleanupPending: true } : {}),
        };
      }

      return {
        success: true,
        status: cloneDescriptor(activeDescriptor),
        recovered: true,
      };
    }

    const sessionAbsent = this._isProvablyAbsent(
      descriptorStatus,
      descriptor.sessionId,
      descriptor.providerId,
    );
    const exactStatus = this._isExactSessionStatus(
      descriptorStatus,
      descriptor.sessionId,
      descriptor.providerId,
    );
    if (descriptor.status === LIVE_DUBBING_STATUS.RUNNING && sessionAbsent) {
      return this._reconcileRuntimeLoss(descriptor);
    }

    const documentAndSessionAbsent = !matchingLease && sessionAbsent;
    if (documentAndSessionAbsent) {
      const cleared = await this._clearDescriptor(descriptor.sessionId);
      if (cleared.outcome === LIVE_DUBBING_CLEAR_OUTCOMES.CLEARED) {
        this._forgetSessionState(descriptor.sessionId);
        return {
          success: true,
          status: null,
          stale: true,
          recovered: false,
          retryable: false,
        };
      }
      if (cleared.outcome === LIVE_DUBBING_CLEAR_OUTCOMES.SESSION_MISMATCH) {
        this._forgetSessionState(descriptor.sessionId);
        return {
          success: true,
          stopped: false,
          ignored: true,
          status: cloneDescriptor(this.descriptor),
          stale: true,
          recovered: false,
        };
      }
      return {
        success: false,
        status: cloneDescriptor(this.descriptor || descriptor),
        stale: true,
        recovered: false,
        retryable: true,
        cleanupPending: true,
      };
    }

    if (descriptor.status === LIVE_DUBBING_STATUS.RUNNING && !exactStatus) {
      return {
        success: false,
        status: cloneDescriptor(descriptor),
        stale: true,
        recovered: false,
        retryable: true,
      };
    }

    this._rememberReconciledSession(descriptor, Boolean(matchingLease));
    const cleanup = await this._awaitCleanup(
      this.cleanupManager.disposeAndRelease(descriptor, {
        releaseLease: Boolean(matchingLease),
      }),
      descriptor,
    );
    if (cleanup.success) {
      const cleared = await this._clearDescriptor(descriptor.sessionId);
      if (cleared.outcome === LIVE_DUBBING_CLEAR_OUTCOMES.CLEARED) {
        this._forgetSessionState(descriptor.sessionId);
        return {
          success: true,
          status: null,
          stale: true,
          retryable: false,
        };
      }
      if (cleared.outcome === LIVE_DUBBING_CLEAR_OUTCOMES.SESSION_MISMATCH) {
        this._forgetSessionState(descriptor.sessionId);
        return {
          success: true,
          stopped: false,
          ignored: true,
          status: cloneDescriptor(this.descriptor),
          stale: true,
        };
      }
      return {
        success: false,
        status: cloneDescriptor(this.descriptor || descriptor),
        stale: true,
        retryable: true,
        cleanupPending: true,
      };
    }

    const failed = this._advance(
      descriptor,
      LIVE_DUBBING_STATUS.ERROR,
      safeFailureCode('RECONCILE'),
    );
    await this._writeDescriptor(failed, descriptor.sessionId).catch(() => {});
    return {
      success: false,
      status: cloneDescriptor(failed),
      stale: true,
      retryable: true,
      cleanupPending: true,
    };
  }

  async _queryStatus(descriptor, sessionId, providerId = descriptor?.providerId) {
    try {
      const response = await this._sendOffscreen(
        descriptor?.sessionId === sessionId
          ? createStatusMessage(descriptor)
          : createSessionMessage(LIVE_DUBBING_ACTIONS.STATUS, sessionId, providerId),
      );
      return response || null;
    } catch {
      return null;
    }
  }

  async _reconcileLease(lease, stale, providerId = null) {
    const sessionId = lease?.leaseId;
    const resolved = await this._resolveLeaseStatus(lease, providerId);
    if (!resolved) return { success: false };

    const { providerId: resolvedProviderId, status } = resolved;
    if (!stale && !this._isExplicitlyInactive(status, resolvedProviderId)) return { success: true };

    return this._awaitCleanup(
      this.cleanupManager.disposeAndRelease(
        { sessionId, providerId: resolvedProviderId },
        { releaseLease: true },
      ),
      { sessionId, providerId: resolvedProviderId },
    );
  }

  async _resolveLeaseStatus(lease, providerId = null) {
    const sessionId = lease?.leaseId;
    if (typeof sessionId !== 'string' || !sessionId.trim()) return null;

    const candidates = isLiveDubbingProviderId(providerId)
      ? [providerId]
      : [...LIVE_DUBBING_PROVIDER_IDS];
    const exactStatuses = [];

    for (const candidate of candidates) {
      const status = await this._queryStatus(null, sessionId, candidate);
      if (this._isExactSessionStatus(status, sessionId, candidate)) {
        if (candidates.length === 1) return { providerId: candidate, status };
        exactStatuses.push({ providerId: candidate, status });
      }
    }

    if (exactStatuses.length === 1) return exactStatuses[0];
    if (exactStatuses.length > 1
      && exactStatuses.every(({ providerId: candidate, status }) => (
        this._isExplicitlyInactive(status, candidate)
      ))) {
      // Both exact probes prove that no supported provider owns this session;
      // idempotent disposal is safe before releasing the stale lease.
      return exactStatuses[0];
    }
    return null;
  }

  async _acquireRecoveryLease(descriptor) {
    const sessionId = descriptor?.sessionId;
    const providerId = descriptor?.providerId;
    if (!sessionId || !isLiveDubbingProviderId(providerId)) return false;
    try {
      return await this.leaseManager.acquire({
        owner: LIVE_DUBBING_OWNER,
        leaseId: sessionId,
        requiredReasons: getLeaseReasons(providerId),
      }) === true;
    } catch {
      this.log.warn('Live dubbing recovery lease acquisition failed');
      return false;
    }
  }

  _rememberReconciledSession(descriptor, leaseAcquired) {
    const current = this.sessionRegistry.getSessionState(descriptor.sessionId);
    if (current) {
      current.descriptor = descriptor;
      current.leaseAcquired = leaseAcquired;
      current.prepared = true;
      current.cleanupCompleted = false;
      this.cleanupManager.syncLeaseOwnership(descriptor.sessionId, current, leaseAcquired);
      return;
    }

    const newState = {
      descriptor,
      leasePromise: null,
      leaseAcquired,
      prepared: true,
      terminalRequested: false,
      cleanupCompleted: false,
      providerDiagnostic: null,
    };
    this.sessionRegistry.setSessionState(descriptor.sessionId, newState);
  }

  _markTerminalState(state) {
    if (!state?.descriptor?.sessionId) return;
    state.terminalRequested = true;
    state.volumeEventSequenceReservation = null;
    this.sessionRegistry.releaseBootstrapSession(state.descriptor.sessionId);
  }

  _reserveVolumeEventSequence(descriptor, eventSequence) {
    const state = this.sessionRegistry.getSessionState(descriptor?.sessionId);
    if (!state || state.terminalRequested
      || state.descriptor?.sessionId !== descriptor?.sessionId
      || state.descriptor?.providerId !== descriptor?.providerId
      || state.descriptor?.status !== descriptor?.status
      || state.descriptor?.eventSequence !== descriptor?.eventSequence
      || descriptor?.status !== LIVE_DUBBING_STATUS.CONNECTING_PROVIDER
      || !Number.isSafeInteger(eventSequence)
      || eventSequence !== descriptor.eventSequence + 1) {
      return false;
    }
    state.volumeEventSequenceReservation = {
      sessionId: descriptor.sessionId,
      providerId: descriptor.providerId,
      eventSequence,
    };
    return true;
  }

  _advanceVolumeSetRequestToken(descriptor, lane) {
    if (!['original', 'dubbed'].includes(lane)) return null;
    const state = this.sessionRegistry.getSessionState(descriptor?.sessionId);
    if (!state
      || state.terminalRequested
      || !this._isSameDescriptorFence(state.descriptor, descriptor)) {
      return null;
    }

    const tokens = state.volumeSetRequestTokens || {};
    const token = (Number.isSafeInteger(tokens[lane]) ? tokens[lane] : 0) + 1;
    state.volumeSetRequestTokens = { ...tokens, [lane]: token };
    return token;
  }

  _isLatestVolumeSetRequestToken(state, lane, token) {
    return ['original', 'dubbed'].includes(lane)
      && Number.isSafeInteger(token)
      && state?.volumeSetRequestTokens?.[lane] === token;
  }

  _clearVolumeEventSequenceReservation(sessionId, providerId) {
    const state = this.sessionRegistry.getSessionState(sessionId);
    const reservation = state?.volumeEventSequenceReservation;
    if (reservation?.sessionId === sessionId && reservation?.providerId === providerId) {
      state.volumeEventSequenceReservation = null;
    }
  }

  _latchProviderDiagnostic(state, diagnostic) {
    if (!state || state.providerDiagnostic) return state?.providerDiagnostic || null;
    const sanitized = sanitizeLiveDubbingProviderDiagnostic(diagnostic);
    if (sanitized) state.providerDiagnostic = sanitized;
    return state.providerDiagnostic || null;
  }

  _forgetSessionState(sessionId, expectedState = null) {
    if (expectedState && !this.sessionRegistry.isSessionState(sessionId, expectedState)) return;
    const state = this.sessionRegistry.getSessionState(sessionId);
    if (state) state.volumeEventSequenceReservation = null;
    // Delegate physical facts ownership; manager fences exact generation only.
    if (expectedState) {
      this.cleanupManager.forgetSession(sessionId, expectedState);
    } else if (state) {
      this.cleanupManager.forgetSession(sessionId, state);
    } else {
      this.cleanupManager.forgetSession(sessionId, null);
    }
    this.sessionRegistry.deleteSessionState(sessionId, state);
    this.sessionRegistry.releaseBootstrapSession(sessionId);
  }

  _classifyStartFailure({ error, providerDiagnostic, providerStartAttempted }) {
    const BOOTSTRAP = 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE';
    const SETUP = 'LIVE_DUBBING_PROVIDER_SETUP_FAILED';
    const GENERIC = 'LIVE_DUBBING_START_FAILED';

    const hasBootstrap = (value) => {
      if (!value) return false;
      if (typeof value === 'string') return value === BOOTSTRAP;
      if (value.code === BOOTSTRAP) return true;
      if (value.error === BOOTSTRAP) return true;
      if (value.providerDiagnostic?.code === BOOTSTRAP) return true;
      return false;
    };

    if (hasBootstrap(error) || hasBootstrap(providerDiagnostic) || hasBootstrap(error?.providerDiagnostic)) {
      return BOOTSTRAP;
    }

    const sanitized = sanitizeLiveDubbingProviderDiagnostic(providerDiagnostic);
    if (
      providerStartAttempted === true
      && sanitized
      && typeof sanitized.code === 'string'
      && sanitized.code
      && sanitized.setupComplete !== true
      && !NON_PROVIDER_SETUP_TERMINAL_CATEGORIES.has(sanitized.terminalCategory)
    ) {
      return SETUP;
    }

    return GENERIC;
  }

  _hasLiveLease(sessionId) {
    try {
      const snapshot = this.leaseManager.getSnapshot?.() || {};
      const leases = snapshot.activeLeases || snapshot.leases || [];
      return leases.some(item => item.owner === LIVE_DUBBING_OWNER && item.leaseId === sessionId);
    } catch {
      return false;
    }
  }

  _isSessionMismatch(response, sessionId, providerId) {
    return Boolean(response && (
      response.sessionId !== sessionId
      || response.providerId !== providerId
      || (Object.prototype.hasOwnProperty.call(response, 'requestedSessionId')
        && response.requestedSessionId !== sessionId)
      || (Object.prototype.hasOwnProperty.call(response, 'actualSessionId')
        && response.actualSessionId !== sessionId)
      || (Object.prototype.hasOwnProperty.call(response, 'requestedProviderId')
        && response.requestedProviderId !== providerId)
      || (Object.prototype.hasOwnProperty.call(response, 'actualProviderId')
        && response.actualProviderId !== providerId)
    ));
  }

  _isExactSessionStatus(response, sessionId, providerId) {
    return Boolean(response
      && response.success !== false
      && isExactSessionResponse(response, sessionId, providerId)
      && typeof response.status === 'string');
  }

  _isSameDescriptorFence(left, right) {
    return Boolean(left && right
      && left.sessionId === right.sessionId
      && left.providerId === right.providerId
      && left.tabId === right.tabId
      && left.startedAt === right.startedAt
      && left.targetLanguage === right.targetLanguage
      && left.eventSequence === right.eventSequence
      && left.status === right.status);
  }

  /**
   * Reconcile one controller-ready response that crossed the Coordinator's
   * provider-ready bridge before its reservation was installed. Public input
   * has already been authorized against the descriptor sequence; this helper
   * may only install the exact next transport fence and replay once.
   */
  async _reconcileVolumeSequenceMismatch({
    descriptor,
    response,
    transportDescriptor,
    setRequestToken = null,
    setRequestLane = null,
    createMessage,
    sendMessage,
  }) {
    const responseData = response?.data && typeof response.data === 'object'
      ? response.data
      : response;
    const expectedEventSequence = descriptor?.eventSequence + 1;
    const isReconciliationCandidate = responseData?.success === false
      && responseData.error === 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH'
      && responseData.ignored === true
      && responseData.status === LIVE_DUBBING_STATUS.RUNNING
      && responseData.eventSequence === expectedEventSequence
      && isExactSessionResponse(responseData, descriptor?.sessionId, descriptor?.providerId);
    if (!isReconciliationCandidate) return { response, transportDescriptor };

    const current = await this._readDescriptor();
    const state = descriptor?.sessionId
      ? this.sessionRegistry.getSessionState(descriptor.sessionId)
      : null;
    if (this._storageReadFailed()
      || this._storageDescriptorInvalid()
      || !current
      || !this._isSameDescriptorFence(current, descriptor)
      || !state
      || state.terminalRequested
      || this.sessionRegistry.hasTerminalOperation(descriptor.sessionId)
      || !this._isSameDescriptorFence(state.descriptor, current)
      || current.status !== LIVE_DUBBING_STATUS.CONNECTING_PROVIDER
      || (setRequestLane
        && !this._isLatestVolumeSetRequestToken(state, setRequestLane, setRequestToken))) {
      return { response, transportDescriptor };
    }

    if (!this._reserveVolumeEventSequence(current, expectedEventSequence)) {
      return { response, transportDescriptor };
    }
    const replayTransportDescriptor = this._resolveVolumeTransportDescriptor(current);
    return {
      response: await sendMessage(createMessage(replayTransportDescriptor)),
      transportDescriptor: replayTransportDescriptor,
    };
  }

  _resolveVolumeTransportDescriptor(descriptor) {
    if (!descriptor) return descriptor;

    const state = this.sessionRegistry.getSessionState(descriptor.sessionId);
    const reservation = state?.volumeEventSequenceReservation;
    const isReservedBridge = descriptor.status === LIVE_DUBBING_STATUS.CONNECTING_PROVIDER
      && !state?.terminalRequested
      && state?.descriptor?.sessionId === descriptor.sessionId
      && state?.descriptor?.providerId === descriptor.providerId
      && state?.descriptor?.status === descriptor.status
      && state?.descriptor?.eventSequence === descriptor.eventSequence
      && reservation?.sessionId === descriptor.sessionId
      && reservation?.providerId === descriptor.providerId
      && reservation.eventSequence === descriptor.eventSequence + 1;

    return isReservedBridge
      ? { ...descriptor, eventSequence: reservation.eventSequence }
      : descriptor;
  }

  _isRecoverableRunningStatus(response, sessionId, providerId) {
    return this._isExactSessionStatus(response, sessionId, providerId)
      && response.status === LIVE_DUBBING_STATUS.RUNNING
      && response.active === true
      && response.captureReady === true
      && response.audioPathReady === true
      && response.setupComplete === true;
  }

  _isProvablyAbsent(response, sessionId, providerId) {
    return this._isExactSessionStatus(response, sessionId, providerId)
      && (['IDLE', 'DISPOSED', 'MISSING'].includes(response.status)
        || response.disposed === true);
  }

  async _isRuntimeAbsent(descriptor) {
    try {
      await this.leaseManager.ensureDocument?.();
    } catch {
      // Runtime absence is best effort; capture loss remains terminal proof.
    }

    let snapshot;
    try {
      snapshot = this.leaseManager.getSnapshot?.() || null;
    } catch {
      snapshot = null;
    }

    if (snapshot?.documentExists === false) return true;

    const status = await this._queryStatus(
      descriptor,
      descriptor?.sessionId,
      descriptor?.providerId,
    );
    return this._isProvablyAbsent(status, descriptor?.sessionId, descriptor?.providerId);
  }

  _isExplicitlyInactive(response, providerId) {
    return Boolean(this._isExactSessionStatus(response, response?.sessionId, providerId)
      && (response.active === false
        || ['IDLE', 'DISPOSED', 'MISSING'].includes(response.status)
        || response.disposed === true));
  }

  _advance(descriptor, status, lastError = null, eventSequence = descriptor.eventSequence + 1) {
    return {
      ...descriptor,
      status,
      lastError,
      eventSequence,
    };
  }

  _getPendingStartTabId(sender) {
    const tabId = sender?.tab?.id;
    return !this.runtimeGateway.isExtensionPageSender(sender) && Number.isInteger(tabId) && tabId >= 0
      ? tabId
      : null;
  }

  _getTargetLanguage(message) {
    return message?.data?.targetLanguage
      ?? message?.targetLanguage;
  }

  _relayTranscriptClear(descriptor) {
    const relayRecord = this._syncTranscriptRelayRecord(descriptor);
    if (!relayRecord || relayRecord.clearSent) return;
    relayRecord.clearSent = true;

    let result;
    try {
      result = this.runtimeGateway.sendTabMessage(
        descriptor.tabId,
        createLiveDubbingTranscriptClearMessage(descriptor.sessionId),
        { frameId: 0 },
      );
    } catch {
      return;
    }
    Promise.resolve(result).catch(() => {});
  }

  _findPendingStart(sessionId, tabId = null) {
    return this.sessionRegistry.findPendingStart(sessionId, tabId);
  }

  async _sendOffscreen(message) {
    return this.runtimeGateway.sendMessage(message);
  }

  async _sendOriginalVolumeQuery(message) {
    const timeoutMs = LIVE_DUBBING_ACTION_TIMEOUTS[LIVE_DUBBING_ACTIONS.GET_ORIGINAL_VOLUME];
    let timeoutId;
    const timeout = new Promise(resolve => {
      timeoutId = setTimeout(() => resolve(null), timeoutMs);
    });

    try {
      return await Promise.race([this._sendOffscreen(message), timeout]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async _sendOriginalVolume(message) {
    const timeoutMs = LIVE_DUBBING_ACTION_TIMEOUTS[LIVE_DUBBING_ACTIONS.SET_ORIGINAL_VOLUME];
    let timeoutId;
    const timeout = new Promise(resolve => {
      timeoutId = setTimeout(() => resolve(null), timeoutMs);
    });

    try {
      return await Promise.race([this._sendOffscreen(message), timeout]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async _sendDubbedVolumeQuery(message) {
    const timeoutMs = LIVE_DUBBING_ACTION_TIMEOUTS[LIVE_DUBBING_ACTIONS.GET_DUBBED_VOLUME];
    let timeoutId;
    const timeout = new Promise(resolve => {
      timeoutId = setTimeout(() => resolve(null), timeoutMs);
    });

    try {
      return await Promise.race([this._sendOffscreen(message), timeout]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async _sendDubbedVolume(message) {
    const timeoutMs = LIVE_DUBBING_ACTION_TIMEOUTS[LIVE_DUBBING_ACTIONS.SET_DUBBED_VOLUME];
    let timeoutId;
    const timeout = new Promise(resolve => {
      timeoutId = setTimeout(() => resolve(null), timeoutMs);
    });

    try {
      return await Promise.race([this._sendOffscreen(message), timeout]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async _sendCaptureStage(stage, message, sensitiveValues = []) {
    try {
      return await this._sendOffscreen(message);
    } catch (error) {
      throw createCaptureStageFailure(
        stage,
        error,
        createLiveDubbingDiagnostic(stage, error, { sensitiveValues }),
      );
    }
  }

  _storageReadFailed() {
    return this.stateStore.isStorageReadFailed();
  }

  _storageDescriptorInvalid() {
    return this.stateStore.isStorageDescriptorInvalid();
  }

  _storageReadFailure() {
    return {
      success: false,
      error: 'LIVE_DUBBING_STORAGE_UNREADABLE',
      retryable: true,
      status: cloneDescriptor(this.descriptor),
    };
  }

  _storageDescriptorFailure() {
    return {
      success: false,
      error: 'LIVE_DUBBING_STORAGE_DESCRIPTOR_INVALID',
      retryable: true,
      status: cloneDescriptor(this.descriptor),
    };
  }

  _storageWriteFailure() {
    return {
      success: false,
      error: 'LIVE_DUBBING_STORAGE_UNWRITABLE',
      retryable: true,
      status: cloneDescriptor(this.descriptor),
    };
  }

  _storageClearFailure(descriptor, error = 'LIVE_DUBBING_STORAGE_CLEAR_FAILED') {
    return {
      success: false,
      error,
      retryable: true,
      cleanupPending: true,
      status: cloneDescriptor(this.descriptor || descriptor),
    };
  }

  async _readStatusSnapshot() {
    return this.stateStore.readStatusSnapshot();
  }

  _getStatusTerminalOutcome() {
    return this.stateStore.getStatusTerminalOutcome();
  }

  _queueOutcomeMutation(operation) {
    return this.stateStore.queueOutcomeMutation(operation);
  }

  async _writeTerminalOutcome(outcome) {
    return this.stateStore.writeTerminalOutcome(outcome);
  }

  async _notifyTerminalOutcome(terminalOutcome = toPublicLiveDubbingTerminalOutcome(this.terminalOutcome)) {
    if (!terminalOutcome || !this.runtimeGateway?.sendMessage) return;

    try {
      await this.runtimeGateway.sendMessage({
        action: LIVE_DUBBING_ACTIONS.TERMINAL_OUTCOME,
        data: terminalOutcome,
      });
    } catch {
      // Outcome notification is best effort and cannot change cleanup state.
    }
  }

  /**
   * Best-effort non-terminal refresh hint for transcript-delivery state.
   * Carries scalar session identity only; never affects lifecycle, cleanup,
   * leases, or ownership.
   */
  async _notifyTranscriptDeliveryChanged(sessionId) {
    if (!sessionId || !this.runtimeGateway?.sendMessage) return;

    try {
      await this.runtimeGateway.sendMessage({
        action: LIVE_DUBBING_ACTIONS.TRANSCRIPT_DELIVERY_CHANGED,
        data: { sessionId },
      });
    } catch {
      // Delivery-state notification is best effort and cannot change session state.
    }
  }

  /**
   * Session-scoped transcript-delivery availability for UI refresh only.
   * True only while the descriptor is active and the relay record still
   * belongs to that same session with its non-terminal flag set.
   */
  _isTranscriptDeliveryUnavailable() {
    const descriptor = this.descriptor;
    if (!descriptor
      || ![LIVE_DUBBING_STATUS.PREPARING_CAPTURE,
        LIVE_DUBBING_STATUS.CONNECTING_PROVIDER,
        LIVE_DUBBING_STATUS.RUNNING].includes(descriptor.status)) {
      return false;
    }
    return this.transcriptRelayRecord?.sessionId === descriptor.sessionId
      && this.transcriptRelayRecord.deliveryUnavailable === true;
  }

  _syncTranscriptRelayRecord(descriptor) {
    const sessionId = typeof descriptor?.sessionId === 'string'
      && descriptor.sessionId.trim()
      ? descriptor.sessionId
      : null;
    if (!sessionId) {
      this.transcriptRelayRecord = null;
      return null;
    }
    if (this.transcriptRelayRecord?.sessionId !== sessionId) {
      this.transcriptRelayRecord = {
        sessionId,
        lastTranscriptSequence: 0,
        clearSent: false,
        deliveryUnavailable: false,
      };
    }
    return this.transcriptRelayRecord;
  }

  async _readDescriptor() {
    const descriptor = await this.stateStore.readDescriptor();
    this._syncTranscriptRelayRecord(descriptor);
    return descriptor;
  }

  async _writeDescriptor(descriptor, expectedSessionId = null, expectedDescriptor = null, options = {}) {
    const wantsClearOutcome = options.clearOutcome === true;
    const isRunningCommit = descriptor.status === LIVE_DUBBING_STATUS.RUNNING;
    const current = await this.stateStore.readDescriptor();
    if (this._storageReadFailed()) return false;

    const state = expectedSessionId ? this.sessionRegistry.getSessionState(expectedSessionId) : null;
    if (state?.terminalRequested
      && ![LIVE_DUBBING_STATUS.STOPPING, LIVE_DUBBING_STATUS.ERROR].includes(descriptor.status)) {
      return false;
    }
    if (current
      && current.status === LIVE_DUBBING_STATUS.STOPPING
      && current.status !== descriptor.status
      && expectedDescriptor?.status !== LIVE_DUBBING_STATUS.STOPPING) {
      return false;
    }
    if (expectedSessionId && (!current || current.sessionId !== expectedSessionId)) return false;
    if (expectedDescriptor && !this._isSameDescriptorFence(current, expectedDescriptor)) return false;

    if (wantsClearOutcome && !isRunningCommit) {
      const { clearOutcome, ...writeOptions } = options;
      void clearOutcome;
      return this.stateStore.writeDescriptorFromCurrent(
        descriptor,
        current,
        expectedSessionId,
        expectedDescriptor,
        writeOptions,
      );
    }

    if (!wantsClearOutcome || !isRunningCommit) {
      return this.stateStore.writeDescriptorFromCurrent(
        descriptor,
        current,
        expectedSessionId,
        expectedDescriptor,
        options,
      );
    }

    // RUNNING + clearOutcome: await outcome mutations, then re-read authoritative descriptor and re-check
    await this.stateStore.awaitOutcomeMutations();

    const currentAfter = await this.stateStore.readDescriptor();
    if (this._storageReadFailed()) return false;

    const stateAfter = this.sessionRegistry.getSessionState(expectedSessionId) || state;
    if (stateAfter?.terminalRequested
      && ![LIVE_DUBBING_STATUS.STOPPING, LIVE_DUBBING_STATUS.ERROR].includes(descriptor.status)) {
      return false;
    }

    if (expectedSessionId && (!currentAfter || currentAfter.sessionId !== expectedSessionId)) return false;
    if (expectedDescriptor && !this._isSameDescriptorFence(currentAfter, expectedDescriptor)) return false;
    if (currentAfter?.status === LIVE_DUBBING_STATUS.STOPPING
      && currentAfter.status !== descriptor.status
      && expectedDescriptor?.status !== LIVE_DUBBING_STATUS.STOPPING) {
      return false;
    }

    return this.stateStore.writeDescriptorFromCurrent(descriptor, currentAfter, expectedSessionId, expectedDescriptor, { clearOutcome: true });
  }

  async _clearDescriptor(expectedSessionId = null) {
    return this.stateStore.clearDescriptor(expectedSessionId);
  }
}

export const liveDubbingCoordinator = new LiveDubbingCoordinator();

export { LIVE_DUBBING_ACTIONS };
