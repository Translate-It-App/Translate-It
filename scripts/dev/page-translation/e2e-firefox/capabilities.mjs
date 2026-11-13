export const capabilityStates = Object.freeze(['SUPPORTED', 'UNSUPPORTED', 'FAILED', 'NOT_TESTED']);

export function capability(status, detail = {}) {
  if (!capabilityStates.includes(status)) throw new TypeError(`Unknown capability status: ${status}`);
  return { ...detail, status };
}

export const requiredCapabilities = Object.freeze([
  'isolation', 'fixture', 'bidiSession', 'protocol', 'interceptionSetup', 'interceptionDispatch', 'extensionInstall',
  'runtimeBridge', 'backgroundLoaded', 'contentLoaded', 'runtimeHandshake', 'hostPermissions',
  'backgroundInspection', 'backgroundReadiness', 'contentInspection', 'contentReadiness', 'discoveryFlags',
  'backgroundProviderInterception', 'providerRequestBody', 'providerResponse',
  'providerDataCollector', 'providerOperation', 'providerPhysicalRequest', 'providerConsumption', 'domAcceptance', 'providerRestore',
  'backgroundNegativeFetch', 'contentNegativeFetch', 'pageNegativeFetch',
  'heldRequestAbort', 'rootSettlement', 'physicalSettlement', 'heldResponseRelease', 'staleDeliveryCheck', 'nostaleDOM', 'cleanup',
]);

// Phase 2B page-replacement proof: trusted SPA-navigation replacement within one
// live extension tab. runtimeBridge here means the authenticated replacement
// collector lane (no Phase-1 runtime collector bridge runs in this mode).
export const replacementRequiredCapabilities = Object.freeze([
  'isolation', 'fixture', 'bidiSession', 'protocol', 'interceptionSetup', 'extensionInstall', 'runtimeBridge',
  'backgroundReadiness', 'contentReadiness', 'discoveryFlags', 'loopbackTlsProxy', 'providerPhysicalRequest',
  'providerRequestBody', 'providerResponse', 'schedulerBatchCorrelation', 'heldRequestAbort',
  'physicalSettlement', 'rootSettlement', 'replacementSessionOwnership', 'replacementDomOwnership', 'cleanup',
]);

// Phase 2C Stale-Success proof: the same replacement A→B lane without any
// controller abort — the second A batch is a genuine released Provider success
// whose reply the harness holds across the navigation, and production's
// Scheduler must reject it. heldRequestAbort is therefore absent here.
export const staleSuccessRequiredCapabilities = Object.freeze([
  'isolation', 'fixture', 'bidiSession', 'protocol', 'interceptionSetup', 'extensionInstall', 'runtimeBridge',
  'backgroundReadiness', 'contentReadiness', 'discoveryFlags', 'loopbackTlsProxy', 'providerPhysicalRequest',
  'providerRequestBody', 'providerResponse', 'schedulerBatchCorrelation',
  'physicalSettlement', 'rootSettlement', 'replacementSessionOwnership', 'replacementDomOwnership',
  'staleSuccessfulReply', 'staleReplyHeld', 'staleSchedulerRejection', 'cleanup',
]);

export function assertFirefoxProbeModeFlags({ loopbackTlsProxy = false, pageTranslationE2E = false, pageTranslationStopE2E = false, pageTranslationReplacementE2E = false, pageTranslationStaleSuccessE2E = false, phase1E2E = pageTranslationE2E } = {}) {
  if (typeof loopbackTlsProxy !== 'boolean' || typeof pageTranslationE2E !== 'boolean'
      || typeof pageTranslationStopE2E !== 'boolean' || typeof pageTranslationReplacementE2E !== 'boolean'
      || typeof pageTranslationStaleSuccessE2E !== 'boolean'
      || typeof phase1E2E !== 'boolean') {
    throw new TypeError('Firefox probe mode flags must be booleans.');
  }
  // Phase 2A runs the same lane as Phase 1, so the lane flag is implied by the
  // Stop Auto flag; the two modes are exclusive by their own flags.
  if (phase1E2E && pageTranslationStopE2E) throw new Error('Choose either Phase 1 page E2E or Phase 2A Stop Auto mode.');
  if (pageTranslationReplacementE2E && (pageTranslationE2E || pageTranslationStopE2E)) {
    throw new Error('Choose exactly one of page E2E, Stop Auto, or Page Replacement mode.');
  }
  if (pageTranslationStaleSuccessE2E && (pageTranslationE2E || pageTranslationStopE2E || pageTranslationReplacementE2E)) {
    throw new Error('Choose exactly one of page E2E, Stop Auto, Page Replacement, or Stale-Success mode.');
  }
  if (pageTranslationStaleSuccessE2E && !loopbackTlsProxy) {
    throw new Error('FIREFOX_E2E_PAGE_TRANSLATION_STALE_SUCCESS requires FIREFOX_E2E_LOOPBACK_TLS_PROXY=1.');
  }
  if (pageTranslationReplacementE2E && !loopbackTlsProxy) {
    throw new Error('FIREFOX_E2E_PAGE_TRANSLATION_REPLACEMENT requires FIREFOX_E2E_LOOPBACK_TLS_PROXY=1.');
  }
  if (pageTranslationE2E && !loopbackTlsProxy) {
    throw new Error('FIREFOX_E2E_PAGE_TRANSLATION requires FIREFOX_E2E_LOOPBACK_TLS_PROXY=1.');
  }
  return true;
}

export function notTested(reason) { return capability('NOT_TESTED', { reason }); }

export function classifyRequestAction(kind) {
  if (kind === 'local') return 'continue-local';
  if (kind === 'runtime-bridge-report') return 'continue-runtime-report';
  if (kind === 'startup-metadata-fixture') return 'provide-known-empty-voices';
  return 'fail-closed';
}

export function isolationSnapshot({ interfaces, routes, routes6 }) {
  const lines = String(interfaces ?? '').trim().split('\n').filter(Boolean);
  const loopbackOnly = lines.length === 1 && /^lo\s+UNKNOWN\s+127\.0\.0\.1\/8\s+::1\/128$/.test(lines[0].trim());
  const ipv4RoutesEmpty = String(routes ?? '').trim() === '';
  const ipv6RoutesEmpty = String(routes6 ?? '').trim() === '';
  return { ok: loopbackOnly && ipv4RoutesEmpty && ipv6RoutesEmpty, interfaces: String(interfaces ?? '').trim(), routes: String(routes ?? '').trim(), routes6: String(routes6 ?? '').trim(), loopbackOnly, ipv4RoutesEmpty, ipv6RoutesEmpty };
}

export function classifyObservedRealm({ observation, expectedEntry, expectedFlags }) {
  if (observation?.evaluationError) return capability('FAILED', { reason: `Realm evaluation failed: ${observation.evaluationError}`, evidence: observation });
  if (!observation?.realmExposed) return capability('UNSUPPORTED', { reason: 'Expected extension realm was not exposed by this BiDi target.', evidence: observation ?? null });
  if (!observation.entryMatched) return capability('FAILED', { reason: 'Exposed extension realm did not contain the expected instrumented entry marker.', evidence: observation });
  if (!observation.ready) return capability('FAILED', { reason: 'Instrumented entry is present but runtime readiness is false.', evidence: observation });
  if (expectedFlags && JSON.stringify(observation.flags) !== JSON.stringify(expectedFlags)) return capability('FAILED', { reason: `Discovery flags mismatch; expected ${JSON.stringify(expectedFlags)}.`, evidence: observation });
  return capability('SUPPORTED', { entry: expectedEntry, ready: true, flags: observation.flags ?? null, evidence: observation });
}

export function summarizeCapabilities(capabilities) {
  return summarizeCapabilitySet(capabilities, requiredCapabilities);
}

export function summarizeCapabilitySet(capabilities, required) {
  const missing = required.filter(name => !capabilities[name]);
  if (missing.length) return { status: 'FAILED', reason: `Required capability results missing: ${missing.join(', ')}`, missing };
  const values = required.map(name => capabilities[name]);
  const failed = required.filter(name => capabilities[name].status === 'FAILED');
  const unsupported = required.filter(name => capabilities[name].status === 'UNSUPPORTED');
  const untested = required.filter(name => capabilities[name].status === 'NOT_TESTED');
  if (failed.length) return { status: 'FAILED', reason: `Required capabilities failed: ${failed.join(', ')}`, failed, unsupported, untested };
  if (unsupported.length || untested.length) return { status: 'UNSUPPORTED', reason: `Required capabilities not supported: ${[...unsupported, ...untested].join(', ')}`, unsupported, untested };
  return { status: values.every(value => value.status === 'SUPPORTED') ? 'SUPPORTED' : 'FAILED', reason: null };
}

export function runtimeProbeGate(capabilities) {
  return ['backgroundInspection', 'backgroundReadiness', 'contentInspection', 'contentReadiness', 'discoveryFlags']
    .every(name => capabilities[name]?.status === 'SUPPORTED');
}

export function retainExecutedCapability(current, reason) {
  return current && current.status !== 'NOT_TESTED' ? current : notTested(reason);
}

export function blockRuntimeBridgePrerequisite(capabilities, name, status, reason, { bridgeAttempted = false } = {}) {
  if (!['interceptionSetup', 'extensionInstall'].includes(name) || !['UNSUPPORTED', 'FAILED'].includes(status)) {
    throw new TypeError('Invalid runtime bridge prerequisite classification.');
  }
  capabilities[name] = capability(status, { reason });
  if (!bridgeAttempted) capabilities.runtimeBridge = retainExecutedCapability(capabilities.runtimeBridge, `${name} prerequisite not met; runtime reports were not attempted.`);
  return capabilities;
}
