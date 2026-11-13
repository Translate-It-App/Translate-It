export function installCallThrough(target, method, observe) {
  const original = target?.[method];
  if (typeof original !== 'function') return false;
  target[method] = function (...args) {
    try { observe.call(this, args); } catch { /* instrumentation must not affect the call */ }
    return original.apply(this, args);
  };
  return true;
}

export function installPrimitiveAdmissionObserver(session, observe) {
  const nodesTranslator = session?.domTranslator?.nodesTranslator;
  return nodesTranslator ? installCallThrough(nodesTranslator, 'translate', observe) : false;
}

export function captureViewportWindow(session, targetIdForNode) {
  const window = session?.discovery?.queue?.find(candidate => candidate.viewportWindow)?.viewportWindow;
  if (!window) return null;
  const candidateDetails = window.candidates.map(candidate => ({
    id: targetIdForNode(candidate.node),
    visible: candidate.visible === true,
  }));
  return {
    phaseAtAdmission: window.phase,
    enumerationSteps: window.enumerationSteps,
    candidateCount: window.candidates.length,
    candidateDetails,
    windowCandidateIds: candidateDetails.map(candidate => candidate.id),
    visibleCandidateIds: candidateDetails.filter(candidate => candidate.visible).map(candidate => candidate.id),
  };
}

export function installTimedCallThrough(target, method, onStart, onEnd) {
  const original = target?.[method];
  if (typeof original !== 'function') return false;
  target[method] = function (...args) {
    let token;
    try { token = onStart.call(this, args); } catch { /* instrumentation must not affect the call */ }
    let result;
    try { result = original.apply(this, args); }
    catch (error) {
      try { onEnd?.call(this, token, error); } catch { /* instrumentation must not affect the call */ }
      throw error;
    }
    if (result && typeof result.then === 'function') {
      result.then(
        () => { try { onEnd?.call(this, token, null); } catch { /* instrumentation must not affect the call */ } },
        error => { try { onEnd?.call(this, token, error); } catch { /* instrumentation must not affect the call */ } },
      );
    } else {
      try { onEnd?.call(this, token, null); } catch { /* instrumentation must not affect the call */ }
    }
    return result;
  };
  return true;
}

export function makeTrace(scope) {
  const events = [];
  return {
    events,
    record(name, detail = {}) {
      events.push({ name, at: Date.now(), ...detail });
    },
    snapshot() {
      return { scope, events: events.map(event => ({ ...event })) };
    },
  };
}
