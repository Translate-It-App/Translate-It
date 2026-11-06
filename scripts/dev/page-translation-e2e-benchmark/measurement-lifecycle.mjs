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

export function groupMutationRecords(records, keyForRecord) {
  const groups = new Map();
  for (const record of records) {
    const key = keyForRecord(record);
    if (key === null || key === undefined) continue;
    let group = groups.get(key);
    if (!group) groups.set(key, group = { key, records: [] });
    group.records.push(record);
  }
  return [...groups.values()];
}

export function isDuplicateAcceptedMutation({ wasAlreadyAccepted, expectedText, resultingText, records }) {
  if (resultingText !== expectedText) return false;
  const nextValueByTarget = new Map();
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    if (record.type !== 'characterData') continue;
    const resultingValue = nextValueByTarget.get(record.target) ?? record.target.nodeValue;
    if (record.oldValue === expectedText && resultingValue === expectedText) return true;
    nextValueByTarget.set(record.target, record.oldValue);
  }
  return wasAlreadyAccepted && records.some(record => record.type === 'childList'
    && [...record.addedNodes].some(node => node.textContent === expectedText));
}

export function summarizeAcceptanceTimes(firstAcceptedAtById, visibleIds, expectedIds) {
  const times = ids => ids.map(id => firstAcceptedAtById?.[id]).filter(Number.isFinite);
  const allTimes = times(expectedIds);
  const visibleTimes = times(visibleIds);
  const allComplete = expectedIds.length > 0 && allTimes.length === expectedIds.length;
  const visibleComplete = visibleIds.length > 0 && visibleTimes.length === visibleIds.length;
  const first = allTimes.length ? Math.min(...allTimes) : null;
  return {
    firstAcceptedAt: first,
    firstAcceptedAtUnavailableReason: first === null ? 'No accepted DOM mutation was observed' : null,
    visibleSetCompletionAt: visibleComplete ? Math.max(...visibleTimes) : null,
    visibleSetCompletionUnavailableReason: visibleComplete ? null : visibleIds.length ? 'Not every initially visible target had an accepted-write observation' : 'No initially visible targets were recorded',
    allTargetsCompletionAt: allComplete ? Math.max(...allTimes) : null,
    allTargetsCompletionUnavailableReason: allComplete ? null : `Accepted-write observations for ${allTimes.length}/${expectedIds.length} targets`,
  };
}

export function trackAcceptedTarget({ id, at, acceptedIds, firstAcceptedAtById, visibleIds, targetCount, completionTimes }) {
  const firstObservation = !Object.hasOwn(firstAcceptedAtById, id);
  if (firstObservation) firstAcceptedAtById[id] = at;
  acceptedIds.add(id);
  const firstTimes = ids => ids.map(targetId => firstAcceptedAtById[targetId]).filter(Number.isFinite);
  if (completionTimes.visible === null && visibleIds.length && firstTimes(visibleIds).length === visibleIds.length) {
    completionTimes.visible = Math.max(...firstTimes(visibleIds));
  }
  if (completionTimes.all === null && acceptedIds.size === targetCount) {
    completionTimes.all = Math.max(...firstTimes([...acceptedIds]));
  }
  return firstObservation;
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
