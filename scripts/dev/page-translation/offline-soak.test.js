import { describe, expect, it } from 'vitest';
import { restoreSnapshotsMatch, runOfflineSoak, RESOURCE_COMPONENTS, SCENARIO_NAMES } from './e2e-benchmark/offline-soak.mjs';

const TARGET_IDS = Array.from({ length: 1000 }, (_, index) => `target-${index}`);

describe('restoreSnapshotsMatch', () => {
  it('accepts exact DOM snapshots and rejects missing or changed snapshots', () => {
    const original = [['target-0', 'source']];
    expect(restoreSnapshotsMatch(original, [['target-0', 'source']])).toBe(true);
    expect(restoreSnapshotsMatch(original, [['target-0', 'translated']])).toBe(false);
    expect(restoreSnapshotsMatch(original, undefined)).toBe(false);
  });
});

function evidence(id, overrides = {}) {
  return {
    passed: true,
    sessionIds: [id],
    observedPhysicalRequestCounts: { fetch: 2 },
    logicalBatchEvidence: {
      observed: true,
      crossSessionAcceptance: false,
      duplicateWrite: false,
    },
    concurrencyEvidence: { peakActiveRequests: 2, peakLogicalBatches: 1 },
    targetCount: 1000,
    acceptedTargetIds: TARGET_IDS,
    expectedTargetIds: TARGET_IDS,
    restoreExact: true,
    metadataExact: true,
    terminalOutcome: { status: id.includes('partial-stop-restore') ? 'stopped' : 'completed' },
    acceptedCount: 100,
    correlatedHeldFetch: true,
    cancellationConfirmed: true,
    noStaleWrites: true,
    sessionA: `${id}-A`,
    sessionB: `${id}-B`,
    acceptedAIds: [],
    acceptedBIds: TARGET_IDS,
    bOwnershipValid: true,
    resourceSnapshot: Object.fromEntries(RESOURCE_COMPONENTS.map(component => [
      component, { active: 0, history: 1 },
    ])),
    ...overrides,
  };
}

function scenarioEvidence(id, scenarioName, overrides = {}) {
  return evidence(id, {
    ...(scenarioName === 'stale-success-replacement' ? { sessionIds: [`${id}-A`, `${id}-B`] } : {}),
    ...overrides,
  });
}

describe('runOfflineSoak', () => {
  it('runs exactly ten ordered cycles and reuses one caller-owned context', async () => {
    const context = { browser: { owner: true } };
    const calls = [];
    const seenContexts = [];
    const observedContexts = [];
    const result = await runOfflineSoak({
      context,
      timeoutMs: 100,
      onScenario: async ({ context: received }) => observedContexts.push(received),
      runScenario: async ({ scenarioName, cycle, context: received }) => {
        calls.push([cycle, scenarioName]);
        seenContexts.push(received);
        return scenarioEvidence(`${cycle}-${scenarioName}`, scenarioName);
      },
    });

    expect(calls).toHaveLength(30);
    expect(calls).toEqual(Array.from({ length: 10 }, (_, i) =>
      SCENARIO_NAMES.map(name => [i + 1, name])).flat());
    expect(seenContexts.every(item => item === context)).toBe(true);
    expect(observedContexts).toHaveLength(30);
    expect(observedContexts.every(item => item === context)).toBe(true);
    expect(result.cycles).toHaveLength(10);
    expect(result.cumulative.observedPhysicalRequestCounts.fetch).toBe(60);
    expect(result.cumulative.sessionIds).toHaveLength(40);
  });

  it('rejects any cycle count other than ten', async () => {
    await expect(runOfflineSoak({
      cycleCount: 9,
      timeoutMs: 100,
      runScenario: async () => evidence('unused'),
    })).rejects.toThrow('cycleCount must be exactly 10');
  });

  it('rejects retained active resources at each scenario boundary', async () => {
    const badResources = Object.fromEntries(RESOURCE_COMPONENTS.map(component => [
      component, { active: component === 'scheduler' ? 1 : 0, history: 4 },
    ]));
    await expect(runOfflineSoak({
      timeoutMs: 100,
      runScenario: async ({ cycle, scenarioName }) => scenarioEvidence(`${cycle}-${scenarioName}`, scenarioName, {
        resourceSnapshot: badResources,
      }),
    })).rejects.toMatchObject({
      name: 'OfflineSoakError',
      artifact: {
        cycles: [{ scenarios: [{ status: 'failed' }] }],
      },
    });
  });

  it('rejects stale-session acceptance and duplicate writes', async () => {
    const artifactError = runOfflineSoak({
      timeoutMs: 100,
      runScenario: async ({ cycle, scenarioName }) => scenarioEvidence(`${cycle}-${scenarioName}`, scenarioName, {
        logicalBatchEvidence: {
          observed: true,
          crossSessionAcceptance: true,
          duplicateWrite: false,
          acceptedSessionId: 'A',
          currentSessionId: 'B',
        },
      }),
    });
    await expect(artifactError).rejects.toMatchObject({
      artifact: { cycles: [{ scenarios: [{ status: 'failed' }] }] },
    });

    await expect(runOfflineSoak({
      timeoutMs: 100,
      runScenario: async ({ cycle, scenarioName }) => scenarioEvidence(`${cycle}-${scenarioName}`, scenarioName, {
        logicalBatchEvidence: { observed: true, crossSessionAcceptance: false, duplicateWrite: true },
      }),
    })).rejects.toThrow(/duplicateWrite false/);
  });

  it.each([
    ['A acceptance', { acceptedAIds: ['target-0'] }, /acceptedAIds/],
    ['corrupted B ownership', { bOwnershipValid: false }, /bOwnershipValid/],
    ['reused A/B session', { sessionA: 'same-session', sessionB: 'same-session' }, /sessionA and sessionB/],
    ['missing B target set', { acceptedBIds: undefined }, /acceptedBIds/],
    ['short B target set', { acceptedBIds: TARGET_IDS.slice(0, 999) }, /acceptedBIds/],
  ])('rejects stale replacement evidence with %s', async (_label, overrides, message) => {
    await expect(runOfflineSoak({
      timeoutMs: 100,
      runScenario: async ({ cycle, scenarioName }) => scenarioEvidence(`${cycle}-${scenarioName}`, scenarioName, {
        ...(scenarioName === 'stale-success-replacement' ? overrides : {}),
      }),
    })).rejects.toThrow(message);
  });

  it('preserves completed and invalid partial evidence when required resource evidence is missing', async () => {
    const resultFor = ({ cycle, scenarioName }) => {
      const result = scenarioEvidence(`${cycle}-${scenarioName}`, scenarioName);
      if (cycle === 1 && scenarioName === SCENARIO_NAMES[1]) delete result.resourceSnapshot['Fetch reservations'];
      return result;
    };
    try {
      await runOfflineSoak({ timeoutMs: 100, runScenario: resultFor });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error.name).toBe('OfflineSoakError');
      expect(error.artifact.cycles[0].scenarios.map(record => record.status)).toEqual(['complete', 'failed']);
      expect(error.artifact.cycles[0].scenarios[1].result.resourceSnapshot['Fetch reservations']).toBeUndefined();
      expect(error.message).toMatch(/Fetch reservations/);
    }
  });

  it('rejects empty physical-request counters or counters that observed no requests', async () => {
    await expect(runOfflineSoak({
      timeoutMs: 100,
      runScenario: async ({ cycle, scenarioName }) => scenarioEvidence(`${cycle}-${scenarioName}`, scenarioName, {
        observedPhysicalRequestCounts: {},
      }),
    })).rejects.toThrow(/at least one named counter/);

    await expect(runOfflineSoak({
      timeoutMs: 100,
      runScenario: async ({ cycle, scenarioName }) => scenarioEvidence(`${cycle}-${scenarioName}`, scenarioName, {
        observedPhysicalRequestCounts: { customFetch: 0 },
      }),
    })).rejects.toThrow(/at least one observed request/);
  });

  it.each([
    ['physical peak over two', 'complete-restore', { peakActiveRequests: 3 }, /peakActiveRequests 1\.\.2/],
    ['logical peak over complete/partial limit', 'complete-restore', { peakLogicalBatches: 3 }, /peakLogicalBatches 1\.\.2/],
    ['logical peak over partial limit', 'partial-stop-restore', { peakLogicalBatches: 3 }, /peakLogicalBatches 1\.\.2/],
    ['logical peak over replacement limit', 'stale-success-replacement', { peakLogicalBatches: 4 }, /peakLogicalBatches 1\.\.3/],
    ['zero physical peak with requests observed', 'complete-restore', {
      peakActiveRequests: 0, peakLogicalBatches: 1,
    }, /concurrencyEvidence peaks/],
    ['zero logical peak with requests observed', 'complete-restore', {
      peakActiveRequests: 1, peakLogicalBatches: 0,
    }, /concurrencyEvidence peaks/],
  ])('rejects invalid concurrency evidence: %s', async (_label, targetScenario, concurrencyEvidence, message) => {
    await expect(runOfflineSoak({
      timeoutMs: 100,
      runScenario: async ({ cycle, scenarioName }) => scenarioEvidence(`${cycle}-${scenarioName}`, scenarioName, {
        ...(scenarioName === targetScenario ? { concurrencyEvidence } : {}),
      }),
    })).rejects.toThrow(message);
  });

  it.each([
    ['missing accepted targets', { acceptedTargetIds: undefined }],
    ['duplicate accepted targets', { acceptedTargetIds: [...TARGET_IDS.slice(0, 999), TARGET_IDS[0]] }],
    ['foreign accepted target', { acceptedTargetIds: [...TARGET_IDS.slice(0, 999), 'foreign-target'] }],
  ])('rejects complete acceptance evidence with %s', async (_label, overrides) => {
    await expect(runOfflineSoak({
      timeoutMs: 100,
      runScenario: async ({ cycle, scenarioName }) => scenarioEvidence(`${cycle}-${scenarioName}`, scenarioName, {
        ...(scenarioName === 'complete-restore' ? overrides : {}),
      }),
    })).rejects.toThrow(/acceptedTargetIds/);
  });

  it.each([
    ['complete-restore', ['session-a', 'session-b']],
    ['partial-stop-restore', ['session-a', 'session-b']],
  ])('requires one session for %s', async (targetScenario, sessionIds) => {
    await expect(runOfflineSoak({
      timeoutMs: 100,
      runScenario: async ({ cycle, scenarioName }) => scenarioEvidence(`${cycle}-${scenarioName}`, scenarioName, {
        ...(scenarioName === targetScenario ? { sessionIds } : {}),
      }),
    })).rejects.toThrow(/exactly one sessionId/);
  });

  it.each([
    ['omits session B', ['session-A']],
    ['augments session A and B', ['session-A', 'session-B', 'session-extra']],
  ])('requires replacement sessionIds to match A/B and rejects when it %s', async (_label, sessionIds) => {
    await expect(runOfflineSoak({
      timeoutMs: 100,
      runScenario: async ({ cycle, scenarioName }) => scenarioEvidence(`${cycle}-${scenarioName}`, scenarioName, {
        ...(scenarioName === 'stale-success-replacement' ? {
          sessionA: 'session-A',
          sessionB: 'session-B',
          sessionIds,
        } : {}),
      }),
    })).rejects.toThrow(/sessionIds must exactly match sessionA and sessionB/);
  });

  it.each([
    ['targetCount', { targetCount: 999 }, /targetCount must be 1000/],
    ['Restore exactness', { restoreExact: false }, /restoreExact must be true/],
    ['metadata exactness', { metadataExact: false }, /metadataExact must be true/],
  ])('requires full-target Restore evidence for partial stop: %s', async (_label, overrides, message) => {
    await expect(runOfflineSoak({
      timeoutMs: 100,
      runScenario: async ({ cycle, scenarioName }) => scenarioEvidence(`${cycle}-${scenarioName}`, scenarioName, {
        ...(scenarioName === 'partial-stop-restore' ? overrides : {}),
      }),
    })).rejects.toThrow(message);
  });

  it('stops on callback failure or timeout with completed records and a failed partial record', async () => {
    const context = { browser: 'shared' };
    const callbackFailure = runOfflineSoak({
      context,
      timeoutMs: 100,
      capturePartial: async ({ scenarioName, cycle, context: received, error }) => ({
        scenarioName, cycle, context: received, originalError: error.message, liveTrial: true,
      }),
      runScenario: async ({ cycle, scenarioName }) => {
        if (cycle === 1 && scenarioName === SCENARIO_NAMES[1]) throw new Error('probe exploded');
        return scenarioEvidence(`${cycle}-${scenarioName}`, scenarioName);
      },
    });
    await expect(callbackFailure).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'probe exploded' }),
      artifact: {
        cycles: [{ scenarios: [
          { status: 'complete' },
          { status: 'failed', partialEvidence: { liveTrial: true, originalError: 'probe exploded' } },
        ] }],
      },
    });

    const captureFailure = runOfflineSoak({
      timeoutMs: 100,
      capturePartial: async () => { throw new Error('capture failed'); },
      runScenario: async ({ cycle, scenarioName }) => {
        if (cycle === 1 && scenarioName === SCENARIO_NAMES[0]) throw new Error('scenario failed');
        return scenarioEvidence(`${cycle}-${scenarioName}`, scenarioName);
      },
    });
    await expect(captureFailure).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'scenario failed' }),
      artifact: {
        cycles: [{ scenarios: [{
          status: 'failed',
          error: { message: 'scenario failed' },
          captureError: { message: 'capture failed' },
        }] }],
      },
    });

    await expect(runOfflineSoak({
      timeoutMs: 5,
      capturePartial: async () => ({ timedOutPartial: true }),
      runScenario: async ({ cycle, scenarioName }) => {
        if (cycle === 1 && scenarioName === SCENARIO_NAMES[1]) return new Promise(() => {});
        return scenarioEvidence(`${cycle}-${scenarioName}`, scenarioName);
      },
    })).rejects.toMatchObject({
      message: expect.stringContaining('timed out'),
      artifact: { cycles: [{ scenarios: [{ status: 'complete' }, { status: 'failed', partialEvidence: { timedOutPartial: true } }] }] },
    });
  });
});
