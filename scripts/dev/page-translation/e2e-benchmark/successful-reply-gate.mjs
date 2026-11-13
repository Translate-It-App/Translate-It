const PAGE_TRANSLATE_BATCH = 'PAGE_TRANSLATE_BATCH';
const MAX_EVENTS = 20;

function describeError(reason) {
  if (typeof reason === 'string') return reason.slice(0, 200);
  if (reason instanceof Error) return reason.name || 'Error';
  return 'gate closed';
}

/** Hold one genuine successful PAGE_TRANSLATE_BATCH reply until explicitly released. */
export function createSuccessfulReplyGate({ sessionId, messageId, timeoutMs = 10_000, onEvent = () => {} } = {}) {
  if (typeof sessionId !== 'string' || !sessionId || typeof messageId !== 'string' || !messageId) {
    throw new TypeError('sessionId and messageId must be non-empty strings.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError('timeoutMs must be a non-negative finite number.');

  const descriptor = Object.freeze({ action: PAGE_TRANSLATE_BATCH, sessionId, messageId });
  const events = [];
  let status = 'armed';
  let captured = false;
  let released = false;
  let settled = false;
  let pending = false;
  let timer = null;
  let error = null;
  let matched = false;
  let openBarrier;
  const barrier = new Promise(resolve => { openBarrier = resolve; });

  function emit(type, detail = {}) {
    if (events.length >= MAX_EVENTS) return;
    const event = Object.freeze({
      sequence: events.length + 1,
      type,
      action: PAGE_TRANSLATE_BATCH,
      sessionId,
      messageId,
      ...detail,
    });
    events.push(event);
    try { onEvent(event); } catch { /* diagnostics must not change provider settlement */ }
  }

  function clearGateTimer() {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  function openGate() {
    openBarrier();
  }

  function fail(reason, type) {
    if (status === 'released' || status === 'closed' || status === 'timed-out') return false;
    status = 'failed';
    error = describeError(reason);
    clearGateTimer();
    emit(type, { error });
    openGate();
    return true;
  }

  function timeoutGate() {
    if (status !== 'pending' && status !== 'captured') return;
    status = 'timed-out';
    error = `successful reply gate timed out after ${timeoutMs}ms`;
    clearGateTimer();
    emit('timeout', { error });
    openGate();
  }

  function matches(message) {
    return message?.action === PAGE_TRANSLATE_BATCH
      && message?.messageId === messageId
      && message?.data?.sessionId === sessionId;
  }

  function intercept(message, originalPromise) {
    if (!matches(message)) return originalPromise;

    if (matched) {
      const duplicateError = 'duplicate matching invocation';
      if (!fail(duplicateError, 'duplicate-match')) {
        error ??= duplicateError;
        emit('duplicate-match', { error: duplicateError });
      }
      return originalPromise;
    }
    matched = true;

    if (status === 'closed' || status === 'timed-out') {
      emit('closed-match-bypassed');
      return originalPromise;
    }

    if (!(originalPromise instanceof Promise)) {
      fail('matching invocation did not return a native Promise', 'unsupported-non-promise');
      return originalPromise;
    }

    status = 'pending';
    pending = true;
    timer = setTimeout(timeoutGate, timeoutMs);
    emit('matched');

    return originalPromise.then(async response => {
      if (response?.success !== true || response?.hasError) {
        if (status === 'pending') fail('original reply was not a successful response', 'not-successful');
        else emit('not-successful-forwarded');
        return response;
      }

      if (status !== 'pending') {
        emit('successful-reply-forwarded-without-hold');
        return response;
      }

      captured = true;
      status = 'captured';
      emit('captured');
      await barrier;
      return response;
    }, originalError => {
      if (status === 'pending') fail(originalError, 'source-rejected');
      else emit('source-rejection-forwarded', { errorName: originalError?.name ?? 'Error' });
      throw originalError;
    }).finally(() => {
      pending = false;
      settled = true;
      clearGateTimer();
      emit('settled');
    });
  }

  function release() {
    if (status !== 'captured' || !captured || released) return false;
    released = true;
    status = 'released';
    clearGateTimer();
    emit('released');
    openGate();
    return true;
  }

  function close(reason = 'gate closed') {
    if (status === 'closed' || status === 'timed-out' || status === 'failed' || status === 'released') return false;
    status = 'closed';
    error = describeError(reason);
    clearGateTimer();
    emit('closed', { error });
    openGate();
    return true;
  }

  /** `settled` means the intercepted reply promise settled; `pending` means it is awaiting source or release. */
  function snapshot() {
    return {
      descriptor: { ...descriptor },
      status,
      captured,
      released,
      settled,
      pending,
      timer: timer !== null,
      error,
      events: events.map(event => ({ ...event })),
    };
  }

  return { intercept, release, close, snapshot };
}
