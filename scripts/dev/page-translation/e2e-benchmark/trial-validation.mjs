import { validateTranslation } from './metrics.mjs';
import { observedPageWorkerLimit, validateProviderRuntime, validateProviderSchedulerRuntime } from './scenario-plan.mjs';

export function validateTrialTranslation({
  originals, translated, requests, restored, expectedCount,
  acceptedIds, admittedIds, enqueuedIds,
}) {
  return validateTranslation({
    originals, translated, requests, restored, expectedCount,
    acceptedIds, admittedIds, enqueuedIds,
  });
}

export async function collectProviderRuntimeEvidence({ trial, lane, page, worker, helpers }) {
  const { chrome, pageSession, contentContext, evaluate } = page;
  const { workerSession } = worker;
  const { until } = helpers;
  trial.providerRuntimeObserved = await evaluate(chrome, workerSession,
    `globalThis.__pageTranslationBenchmark.providerRuntimeSnapshot(${JSON.stringify(lane.provider)},${lane.optimizationLevel})`, undefined, false);
  trial.providerRuntimeValidation = validateProviderRuntime({
    requestedProvider: lane.provider,
    requestedOptimizationLevel: lane.optimizationLevel,
    snapshot: trial.providerRuntimeObserved,
  });
  if (!trial.providerRuntimeValidation.ok) throw new Error(trial.providerRuntimeValidation.issues.join('; '));
  trial.providerSchedulerObserved = await until(() => evaluate(chrome, pageSession,
    'window.__pageTranslationBenchmark.pageSessionSnapshot()?.schedulerBatchConfig??null', contentContext, false));
  trial.pageWorkerLimit = observedPageWorkerLimit(trial.providerSchedulerObserved);
  trial.providerSchedulerValidation = validateProviderSchedulerRuntime({
    provider: lane.provider,
    optimizationLevel: lane.optimizationLevel,
    providerRuntime: trial.providerRuntimeObserved,
    scheduler: trial.providerSchedulerObserved,
  });
  if (!trial.providerSchedulerValidation.ok) throw new Error(trial.providerSchedulerValidation.issues.join('; '));
}
