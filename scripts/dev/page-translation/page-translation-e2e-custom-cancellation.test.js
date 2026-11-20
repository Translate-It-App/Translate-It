import { describe, expect, it } from 'vitest';
import {
  parseResilienceProbeSelection, selectResolvedCustomCancellationBatch, validateCustomCancellationEvidence,
  validateResilienceProbeIsolation,
} from './e2e-benchmark/resilience-probes.mjs';
import { admitCustomCancellationRequest, armCustomCancellation, awaitCustomCancellationNetwork, classifyCustomCancellationTiming, createCustomCancellationProtocol, executeCustomCancellation } from './e2e-benchmark/resilience/custom-cancellation.mjs';

const targetIds = Array.from({ length: 1000 }, (_, index) => `target-${index}`);
const retainedIds = targetIds.slice(0, 25);
const heldTargetIds = targetIds.slice(25, 50);
const fixtureTargetMapping = targetIds.map((id, index) => ({ id, source: `source-${index}` }));
const metadataBaseline = targetIds.map(id => ({ id, tagName: 'P' }));
const snapshot = (translated = new Set()) => ({
  dom: targetIds.map((id, index) => [id, translated.has(id)
    ? `\u200efixture translation: source-${index}` : `source-${index}`]),
  metadata: metadataBaseline,
});

const evidence = () => ({
  arm: { sessionId: 'page-A', armedWallMs: 5, initialTargetIds: retainedIds,
    resolver: { present: true, resolutionPending: false, effectiveSourceLanguage: 'en', effectiveTargetLanguage: 'fr' } },
  heldRequest: { requestId: 'fetch-1', networkId: 'network-1', networkSessionId: 'target-session', attemptId: 'attempt-1', messageId: 'message-1',
    pageSessionId: 'page-A', method: 'POST', url: 'https://custom.invalid/translate', requestBody: '{}',
    targetIds: heldTargetIds },
  pendingCheckpoint: { positive: true, requestId: 'fetch-1', controllerAborted: false, providerRootStatus: 'pending' },
  cancellation: {
     stop: { action: 'page-translate-stop-auto', status: 'fulfilled', sentAt: 10, respondedAt: 11, response: { success: true } },
    cancelMessage: { kind: 'runtime.cancel.send', action: 'CANCEL_TRANSLATION', messageId: null,
      sessionId: 'page-A', targetSessionId: 'page-A', status: 'fulfilled', response: { success: true } },
      invalidation: { sessionId: 'page-A', capturedSessionActive: false, discoveryCancelled: true,
        invalidationCallStartedAt: 10, invalidationCallCompletedAt: 11 },
    serviceCall: { status: 'fulfilled', messageId: 'message-1', sessionId: 'page-A', controllerMatched: true,
      controllerAbortedBefore: false, controllerAbortedAfter: true, response: { handled: true, success: true }, sequence: 2 },
    abortEvent: { messageId: 'message-1', sessionId: 'page-A', sequence: 3 },
    controller: { messageId: 'message-1', sessionId: 'page-A', aborted: true },
     providerRoot: { messageId: 'message-1', sessionId: 'page-A', status: 'rejected', operationAborted: false,
      errorType: 'USER_CANCELLED', settledSequence: 4 },
    physical: { messageId: 'message-1', sessionId: 'page-A', status: 'rejected', controllerAbortedAtEnd: true,
      url: 'https://custom.invalid/translate', method: 'POST', requestBody: '{}',
      settledSequence: 5, errorType: null, error: null, abortReasonMatched: true, abortReasonType: 'string', operationAborted: false },
    physicalMatchCount: 1,
    acceptedIdsAfterStop: retainedIds,
     network: { sessionId: 'target-session', networkId: 'network-1', status: null, outcome: 'failed', error: 'net::ERR_ABORTED' },
  },
  attempts: [
    { selected: true, attemptId: 'attempt-1', networkId: 'network-1', networkSessionId: 'target-session', pageSessionId: 'page-A',
     logicalMessageId: 'message-1', targetIds: heldTargetIds,
       texts: Array.from({ length: 25 }, (_, index) => `source-${index + 25}`),
      startedWallMs: 5, outcome: 'failed', networkError: 'net::ERR_ABORTED',
       status: null, correlation: { rootMatchCount: 1, physicalMatchCount: 1,
           controllerMatchCount: 1, providerRootStatus: 'rejected', physicalStatus: 'rejected', providerRootErrorType: 'USER_CANCELLED',
        physicalControllerAbortedAtEnd: true, physicalAbortReasonMatched: true,
        physicalErrorType: null, physicalError: null, physicalErrorName: null, controllerAborted: true } },
     { selected: false, sibling: true, attemptId: 'attempt-2', networkId: 'network-2', networkSessionId: 'target-session',
       pageSessionId: 'page-A', logicalMessageId: 'message-2', targetIds: targetIds.slice(50, 75),
       texts: Array.from({ length: 25 }, (_, index) => `source-${index + 50}`),
      startedWallMs: 6, outcome: 'failed', networkError: 'net::ERR_ABORTED',
       status: null, correlation: { rootMatchCount: 1, physicalMatchCount: 1,
           controllerMatchCount: 1, providerRootStatus: 'rejected', physicalStatus: 'rejected', providerRootErrorType: 'USER_CANCELLED',
        physicalControllerAbortedAtEnd: true, physicalAbortReasonMatched: true,
         physicalErrorType: null, physicalError: null, physicalErrorName: null, controllerAborted: true } },
     { selected: false, attemptId: 'attempt-3', networkId: 'network-3', networkSessionId: 'target-session',
       pageSessionId: 'page-A', logicalMessageId: 'message-3', targetIds: targetIds.slice(75, 100),
       texts: Array.from({ length: 25 }, (_, index) => `source-${index + 75}`),
       startedWallMs: 4, outcome: 'finished', networkError: null, status: 200,
       correlation: { rootMatchCount: 1, physicalMatchCount: 1, controllerMatchCount: 1,
         providerRootStatus: 'fulfilled', providerRootErrorType: null, physicalStatus: 'fulfilled',
         physicalControllerAbortedAtEnd: false, physicalErrorType: null, physicalError: null,
         physicalErrorName: null, controllerAborted: false } },
  ],
  unexpectedPhysicalAttempts: [],
  unnecessaryRetransmits: [],
  retries: [],
  failovers: [],
  recovery: [],
  allSessionRoots: [
     { sessionId: 'page-A', messageId: 'message-1', status: 'rejected' },
     { sessionId: 'page-A', messageId: 'message-2', status: 'rejected' },
     { sessionId: 'page-A', messageId: 'message-3', status: 'fulfilled' },
  ],
  allSessionPhysicalAttempts: [
   { attemptId: 'attempt-1', networkId: 'network-1', networkSessionId: 'target-session', pageSessionId: 'page-A', status: null, outcome: 'failed' },
    { attemptId: 'attempt-2', networkId: 'network-2', networkSessionId: 'target-session', pageSessionId: 'page-A', status: null, outcome: 'failed' },
    { attemptId: 'attempt-3', networkId: 'network-3', networkSessionId: 'target-session', pageSessionId: 'page-A', status: 200, outcome: 'finished' },
  ],
  allSessionControllers: [
    { sessionId: 'page-A', messageId: 'message-1', aborted: true },
     { sessionId: 'page-A', messageId: 'message-2', aborted: true },
     { sessionId: 'page-A', messageId: 'message-3', aborted: false },
  ],
  targetMapping: fixtureTargetMapping,
   snapshots: { beforeStop: snapshot(new Set(retainedIds)), afterStop: snapshot(new Set(retainedIds)),
     preRestore: snapshot(new Set(retainedIds)), restored: snapshot() },
   metadataBaseline,
  postInvalidation: { ok: true, lateAcceptedSettlements: [], invalidMutations: [] },
  retainedAcceptedIds: retainedIds,
  duplicateAcceptedWriteIds: [],
  translation: { exact: true, targetCount: 1000, acceptedTargetCount: retainedIds.length, acceptedTargetIds: retainedIds,
    acceptedWriteCount: retainedIds.length, acceptedSessionActivity: 0, duplicates: 0,
    restoreExact: true, metadataExact: true, expectedTargetIds: targetIds },
  queueAttemptEvidence: { ok: true, queueStartCount: 1, queueEndCount: 1, issues: [] },
  concurrency: { peakPhysical: 2, peakLogical: 2, providerLimiterCapacity: 2, pageWorkerLimit: 2 },
  resources: { sourceResolvers: { 'page-A': { present: false } } },
  cleanup: { ok: true, handlersDrained: true, handlerCount: 0,
      requestLifecycle: { ok: true, closing: true, reservationCount: 3,
        drainInterval: { startedAt: 12, completedAt: 13 }, reservations: [
        { requestId: 'fetch-1', sessionId: 'target-session', networkId: 'network-1', releaseRequested: true, handlerSettled: true,
          handlerError: null,
          releaseOutcome: { error: 'Invalid InterceptionId.' },
          releaseClassification: 'network-loadingFailed-canceled-with-provider-settlement' },
        { requestId: 'fetch-2', sessionId: 'target-session', networkId: 'network-2', releaseRequested: true, handlerSettled: true,
          handlerError: null,
          releaseOutcome: { error: 'Invalid InterceptionId.' },
          releaseClassification: 'network-cancellation-after-production-stop' },
        { requestId: 'fetch-3', sessionId: 'target-session', networkId: 'network-3', releaseRequested: true, handlerSettled: true,
          handlerError: null, releaseOutcome: { ok: true, action: 'fulfill' } },
      ] }, resourceValidation: { ok: true }, finalDrainAt: 13,
    pageScheduler: { managerTranslating: false, activeFlushes: 0, queueIds: [], pendingSettlementCount: 0,
      batchTimerActive: false, completionTimerActive: false },
     contentDrain: { pendingOperations: 0 }, workerDrain: { ledger: { pending: 0 },
        providerRoots: [{ sessionId: 'page-A', messageId: 'message-1', status: 'rejected' },
          { sessionId: 'page-A', messageId: 'message-2', status: 'rejected' },
          { sessionId: 'page-A', messageId: 'message-3', status: 'fulfilled' }],
        controllers: [{ sessionId: 'page-A', messageId: 'message-1', aborted: true },
          { sessionId: 'page-A', messageId: 'message-2', aborted: true },
          { sessionId: 'page-A', messageId: 'message-3', aborted: false }] } },
    admissions: [
      { requestId: 'fetch-1', networkId: 'network-1', networkSessionId: 'target-session', order: 1, decision: 'initiator-complete', admittedAt: 5, startedWallMs: 5, relativeToInvalidation: 'before', networkRelativeToInvalidation: 'before' },
      { requestId: 'fetch-2', networkId: 'network-2', networkSessionId: 'target-session', order: 2, decision: 'cancelled-sibling', admittedAt: 6, startedWallMs: 6, relativeToInvalidation: 'before', networkRelativeToInvalidation: 'before' },
   ],
   releaseClassification: { ok: true },
});

describe('Custom cancellation resilience probe', () => {
  it('synchronously holds concurrent admissions and waits for delayed Network correlation', async () => {
    const protocol = createCustomCancellationProtocol();
    protocol.armed = true;
    protocol.armedWallMs = 10;
    protocol.fixtureTargetBySource = new Map([['source-1', 'target-1']]);
    const held = [];
    const reserve = requestId => ({
      held: false,
      hold() { held.push(requestId); this.held = true; return true; },
    });
    const make = requestId => {
      const reservation = reserve(requestId);
      const admission = admitCustomCancellationRequest({
        protocol, event: { sessionId: 'target-session', params: { networkId: `network-${requestId}` } },
        requestRecord: {}, requestId, reservation, body: ['source-1'], now: () => 20,
      });
      return { admission, reservation };
    };
    const { admission: first, reservation: firstReservation } = make('fetch-1');
    const { reservation: secondReservation } = make('fetch-2');
    expect(held).toEqual(['fetch-1', 'fetch-2']);
    expect(protocol.admissions.map(item => item.order)).toEqual([1, 2]);

    const events = new Map();
    let publish;
    const delayed = awaitCustomCancellationNetwork(first, events, async (read, timeout) => {
      expect(timeout).toBe(10_000);
      const pending = new Promise(resolve => { publish = resolve; });
      const result = read();
      if (result) return result;
      await pending;
      return read();
    });
    events.set('target-session:network-fetch-1', { wallTime: 11 });
    publish();
    await expect(delayed).resolves.toMatchObject({ wallTime: 11 });
    expect(first.decision).toBe('pending');
    expect(firstReservation.held).toBe(true);
    expect(secondReservation.held).toBe(true);
  });

  it('fails closed when bounded Network correlation never arrives', async () => {
    const admission = { requestId: 'fetch-missing', networkSessionId: 'target-session',
      networkId: 'network-missing', decision: 'pending' };
    await expect(awaitCustomCancellationNetwork(admission, new Map(), async (_read, timeout) => {
      expect(timeout).toBe(10_000);
      return null;
    })).rejects.toThrow('lacks bounded Network correlation');
    expect(admission.decision).toBe('correlation-timeout');
  });

  it('releases every queued turn after initiator failure and fails siblings closed', async () => {
    const protocol = createCustomCancellationProtocol();
    protocol.armed = true;
    protocol.armedWallMs = 10;
    let resumeCorrelation;
    let signalBarrier;
    const barrierEntered = new Promise(resolve => { signalBarrier = resolve; });
    const correlationGate = new Promise(resolve => { resumeCorrelation = resolve; });
    let releases = 0;
    const makeReservation = () => ({
      hold: () => true,
      release: async () => { releases += 1; return { ok: true, action: 'fail' }; },
    });
    const requests = ['fetch-1', 'fetch-2', 'fetch-3'].map((requestId, index) => {
      const requestRecord = {};
      const event = { sessionId: 'target-session', params: { networkId: `network-${index + 1}` } };
      const reservation = makeReservation();
      const admission = admitCustomCancellationRequest({
        protocol, event, requestRecord, requestId, reservation, body: [], now: () => 20 + index,
      });
      return { requestId, requestRecord, event, reservation, admission };
    });
    const first = executeCustomCancellation({
      protocol, ...requests[0], body: [], fixtureConfig: {}, sessionId: 'page-A',
      providerNetworkEvents: new Map(), until: async () => {
        signalBarrier();
        return correlationGate;
      },
    });
    await barrierEntered;
    const siblings = requests.slice(1).map(request => executeCustomCancellation({
      protocol, ...request, body: [], fixtureConfig: {}, sessionId: 'page-A',
      providerNetworkEvents: new Map(), until: async () => null,
    }));
    resumeCorrelation(null);
    const outcomes = await Promise.allSettled([first, ...siblings]);
    expect(outcomes.map(outcome => outcome.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(outcomes[0].reason.message).toContain('lacks bounded Network correlation');
    expect(outcomes.slice(1).map(outcome => outcome.reason.message))
      .toEqual(['Custom cancellation admission fetch-1 lacks bounded Network correlation.',
        'Custom cancellation admission fetch-1 lacks bounded Network correlation.']);
    expect(protocol.productionCancellationEstablished).not.toBe(true);
    expect(releases).toBe(0);
    expect(requests.map(item => item.admission.decision))
      .toEqual(['correlation-timeout', 'failed-closed', 'failed-closed']);
  });

  it.each([
    [9, 'before'],
    [12, 'after'],
    [10, 'indeterminate'],
  ])('classifies admission timestamp %s against the measured invalidation envelope', (timestamp, classification) => {
    expect(classifyCustomCancellationTiming(timestamp, {
      invalidationCallStartedAt: 10, invalidationCallCompletedAt: 11,
    })).toBe(classification);
  });

  it.each([
    ['missing', item => { item.admissions = []; }],
    ['missing post-arm attempt admission', item => { item.admissions.pop(); }],
    ['duplicate', item => { item.admissions.push({ ...item.admissions[0] }); }],
    ['unmapped', item => { item.admissions[0].requestId = 'fetch-unknown'; }],
  ])('rejects %s admission reservation accounting', (_name, mutate) => {
    const item = evidence();
    mutate(item);
    expect(validateCustomCancellationEvidence(item).issues).toContain(
      'Custom Fetch admission decisions do not map one-to-one to settled, classified lifecycle reservations with valid invalidation timing',
    );
  });

  it('accepts a complete coherent positive-evidence baseline', () => {
    expect(validateCustomCancellationEvidence(evidence())).toEqual({ ok: true, issues: [] });
  });

  it('accepts status-null aborted failed physical attempts only with complete cancellation correlation', () => {
    const item = evidence();
    item.attempts[1].status = null;
    item.attempts[1].outcome = 'failed';
    item.attempts[1].networkError = 'net::ERR_ABORTED';
    item.allSessionPhysicalAttempts[1].status = null;
    expect(validateCustomCancellationEvidence(item)).toEqual({ ok: true, issues: [] });

    item.attempts[1].correlation.physicalAbortReasonMatched = false;
    expect(validateCustomCancellationEvidence(item).issues).toContain(
      'one or more Custom physical requests lack unique actual session/root/physical/controller correlation',
    );
  });

  it('selects only an isolated Custom Level 3 sliced fluid scroll-through probe', () => {
    expect(parseResilienceProbeSelection('custom-cancellation')).toEqual(['custom-cancellation']);
    expect(validateResilienceProbeIsolation({ selected: true, probe: 'custom-cancellation', provider: 'custom',
      optimizationLevel: 3, modes: 'sliced', scenario: 'scroll-through', schedulingMode: 'fluid' })).toBe(true);
    expect(() => validateResilienceProbeIsolation({ selected: true, probe: 'custom-cancellation', provider: 'googlev2',
      optimizationLevel: 3 })).toThrow();
  });

  it('rejects miscorrelated owner, duplicate/unknown targets, and wrong physical identities', () => {
    const selection = fields => selectResolvedCustomCancellationBatch({
      request: { networkId: 'n1', sessionId: 'page-A', physicalStartedWallMs: 5, texts: Array(25).fill('source'),
        targetIds: Array.from({ length: 25 }, (_, i) => `target-${i}`), ...fields },
      classification: { kind: 'provider-translation', provider: 'custom' },
      resolver: { present: true, resolutionPending: false, effectiveSourceLanguage: 'en', effectiveTargetLanguage: 'fr' },
      roots: [{ sessionId: 'page-A', messageId: 'm1', texts: Array(25).fill('source') }],
      expectedTargetIds: Array.from({ length: 25 }, (_, i) => `target-${i}`), initialTargetIds: [], armedWallMs: 1,
    });
    expect(selection({ sessionId: 'wrong-owner' }).selected).toBe(false);
    expect(selection({ targetIds: [...Array(24)].map((_, i) => `target-${i}`).concat('target-23') }).selected).toBe(false);
    expect(selection({ targetIds: [...Array(24)].map((_, i) => `target-${i}`).concat('unknown') }).selected).toBe(false);

    const invalid = evidence();
    invalid.heldRequest.networkSessionId = 'other-target';
    invalid.cancellation.physical.sessionId = 'wrong-page';
    invalid.cancellation.physicalMatchCount = 2;
    expect(validateCustomCancellationEvidence(invalid).issues).toEqual(expect.arrayContaining([
      'provider root and exactly one physical Custom request did not settle as USER_CANCELLED after a matched network abort',
    ]));
  });

  it('rejects targeted cleanup, ownership, retry, recovery, and post-Stop-start mutations', () => {
    const cases = [
      [item => { item.cleanup.handlersDrained = false; }, 'queue, runtime resources, promise roots, or Fetch handlers did not drain'],
      [item => { item.postInvalidation.lateAcceptedSettlements.push({ id: 'late-write' }); }, 'post-invalidation accepted writes or duplicate writes were observed'],
      [item => { item.cancellation.providerRoot.errorType = 'OPERATION_TIMEOUT'; }, 'provider root and exactly one physical Custom request did not settle as USER_CANCELLED after a matched network abort'],
      [item => { item.releaseClassification.ok = false; }, 'held Fetch release failure was not positively classified after matching cancellation'],
      [item => { item.cancellation.abortEvent.messageId = 'wrong-message'; }, 'production cancellation did not abort the exact live provider controller'],
      [item => { item.cancellation.controller.messageId = 'wrong-message'; }, 'cancelled provider controller evidence does not match the held Page session and logical root'],
      [item => { item.retries.push({ attemptNumber: 2 }); }, 'unexpected selected requests, cancelled-session activity, retries, recovery, or failovers were observed'],
      [item => { item.recovery.push({ kind: 'provider-recovery' }); }, 'unexpected selected requests, cancelled-session activity, retries, recovery, or failovers were observed'],
      [item => { item.attempts[1].startedWallMs = item.cancellation.stop.sentAt + 1; }, 'one or more Custom physical requests lack unique actual session/root/physical/controller correlation'],
      [item => {
        Object.assign(item.attempts[1].correlation, { physicalErrorType: 'NETWORK_ERROR', physicalError: 'unrelated network error',
          physicalAbortReasonMatched: false, physicalOperationAborted: false });
      }, 'one or more Custom physical requests lack unique actual session/root/physical/controller correlation'],
    ];
    for (const [mutate, expectedIssue] of cases) {
      const item = evidence();
      mutate(item);
      expect(validateCustomCancellationEvidence(item).issues).toContain(expectedIssue);
    }
  });

  it.each([
      ['wrong provider-root session', item => { item.cancellation.providerRoot.sessionId = 'wrong-session'; },
        'provider root and exactly one physical Custom request did not settle as USER_CANCELLED after a matched network abort'],
      ['missing arm timestamp', item => { delete item.arm.armedWallMs; },
        'initial band and concrete AUTO resolution were not proven before arming'],
    ['missing worker-drain roots', item => { delete item.cleanup.workerDrain.providerRoots; },
      'queue, runtime resources, promise roots, or Fetch handlers did not drain'],
    ['missing worker-drain controllers', item => { delete item.cleanup.workerDrain.controllers; },
      'queue, runtime resources, promise roots, or Fetch handlers did not drain'],
    ['inconsistent all-session controller state', item => { item.allSessionControllers[1].aborted = false; },
      'not all cancelled-session provider controllers have unique final accounting'],
    ['tampered restored DOM', item => { item.snapshots.restored.dom[0][1] = 'tampered'; },
      'raw DOM or metadata snapshots do not match fixture and source baselines'],
    ['missing unexpected-attempt evidence', item => { delete item.unexpectedPhysicalAttempts; },
      'retry, failover, recovery, and duplicate-write accounting evidence is incomplete'],
    ['missing unnecessary-retransmit evidence', item => { delete item.unnecessaryRetransmits; },
      'retry, failover, recovery, and duplicate-write accounting evidence is incomplete'],
    ['HTTP 500 despite failed network outcome', item => {
        item.attempts[0].status = 500;
        item.attempts[0].outcome = 'failed';
      }, 'raw Network status/outcome does not match the cancelled provider root and physical terminal state'],
    ['mismatched complete reservation count', item => { item.cleanup.requestLifecycle.reservationCount++; },
      'post-Stop request accounting is not complete through final Fetch handler drainage'],
    ['drain interval ending before Stop', item => { item.cleanup.requestLifecycle.drainInterval.completedAt = 9; },
      'post-Stop request accounting is not complete through final Fetch handler drainage'],
    ['missing invalidation timing envelope', item => { delete item.cancellation.invalidation.invalidationCallStartedAt; },
      'session invalidation lacks a valid benchmark call timing envelope'],
    ['fabricated admission boundary label', item => { item.admissions[0].relativeToInvalidation = 'after'; },
      'Custom Fetch admission decisions do not map one-to-one to settled, classified lifecycle reservations with valid invalidation timing'],
  ])('rejects %s', (_name, mutate, expectedIssue) => {
    const item = evidence();
    mutate(item);
    expect(validateCustomCancellationEvidence(item).issues).toContain(expectedIssue);
  });

  it('requires positive raw physical-abort evidence and rejects explicit non-cancellation failures', () => {
    for (const mutate of [
      item => Object.assign(item.cancellation.physical, { errorType: 'NETWORK_ERROR', error: 'unrelated network error',
        abortReasonMatched: false, operationAborted: false }),
      item => Object.assign(item.cancellation.physical, { error: 'unrelated network error',
        abortReasonMatched: false, operationAborted: false }),
    ]) {
      const item = evidence();
      mutate(item);
      expect(validateCustomCancellationEvidence(item).issues).toContain(
        'provider root and exactly one physical Custom request did not settle as USER_CANCELLED after a matched network abort',
      );
    }
  });

  it('rejects incomplete identities, accounting, lifecycle reservations, queue counts, timestamps, and snapshots', () => {
    const cases = [
      ...['retries', 'recovery', 'failovers', 'duplicateAcceptedWriteIds'].map(key => [
        item => { delete item[key]; }, 'retry, failover, recovery, and duplicate-write accounting evidence is incomplete',
      ]),
      [item => { item.attempts[1].pageSessionId = 'foreign-page'; }, 'one or more Custom physical requests lack unique actual session/root/physical/controller correlation'],
      [item => { item.attempts[1].networkSessionId = 'foreign-target'; }, 'not all cancelled-session logical roots and physical requests have final settlement evidence'],
      [item => { item.attempts[1].attemptId = item.attempts[0].attemptId; }, 'provider attempt, physical request, or logical root identity is duplicated'],
      [item => { item.attempts[1].networkId = item.attempts[0].networkId; }, 'provider attempt, physical request, or logical root identity is duplicated'],
      [item => { item.attempts[1].logicalMessageId = item.attempts[0].logicalMessageId; }, 'provider attempt, physical request, or logical root identity is duplicated'],
      [item => { item.attempts[1].targetIds[0] = 'target-999'; }, 'one or more Custom physical requests lack unique actual session/root/physical/controller correlation'],
      [item => { item.attempts[1].texts[0] = 'source-999'; }, 'one or more Custom physical requests lack unique actual session/root/physical/controller correlation'],
      [item => { item.allSessionControllers = []; }, 'not all cancelled-session provider controllers have unique final accounting'],
      [item => { item.allSessionRoots = []; }, 'not all cancelled-session logical roots and physical requests have final settlement evidence'],
      [item => { item.cancellation.stop.sentAt = 0; }, 'production Stop lacks a valid timestamp and ordered acknowledgement'],
      [item => { delete item.cancellation.stop.sentAt; }, 'production Stop lacks a valid timestamp and ordered acknowledgement'],
      [item => { item.allSessionPhysicalAttempts.pop(); }, 'not all cancelled-session logical roots and physical requests have final settlement evidence'],
      [item => { item.cleanup.finalDrainAt = null; }, 'post-Stop request accounting is not complete through final Fetch handler drainage'],
      [item => { item.snapshots.beforeStop = null; }, 'raw before-Stop, after-Stop, pre-Restore, and restored DOM/metadata snapshots are incomplete'],
      [item => { item.snapshots.afterStop = null; }, 'raw before-Stop, after-Stop, pre-Restore, and restored DOM/metadata snapshots are incomplete'],
      [item => { item.snapshots.preRestore = null; }, 'raw before-Stop, after-Stop, pre-Restore, and restored DOM/metadata snapshots are incomplete'],
      [item => { item.snapshots.restored = null; }, 'raw before-Stop, after-Stop, pre-Restore, and restored DOM/metadata snapshots are incomplete'],
      [item => { item.cleanup.requestLifecycle.reservations.pop(); }, 'provider attempts do not map one-to-one to settled, classified Fetch reservations'],
      [item => { item.cleanup.requestLifecycle.reservations.push({ ...item.cleanup.requestLifecycle.reservations[0] }); }, 'provider attempts do not map one-to-one to settled, classified Fetch reservations'],
      [item => { item.cleanup.requestLifecycle.reservations[0].releaseClassification = 'unclassified-cdp-release-error'; }, 'provider attempts do not map one-to-one to settled, classified Fetch reservations'],
      [item => { item.queueAttemptEvidence.queueStartCount = 2; }, 'held logical root lacks exactly one observed QueueManager start and end event'],
      [item => { item.queueAttemptEvidence.queueEndCount = 0; }, 'held logical root lacks exactly one observed QueueManager start and end event'],
      [item => { item.attempts.pop(); }, 'not all cancelled-session logical roots and physical requests have final settlement evidence'],
    ];
    for (const [mutate, expectedIssue] of cases) {
      const item = evidence();
      mutate(item);
      expect(validateCustomCancellationEvidence(item).issues).toContain(expectedIssue);
    }
  });

  it('rejects missing evidence without throwing and correlates a physical operation without a Network ID field', async () => {
    expect(() => validateCustomCancellationEvidence(undefined)).not.toThrow();
    expect(validateCustomCancellationEvidence(undefined).ok).toBe(false);

    const targets = Array.from({ length: 50 }, (_, index) => ({ id: `target-${index}`, source: `source-${index}` }));
    const initialIds = targets.slice(0, 25).map(target => target.id);
    const resolver = { present: true, resolutionPending: false, effectiveSourceLanguage: 'en', effectiveTargetLanguage: 'fr' };
    const protocol = createCustomCancellationProtocol();
    armCustomCancellation({ protocol, sessionId: 'page-A', resolver, initialIds,
      fixtureConfig: { targets, targetCount: targets.length }, now: () => 10 });
    protocol.initialDOMMetadata = targets.map(target => ({ id: target.id, tagName: 'P', attributes: [['data-bench-id', target.id]] }));
    const texts = targets.slice(25).map(target => target.source);
    const requestRecord = { physicalAttemptId: 'attempt-1', method: 'POST', url: 'https://custom.invalid/translate',
      postData: JSON.stringify(texts), networkId: 'network-1', targetSessionId: 'target-session' };
    const root = { messageId: 'message-1', sessionId: 'page-A', texts, status: 'pending' };
    const controller = { messageId: 'message-1', sessionId: 'page-A', aborted: false };
    const physical = { kind: 'provider.physical', messageId: 'message-1', sessionId: 'page-A',
      url: requestRecord.url, method: requestRecord.method, requestBody: requestRecord.postData,
      status: 'pending', controllerAbortedAtEnd: false };
    const contentOps = [];
    let released = false;
    let stopAcknowledged = false;
    let publishNetwork;
    let signalNetworkWait;
    const networkWaitStarted = new Promise(resolve => { signalNetworkWait = resolve; });
    const networkGate = new Promise(resolve => { publishNetwork = resolve; });
    const state = () => ({
      providerRoots: [{ ...root, status: released ? 'rejected' : 'pending',
        operationAborted: released, settledSequence: released ? 4 : undefined }],
      controllers: [{ ...controller, aborted: stopAcknowledged }],
      ledger: { operations: [
        { kind: 'provider.root', messageId: 'message-1', sessionId: 'page-A',
          status: released ? 'rejected' : 'pending', operationAborted: released,
          errorType: released ? 'USER_CANCELLED' : null,
          settledSequence: released ? 4 : undefined },
        { ...physical, status: released ? 'rejected' : 'pending',
          controllerAbortedAtEnd: released, errorType: released ? 'USER_CANCELLED' : null,
          settledSequence: released ? 5 : undefined },
        ...(stopAcknowledged ? [
          { kind: 'service.cancelRequest', sessionId: 'page-A', messageId: 'message-1', status: 'fulfilled',
            response: { handled: true, success: true }, controllerMatched: true, controllerAbortedBefore: false,
            controllerAbortedAfter: true, sequence: 2 },
          { kind: 'controller.abort', sessionId: 'page-A', messageId: 'message-1', sequence: 3 },
        ] : []),
      ] },
    });
    const evaluate = async (_chrome, _session, expression) => {
      if (expression.includes('resourceSnapshot')) return { sourceResolvers: { 'page-A': resolver } };
      if (expression.includes('window.__pageTranslationBenchmark.cancellationSnapshot')) {
        return { operations: contentOps, mutationSnapshot: { duplicateAcceptedIds: [] } };
      }
      if (expression.includes('cancellationSnapshot()')) return state();
      if (expression.includes('cancellationSnapshot("page-A")')) return state();
      if (expression.includes('measurementSnapshot')) return { acceptedIds: initialIds };
      if (expression.startsWith('(()=>({dom:')) return {
        dom: targets.map(target => [target.id, initialIds.includes(target.id) ? `\u200efixture translation: ${target.source}` : target.source]),
        metadata: protocol.initialDOMMetadata,
      };
      if (expression.includes('chrome.runtime.sendMessage')) {
        stopAcknowledged = true;
        contentOps.push({ kind: 'runtime.cancel.send', action: 'CANCEL_TRANSLATION', messageId: 'message-1',
          sessionId: 'page-A', targetSessionId: 'page-A', status: 'fulfilled', response: { success: true } });
        contentOps.push({ kind: 'session.invalidation', sessionId: 'page-A', capturedSessionActive: false,
          discoveryCancelled: true, sequence: 6, invalidationCallStartedAt: 31, invalidationCallCompletedAt: 32 });
        return { success: true };
      }
      throw new Error(`Unexpected mocked expression: ${expression}`);
    };
    const reservation = { hold: () => true, classifyRelease: () => true,
      release: async () => { released = true; return { ok: false, error: 'Invalid InterceptionId.' }; } };
    let siblingReleased = false;
    const siblingReservation = { hold: () => true, classifyRelease: () => true,
      release: async () => {
        siblingReleased = true;
        expect(protocol.productionCancellationEstablished).toBe(true);
        return { ok: true, action: 'fail' };
      } };
    const providerNetworkEvents = new Map();
    admitCustomCancellationRequest({ protocol, event: { sessionId: 'target-session', params: { networkId: 'network-1' } },
      requestRecord, requestId: 'fetch-1', reservation, body: texts, now: () => 15 });
    const until = async (read, timeout) => {
      const result = await read();
      if (result) return result;
      if (timeout === 10_000) {
        signalNetworkWait();
        await networkGate;
        return read();
      }
      throw new Error('Unexpected wait in test mock.');
    };
    const initiator = executeCustomCancellation({
      protocol, event: { sessionId: 'target-session', params: { networkId: 'network-1' } },
      requestId: 'fetch-1', requestRecord, body: texts, fixtureConfig: { targets, targetCount: targets.length },
      sessionId: 'page-A', providerNetworkEvents, chrome: {}, workerSession: 'worker', pageSession: 'page',
      contentContext: 1, evaluate, until, now: () => 30, reservation,
      sameProviderTexts: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    });
    await networkWaitStarted;
    const siblingRecord = { physicalAttemptId: 'attempt-2', method: 'POST', url: requestRecord.url,
      postData: requestRecord.postData, networkId: 'network-2', targetSessionId: 'target-session' };
    admitCustomCancellationRequest({ protocol, event: { sessionId: 'target-session', params: { networkId: 'network-2' } },
      requestRecord: siblingRecord, requestId: 'fetch-2', reservation: siblingReservation, body: texts, now: () => 16 });
    const sibling = executeCustomCancellation({
      protocol, event: { sessionId: 'target-session', params: { networkId: 'network-2' } },
      requestId: 'fetch-2', requestRecord: siblingRecord, body: texts, fixtureConfig: { targets, targetCount: targets.length },
      sessionId: 'page-A', providerNetworkEvents, chrome: {}, workerSession: 'worker', pageSession: 'page',
      contentContext: 1, evaluate, until, now: () => 30, reservation: siblingReservation,
      sameProviderTexts: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    });
    expect(siblingReleased).toBe(false);
    providerNetworkEvents.set('target-session:network-1',
      { wallTime: 20, startedAt: 10, outcome: 'failed', error: 'net::ERR_ABORTED' });
    providerNetworkEvents.set('target-session:network-2',
      { wallTime: 40, startedAt: 11, outcome: 'failed', error: 'net::ERR_ABORTED' });
    publishNetwork();
    await initiator;
    await expect(sibling).resolves.toBe(true);
    expect(siblingReleased).toBe(true);
    expect(protocol.admissions[1]).toMatchObject({
      relativeToInvalidation: 'before',
      networkRelativeToInvalidation: 'after',
    });
    expect(protocol.evidence.cancellation.physicalMatchCount).toBe(1);
    expect(protocol.evidence.releaseClassification.ok).toBe(true);
    expect(() => JSON.stringify({ protocol, requestRecord })).not.toThrow();
  });
});
