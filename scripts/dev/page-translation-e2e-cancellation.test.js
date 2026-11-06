// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  createCancellationLedger,
  classifyHeldFetchRelease,
  createCancellationRequestLifecycle,
  installCancellationRuntimeMessageObserver,
  installTrustedLifecycleObserver,
  parseCancellationProbeSelection,
  sessionIdForTranslationContext,
  trackRequiredCancellationPromise,
  validateActiveReplacementCheckpoint,
  validatePostInvalidationEvidence,
  validateCancellationQuiescence,
  validateCancellationSetup,
  validateMatchedCancellation,
  validateReplacementOwnership,
  validateSingleHeldRequest,
} from './page-translation-e2e-benchmark/cancellation-probes.mjs';

describe('Sliced discovery cancellation probe evidence', () => {
  it('parses only the three explicit cancellation cases', () => {
    expect(parseCancellationProbeSelection()).toEqual([]);
    expect(parseCancellationProbeSelection('stop,restore,replacement')).toEqual(['stop', 'restore', 'replacement']);
    expect(() => parseCancellationProbeSelection('stop,stop')).toThrow('Duplicate');
    expect(() => parseCancellationProbeSelection('unknown')).toThrow('Unsupported');
  });

  it('requires a genuine session, first batch acceptance, different held batch, and live matched controller', () => {
    const firstBatchIds = Array.from({ length: 25 }, (_, index) => `target-${index}`);
    const valid = { sessionId: 'A', firstBatchIds, acceptedIds: firstBatchIds, heldBatchIds: ['target-25'], heldControllerAborted: false, heldProviderRootStatus: 'pending' };
    expect(validateCancellationSetup(valid).ok).toBe(true);
    expect(validateCancellationSetup({ ...valid, heldBatchIds: ['target-0'] }).ok).toBe(false);
    expect(validateCancellationSetup({ ...valid, heldControllerAborted: true }).ok).toBe(false);
    expect(validateCancellationSetup({ ...valid, acceptedIds: firstBatchIds.slice(1) }).ok).toBe(false);
  });

  it('refuses to reuse one HTTP correlation proof for multiple held batches or another owner', () => {
    const held = { pageSessionId: 'A', requestId: 'fetch-1', batchMessageId: 'batch-1', targetIds: ['target-21'] };
    expect(validateSingleHeldRequest([held], 'A').ok).toBe(true);
    expect(validateSingleHeldRequest([held, { ...held, requestId: 'fetch-2' }], 'A').ok).toBe(false);
    expect(validateSingleHeldRequest([held], 'B').ok).toBe(false);
    expect(validateSingleHeldRequest([{ ...held, batchMessageId: null }], 'A').ok).toBe(false);
  });

  it('requires the actual matching service-cancel success before a later controller abort', () => {
    const valid = {
      sessionId: 'A', messageId: 'batch-A',
      serviceCall: {
        sequence: 10, sessionId: 'A', messageId: 'batch-A', status: 'fulfilled',
        controllerMatched: true, controllerAbortedBefore: false, controllerAbortedAfter: true,
        response: { handled: true, success: true },
      },
      abortEvent: { sequence: 11, sessionId: 'A', messageId: 'batch-A' },
      controller: { sessionId: 'A', messageId: 'batch-A', aborted: true },
    };
    expect(validateMatchedCancellation(valid).ok).toBe(true);
    expect(validateMatchedCancellation({ ...valid, serviceCall: { ...valid.serviceCall, response: { handled: true, success: false } } }).ok).toBe(false);
    expect(validateMatchedCancellation({ ...valid, serviceCall: { ...valid.serviceCall, controllerAbortedBefore: true } }).ok).toBe(false);
    expect(validateMatchedCancellation({ ...valid, abortEvent: { ...valid.abortEvent, sequence: 9 } }).ok).toBe(false);
    expect(validateMatchedCancellation({ ...valid, serviceCall: { ...valid.serviceCall, messageId: 'other-batch' } }).ok).toBe(false);
  });

  it('requires a currently active, trusted replacement owner and its pending live provider request', () => {
    const checkpoint = {
      sessionId: 'B', activeManagerSessionId: 'B', capturedSessionActive: true,
      currentBridgeOwnsSession: true, schedulerSessionContextOwned: true,
      trustedStart: { sessionId: 'B', action: 'page-translate-start', accepted: true, sequence: 12 },
      providerRoot: { sessionId: 'B', messageId: 'batch-B', status: 'pending' },
      controller: { sessionId: 'B', messageId: 'batch-B', aborted: false },
    };
    expect(validateActiveReplacementCheckpoint(checkpoint).ok).toBe(true);
    expect(validateActiveReplacementCheckpoint({ ...checkpoint, trustedStart: null }).ok).toBe(false);
    expect(validateActiveReplacementCheckpoint({ ...checkpoint, capturedSessionActive: false }).ok).toBe(false);
    expect(validateActiveReplacementCheckpoint({ ...checkpoint, providerRoot: { ...checkpoint.providerRoot, status: 'rejected' } }).ok).toBe(false);
    expect(validateActiveReplacementCheckpoint({ ...checkpoint, controller: { ...checkpoint.controller, aborted: true } }).ok).toBe(false);
  });

  it('accepts coordinator START only on exact success and preserves the installed method contract', () => {
    const observed = [];
    const calls = [];
    const failure = new Error('coordinator failed');
    const coordinator = {
      handleTrustedPageLifecycle(event, callback) {
        calls.push({ receiver: this, event, callback });
        callback?.();
        if (event.data.result === 'throw') throw failure;
        return event.data.result;
      },
    };
    expect(installTrustedLifecycleObserver(coordinator, 'handleTrustedPageLifecycle', event => observed.push(event))).toBe(true);
    const callback = () => calls.push({ callbackRan: true });
    const failed = { action: 'page-translate-start', data: { sessionId: 'B', result: { success: false, ignored: false } } };
    const result = coordinator.handleTrustedPageLifecycle(failed, callback);
    expect(result).toBe(failed.data.result);
    expect(calls[0].receiver).toBe(coordinator);
    expect(calls[0].event).toBe(failed);
    expect(calls[0].callback).toBe(callback);
    expect(observed.at(-1)).toMatchObject({ sessionId: 'B', action: 'page-translate-start', accepted: false });
    coordinator.handleTrustedPageLifecycle({ action: 'page-translate-start', data: { sessionId: 'B', result: undefined } });
    expect(observed.at(-1).accepted).toBe(false);
    coordinator.handleTrustedPageLifecycle({ action: 'page-translate-start', data: { sessionId: 'B', result: { success: true, ignored: true } } });
    expect(observed.at(-1).accepted).toBe(false);
    coordinator.handleTrustedPageLifecycle({ action: 'page-translate-start', data: { sessionId: 'B', result: { success: true, ignored: false } } });
    expect(observed.at(-1).accepted).toBe(true);
    expect(() => coordinator.handleTrustedPageLifecycle({ action: 'x', data: { sessionId: 'B', result: 'throw' } })).toThrow(failure);
  });

  it('records an unsupported native sendMessage return without changing receiver, args, callbacks, or return value', () => {
    const ledger = createCancellationLedger();
    const instrumentationErrors = [];
    const calls = [];
    const callback = () => {};
    const runtime = {
      sendMessage(...args) { calls.push({ receiver: this, args }); return undefined; },
    };
    expect(installCancellationRuntimeMessageObserver(runtime, ledger, error => instrumentationErrors.push(error)).installed).toBe(true);
    const message = { action: 'CANCEL_SESSION', data: { sessionId: 'A' } };
    expect(runtime.sendMessage(message, callback)).toBeUndefined();
    expect(calls).toEqual([{ receiver: runtime, args: [message, callback] }]);
    expect(instrumentationErrors).toEqual(['runtime.cancelSession.send expected a Promise result.']);
    expect(ledger.snapshot('A').operations).toMatchObject([
      { kind: 'runtime.cancelSession.send', action: 'CANCEL_SESSION', status: 'unsupported-non-promise' },
    ]);
  });

  it('does not mistake cancellation acknowledgement or a fetch release for provider quiescence', () => {
    const proof = {
      sessionId: 'A', capturedSessionActive: false, discoveryCancelled: true, controllerAborted: true,
      pendingOperations: 0, heldRequestReleased: true, providerRootSettled: true, cancelAcknowledged: true,
    };
    expect(validateCancellationQuiescence(proof).ok).toBe(true);
    expect(validateCancellationQuiescence({ ...proof, providerRootSettled: false, pendingOperations: 1 }).ok).toBe(false);
    expect(validateCancellationQuiescence({ ...proof, cancelTargetSessionId: 'B' }).issues).toContain('cancellation targeted a different session');
    expect(validateCancellationQuiescence({ ...proof, heldRequestReleased: false }).ok).toBe(false);
  });

  it('classifies only a matching post-abort Fetch error with actual provider and root settlement', () => {
    const evidence = {
      heldRequestId: 'fetch-A', matchedRequestId: 'fetch-A',
      releaseOutcome: { ok: false, error: 'Invalid InterceptionId.' }, networkCanceled: false,
      controllerAborted: true, cancelTargetMatched: true,
      providerRootStatus: 'rejected', physicalStatus: 'rejected', physicalControllerAborted: true,
      controllerAbortSequence: 4, providerRootSettledSequence: 6, physicalSettledSequence: 5,
    };
    expect(classifyHeldFetchRelease(evidence)).toMatchObject({
      ok: true, classification: 'invalid-fetch-id-after-matched-abort-and-provider-root-plus-physical-rejection',
    });
    expect(classifyHeldFetchRelease({ ...evidence, physicalStatus: 'pending' }).ok).toBe(false);
    expect(classifyHeldFetchRelease({ ...evidence, matchedRequestId: 'fetch-B' }).ok).toBe(false);
    expect(classifyHeldFetchRelease({ ...evidence, cancelTargetMatched: false }).ok).toBe(false);
    expect(classifyHeldFetchRelease({ ...evidence, controllerAbortSequence: 9 }).ok).toBe(false);
    expect(classifyHeldFetchRelease({ ...evidence, releaseOutcome: { ok: false, error: 'Target closed.' } }).ok).toBe(false);
    expect(classifyHeldFetchRelease({ ...evidence, releaseOutcome: { ok: false, error: 'Invalid InterceptionId.' }, matchedRequestId: 'fetch-B' }).classification)
      .toBe('unclassified-cdp-release-error');
  });

  it('closes Fetch admission before sweeping and drains handlers admitted during that close barrier', async () => {
    const dispatches = [];
    const lifecycle = createCancellationRequestLifecycle(async (record, action) => {
      dispatches.push({ requestId: record.requestId, action });
      return { ok: true, action };
    });
    let finishCorrelation;
    const correlation = new Promise(resolve => { finishCorrelation = resolve; });
    const runHandler = record => lifecycle.trackHandler(record, (async () => {
      await correlation;
      if (record.hold()) await record.waitForRelease();
      await record.release('fulfill');
    })());
    const first = lifecycle.reserve({ requestId: 'held-before-cleanup', sessionId: 'A' });
    runHandler(first);
    let late;
    const result = await lifecycle.closeAndDrain({
      timeoutMs: 1_000,
      disableFetch: async () => {
        expect(lifecycle.closing).toBe(true);
        late = lifecycle.reserve({ requestId: 'arrived-before-Fetch.disable-ack', sessionId: 'A' });
        runHandler(late);
        finishCorrelation();
      },
    });
    expect(result.ok).toBe(true);
    expect(result.handlerCount).toBe(0);
    expect(result.reservations).toHaveLength(2);
    expect(result.reservations.every(record => record.handlerSettled && record.releaseOutcome?.ok)).toBe(true);
    expect(dispatches).toEqual([
      { requestId: 'held-before-cleanup', action: 'fail' },
      { requestId: 'arrived-before-Fetch.disable-ack', action: 'fail' },
    ]);
    let chromeClosed = false;
    expect(result.handlerCount).toBe(0);
    chromeClosed = true;
    expect(chromeClosed).toBe(true);
  });

  it('keeps promises registered during a drain and preserves origin session attribution', () => {
    const ledger = createCancellationLedger();
    const root = ledger.begin('provider-root', 'A', { messageId: 'batch-A' });
    const snapshotBeforeLateChild = ledger.snapshot('A');
    expect(snapshotBeforeLateChild.pending).toBe(1);
    const child = ledger.begin('provider-physical', 'A', { messageId: 'batch-A', fetchId: 'fetch-1' });
    ledger.settle(root, 'rejected', { reason: 'AbortError' });
    expect(ledger.snapshot('A').pending).toBe(1);
    const lateDelivery = ledger.record('lifecycle-delivery', 'A', { deliveredWhileSession: 'B', accepted: false });
    expect(lateDelivery.sessionId).toBe('A');
    expect(lateDelivery.deliveredWhileSession).toBe('B');
    ledger.settle(child, 'fulfilled');
    expect(ledger.snapshot('A').pending).toBe(0);
    expect(ledger.snapshot('B').operations).toEqual([]);
  });

  it('resolves settlement ownership from the item context, not the scheduler current session', () => {
    const contexts = new Map([[Symbol.for('session-A'), 'A'], [Symbol.for('session-B'), 'B']]);
    const currentSchedulerSession = 'B';
    const item = { context: Symbol.for('session-A') };
    expect(sessionIdForTranslationContext(contexts, item.context)).toBe('A');
    expect(sessionIdForTranslationContext(contexts, Symbol.for('unknown'))).toBeNull();
    expect(sessionIdForTranslationContext(contexts, item.context)).not.toBe(currentSchedulerSession);
  });

  it('blocks quiescence on pending CANCEL_SESSION and rejects unsupported callback-style results', () => {
    const ledger = createCancellationLedger();
    const pendingErrors = [];
    trackRequiredCancellationPromise(ledger, 'runtime.cancelSession.send', 'A', new Promise(() => {}), { action: 'CANCEL_SESSION' }, message => pendingErrors.push(message));
    const pending = ledger.snapshot('A');
    expect(pending.pending).toBe(1);
    expect(validateCancellationQuiescence({
      sessionId: 'A', capturedSessionActive: false, discoveryCancelled: true, controllerAborted: true,
      pendingOperations: pending.pending, heldRequestReleased: true, providerRootSettled: true, cancelAcknowledged: true,
    }).ok).toBe(false);
    expect(pendingErrors).toEqual([]);

    const unsupportedLedger = createCancellationLedger();
    const instrumentationErrors = [];
    const tracked = trackRequiredCancellationPromise(unsupportedLedger, 'runtime.cancelSession.send', 'A', undefined,
      { action: 'CANCEL_SESSION' }, message => instrumentationErrors.push(message));
    expect(tracked.supported).toBe(false);
    expect(instrumentationErrors).toEqual(['runtime.cancelSession.send expected a Promise result.']);
    expect(unsupportedLedger.snapshot('A').pending).toBe(0);
  });

  it('uses continuation settlement sequence and owner-attributed mutations at invalidation', () => {
    const invalidationSequence = 10;
    const pendingA = { kind: 'node.continuation', sessionId: 'A', sequence: 7, settledSequence: 15, id: 'target-1' };
    const bWrite = { kind: 'dom.acceptedMutation', sessionId: 'B', sequence: 17, id: 'target-2', originTransitionCaptured: true };
    const proof = validatePostInvalidationEvidence({
      sessionId: 'A', invalidationSequence, operations: [pendingA, bWrite], allowedMutationOwners: ['B'],
    });
    expect(proof.ok).toBe(true);
    expect(proof.lateNodeContinuations).toEqual([pendingA]);
    expect(validatePostInvalidationEvidence({
      sessionId: 'A', invalidationSequence,
      operations: [{ kind: 'scheduler.settlement', sessionId: 'A', sequence: 11, outcome: 'accepted', changed: true, id: 'target-1' }],
    }).ok).toBe(false);
    expect(validatePostInvalidationEvidence({
      sessionId: 'A', invalidationSequence,
      operations: [{ kind: 'dom.acceptedMutation', sessionId: null, sequence: 12, id: 'target-3', originTransitionCaptured: false }],
    }).ok).toBe(false);
    expect(validatePostInvalidationEvidence({
      sessionId: 'A', invalidationSequence, operations: [], duplicateAcceptedIds: ['target-2'],
    }).ok).toBe(false);
  });

  it('reserves and tracks request handlers before correlation, then drains late admissions before target close', async () => {
    const dispatched = [];
    const lifecycle = createCancellationRequestLifecycle(async (record, action) => {
      dispatched.push({ requestId: record.requestId, action });
      return { ok: true, action };
    });
    let finishCorrelation;
    const correlation = new Promise(resolve => { finishCorrelation = resolve; });
    const runHandler = record => lifecycle.trackHandler(record, (async () => {
      await correlation;
      if (record.hold()) await record.waitForRelease();
      await record.release('fulfill');
    })());
    runHandler(lifecycle.reserve({ requestId: 'paused-before-cleanup', sessionId: 'A' }));
    let closeTargetCalled = false;
    const cleanup = await lifecycle.closeAndDrain({
      timeoutMs: 1_000,
      disableFetch: async () => {
        expect(lifecycle.closing).toBe(true);
        runHandler(lifecycle.reserve({ requestId: 'paused-during-disable-ack', sessionId: 'A' }));
        finishCorrelation();
      },
    });
    expect(cleanup.ok).toBe(true);
    expect(cleanup.handlerCount).toBe(0);
    expect(cleanup.reservations.every(item => item.handlerSettled && item.releaseOutcome?.ok)).toBe(true);
    expect(dispatched).toEqual([
      { requestId: 'paused-before-cleanup', action: 'fail' },
      { requestId: 'paused-during-disable-ack', action: 'fail' },
    ]);
    closeTargetCalled = true;
    expect(closeTargetCalled).toBe(true);
  });

  it('requires retained A and new B ownership to be disjoint and complete', () => {
    const a = Array.from({ length: 25 }, (_, index) => `target-${index}`);
    const b = Array.from({ length: 975 }, (_, index) => `target-${index + 25}`);
    const expected = Array.from({ length: 1000 }, (_, index) => `target-${index}`);
    expect(validateReplacementOwnership({ acceptedAIds: a, acceptedBIds: b, finalTranslatedIds: expected, expectedIds: expected }).ok).toBe(true);
    expect(validateReplacementOwnership({ acceptedAIds: a, acceptedBIds: [...b, a[0]], finalTranslatedIds: expected, expectedIds: expected }).ok).toBe(false);
    expect(validateReplacementOwnership({ acceptedAIds: a, acceptedBIds: [...b, b[0]], finalTranslatedIds: expected, expectedIds: expected }).issues)
      .toContain('duplicate successful B acceptance events');
    expect(validateReplacementOwnership({ acceptedAIds: [...a, a[0]], acceptedBIds: b, finalTranslatedIds: expected, expectedIds: expected }).issues)
      .toContain('duplicate successful A acceptance events');
    expect(validateReplacementOwnership({ acceptedAIds: a, acceptedBIds: b, finalTranslatedIds: expected.slice(0, 999), expectedIds: expected }).ok).toBe(false);
  });
});
