const ACCEPTED_CLICK = 'translate-it:select-element-benchmark:accepted-click';
const REQUEST_DISPATCH = 'translate-it:select-element-benchmark:request-dispatch';
const OPERATION_TERMINAL = 'translate-it:select-element-benchmark:operation-terminal';
const OPT_IN_ATTRIBUTE = 'data-translate-it-live-benchmark';
const ROOT_ATTRIBUTE = 'data-translate-it-live-benchmark-root';
const TRIAL_ATTRIBUTE = 'data-translate-it-live-benchmark-trial';

export function getBenchmarkTrialId(element) {
  if (!import.meta.env.DEV
      || document.documentElement.getAttribute(OPT_IN_ATTRIBUTE) !== 'true'
      || !element?.isConnected
      || element.getAttribute(ROOT_ATTRIBUTE) !== 'true') return null;
  return element.getAttribute(TRIAL_ATTRIBUTE) || null;
}

function emit(type, element, payload, expectedTrialId = getBenchmarkTrialId(element)) {
  if (!expectedTrialId || getBenchmarkTrialId(element) !== expectedTrialId) return;
  document.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify({ ...payload, trialId: expectedTrialId }) }));
}

export function emitBenchmarkAcceptedClick(event, element) {
  const trialId = getBenchmarkTrialId(element);
  if (!trialId) return;
  emit(ACCEPTED_CLICK, element, {
    clickTimeStamp: Number.isFinite(event?.timeStamp) ? event.timeStamp : null,
    acceptedAt: performance.now(),
  }, trialId);
}

export function emitBenchmarkRequestDispatch(element) {
  const trialId = getBenchmarkTrialId(element);
  if (!trialId) return;
  emit(REQUEST_DISPATCH, element, { at: performance.now() }, trialId);
}

export function emitBenchmarkTerminal(element, status, expectedTrialId) {
  if (!expectedTrialId
      || getBenchmarkTrialId(element) !== expectedTrialId
      || !['successful', 'partial', 'failed', 'cancelled'].includes(status)) return;
  emit(OPERATION_TERMINAL, element, { at: performance.now(), status }, expectedTrialId);
}
