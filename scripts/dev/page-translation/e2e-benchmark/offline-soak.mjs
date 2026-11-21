const SCENARIO_NAMES = Object.freeze([
  'complete-restore',
  'partial-stop-restore',
  'stale-success-replacement',
]);
const CYCLE_COUNT = 10;

export function restoreSnapshotsMatch(original, restored) {
  return Array.isArray(restored) && JSON.stringify(restored) === JSON.stringify(original);
}

const RESOURCE_COMPONENTS = Object.freeze([
  'QueueManager',
  'RateLimitManager',
  'source resolver',
  'lifecycle registry',
  'scheduler',
  'active promises',
  'Fetch reservations',
  'handlers',
  'background operation leases',
]);

export class OfflineSoakError extends Error {
  constructor(message, artifact, cause) {
    super(message, { cause });
    this.name = 'OfflineSoakError';
    this.artifact = artifact;
  }
}

function validateScenarioResult(result, scenarioName) {
  const issues = [];
  if (!result || typeof result !== 'object') return ['result must be an object'];
  if (result.passed !== true) issues.push('passed must be true');

  if (!Array.isArray(result.sessionIds) || !result.sessionIds.length
    || result.sessionIds.some(id => typeof id !== 'string' || !id.trim())
    || new Set(result.sessionIds).size !== result.sessionIds.length) {
    issues.push('sessionIds must be non-empty unique strings');
  }
  if ((scenarioName === 'complete-restore' || scenarioName === 'partial-stop-restore')
    && (!Array.isArray(result.sessionIds) || result.sessionIds.length !== 1)) {
    issues.push(`${scenarioName} must have exactly one sessionId`);
  }

  const requests = result.observedPhysicalRequestCounts;
  if (!requests || typeof requests !== 'object' || Array.isArray(requests) || !Object.keys(requests).length
    || Object.keys(requests).some(name => !name.trim())
    || Object.values(requests).some(count => !Number.isInteger(count) || count < 0)
    || Object.values(requests).every(count => count === 0)) {
    issues.push('observedPhysicalRequestCounts must contain at least one named counter and at least one observed request');
  }

  const batches = result.logicalBatchEvidence;
  if (!batches || typeof batches !== 'object' || batches.observed !== true
    || batches.crossSessionAcceptance !== false || batches.duplicateWrite !== false) {
    issues.push('logicalBatchEvidence must be observed with crossSessionAcceptance and duplicateWrite false');
  }

  const concurrency = result.concurrencyEvidence;
  const maxLogicalBatches = scenarioName === 'stale-success-replacement' ? 3 : 2;
  if (!concurrency || typeof concurrency !== 'object'
    || !Number.isInteger(concurrency.peakActiveRequests) || concurrency.peakActiveRequests < 1 || concurrency.peakActiveRequests > 2
    || !Number.isInteger(concurrency.peakLogicalBatches) || concurrency.peakLogicalBatches < 1 || concurrency.peakLogicalBatches > maxLogicalBatches) {
    issues.push(`concurrencyEvidence peaks must be peakActiveRequests 1..2 and peakLogicalBatches 1..${maxLogicalBatches}`);
  }

  const terminalStatus = scenarioName === 'partial-stop-restore' ? 'stopped' : 'completed';
  if (!result.terminalOutcome || typeof result.terminalOutcome !== 'object'
    || result.terminalOutcome.status !== terminalStatus) {
    issues.push(`terminalOutcome.status must be ${terminalStatus}`);
  }

  if (result.targetCount !== 1000) issues.push('targetCount must be 1000');
  if (result.restoreExact !== true) issues.push('restoreExact must be true');
  if (result.metadataExact !== true) issues.push('metadataExact must be true');

  if (scenarioName === 'complete-restore') {
    const validIds = ids => Array.isArray(ids) && ids.length === 1000
      && ids.every(id => typeof id === 'string' && id.trim())
      && new Set(ids).size === 1000;
    if (!validIds(result.expectedTargetIds)) {
      issues.push('expectedTargetIds must contain 1000 unique non-empty target IDs');
    }
    if (!validIds(result.acceptedTargetIds)
      || !validIds(result.expectedTargetIds)
      || result.acceptedTargetIds.some(id => !result.expectedTargetIds.includes(id))) {
      issues.push('acceptedTargetIds must contain exactly the 1000 unique expected target IDs');
    }
  }

  if (scenarioName === 'partial-stop-restore') {
    if (!Number.isInteger(result.acceptedCount) || result.acceptedCount < 1 || result.acceptedCount > 999) {
      issues.push('acceptedCount must be an integer from 1 through 999');
    }
    if (result.correlatedHeldFetch !== true) issues.push('correlatedHeldFetch must be true');
    if (result.cancellationConfirmed !== true) issues.push('cancellationConfirmed must be true');
    if (result.noStaleWrites !== true) issues.push('noStaleWrites must be true');
  }

  if (scenarioName === 'stale-success-replacement') {
    if (typeof result.sessionA !== 'string' || !result.sessionA.trim()
      || typeof result.sessionB !== 'string' || !result.sessionB.trim()
      || result.sessionA === result.sessionB) {
      issues.push('sessionA and sessionB must be distinct non-empty strings');
    }
    if (!Array.isArray(result.sessionIds)
      || new Set(result.sessionIds).size !== new Set([result.sessionA, result.sessionB]).size
      || result.sessionIds.length !== 2
      || ![result.sessionA, result.sessionB].every(id => result.sessionIds.includes(id))) {
      issues.push('sessionIds must exactly match sessionA and sessionB');
    }
    if (!Array.isArray(result.expectedTargetIds) || result.expectedTargetIds.length !== 1000
      || result.expectedTargetIds.some(id => typeof id !== 'string' || !id.trim())
      || new Set(result.expectedTargetIds).size !== 1000) {
      issues.push('expectedTargetIds must contain 1000 unique non-empty target IDs');
    }
    if (!Array.isArray(result.acceptedAIds) || result.acceptedAIds.length !== 0) {
      issues.push('acceptedAIds must be an empty array');
    }
    if (!Array.isArray(result.acceptedBIds) || result.acceptedBIds.length !== 1000
      || result.acceptedBIds.some(id => typeof id !== 'string' || !id.trim())
      || new Set(result.acceptedBIds).size !== 1000
      || !Array.isArray(result.expectedTargetIds)
      || result.acceptedBIds.some(id => !result.expectedTargetIds.includes(id))) {
      issues.push('acceptedBIds must contain exactly the 1000 unique expected target IDs');
    }
    if (result.bOwnershipValid !== true) issues.push('bOwnershipValid must be true');
    if (result.noStaleWrites !== true) issues.push('noStaleWrites must be true');
  }

  const resources = result.resourceSnapshot;
  if (!resources || typeof resources !== 'object') {
    issues.push('resourceSnapshot is required');
  } else {
    for (const component of RESOURCE_COMPONENTS) {
      const state = resources[component];
      if (!state || typeof state !== 'object'
        || !Number.isInteger(state.active) || state.active < 0
        || !Number.isInteger(state.history) || state.history < 0) {
        issues.push(`resourceSnapshot.${component} must include non-negative integer active and history counts`);
      } else if (state.active !== 0) {
        issues.push(`resourceSnapshot.${component}.active must be zero at the cycle boundary`);
      }
    }
  }
  return issues;
}

function addTotals(target, values) {
  for (const [key, value] of Object.entries(values ?? {})) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function raceTimeout(promise, timeoutMs, label) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

/**
 * Run ordered offline-soak scenarios against one caller-owned context/browser.
 *
 * Integration contract: runScenario({ scenarioName, cycle, context }) returns
 * normalized trial evidence with passed, sessionIds, observedPhysicalRequestCounts,
 * logicalBatchEvidence ({ observed, crossSessionAcceptance, duplicateWrite }),
 * concurrencyEvidence ({ peakActiveRequests, peakLogicalBatches }),
 * terminalOutcome, and resourceSnapshot. Completion scenarios
 * (complete-restore, stale-success-replacement) also require targetCount: 1000,
 * restoreExact, metadataExact, and terminal status completed. The partial-stop-
 * restore scenario requires terminal status stopped, acceptedCount 1..999,
 * correlatedHeldFetch, cancellationConfirmed, and noStaleWrites. The stale
 * complete scenario additionally requires acceptedTargetIds exactly matching
 * the 1000 unique expectedTargetIds. Replacement requires sessionIds exactly
 * matching distinct sessionA/sessionB,
 * empty acceptedAIds, acceptedBIds exactly matching the 1000 unique
 * expectedTargetIds, bOwnershipValid, and noStaleWrites. Raw probe/trial results
 * can be retained as extra fields. The snapshot maps every
 * component listed in RESOURCE_COMPONENTS to { active, history }; active must be
 * zero at every cycle boundary, while history is diagnostic and may accumulate.
 * No browser is created here. The same context object is forwarded to runScenario
 * and onScenario for every scenario. On failure, capturePartial receives
 * { scenarioName, cycle, context, error, result } and its returned raw evidence
 * is saved as record.partialEvidence; capture failures are saved separately.
 */
export async function runOfflineSoak({
  runScenario,
  onScenario = () => {},
  capturePartial = async () => undefined,
  context,
  cycleCount = CYCLE_COUNT,
  timeoutMs,
} = {}) {
  if (typeof runScenario !== 'function' || typeof onScenario !== 'function' || typeof capturePartial !== 'function') {
    throw new TypeError('runScenario, onScenario, and capturePartial callbacks are required');
  }
  if (cycleCount !== CYCLE_COUNT) throw new TypeError(`cycleCount must be exactly ${CYCLE_COUNT}`);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive finite number');

  const artifact = {
    cycleCount: CYCLE_COUNT,
    scenarioNames: [...SCENARIO_NAMES],
    cycles: [],
    cumulative: { observedPhysicalRequestCounts: {}, sessionIds: [], resourceHistory: {} },
  };
  const allSessionIds = new Set();

  for (let cycle = 1; cycle <= CYCLE_COUNT; cycle++) {
    const cycleRecord = { cycle, scenarios: [] };
    artifact.cycles.push(cycleRecord);
    for (const scenarioName of SCENARIO_NAMES) {
      const record = { scenarioName, status: 'running' };
      cycleRecord.scenarios.push(record);
      try {
        const callbackContext = { scenarioName, cycle, context };
        const result = await raceTimeout(Promise.resolve().then(() => runScenario(callbackContext)), timeoutMs, scenarioName);
        record.result = result;
        const issues = validateScenarioResult(result, scenarioName);
        if (!issues.length) {
          for (const id of result.sessionIds) {
            if (allSessionIds.has(id)) issues.push(`sessionId ${id} was reused across scenarios`);
          }
        }
        if (issues.length) throw new Error(issues.join('; '));
        await raceTimeout(Promise.resolve().then(() => onScenario({ ...callbackContext, result })), timeoutMs, `${scenarioName} onScenario`);
        record.status = 'complete';
        addTotals(artifact.cumulative.observedPhysicalRequestCounts, result.observedPhysicalRequestCounts);
        for (const id of result.sessionIds) {
          allSessionIds.add(id);
          artifact.cumulative.sessionIds.push(id);
        }
        for (const [component, state] of Object.entries(result.resourceSnapshot)) {
          artifact.cumulative.resourceHistory[component] = (artifact.cumulative.resourceHistory[component] ?? 0) + state.history;
        }
      } catch (error) {
        record.status = 'failed';
        record.error = { name: error?.name ?? 'Error', message: error?.message ?? String(error) };
        try {
          record.partialEvidence = await capturePartial({
            scenarioName,
            cycle,
            context,
            error,
            result: record.result,
          });
        } catch (captureError) {
          record.captureError = {
            name: captureError?.name ?? 'Error',
            message: captureError?.message ?? String(captureError),
          };
        }
        throw new OfflineSoakError(`Offline soak stopped at cycle ${cycle}, ${scenarioName}: ${record.error.message}`, artifact, error);
      }
    }
  }
  return artifact;
}

export { RESOURCE_COMPONENTS, SCENARIO_NAMES, validateScenarioResult };
