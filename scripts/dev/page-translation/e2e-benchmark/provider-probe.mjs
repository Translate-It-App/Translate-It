import { mapEdgeResponse } from './metrics.mjs';

const sourceIndex = value => {
  const match = /^Benchmark sentence (\d+) has stable fixture content\.$/.exec(value);
  const index = Number(match?.[1]) - 1;
  return Number.isInteger(index) && index >= 0 && index < 12 ? index : -1;
};
const toTexts = values => Array.isArray(values)
  ? values.map(value => typeof value === 'string' ? value : typeof value?.text === 'string' ? value.text : null)
  : [];
const indexes = values => toTexts(values).map(sourceIndex);
const isEdgeEndpoint = value => {
  try {
    const url = new URL(value);
    const keys = [...url.searchParams.keys()];
    return url.protocol === 'https:' && url.hostname === 'edge.microsoft.com' && url.port === ''
      && url.pathname === '/translate/translatetext' && url.searchParams.get('isEnterpriseClient') === 'false'
      && url.searchParams.get('to') === 'fr' && keys.every(key => ['isEnterpriseClient', 'to', 'from'].includes(key))
      && keys.filter(key => key === 'isEnterpriseClient').length === 1 && keys.filter(key => key === 'to').length === 1
      && keys.filter(key => key === 'from').length <= 1 && !url.username && !url.password && !url.hash;
  } catch { return false; }
};
const sha256 = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const fetchFailure = error => error?.name === 'AbortError' || error?.operationAborted === true || error?.code === 'ABORTED'
  ? ['cancelled', 'ABORTED']
  : error instanceof TypeError || error?.name === 'TypeError' ? ['rejected', 'NETWORK_ERROR'] : ['rejected', 'FETCH_ERROR'];

export function createEdgeProviderProbe(report) {
  let enabled = false;
  let stopped = false;
  let installed = false;
  let proxyManagerRef = null;
  let invocationNumber = 0;
  let attemptNumber = 0;
  let chain = Promise.resolve();
  const invocations = [];
  const pendingPreOptions = new Map();
  const nativeOptions = new WeakMap();
  let edgeProviderClass;
  let activeInvocation = null;
  let providerOnlyController = null;
  let latestInvocation = null;
  const emit = (event, evidence) => {
    chain = chain.then(() => report(event, evidence)).catch(() => {});
    return chain;
  };
  const wrap = (target, key, makeWrapper) => {
    const original = target?.[key];
    if (typeof original !== 'function') return false;
    target[key] = makeWrapper(original);
    return typeof target[key] === 'function' && target[key] !== original;
  };
  const keyFor = (url, options) => typeof options?.body === 'string' ? `${url}\n${options.method}\n${options.body}` : null;
  const removePre = record => {
    const list = pendingPreOptions.get(record.key);
    if (!list) return;
    const index = list.indexOf(record);
    if (index >= 0) list.splice(index, 1);
    if (!list.length) pendingPreOptions.delete(record.key);
  };

  return {
    arm() { enabled = true; },
    stop() { stopped = true; },
    async invokeProviderOnly(MicrosoftEdgeProvider, texts, { sessionId, messageId }) {
      if (!enabled || stopped || providerOnlyController || !Array.isArray(texts) || texts.length !== 12) throw new Error('Provider-only invocation is not available.');
      providerOnlyController = new AbortController();
      const provider = new MicrosoftEdgeProvider();
      try {
        const result = await provider._translateChunk(texts, 'en', 'fr', 'page', providerOnlyController, 0, texts.length, 0, 1, { sessionId, messageId });
        await latestInvocation?.completion;
        return result;
      } finally { providerOnlyController = null; }
    },
    abortProviderOnly() { providerOnlyController?.abort(); },
    proxyDisabled() { return installed && typeof proxyManagerRef?.isEnabled === 'function' && !proxyManagerRef.isEnabled(); },
    get observersInstalled() { return installed; },
    install({ MicrosoftEdgeProvider, ProviderRequestEngine, proxyManager }) {
      edgeProviderClass = MicrosoftEdgeProvider;
      proxyManagerRef = proxyManager;
      const edgeInstalled = wrap(MicrosoftEdgeProvider?.prototype, '_translateChunk', original => function (...args) {
        if (!enabled || stopped) return original.apply(this, args);
        const sessionId = typeof args[9]?.sessionId === 'string' ? args[9].sessionId : null;
        const source = toTexts(args[0]);
        const sourceIndexes = source.map(sourceIndex);
        if (!sourceIndexes.length || sourceIndexes.some(index => index < 0) || new Set(sourceIndexes).size !== sourceIndexes.length) {
          void emit('error', { code: 'INVALID_BODY' });
        }
        const invocation = {
          invocationId: `edge-fr-invocation-${++invocationNumber}`,
          sessionId,
          messageId: typeof args[9]?.messageId === 'string' ? args[9].messageId : null,
          sourceIndexes,
          source,
          attempts: [],
          settled: false,
        };
        invocation.completion = new Promise(resolve => { invocation.complete = resolve; });
        latestInvocation = invocation;
        invocations.push(invocation);
        if (sourceIndexes.length && sourceIndexes.every(index => index >= 0) && new Set(sourceIndexes).size === sourceIndexes.length) {
          void emit('provider-invoked', {
            invocationId: invocation.invocationId, sessionId, messageId: invocation.messageId,
            provider: 'edge', itemCount: sourceIndexes.length, sourceIndexes,
          });
        }
        let result;
        const previousInvocation = activeInvocation;
        activeInvocation = invocation;
        try { result = original.apply(this, args); }
        catch (error) {
          const [outcome, code] = fetchFailure(error);
          void emit('provider-settled', { invocationId: invocation.invocationId, sessionId, outcome, code });
          throw error;
        }
        finally { activeInvocation = previousInvocation; }
        if (result && typeof result.then === 'function') result.then(value => {
          void (async () => {
            await Promise.all(invocation.attempts.map(attempt => attempt.settledReport));
            invocation.settled = true;
            let resultsMatch = false;
            try {
              const expected = mapEdgeResponse(invocation.source).map(item => item.translations[0].text);
              resultsMatch = invocation.attempts.length > 0 && Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
            } catch { /* Do not expose request text or parser errors. */ }
            if (resultsMatch) await emit('parser-success', { invocationId: invocation.invocationId, sessionId: invocation.sessionId, sourceIndexes, resultsMatch: true });
            else await emit('error', { code: 'INVALID_BODY' });
            await emit('provider-settled', { invocationId: invocation.invocationId, sessionId: invocation.sessionId, outcome: 'fulfilled', code: null });
            invocation.complete();
          })().catch(() => { void emit('error', { code: 'PROTOCOL_ERROR' }); }).finally(() => invocation.complete());
        }, error => {
          invocation.settled = true;
          const [outcome, code] = fetchFailure(error);
          void Promise.all(invocation.attempts.map(attempt => attempt.settledReport))
            .then(() => emit('provider-settled', { invocationId: invocation.invocationId, sessionId: invocation.sessionId, outcome, code }))
            .catch(() => {}).finally(() => invocation.complete());
        });
        return result;
      });
      const preOptionsInstalled = wrap(ProviderRequestEngine, 'executeApiCall', original => function (provider, options, ...rest) {
        let pre = null;
        if (enabled && !stopped && provider instanceof edgeProviderClass && isEdgeEndpoint(options?.url)) {
          const fetchOptions = options?.fetchOptions;
          const key = keyFor(options.url, fetchOptions);
          if (key) {
            let bodyIndexes = [];
            try { bodyIndexes = indexes(JSON.parse(fetchOptions.body)); } catch { /* Invalid bodies remain uncorrelated. */ }
            const matches = item => !!item && !item.settled && item.sessionId === (options.sessionId ?? null)
              && sameIndexes(item.sourceIndexes, bodyIndexes);
            const candidates = invocations.filter(matches);
            const invocation = activeInvocation ? (matches(activeInvocation) ? activeInvocation : null) : candidates.length === 1 ? candidates[0] : null;
            if (!invocation) {
              void emit('error', { code: 'BODY_UNSUPPORTED' });
              const result = original.call(this, provider, options, ...rest);
              return result;
            }
            pre = {
              key, url: options.url, method: fetchOptions.method, body: fetchOptions.body,
              sessionId: options.sessionId ?? null, invocation,
              proxyDisabled: false, consumed: false,
            };
            const list = pendingPreOptions.get(key) ?? [];
            list.push(pre);
            pendingPreOptions.set(key, list);
          }
        }
        let result;
        try { result = original.call(this, provider, options, ...rest); }
        catch (error) { if (pre) removePre(pre); throw error; }
        if (pre && result && typeof result.then === 'function') result.then(() => { if (!pre.consumed) removePre(pre); }, () => { if (!pre.consumed) removePre(pre); });
        return result;
      });
      const proxyFetchInstalled = wrap(proxyManager, 'fetch', original => function (url, options, requestConfig, ...rest) {
        const key = keyFor(url, options);
        const list = key ? pendingPreOptions.get(key) : null;
        const pre = list?.[0];
        if (pre) {
          pre.consumed = true;
          pre.proxyDisabled = proxyManagerRef?.isEnabled?.(requestConfig) === false;
          nativeOptions.set(options, pre);
          removePre(pre);
        }
        return original.call(this, url, options, requestConfig, ...rest);
      });
      installed = edgeInstalled && preOptionsInstalled && proxyFetchInstalled && typeof proxyManager?.isEnabled === 'function';
      return installed;
    },
    observeDirectFetch(url, options, nativePromise, proxyDisabledBranch) {
      if (!enabled || stopped) return;
      let body;
      try { body = typeof options?.body === 'string' ? JSON.parse(options.body) : null; } catch { body = null; }
      const sourceIndexes = indexes(body);
      const pre = options && typeof options === 'object' ? nativeOptions.get(options) : null;
      const invocation = pre?.invocation;
       if (!invocation || proxyDisabledBranch !== true || !pre?.proxyDisabled || pre.url !== url || pre.method !== options?.method || pre.body !== options?.body
           || !isEdgeEndpoint(url) || options?.method !== 'POST' || !Array.isArray(body)
           || !body.length || body.length > 12 || sourceIndexes.some(index => index < 0) || new Set(sourceIndexes).size !== sourceIndexes.length
           || !sameIndexes(sourceIndexes, invocation.sourceIndexes)) {
        void emit('error', { code: 'BODY_UNSUPPORTED' });
        return;
      }
      const attemptId = `edge-fr-attempt-${++attemptNumber}`;
      const attempt = { attemptId, settledReport: Promise.resolve() };
      invocation.attempts.push(attempt);
      const bodyBytes = new TextEncoder().encode(options.body).length;
       const start = sha256(options.body).then(bodyHash => emit('physical-start', {
        attemptId, invocationId: invocation.invocationId, sessionId: invocation.sessionId, messageId: invocation.messageId,
        provider: 'edge', method: 'POST', url, bodyBytes, bodyHash, sourceIndexes,
      }));
      const settledReport = Promise.resolve(nativePromise).then(response => start.then(() => emit('physical-settled', {
          attemptId, sessionId: invocation.sessionId, outcome: 'fulfilled',
          status: Number.isInteger(response?.status) ? response.status : null, code: null,
        })), error => {
        const [outcome, code] = fetchFailure(error);
        return start.then(() => emit('physical-settled', { attemptId, sessionId: invocation.sessionId, outcome, status: null, code }));
      });
      attempt.settledReport = settledReport.catch(() => {});
    },
  };
}

function sameIndexes(left, right) { return Array.isArray(right) && left.length === right.length && left.every((index, position) => index === right[position]); }
