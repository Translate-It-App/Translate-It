async function stopOnce(state, stopMeasurement, cleanupErrors) {
  if (!state.attempted || state.stopped || state.stopAttempts > 0) return null;
  state.stopAttempts++;
  try {
    const snapshot = await stopMeasurement();
    state.stopped = snapshot?.available === true;
    if (state.started && !state.stopped) cleanupErrors.push(`Measurement stop returned unavailable: ${snapshot?.reason ?? 'no snapshot'}`);
    return snapshot;
  } catch (error) {
    cleanupErrors.push(`Measurement observer cleanup: ${error.message}`);
    return null;
  }
}

export function drainAndDisconnectMeasurementObservers({ mutationObserver, processMutations, longTaskObserver, processLongTasks }) {
  const failures = [];
  try { processMutations(mutationObserver.takeRecords()); } catch (error) { failures.push(error); }
  try { mutationObserver.disconnect(); } catch (error) { failures.push(error); }
  if (longTaskObserver) {
    try { processLongTasks(longTaskObserver.takeRecords()); } catch (error) { failures.push(error); }
    try { longTaskObserver.disconnect(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'Measurement observers failed to drain or disconnect.');
}

export async function completeTranslationMeasurement({ state, awaitAcceptedTranslation, stopMeasurement, sendRestore, awaitRestoredDOM, cleanupErrors }) {
  try {
    const translation = await awaitAcceptedTranslation();
    const measurement = await stopOnce(state, stopMeasurement, cleanupErrors);
    if (!state.stopped) throw new Error('Translation measurement could not be stopped before Restore.');
    const restoreStartedAt = Date.now();
    const restoreResponse = await sendRestore();
    if (!restoreResponse?.success) throw new Error(`PAGE_RESTORE rejected: ${JSON.stringify(restoreResponse)}`);
    const restored = await awaitRestoredDOM();
    return { translation, measurement, restoreResponse, restored, restoreStartedAt, restoreCompletedAt: Date.now() };
  } finally {
    if (state.attempted && !state.stopped && state.stopAttempts === 0) {
      await stopOnce(state, stopMeasurement, cleanupErrors);
    }
  }
}

export async function cleanupMeasurementBeforeResources({ state, stopMeasurement, resources, cleanupErrors }) {
  if (state.attempted && !state.stopped && state.stopAttempts === 0) {
    await stopOnce(state, stopMeasurement, cleanupErrors);
  }
  await Promise.all(resources.map(async cleanup => {
    try { await cleanup(); } catch (error) { cleanupErrors.push(error.message); }
  }));
}
