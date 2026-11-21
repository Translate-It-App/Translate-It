import { describe, expect, it } from 'vitest';
import { cleanupMeasurementBeforeResources, completeTranslationMeasurement, drainAndDisconnectMeasurementObservers, findFinalTranslationTerminal, groupMutationRecords, isDuplicateAcceptedMutation, summarizeAcceptanceTimes, trackAcceptedTarget, trackCohortAcceptedTarget } from './e2e-benchmark/measurement-lifecycle.mjs';

describe('translation measurement lifecycle boundary', () => {
  it('preserves static count-based completion without an explicit dynamic inventory', () => {
    const acceptedIds = new Set();
    const firstAcceptedAtById = {};
    const completionTimes = { visible: null, all: null };
    const record = (id, at) => trackAcceptedTarget({
      id, at, acceptedIds, firstAcceptedAtById, visibleIds: [], targetCount: 2, completionTimes,
    });
    record('static-a', 10);
    expect(completionTimes.all).toBeNull();
    record('static-b', 20);
    expect(completionTimes).toEqual({ visible: null, all: 20 });
  });

  it('keeps initial-set completion separate from known all-target completion', () => {
    const initialTargetIds = Array.from({ length: 12 }, (_, index) => `target-${index}`);
    const dynamicTargetIds = Array.from({ length: 6 }, (_, index) => `dynamic-${index}`);
    const expectedTargetIds = [...initialTargetIds, ...dynamicTargetIds];
    const completionTimes = { visible: null, initialAll: null, all: null, initialMaxAcceptedAt: null, allMaxAcceptedAt: null };
    const acceptedIds = new Set();
    const firstAcceptedAtById = {};
    const nonIterableRemainingIds = ids => {
      const remaining = new Set(ids);
      return {
        has: id => remaining.has(id),
        delete: id => remaining.delete(id),
        get size() { return remaining.size; },
        [Symbol.iterator]() { throw new Error('Dynamic completion must not scan the inventory.'); },
      };
    };
    const visibleRemainingIds = nonIterableRemainingIds(initialTargetIds);
    const initialRemainingIds = nonIterableRemainingIds(initialTargetIds);
    const expectedRemainingIds = nonIterableRemainingIds(expectedTargetIds);
    const record = (id, at) => trackAcceptedTarget({
      id, at, acceptedIds, firstAcceptedAtById, visibleIds: [], targetCount: initialTargetIds.length,
      visibleRemainingIds, initialRemainingIds, expectedRemainingIds, completionTimes,
    });
    initialTargetIds.forEach((id, index) => record(id, index + 1));
    expect(completionTimes.visible).toBe(12);
    expect(completionTimes.initialAll).toBe(12);
    expect(completionTimes.all).toBeNull();
    dynamicTargetIds.forEach((id, index) => record(id, index + 13));
    expect(completionTimes.initialAll).toBe(12);
    expect(completionTimes.all).toBe(18);
    const cohortIds = ['dynamic-0', 'dynamic-1'];
    const cohort = {
      targetIds: cohortIds,
      remainingIds: nonIterableRemainingIds(cohortIds),
      firstAcceptedAt: null,
      completionAt: null,
      acceptedAtById: {},
    };
    expect(trackCohortAcceptedTarget(cohort, cohortIds[0], 19)).toBe(true);
    expect(trackCohortAcceptedTarget(cohort, cohortIds[0], 20)).toBe(false);
    expect(trackCohortAcceptedTarget(cohort, cohortIds[1], 21)).toBe(true);
    expect(cohort).toMatchObject({ firstAcceptedAt: 19, completionAt: 21 });
    const summary = summarizeAcceptanceTimes(firstAcceptedAtById, [], expectedTargetIds);
    expect(summary.allTargetsCompletionAt).toBe(18);
    expect(summarizeAcceptanceTimes(firstAcceptedAtById, [], initialTargetIds).allTargetsCompletionAt).toBe(12);
  });

  it('selects only a same-session terminal with full expected completion evidence', () => {
    const event = (action, translatedCount, totalCount, failedCount, owner = 'session-dynamic') => ({
      message: {
        action: 'page-translation-frame-lifecycle',
        data: { action, data: { sessionId: owner, translatedCount, totalCount, failedCount } },
      },
    });
    const early = event('page-translate-idle', 12, 12, 0);
    const partial = event('page-translate-complete', 15, 18, 0);
    const wrongOwner = event('page-translate-idle', 18, 18, 0, 'other-session');
    const final = event('page-translate-idle', 18, 18, 0);
    expect(findFinalTranslationTerminal([early, partial, wrongOwner, final], 'session-dynamic', 18)).toBe(final);
    expect(findFinalTranslationTerminal([early, partial, wrongOwner], 'session-dynamic', 18)).toBeNull();
    expect(findFinalTranslationTerminal([event('page-translate-complete', 18, 18, 1)], 'session-dynamic', 18)).toBeNull();
  });

  it('allows an explicitly expected terminal failure count without changing the default', () => {
    const partial = {
      message: {
        action: 'page-translation-frame-lifecycle',
        data: { action: 'page-translate-complete', data: { sessionId: 'session-partial',
          translatedCount: 975, totalCount: 1000, failedCount: 25 } },
      },
    };
    expect(findFinalTranslationTerminal([partial], 'session-partial', 1000)).toBeNull();
    expect(findFinalTranslationTerminal([partial], 'session-partial', 1000, 25)).toBe(partial);
    expect(findFinalTranslationTerminal([partial], 'session-partial', 1000, 24)).toBeNull();
    expect(findFinalTranslationTerminal([{
      ...partial,
      message: { ...partial.message, data: { ...partial.message.data,
        data: { ...partial.message.data.data, translatedCount: 1000 } } },
    }], 'session-partial', 1000, 25)).toBeNull();
  });

  it('stops translation observers after exact completion/DOM acceptance and before real Restore', async () => {
    const order = [];
    const state = { attempted: true, started: true, stopped: false, stopAttempts: 0 };
    let mutationWrites = ['translation-accepted'];
    const longTasks = [];
    const lifecycleEvents = [];
    const lifecycle = await completeTranslationMeasurement({
      state,
      cleanupErrors: [],
      awaitAcceptedTranslation: async () => {
        order.push('completion-session-and-dom-validated');
        return { sessionId: 'session-current', translatedCount: 12 };
      },
      stopMeasurement: async () => {
        order.push('stop-translation-observers');
        const frozen = { available: true, stoppedAt: Date.now(), mutations: [...mutationWrites], longTasks: [...longTasks] };
        return frozen;
      },
      sendRestore: async () => { order.push('send-real-restore'); return { success: true }; },
      awaitRestoredDOM: async () => {
        order.push('restore-session-and-original-DOM-validated');
        mutationWrites.push('restore-write');
        longTasks.push({ source: 'Restore task' });
        lifecycleEvents.push({ action: 'page-restore-complete', sessionId: 'session-current' });
        return { sessionId: 'session-current', restoredCount: 12 };
      },
    });

    expect(order).toEqual([
      'completion-session-and-dom-validated',
      'stop-translation-observers',
      'send-real-restore',
      'restore-session-and-original-DOM-validated',
    ]);
    expect(lifecycle.measurement.mutations).toEqual(['translation-accepted']);
    expect(lifecycle.measurement.longTasks).toEqual([]);
    expect(lifecycle.measurement.stoppedAt).toBeLessThanOrEqual(lifecycle.restoreStartedAt);
    expect(lifecycle.restoreCompletedAt).toBeGreaterThanOrEqual(lifecycle.restoreStartedAt);
    expect(lifecycle.restored.restoredCount).toBe(12);
    expect(lifecycleEvents).toContainEqual({ action: 'page-restore-complete', sessionId: 'session-current' });
    expect(state.stopAttempts).toBe(1);
    expect(state.stopped).toBe(true);
  });

  it('stops observers on early translation failure without issuing Restore and preserves that failure', async () => {
    const primary = new Error('translation failed');
    const cleanupErrors = [];
    const state = { attempted: true, started: true, stopped: false, stopAttempts: 0 };
    let stopCount = 0;
    const sendRestore = async () => { throw new Error('Restore must not run'); };
    await expect(completeTranslationMeasurement({
      state, cleanupErrors,
      awaitAcceptedTranslation: async () => { throw primary; },
      stopMeasurement: async () => { stopCount++; return { available: true }; },
      sendRestore,
      awaitRestoredDOM: async () => null,
    })).rejects.toBe(primary);
    expect(stopCount).toBe(1);
    expect(state.stopped).toBe(true);
    expect(cleanupErrors).toEqual([]);
  });

  it('does not stop twice after a successful measurement stop when Restore fails', async () => {
    const state = { attempted: true, started: true, stopped: false, stopAttempts: 0 };
    let stopCount = 0;
    await expect(completeTranslationMeasurement({
      state, cleanupErrors: [],
      awaitAcceptedTranslation: async () => ({ sessionId: 's' }),
      stopMeasurement: async () => { stopCount++; return { available: true }; },
      sendRestore: async () => ({ success: false, error: 'Restore failed' }),
      awaitRestoredDOM: async () => null,
    })).rejects.toThrow('PAGE_RESTORE rejected');
    expect(stopCount).toBe(1);
    expect(state.stopped).toBe(true);
  });

  it('attempts observer cleanup before independent resource cleanups and retains cleanup failures', async () => {
    const order = [];
    const cleanupErrors = [];
    const state = { attempted: true, started: true, stopped: false, stopAttempts: 0 };
    const primary = new Error('primary lifecycle failure');
    let reportedPrimary;
    try {
      await completeTranslationMeasurement({
        state, cleanupErrors,
        awaitAcceptedTranslation: async () => { throw primary; },
        stopMeasurement: async () => { order.push('observer-stop'); throw new Error('observer-stop-error'); },
        sendRestore: async () => ({ success: true }),
        awaitRestoredDOM: async () => null,
      });
    } catch (error) { reportedPrimary = error; }
    await cleanupMeasurementBeforeResources({
      state,
      stopMeasurement: async () => { order.push('duplicate-observer-stop'); return { available: true }; },
      resources: [
        async () => { order.push('chrome-close'); throw new Error('chrome-close-error'); },
        async () => { order.push('server-close'); },
      ],
      cleanupErrors,
    });
    expect(reportedPrimary).toBe(primary);
    expect(order).toEqual(['observer-stop', 'chrome-close', 'server-close']);
    expect(cleanupErrors).toEqual(['Measurement observer cleanup: observer-stop-error', 'chrome-close-error']);
    expect(state.stopAttempts).toBe(1);
  });

  it.each([false, true])('cleans up an active measurement after failure before completion polling (stop fails=%s)', async fails => {
    const order = [];
    const cleanupErrors = [];
    const state = { attempted: true, started: true, stopped: false, stopAttempts: 0 };
    await cleanupMeasurementBeforeResources({
      state,
      stopMeasurement: async () => {
        order.push('observer-stop');
        if (fails) throw new Error('observer-stop-error');
        return { available: true };
      },
      resources: [async () => { order.push('chrome-close'); }, async () => { order.push('server-close'); }],
      cleanupErrors,
    });
    expect(order).toEqual(['observer-stop', 'chrome-close', 'server-close']);
    expect(cleanupErrors).toEqual(fails ? ['Measurement observer cleanup: observer-stop-error'] : []);
    expect(state.stopAttempts).toBe(1);
  });

  it('does not call stop before measurement starts or after observers are already stopped', async () => {
    let calls = 0;
    const stopMeasurement = async () => { calls++; return { available: true }; };
    await cleanupMeasurementBeforeResources({
      state: { attempted: false, started: false, stopped: false, stopAttempts: 0 },
      stopMeasurement, resources: [], cleanupErrors: [],
    });
    await cleanupMeasurementBeforeResources({
      state: { attempted: true, started: true, stopped: true, stopAttempts: 1 },
      stopMeasurement, resources: [], cleanupErrors: [],
    });
    expect(calls).toBe(0);
  });

  it('drains and disconnects both observers even when mutation or long-task processing throws', () => {
    const order = [];
    const mutationFailure = new Error('mutation drain failed');
    const longTaskFailure = new Error('long-task drain failed');
    const mutationObserver = {
      takeRecords() { order.push('take-mutations'); return [1]; },
      disconnect() { order.push('disconnect-mutations'); },
    };
    const longTaskObserver = {
      takeRecords() { order.push('take-longtasks'); throw longTaskFailure; },
      disconnect() { order.push('disconnect-longtasks'); },
    };
    expect(() => drainAndDisconnectMeasurementObservers({
      mutationObserver,
      processMutations() { throw mutationFailure; },
      longTaskObserver,
      processLongTasks() {},
    })).toThrow(AggregateError);
    expect(order).toEqual(['take-mutations', 'disconnect-mutations', 'take-longtasks', 'disconnect-longtasks']);
  });

  it('coalesces mutation records per target and only calls a repeated accepted text write a duplicate', () => {
    const element = { dataset: { benchId: 'target-1' } };
    const records = [
      { target: { element }, type: 'characterData', oldValue: 'source' },
      { target: { element }, type: 'characterData', oldValue: 'intermediate' },
    ];
    const groups = groupMutationRecords(records, record => record.target.element.dataset.benchId);
    expect(groups).toHaveLength(1);
    expect(groups[0].records).toHaveLength(2);
    const expectedText = '\u200efixture translation: source';
    expect(isDuplicateAcceptedMutation({ wasAlreadyAccepted: false, expectedText, resultingText: expectedText, records: groups[0].records })).toBe(false);
    expect(isDuplicateAcceptedMutation({
      wasAlreadyAccepted: true, expectedText, resultingText: expectedText,
      records: [{ type: 'characterData', oldValue: expectedText, target: { nodeValue: expectedText } }],
    })).toBe(true);
  });
});
