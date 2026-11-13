import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { writeBenchmarkArtifact } from '../page-translation-e2e-benchmark/artifact-writer.mjs';
import { buildBenchmarkExtension } from '../page-translation-e2e-benchmark/build.mjs';
import { requiredCapabilities, replacementRequiredCapabilities, staleSuccessRequiredCapabilities, summarizeCapabilities, summarizeCapabilitySet, capability, assertFirefoxProbeModeFlags } from './capabilities.mjs';
import { runFirefoxProbe, verifyIsolation } from './driver.mjs';
import { launchIsolatedWorker } from './launcher.mjs';

const script = resolve(process.argv[1]);
const inside = process.argv.includes('--inside');
const loopbackTlsProxy = process.env.FIREFOX_E2E_LOOPBACK_TLS_PROXY === '1';
const pageTranslationStaleSuccessE2E = process.env.FIREFOX_E2E_PAGE_TRANSLATION_STALE_SUCCESS === '1';
const pageTranslationReplacementE2E = process.env.FIREFOX_E2E_PAGE_TRANSLATION_REPLACEMENT === '1';
const pageTranslationStopE2E = process.env.FIREFOX_E2E_PAGE_TRANSLATION_STOP === '1';
const pageTranslationE2E = process.env.FIREFOX_E2E_PAGE_TRANSLATION === '1' || pageTranslationStopE2E;
assertFirefoxProbeModeFlags({ loopbackTlsProxy, pageTranslationE2E, pageTranslationStopE2E, pageTranslationReplacementE2E, pageTranslationStaleSuccessE2E,
  phase1E2E: process.env.FIREFOX_E2E_PAGE_TRANSLATION === '1' });
const phase1RequiredCapabilities = [
  'isolation', 'fixture', 'bidiSession', 'protocol', 'interceptionSetup', 'extensionInstall',
  'runtimeBridge', 'backgroundLoaded', 'contentLoaded', 'runtimeHandshake', 'hostPermissions',
  'backgroundReadiness', 'contentReadiness', 'discoveryFlags', 'loopbackTlsProxy', 'providerPhysicalRequest',
  'providerRequestBody', 'providerResponse', 'providerOperation', 'providerConsumption', 'schedulerBatchCorrelation',
  'domAcceptance', 'providerRestore', 'pageTranslationProof', 'cleanup',
];
const stopAutoRequiredCapabilities = [
  'isolation', 'fixture', 'bidiSession', 'protocol', 'interceptionSetup', 'extensionInstall',
  'runtimeBridge', 'backgroundLoaded', 'contentLoaded', 'runtimeHandshake', 'hostPermissions',
  'backgroundReadiness', 'contentReadiness', 'discoveryFlags', 'loopbackTlsProxy', 'providerPhysicalRequest',
  'providerRequestBody', 'providerResponse', 'providerOperation', 'schedulerBatchCorrelation',
  'heldRequestAbort', 'physicalSettlement', 'rootSettlement', 'nostaleDOM', 'pageTranslationStopProof', 'cleanup',
];
const runId = inside ? process.env.FIREFOX_PROBE_RUN_ID ?? randomUUID() : randomUUID();
let artifactPath = resolve(process.env.FIREFOX_PROBE_ARTIFACT ?? resolve(tmpdir(), 'opencode', `page-translation-firefox-${runId}.json`));
try { await stat(artifactPath); artifactPath = `${artifactPath}.${runId}.json`; } catch { /* A new target path is safe to publish atomically. */ }
const baseArtifact = {
  probe: 'benchmark-only Firefox page-translation capability probe', runId, createdAt: new Date().toISOString(),
  commands: ['unshare --user --map-root-user --net', 'ip link set lo up', `node ${script} --inside`],
  networkScope: 'Must be verified in the process namespace before launching Firefox.',
  mode: pageTranslationReplacementE2E ? 'opt-in loopback TLS Firefox page-translation replacement proof' : pageTranslationStaleSuccessE2E ? 'opt-in loopback TLS Firefox page-translation stale-success proof' : pageTranslationStopE2E ? 'opt-in loopback TLS Firefox page-translation stop-auto proof' : pageTranslationE2E ? 'opt-in loopback TLS Firefox page-translation E2E' : loopbackTlsProxy ? 'opt-in loopback TLS provider-only prototype' : 'default Firefox capability probe',
  flags: { sourceDefaults: { slicedDiscovery: true, viewportFirstDiscovery: false }, benchmarkBuild: { slicedDiscovery: true, viewportFirstDiscovery: false }, loopbackTlsProxy, pageTranslationE2E, pageTranslationStopE2E, pageTranslationReplacementE2E, pageTranslationStaleSuccessE2E },
  capabilities: Object.fromEntries(requiredCapabilities.map(name => [name, { status: 'NOT_TESTED', reason: 'Setup did not reach this capability.' }])),
};

if (!inside) {
  const childEnv = { ...process.env, FIREFOX_PROBE_ARTIFACT: artifactPath, FIREFOX_PROBE_RUN_ID: runId };
  delete childEnv.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS;
  process.exitCode = await launchIsolatedWorker({
    command: 'unshare', args: ['--user', '--map-root-user', '--net', 'sh', '-c', 'ip link set lo up && exec "$@"', 'firefox-probe', process.execPath, script, '--inside'],
    env: childEnv, artifactPath, runId,
    writeFailure: (reason, error) => writeFailure(reason, error),
  });
  console.log(`${process.exitCode === 0 ? 'SUPPORTED' : process.exitCode === 2 ? 'UNSUPPORTED' : 'FAILED'}: isolated probe result`);
  console.log(`Artifact: ${artifactPath}`);
} else {
  const artifact = { ...baseArtifact, runId };
  let status = 1;
  try {
    delete process.env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS;
    const isolation = await verifyIsolation();
    artifact.networkScope = isolation;
    if (!isolation.ok) {
      artifact.capabilities.isolation = capability('FAILED', { reason: 'Only loopback interface with no IPv4/IPv6 routes is permitted.', evidence: isolation });
      throw new Error('Network isolation verification failed; Firefox launch prevented.');
    }
    artifact.capabilities.isolation = capability('SUPPORTED', { evidence: isolation });
    artifact.versions = { node: process.version, firefox: await commandOutput('/usr/bin/firefox', ['--version']) };
    artifact.provenance = await provenance();
     const capabilities = await runFirefoxProbe({ buildBenchmarkExtension,
       workerEntry: resolve(pageTranslationReplacementE2E || pageTranslationStaleSuccessE2E
         ? 'scripts/dev/page-translation-e2e-firefox/page-replacement-worker-entry.mjs'
         : pageTranslationStopE2E ? 'scripts/dev/page-translation-e2e-firefox/page-stop-worker-entry.mjs' : 'scripts/dev/page-translation-e2e-benchmark/worker-entry.mjs'),
       contentEntry: resolve(pageTranslationReplacementE2E || pageTranslationStaleSuccessE2E
         ? 'scripts/dev/page-translation-e2e-firefox/page-replacement-content-entry.mjs'
         : pageTranslationStopE2E ? 'scripts/dev/page-translation-e2e-firefox/page-stop-content-entry.mjs' : 'scripts/dev/page-translation-e2e-benchmark/content-entry.mjs'),
       artifact, loopbackTlsProxy, pageTranslationE2E, pageTranslationStopE2E, pageTranslationReplacementE2E, pageTranslationStaleSuccessE2E });
    const allCapabilities = { ...artifact.capabilities, ...capabilities };
    const fullSummary = summarizeCapabilities(allCapabilities);
    const required = pageTranslationStaleSuccessE2E ? staleSuccessRequiredCapabilities
      : pageTranslationReplacementE2E ? replacementRequiredCapabilities : pageTranslationStopE2E ? stopAutoRequiredCapabilities : phase1RequiredCapabilities;
     const summary = pageTranslationE2E || pageTranslationReplacementE2E || pageTranslationStaleSuccessE2E ? summarizeCapabilitySet(allCapabilities, required) : fullSummary;
     if (pageTranslationE2E || pageTranslationReplacementE2E || pageTranslationStaleSuccessE2E) artifact.fullCapabilitySummary = fullSummary;
    artifact.status = summary.status; artifact.reason = summary.reason; artifact.summary = summary;
    status = summary.status === 'SUPPORTED' ? 0 : summary.status === 'UNSUPPORTED' ? 2 : 1;
  } catch (error) {
    artifact.status = 'FAILED'; artifact.reason = error.message;
    artifact.errors = [...(artifact.errors ?? []), error.stack ?? String(error)];
    const fullSummary = summarizeCapabilities(artifact.capabilities);
    if (pageTranslationE2E || pageTranslationReplacementE2E) artifact.fullCapabilitySummary = fullSummary;
     artifact.summary = pageTranslationE2E || pageTranslationReplacementE2E || pageTranslationStaleSuccessE2E ? summarizeCapabilitySet(artifact.capabilities, pageTranslationStaleSuccessE2E ? staleSuccessRequiredCapabilities : pageTranslationReplacementE2E ? replacementRequiredCapabilities : pageTranslationStopE2E ? stopAutoRequiredCapabilities : phase1RequiredCapabilities) : fullSummary;
    status = 1;
  } finally {
    artifact.cleanup ??= { status: artifact.capabilities.cleanup?.status ?? 'NOT_TESTED', reason: 'Cleanup is performed by the probe finally block.' };
    try { await writeBenchmarkArtifact(artifactPath, artifact); }
    catch (error) { console.error(`Artifact write failed (${artifactPath}): ${error.stack ?? error}`); status = 1; }
  }
  console.log(`${artifact.status}: ${artifact.reason ?? 'all required capabilities supported'}`);
  console.log(`Artifact: ${artifactPath}`);
  process.exitCode = status;
}

async function commandOutput(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }); let stdout = ''; let stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${command} exited ${code}: ${stderr}`)));
  });
}
async function provenance() {
  const head = await commandOutput('git', ['rev-parse', 'HEAD']);
  const candidates = [
      'scripts/dev/page-translation-e2e-firefox/capabilities.mjs', 'scripts/dev/page-translation-e2e-firefox/driver.mjs',
      'scripts/dev/page-translation-e2e-firefox/run.mjs', 'scripts/dev/page-translation-e2e-firefox/launcher.mjs', 'scripts/dev/page-translation-e2e-firefox/README.md', 'scripts/dev/page-translation-e2e-firefox/loopback-edge-proxy.mjs', 'scripts/dev/page-translation-e2e-firefox/controller-abort-observer.mjs', 'scripts/dev/page-translation-e2e-firefox/page-stop-worker-entry.mjs', 'scripts/dev/page-translation-e2e-firefox/page-stop-content-entry.mjs', 'scripts/dev/page-translation-e2e-firefox-proxy.test.js', 'scripts/dev/page-translation-e2e-firefox.test.js', 'scripts/dev/page-translation-e2e-firefox-runtime.test.js', 'scripts/dev/page-translation-e2e-benchmark/build.mjs',
      'scripts/dev/page-translation-e2e-firefox/runtime-replacement-collector.mjs', 'scripts/dev/page-translation-e2e-firefox/runtime-replacement-background.mjs', 'scripts/dev/page-translation-e2e-firefox/runtime-replacement-content.mjs', 'scripts/dev/page-translation-e2e-firefox/runtime-replacement-protocol.mjs', 'scripts/dev/page-translation-e2e-firefox/page-replacement-worker-entry.mjs', 'scripts/dev/page-translation-e2e-firefox/page-replacement-content-entry.mjs',
      'scripts/dev/page-translation-e2e-firefox/runtime-stale-collector.mjs', 'scripts/dev/page-translation-e2e-firefox-stale-driver.test.js',
    'scripts/dev/page-translation-e2e-benchmark/build-environment.mjs',
     'scripts/dev/page-translation-e2e-firefox/runtime-background.mjs', 'scripts/dev/page-translation-e2e-firefox/runtime-content.mjs', 'scripts/dev/page-translation-e2e-firefox/runtime-constants.mjs', 'scripts/dev/page-translation-e2e-firefox/runtime-collector.mjs', 'scripts/dev/page-translation-e2e-firefox/restore-dom-diagnostics.mjs',
     'scripts/dev/page-translation-e2e-benchmark/provider-probe.mjs', 'scripts/dev/page-translation-e2e-benchmark/provider-probe-content.mjs',
    'scripts/dev/page-translation-e2e-benchmark/worker-entry.mjs', 'scripts/dev/page-translation-e2e-benchmark/content-entry.mjs',
    'scripts/dev/page-translation-e2e-benchmark/cancellation-probes.mjs', 'scripts/dev/page-translation-e2e-benchmark/fixture.mjs',
     'scripts/dev/page-translation-e2e-benchmark/metrics.mjs', 'scripts/dev/page-translation-e2e-benchmark/trace.mjs', 'scripts/dev/page-translation-e2e-benchmark/page-translation-start-probe.mjs', 'scripts/dev/page-translation-e2e-benchmark/artifact-writer.mjs',
    'src/features/page-translation/PageTranslationConstants.js',
  ];
  const sourceHashes = {};
  for (const file of candidates) sourceHashes[file] = createHash('sha256').update(await readFile(file)).digest('hex');
  return { head, sourceHashes, discoveryMode: 'sliced', slicedDiscovery: true, viewportFirstDiscovery: false };
}
async function writeFailure(reason, error) {
  const artifact = { ...baseArtifact, runId, status: 'FAILED', reason, errors: [error?.stack ?? String(error)], capabilities: { ...baseArtifact.capabilities, isolation: capability('FAILED', { reason }) }, cleanup: { status: 'NOT_TESTED', reason: 'Browser was not launched.' } };
  try {
    await stat(dirname(artifactPath));
    await writeBenchmarkArtifact(artifactPath, artifact);
  } catch (writeError) { console.error(`Could not write failure artifact (${artifactPath}): ${writeError.message}`); }
}
