const EXPECTED = Symbol('expectedText');

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
  node.textContent = text;
  return node;
};

const attributeTarget = (element, id, name, value) => {
  element.setAttribute(name, value);
  element.dataset[`benchId${name.replaceAll(/(^|-)(.)/g, (_, _dash, char) => char.toUpperCase())}`] = id;
  return { id, element, kind: 'attribute', name, original: value, expected: `${LRM}T:${value}` };
};

export const createAttributeHeavyFixture = () => {
  const fragment = document.createDocumentFragment();
  const targets = [];
  for (let i = 0; i < 48; i++) {
    const group = document.createElement('section');
    group.dataset.benchTarget = '';
    group.dataset.benchExcluded = `excluded-${i}`;
    const text = `Attribute fixture text ${i}`;
    const textParagraph = paragraph(`attribute-${i}-text`, text, `T:${text}`);
    targets.push({ id: textParagraph.dataset.benchId, element: textParagraph, kind: 'text', original: textParagraph.textContent, expected: expected(textParagraph) });
    const titleParagraph = document.createElement('p');
    targets.push(attributeTarget(titleParagraph, `attribute-${i}-title`, 'title', `Title ${i}`));

    const image = document.createElement('img');
    image.dataset.benchTarget = '';
    targets.push(attributeTarget(image, `attribute-${i}-alt`, 'alt', `Image description ${i}`));
    image.setAttribute('data-bench-excluded', `excluded-image-${i}`);
    // A missing placeholder is intentionally not an eligible translation target.
    const input = document.createElement('input');
    input.type = 'text';
    input.readOnly = true;
    input.dataset.benchTarget = '';
    targets.push(attributeTarget(input, `attribute-${i}-placeholder`, 'placeholder', `Action hint ${i}`));
    const button = document.createElement('button');
    button.dataset.benchTarget = '';
    targets.push(attributeTarget(button, `attribute-${i}-aria-label`, 'aria-label', `Accessible action ${i}`));
    button.setAttribute('data-bench-excluded', `excluded-button-${i}`);
    group.append(textParagraph, titleParagraph, image, input, button);
    fragment.append(group);
  }
  return { fragment, targets };
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
  const attributeHeavy = fixture === 'attribute-heavy';
  const panel = attributeHeavy ? null : makeViewportPanel();
  const offscreen = attributeHeavy ? null : makePrefixAndTail(prefixCount);
  let targets;
  if (attributeHeavy) {
    const heavy = createAttributeHeavyFixture();
    targets = heavy.targets;
    document.body.append(heavy.fragment);
  } else {
    targets = [...offscreen.targets, ...panel.targets].map(element => ({
      id: element.dataset.benchId, element, kind: 'text', original: element.textContent, expected: expected(element),
    }));
    if (fixture === 'late-dom') document.body.append(offscreen.fragment, panel.panel);
    else document.body.append(panel.panel, offscreen.fragment);
  }
  const expectedIds = new Set(targets.map(target => target.id));
  const visibleIds = new Set(attributeHeavy
    ? targets.filter(target => {
      const { top, left, right, bottom, width, height } = target.element.getBoundingClientRect();
      return width > 0 && height > 0 && bottom > 0 && right > 0 && top < innerHeight && left < innerWidth;
    }).map(target => target.id)
    : panel.targets.map(node => node.dataset.benchId));
  const originalValue = target => target.kind === 'text' ? target.element.textContent : target.element.getAttribute(target.name);
  const writeTarget = target => target.kind === 'text' ? target.element.textContent : target.element.getAttribute(target.name);
  const attributeTargets = new Map();
  for (const target of targets.filter(item => item.kind === 'attribute')) {
    const list = attributeTargets.get(target.element) ?? new Map();
    list.set(target.name, target);
    attributeTargets.set(target.element, list);
  }
  const textTargetByElement = new Map(targets.filter(target => target.kind === 'text').map(target => [target.element, target]));
  const textTargetByText = new WeakMap(targets.filter(target => target.kind === 'text').map(target => [target.element.firstChild, target]));
  const requests = new Map();
  let providerCallbackCalls = 0;
  let untrackedProviderCallbackCalls = 0;
  let settlementCalls = 0;
  const settlementStates = new Set();
  const observedWriteIds = new Set();
  const settlements = new Map();
  let start = 0;
  let firstVisibleAcceptedWriteMs = null;
  let visibleCompletionMs = null;
  let allCompletionMs = null;
  let discoveryDrainElapsedMs = null;

  const observer = new MutationObserver(records => {
    for (const record of records) {
      const target = record.type === 'attributes'
        ? attributeTargets.get(record.target)?.get(record.attributeName)
        : textTargetByText.get(record.target) ?? textTargetByElement.get(record.target);
      if (!target || observedWriteIds.has(target.id) || writeTarget(target) !== target.expected) continue;
      observedWriteIds.add(target.id);
      const now = performance.now() - start;
      if (visibleIds.has(target.id) && firstVisibleAcceptedWriteMs === null) {
        firstVisibleAcceptedWriteMs = now;
      }
      if (visibleCompletionMs === null && [...visibleIds].every(id => observedWriteIds.has(id))) visibleCompletionMs = now;
      if (allCompletionMs === null && observedWriteIds.size === expectedIds.size) allCompletionMs = now;
    }
  });
  const observerOptions = { subtree: true, childList: true, characterData: true };
  if (attributeHeavy) observerOptions.attributes = true;
  observer.observe(document.body, observerOptions);

  const longTaskEntries = [];
  const longTasks = PerformanceObserver.supportedEntryTypes?.includes('longtask')
    ? new PerformanceObserver(list => longTaskEntries.push(...list.getEntries()))
    : null;
  longTasks?.observe({ type: 'longtask' });

  const provider = (text, _context, _key, node) => {
    providerCallbackCalls++;
    const target = node?.nodeType === 2
      ? attributeTargets.get(node.ownerElement)?.get(node.name)
      : textTargetByText.get(node) ?? textTargetByElement.get(node?.nodeType === 1 ? node : node?.parentElement);
    const id = target?.id;
    if (id && expectedIds.has(id)) requests.set(id, (requests.get(id) ?? 0) + 1);
    else untrackedProviderCallbackCalls++;
    return pause(latency).then(() => ({
      __pageTranslationSettlement: true,
      text: `T:${text}`,
      state: 'pending',
      settle(outcome) {
        settlementCalls++;
        this.state = outcome;
        settlementStates.add(outcome);
        if (id) settlements.set(id, (settlements.get(id) ?? 0) + (outcome === 'accepted' ? 1 : 0));
      },
    }));
  };
  const bridge = new Bridge();
  let initialized = false;
  let result;
  let primaryError;
  let restoreError;
  let cleanupError;
  let restoredTargets = 0;
  try {
  await bridge.initialize({
    targetLanguage: 'en',
    lazyLoading: false,
    showOriginalOnHover: false,
    autoTranslateOnDOMChanges: false,
    attributesToTranslate: attributeHeavy ? ['title', 'alt', 'placeholder', 'value', 'aria-label'] : [],
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
    throw new Error(`${mode}/${fixture}: ${error.message} Eligible=${expectedIds.size}, providerCallbacks=${providerCallbackCalls}, trackedAdmissions=${requests.size}, untrackedCallbacks=${untrackedProviderCallbackCalls}, settlements=${settlementCalls}, writes=${observedWriteIds.size}`);
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
  const translatedIds = new Set(targets.filter(target => writeTarget(target) === target.expected).map(target => target.id));
  const missingTranslationIds = [...expectedIds].filter(id => !translatedIds.has(id));
  const extraTranslationIds = [...translatedIds].filter(id => !expectedIds.has(id));

  result = {
    fixture,
    latencyMs: latency,
    expectedEligibleTargets: expectedIds.size,
    visibleTargets: visibleIds.size,
    translatedTargets: translatedIds.size,
    observedTargetWrites: observedWriteIds.size,
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

  const missingWrites = [...expectedIds].filter(id => !observedWriteIds.has(id));
  const badSettlementIds = [...expectedIds].filter(id => settlements.get(id) !== 1);
  if (translatedIds.size !== expectedIds.size || missingTranslationIds.length || extraTranslationIds.length
    || requests.size !== expectedIds.size || missingAdmissionIds.length || duplicateAdmissionIds.length
    || providerCallbackCalls !== expectedIds.size || untrackedProviderCallbackCalls
    || settlementCalls !== expectedIds.size || [...settlementStates].length !== 1 || !settlementStates.has('accepted')
    || badSettlementIds.length || missingWrites.length
    || firstVisibleAcceptedWriteMs === null || visibleCompletionMs === null || !Number.isFinite(discoveryDrainElapsedMs)) {
    throw new Error(`Fixture invariant failed: ${JSON.stringify(result)}`);
  }

  } catch (error) {
    primaryError = error;
  } finally {
    try { observer.disconnect(); } catch (error) { cleanupError ||= error; }
    try { longTasks?.disconnect(); } catch (error) { cleanupError ||= error; }
    if (initialized) {
      try {
        bridge.restore(document.body);
      } catch (error) {
        restoreError = error;
      }
      const mismatchedTargets = targets.filter(target => originalValue(target) !== target.original);
      restoredTargets = targets.length - mismatchedTargets.length;
      if (mismatchedTargets.length) {
        const invariantError = new Error(
          `Restore invariant failed: restored=${restoredTargets} expected=${targets.length}; mismatched IDs=${mismatchedTargets.map(target => target.id).join(',')}`,
        );
        restoreError = restoreError
          ? new AggregateError([restoreError, invariantError], 'Production fixture restore failed.')
          : invariantError;
      }
    }
    try { bridge.cleanup(); } catch (error) { cleanupError ||= error; }
  }
  const failures = [primaryError, restoreError, cleanupError].filter(Boolean);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Production fixture failed during translation, restore, or cleanup.');
  return result;
};
