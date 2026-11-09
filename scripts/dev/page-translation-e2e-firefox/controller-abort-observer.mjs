const observers = new WeakMap();

export function observeControllerAbort(controller, owner, record) {
  if (!controller?.signal || typeof controller.abort !== 'function' || typeof record !== 'function') return null;
  if (observers.has(controller)) return null;
  const originalAbort = controller.abort;
  let currentOwner = owner;
  let transitioned = false;
  let published = false;
  let ownerAtTransition = null;
  const publish = () => {
    if (!transitioned || published || !safeOwner(ownerAtTransition)) return;
    published = true;
    try {
      record({
        messageId: ownerAtTransition.messageId,
        sessionId: ownerAtTransition.sessionId,
        context: typeof ownerAtTransition.context === 'string' ? ownerAtTransition.context : null,
        cancelRequestSequence: Number.isSafeInteger(ownerAtTransition.cancelRequestSequence) ? ownerAtTransition.cancelRequestSequence : null,
        abortedBefore: false,
        abortedAfter: true,
      });
    } catch { /* Test telemetry must not change AbortController behavior. */ }
  };
  const observeTransition = before => {
    const after = controller.signal.aborted === true;
    if (before || !after || transitioned) return;
    transitioned = true;
    ownerAtTransition = safeOwner(currentOwner) ? { ...currentOwner } : null;
    publish();
  };
  let signalListenerInstalled = false;
  try {
    if (typeof controller.signal.addEventListener === 'function') {
      let signalWasAborted = controller.signal.aborted === true;
      controller.signal.addEventListener('abort', () => {
        observeTransition(signalWasAborted);
        signalWasAborted = controller.signal.aborted === true;
      }, { once: true });
      signalListenerInstalled = true;
    }
  } catch { /* Try the abort-method wrapper as the alternate observation path. */ }
  const wrappedAbort = function (...args) {
    const abortedBefore = controller.signal.aborted === true;
    const result = Reflect.apply(originalAbort, this, args);
    observeTransition(abortedBefore);
    return result;
  };
  wrappedAbort.__firefoxControllerAbortObserved = true;
  let abortWrapperInstalled = false;
  try { controller.abort = wrappedAbort; abortWrapperInstalled = controller.abort === wrappedAbort; }
  catch { /* Firefox may expose a non-shadowable AbortController method. */ }
  if (!abortWrapperInstalled) {
    try { if (controller.abort !== originalAbort) controller.abort = originalAbort; } catch { /* Preserve the native path where possible. */ }
  }
  if (!signalListenerInstalled && !abortWrapperInstalled) return null;
  const observer = {
    setOwner(nextOwner) { if (!transitioned) currentOwner = nextOwner; },
    get transitioned() { return transitioned; },
    get signalListenerInstalled() { return signalListenerInstalled; },
    get abortWrapperInstalled() { return abortWrapperInstalled; },
  };
  observers.set(controller, observer);
  return observer;
}

function safeOwner(value) {
  return value && typeof value.messageId === 'string' && value.messageId.length > 0
    && typeof value.sessionId === 'string' && value.sessionId.length > 0;
}
