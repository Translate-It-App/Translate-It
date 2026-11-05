const EXPECTED = Symbol('expectedText');
const ORIGINAL = Symbol('originalText');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await pause(2);
  }
  throw new Error('Timed out waiting for production Bridge completion.');
};

const paragraph = (id, text, expected) => {
  const node = document.createElement('p');
  node.dataset.benchId = id;
  node[EXPECTED] = expected;
  node[ORIGINAL] = text;
  node.textContent = text;
  return node;
};

const makeViewportPanel = () => {
  const panel = document.createElement('section');
  panel.className = 'viewport-panel';
  const targets = [];
  for (let i = 0; i < 16; i++) {
    const node = paragraph(`visible-${i}`, `Visible item ${i}`, `T:Visible item ${i}`);
    panel.append(node);
    targets.push(node);
  }
  return { panel, targets };
};

const makePrefixAndTail = prefixCount => {
  const fragment = document.createDocumentFragment();
  const targets = [];
  for (let i = 0; i < prefixCount; i++) {
    const node = paragraph(`prefix-${i}`, `Prefix item ${i}`, `T:Prefix item ${i}`);
    node.className = 'prefix';
    fragment.append(node);
    targets.push(node);
  }
  for (let i = 0; i < 64; i++) {
    const node = paragraph(`tail-${i}`, `Tail item ${i}`, `T:Tail item ${i}`);
    node.className = 'tail';
    fragment.append(node);
    targets.push(node);
  }
  return { fragment, targets };
};

const LRM = '\u200e';
const expected = node => `${LRM}${node[EXPECTED]}`;
const original = node => node[ORIGINAL];

export const calibrateLongTaskObserver = async () => {
  if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    return { supported: false, captured: false, count: null, maxDurationMs: null };
  }
  const entries = [];
  const observer = new PerformanceObserver(list => entries.push(...list.getEntries()));
  observer.observe({ type: 'longtask' });
  await new Promise(resolve => setTimeout(() => {
    const deadline = performance.now() + 75;
    while (performance.now() < deadline) { /* Deliberate isolated calibration task. */ }
    resolve();
  }, 0));
  await pause(0);
  entries.push(...observer.takeRecords());
  observer.disconnect();
  const maxDurationMs = entries.length ? Math.max(...entries.map(entry => entry.duration)) : 0;
  return { supported: true, captured: entries.some(entry => entry.duration >= 50), count: entries.length, maxDurationMs };
};

export const runProductionFixture = async ({ Bridge, mode, fixture, latency, prefixCount, longTaskCaptureValid }) => {
  document.body.replaceChildren();
  const panel = makeViewportPanel();
  const offscreen = makePrefixAndTail(prefixCount);
  const targets = [...offscreen.targets, ...panel.targets];

  if (fixture === 'late-dom') {
    document.body.append(offscreen.fragment, panel.panel);
  } else {
    document.body.append(panel.panel, offscreen.fragment);
  }

  const expectedIds = new Set(targets.map(node => node.dataset.benchId));
  const visibleIds = new Set(panel.targets.map(node => node.dataset.benchId));
  const requests = new Map();
  let providerCallbackCalls = 0;
  let untrackedProviderCallbackCalls = 0;
  let settlementCalls = 0;
  const settlementStates = new Set();
  const writes = new Set();
  let start = 0;
  let firstVisibleAcceptedWriteMs = null;
  let visibleCompletionMs = null;
  let allCompletionMs = null;
  let discoveryDrainElapsedMs = null;

  const observer = new MutationObserver(records => {
    for (const record of records) {
      const target = record.target.closest?.('[data-bench-id]') ?? record.target.parentElement?.closest('[data-bench-id]');
      if (!target || target.textContent !== expected(target)) continue;
      writes.add(target.dataset.benchId);
      const now = performance.now() - start;
      if (visibleIds.has(target.dataset.benchId) && firstVisibleAcceptedWriteMs === null) {
        firstVisibleAcceptedWriteMs = now;
      }
      if (visibleCompletionMs === null && [...visibleIds].every(id => writes.has(id))) visibleCompletionMs = now;
      if (allCompletionMs === null && writes.size === expectedIds.size) allCompletionMs = now;
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });

  const longTaskEntries = [];
  const longTasks = PerformanceObserver.supportedEntryTypes?.includes('longtask')
    ? new PerformanceObserver(list => longTaskEntries.push(...list.getEntries()))
    : null;
  longTasks?.observe({ type: 'longtask' });

  const provider = (text, _context, _key, node) => {
    providerCallbackCalls++;
    const target = node?.nodeType === 1 ? node : node?.parentElement?.closest('[data-bench-id]');
    const id = target?.dataset?.benchId;
    if (id && expectedIds.has(id)) requests.set(id, (requests.get(id) ?? 0) + 1);
    else untrackedProviderCallbackCalls++;
    return pause(latency).then(() => ({
      __pageTranslationSettlement: true,
      text: `T:${text}`,
      state: 'pending',
      settle(outcome) { settlementCalls++; this.state = outcome; settlementStates.add(outcome); },
    }));
  };
  const bridge = new Bridge();
  let initialized = false;
  let successful = false;
  let result;
  let restoreError;
  let restoredTargets = 0;
  try {
  await bridge.initialize({
    targetLanguage: 'en',
    lazyLoading: false,
    showOriginalOnHover: false,
    autoTranslateOnDOMChanges: false,
    attributesToTranslate: [],
  }, provider, null, {
    onDiscoveryStateChange: state => {
      if (state === false && discoveryDrainElapsedMs === null) discoveryDrainElapsedMs = performance.now() - start;
    },
  });
  initialized = true;

  const translateInvocationElapsedMs = await new Promise(resolve => setTimeout(() => {
    start = performance.now();
    bridge.translate(document.body);
    resolve(performance.now() - start);
  }, 0));
  if (mode === 'legacy') discoveryDrainElapsedMs = translateInvocationElapsedMs;

  try {
    await until(() => allCompletionMs !== null);
  } catch (error) {
    const unmarkedExpected = node => node[EXPECTED];
    const translatedWithoutLRM = targets.filter(node => node.textContent === unmarkedExpected(node)).length;
    const translatedAfterRemovingLRM = targets.filter(node => node.textContent.replaceAll(LRM, '') === unmarkedExpected(node)).length;
    const markerShapes = {
      prefix: targets.filter(node => node.textContent === `${LRM}${unmarkedExpected(node)}`).length,
      suffix: targets.filter(node => node.textContent === `${unmarkedExpected(node)}${LRM}`).length,
      surrounding: targets.filter(node => node.textContent === `${LRM}${unmarkedExpected(node)}${LRM}`).length,
      afterTranslationPrefix: targets.filter(node => node.textContent === unmarkedExpected(node).replace('T:', `T:${LRM}`)).length,
      beforeTranslationPrefix: targets.filter(node => node.textContent === unmarkedExpected(node).replace('T:', `${LRM}T:`)).length,
    };
    const hasLRM = targets.filter(node => node.textContent.includes(LRM)).length;
    throw new Error(`${mode}/${fixture}: ${error.message} Eligible=${expectedIds.size}, providerCallbacks=${providerCallbackCalls}, trackedAdmissions=${requests.size}, untrackedCallbacks=${untrackedProviderCallbackCalls}, settlements=${settlementCalls}, writes=${writes.size}, exactUnmarked=${translatedWithoutLRM}, afterRemovingLRM=${translatedAfterRemovingLRM}, targetsWithLRM=${hasLRM}, markerShapes=${JSON.stringify(markerShapes)}`);
  }
  await pause(20);
  longTaskEntries.push(...(longTasks?.takeRecords() ?? []));
  const intervalEnd = start + allCompletionMs;
  const measuredLongTasks = longTaskEntries.filter(entry =>
    entry.startTime <= intervalEnd && entry.startTime + entry.duration >= start,
  );
  const longTaskCount = longTaskCaptureValid ? measuredLongTasks.length : null;
  const longTaskTotalMs = longTaskCaptureValid ? measuredLongTasks.reduce((sum, entry) => sum + entry.duration, 0) : null;
  const longTaskMaxMs = longTaskCaptureValid && measuredLongTasks.length
    ? Math.max(...measuredLongTasks.map(entry => entry.duration))
    : longTaskCaptureValid ? 0 : null;

  const duplicateAdmissionIds = [...requests].filter(([, count]) => count !== 1).map(([id]) => id);
  const missingAdmissionIds = [...expectedIds].filter(id => !requests.has(id));
  const translatedIds = new Set(targets.filter(node => node.textContent === expected(node)).map(node => node.dataset.benchId));
  const missingTranslationIds = [...expectedIds].filter(id => !translatedIds.has(id));
  const extraTranslationIds = [...translatedIds].filter(id => !expectedIds.has(id));

  result = {
    fixture,
    latencyMs: latency,
    expectedEligibleTargets: expectedIds.size,
    translatedTargets: translatedIds.size,
    firstVisibleAcceptedWriteMs,
    visibleCompletionMs,
    allWriteCompletionMs: allCompletionMs,
    discoveryDrainElapsedMs,
    translateInvocationElapsedMs,
    mainThreadLongTaskCount: longTaskCount,
    mainThreadLongTaskTotalMs: longTaskTotalMs,
    mainThreadLongTaskMaxMs: longTaskMaxMs,
    providerAdmissions: [...requests.values()].reduce((sum, count) => sum + count, 0),
    providerCallbackCalls,
    untrackedProviderCallbackCalls,
    settlementCalls,
    settlementStates: [...settlementStates],
    uniqueProviderTargetAdmissions: requests.size,
    duplicateAdmissionIds,
    missingAdmissionIds,
    missingTranslationIds,
    extraTranslationIds,
  };

  if (translatedIds.size !== expectedIds.size || missingTranslationIds.length || extraTranslationIds.length
    || requests.size !== expectedIds.size || missingAdmissionIds.length || duplicateAdmissionIds.length
    || providerCallbackCalls !== expectedIds.size || untrackedProviderCallbackCalls
    || settlementCalls !== expectedIds.size
    || firstVisibleAcceptedWriteMs === null || visibleCompletionMs === null || !Number.isFinite(discoveryDrainElapsedMs)) {
    throw new Error(`Fixture invariant failed: ${JSON.stringify(result)}`);
  }

  successful = true;
  } finally {
    observer.disconnect();
    longTasks?.disconnect();
    if (initialized) {
      try { bridge.restore(document.body); } catch (error) { restoreError = error; }
      const originals = new Map(targets.map(node => [node.dataset.benchId, original(node)]));
      for (const node of document.querySelectorAll('[data-bench-id]')) {
        if (originals.has(node.dataset.benchId)) node.textContent = originals.get(node.dataset.benchId);
      }
      restoredTargets = [...document.querySelectorAll('[data-bench-id]')]
        .filter(node => originals.get(node.dataset.benchId) === node.textContent).length;
      bridge.cleanup();
    } else {
      bridge.cleanup();
    }
  }
  if (restoreError) throw restoreError;
  if (successful && restoredTargets !== expectedIds.size) {
    throw new Error(`Restore invariant failed: restored=${restoredTargets}, expected=${expectedIds.size}`);
  }
  return result;
};
