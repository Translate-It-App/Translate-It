import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { buildBenchmarkExtension } from './build.mjs';
import { runTrial } from './trial-runner.mjs';
import { validateBuildParity, validateSuccessfulReplyBuildParity } from './build-environment.mjs';
import { writeBenchmarkArtifact } from './artifact-writer.mjs';
import { longTasksWithinInterval, summarize, summarizeIntervals, summarizeLongTasks, validateRunGate, measureScenarioRuns } from './metrics.mjs';
import { createFixture } from './fixture.mjs';
import { modeOrder, parseProviderLane, providerLaneFinalization, parseScenarioSelection, parseScrollSchedulingMode, shouldRunProviderPerformanceLane, validateSampleCount, usesBandedProviderScroll } from './scenario-plan.mjs';
import { parseCancellationProbeSelection } from './cancellation-probes.mjs';
import { parseCustomStaleSuccessScheduling, parseSuccessfulReplyProbeSelection } from './successful-reply-probes.mjs';
import { parseResilienceProbeSelection, validateResilienceProbeIsolation } from './resilience-probes.mjs';

const root = process.cwd();
const providerLane = parseProviderLane(process.env);
const cancellationProbes = parseCancellationProbeSelection(process.env.BENCH_CANCELLATION_PROBES);
const staleSuccessProbes = parseSuccessfulReplyProbeSelection(process.env.BENCH_STALE_SUCCESS_PROBES);
const resilienceProbes = parseResilienceProbeSelection(process.env.BENCH_RESILIENCE_PROBES);
if (cancellationProbes.length && staleSuccessProbes.length) throw new TypeError('Cancellation and stale-success probes must run separately.');
if ([cancellationProbes, staleSuccessProbes, resilienceProbes].filter(items => items.length).length > 1) throw new TypeError('Isolated correctness probes must run separately.');
const isolatedProbes = cancellationProbes.length ? cancellationProbes : staleSuccessProbes.length ? staleSuccessProbes : resilienceProbes;
validateResilienceProbeIsolation({
  selected: resilienceProbes.length > 0, provider: providerLane?.provider,
  probe: resilienceProbes[0],
  optimizationLevel: providerLane?.optimizationLevel, modes: process.env.BENCH_MODES,
  scenario: process.env.BENCH_SCENARIOS, schedulingMode: process.env.BENCH_SCROLL_SCHEDULING,
  competingProbe: cancellationProbes.length > 0 || staleSuccessProbes.length > 0,
});
const customStaleSuccess = staleSuccessProbes.includes('custom-stale-success');
if (providerLane && (cancellationProbes.length || staleSuccessProbes.length
    && (!customStaleSuccess || providerLane.provider !== 'custom' || providerLane.optimizationLevel !== 3))) {
  throw new TypeError('Provider lane can only accompany custom-stale-success at Custom optimization level 3.');
}
if (customStaleSuccess && (staleSuccessProbes.length !== 1 || providerLane?.provider !== 'custom' || providerLane.optimizationLevel !== 3)) {
  throw new TypeError('custom-stale-success requires an isolated Custom provider lane at optimization level 3.');
}
const requestedModes = [...new Set((providerLane ? 'sliced' : process.env.BENCH_MODES ?? (isolatedProbes.length ? 'sliced' : 'legacy,sliced,viewport')).split(',').map(value => value.trim()).filter(Boolean))];
if (isolatedProbes.length && (requestedModes.length !== 1 || requestedModes[0] !== 'sliced')) {
  throw new TypeError('Cancellation and stale-success probes require BENCH_MODES=sliced only.');
}
if (isolatedProbes.length && !resilienceProbes.length && process.env.BENCH_SCENARIOS && process.env.BENCH_SCENARIOS !== 'early-visible') {
  throw new TypeError('Cancellation and stale-success probes require BENCH_SCENARIOS=early-visible.');
}
const modes = providerLane ? ['sliced'] : isolatedProbes.length ? ['sliced'] : ['legacy', ...requestedModes.filter(mode => mode !== 'legacy')];
const scenarios = isolatedProbes.length ? [resilienceProbes.length ? 'scroll-through' : 'early-visible'] : parseScenarioSelection(usesBandedProviderScroll(providerLane?.provider) ? process.env.BENCH_SCENARIOS ?? 'scroll-through' : process.env.BENCH_SCENARIOS ?? 'small');
const probeSchedulingMode = customStaleSuccess ? parseCustomStaleSuccessScheduling(process.env.BENCH_SCROLL_SCHEDULING) : null;
const scrollSchedulingMode = customStaleSuccess ? null : parseScrollSchedulingMode(process.env.BENCH_SCROLL_SCHEDULING);
if (scenarios.includes('scroll-through') !== (scrollSchedulingMode !== null)) throw new TypeError('BENCH_SCENARIOS=scroll-through requires BENCH_SCROLL_SCHEDULING=fluid or on-stop, and scheduling is only valid with scroll-through.');
if (!customStaleSuccess && usesBandedProviderScroll(providerLane?.provider)
    && (scenarios.length !== 1 || scenarios[0] !== 'scroll-through')) {
  throw new TypeError(`${providerLane.provider} provider lane requires the scroll-through workload.`);
}
const samples = Number(process.env.BENCH_SAMPLES ?? 5);
const warmups = Number(process.env.BENCH_WARMUPS ?? 1);
const defaultArtifact = `/tmp/opencode/page-translation-${providerLane ? 'provider-' : ''}e2e-${new Date().toISOString().replaceAll(':', '-')}-${process.pid}.json`;
const artifactPath = resolve(process.env.BENCH_OUTPUT ?? defaultArtifact);
const sourcePaths = [
  'src/core/background/index.js',
  'src/core/content-scripts/index-main.js',
  'src/features/page-translation/PageTranslationManager.js',
  'src/features/page-translation/PageTranslationScheduler.js',
  'src/features/page-translation/PageTranslationBridge.js',
  'src/features/page-translation/PageTranslationConstants.js',
  'src/features/translation/providers/MicrosoftEdgeProvider.js',
  'src/features/translation/providers/GoogleTranslateV2Provider.js',
  'src/features/translation/providers/CustomProvider.js',
  'src/features/translation/providers/GoogleGemini.js',
  'src/features/translation/providers/BaseAIProvider.js',
  'src/features/translation/providers/utils/AIResponseParser.js',
  'src/features/translation/providers/ProviderManifest.js',
  'src/features/translation/core/ProviderConfigurations.js',
  'src/core/services/translation/UnifiedTranslationService.js',
  'scripts/dev/page-translation/e2e-benchmark/run.mjs',
  'scripts/dev/page-translation/e2e-benchmark/trial-runner.mjs',
  'scripts/dev/page-translation/e2e-benchmark/fixture.mjs',
  'scripts/dev/page-translation/e2e-benchmark/metrics.mjs',
  'scripts/dev/page-translation/e2e-benchmark/google-v2-fixture.mjs',
  'scripts/dev/page-translation/e2e-benchmark/custom-fixture.mjs',
  'scripts/dev/page-translation/e2e-benchmark/gemini-fixture.mjs',
  'scripts/dev/page-translation/e2e-benchmark/resilience-probes.mjs',
  'scripts/dev/page-translation/e2e-benchmark/network-interception.mjs',
  'scripts/dev/page-translation/e2e-benchmark/resilience/googlev2-503.mjs',
  'scripts/dev/page-translation/e2e-benchmark/resilience/googlev2-timeout.mjs',
  'scripts/dev/page-translation/e2e-benchmark/resilience/custom-429.mjs',
  'scripts/dev/page-translation/e2e-benchmark/resilience/custom-400.mjs',
  'scripts/dev/page-translation/e2e-benchmark/resilience/custom-cancellation.mjs',
  'scripts/dev/page-translation/e2e-benchmark/resilience/gemini-structured-recovery.mjs',
  'scripts/dev/page-translation/e2e-benchmark/build.mjs',
  'scripts/dev/page-translation/e2e-benchmark/build-environment.mjs',
  'scripts/dev/page-translation/e2e-benchmark/chrome.mjs',
  'scripts/dev/page-translation/e2e-benchmark/worker-entry.mjs',
  'scripts/dev/page-translation/e2e-benchmark/content-entry.mjs',
  'scripts/dev/page-translation/e2e-benchmark/provider-probe-content.mjs',
  'scripts/dev/page-translation/e2e-benchmark/trace.mjs',
  'scripts/dev/page-translation/e2e-benchmark/measurement-lifecycle.mjs',
  'scripts/dev/page-translation/e2e-benchmark/rate-limit-queue.mjs',
  'scripts/dev/page-translation/e2e-benchmark/artifact-writer.mjs',
  'scripts/dev/page-translation/e2e-benchmark/scenario-plan.mjs',
  'scripts/dev/page-translation/e2e-benchmark/cancellation-probes.mjs',
  'scripts/dev/page-translation/e2e-benchmark/cancellation-runner.mjs',
  'scripts/dev/page-translation/e2e-benchmark/stale-success-runner.mjs',
  'scripts/dev/page-translation/e2e-benchmark/trial-validation.mjs',
  'scripts/dev/page-translation/e2e-benchmark/successful-reply-probes.mjs',
  'scripts/dev/page-translation/e2e-benchmark/successful-reply-gate.mjs',
  'scripts/dev/page-translation/e2e-benchmark/README.md',
  'scripts/dev/page-translation/page-translation-e2e-runtime.test.js',
  'scripts/dev/page-translation/page-translation-e2e-benchmark.test.js',
  'scripts/dev/page-translation/page-translation-e2e-measurement.test.js',
  'scripts/dev/page-translation/page-translation-e2e-large-page.test.js',
  'scripts/dev/page-translation/page-translation-e2e-artifact-writer.test.js',
  'scripts/dev/page-translation/page-translation-e2e-cancellation.test.js',
  'scripts/dev/page-translation/page-translation-e2e-custom-cancellation.test.js',
  'scripts/dev/page-translation/page-translation-e2e-stale-success.test.js',
  'scripts/dev/page-translation/page-translation-e2e-scheduler-stale-success.test.js',
  'scripts/dev/page-translation/page-translation-e2e-successful-reply-gate.test.js',
];
const settings = Object.freeze({
  WHOLE_PAGE_LAZY_LOADING: false,
  WHOLE_PAGE_TRANSLATE_AFTER_SCROLL_STOP: false,
  WHOLE_PAGE_AUTO_TRANSLATE_ON_DOM_CHANGES: false,
  PROXY_ENABLED: false,
});
const now = () => Date.now();
async function hashFile(path) { return createHash('sha256').update(await readFile(resolve(root, path))).digest('hex'); }
function git(...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
function measureMode(runs) {
  const intervals = (start, end) => summarizeIntervals(runs.map(start), runs.map(end));
  const times = {
    commandToFirstVisibleWrite: intervals(run => run.timestamps.translationCommand, run => run.derivedTimings?.firstVisibleAcceptedWrite),
    commandToVisibleCompletion: intervals(run => run.timestamps.translationCommand, run => run.derivedTimings?.visibleSetCompletion),
    commandToAllWrites: intervals(run => run.timestamps.translationCommand, run => run.derivedTimings?.allAcceptedWrites),
    commandToInitialAllWrites: intervals(run => run.timestamps.translationCommand, run => run.derivedTimings?.initialAllAcceptedWrites),
    commandToCompletion: intervals(run => run.timestamps.translationCommand, run => run.derivedTimings?.completion),
    commandToDiscoveryDrain: intervals(run => run.timestamps.translationCommand, run => run.derivedTimings?.discoveryDrained),
    commandToFirstFlush: intervals(run => run.timestamps.translationCommand, run => run.derivedTimings?.firstSchedulerFlush),
    commandToBatchEntry: intervals(run => run.timestamps.translationCommand, run => run.derivedTimings?.schedulerRequestEntry),
    commandToBackgroundAdmission: intervals(run => run.timestamps.translationCommand, run => run.derivedTimings?.backgroundAdmission),
    restoreDuration: intervals(run => run.derivedTimings?.restoreStart, run => run.derivedTimings?.restoreEnd),
  };
  const taskEntries = runs.map(run => run.derivedTimings?.longTasks);
  const longTaskSummary = taskEntries.some(entries => entries === null || entries === undefined)
    ? { ...summarizeLongTasks(null), unavailableReason: 'One or more trials lacked calibrated long-task observations.' }
    : { ...summarizeLongTasks(taskEntries.flat()), unavailableReason: null };
  return {
    n: runs.length,
    times,
    ...(runs.every(run => run.lane === 'provider') ? { providerExecution: {
      logicalBatchCounts: runs.map(run => run.providerLogicalBatches?.logicalBatchCount ?? null),
      logicalBatchSizes: runs.map(run => run.providerLogicalBatches?.logicalBatchSizes ?? null),
      peakLogicalBatchConcurrency: runs.map(run => run.providerLogicalBatches?.peakLogicalBatchConcurrency ?? null),
      configuredPageWorkerLimits: runs.map(run => run.pageWorkerLimit ?? null),
      effectiveProviderLimiterCapacity: runs.map(run => run.providerRuntimeObserved?.limiterCapacity ?? null),
      physicalRequestCounts: runs.map(run => run.physicalProviderAccounting?.physicalRequestCount ?? null),
      peakPhysicalHTTPOverlap: runs.map(run => run.physicalProviderAccounting?.peakPhysicalConcurrency ?? null),
      concurrencyValidation: runs.map(run => run.providerConcurrencyValidation ?? null),
      physicalRequestLatencyMs: summarize(runs.flatMap(run => (run.providerHTTPAttempts ?? []).map(attempt => attempt.latencyMs))),
      commandToFirstAcceptedTranslationMs: summarizeIntervals(runs.map(run => run.timestamps.translationCommand),
        runs.map(run => run.firstAcceptedTranslationAt)),
      commandToTotalCompletionMs: summarizeIntervals(runs.map(run => run.timestamps.translationCommand),
        runs.map(run => run.totalCompletionAt)),
      sourceLanguageQuery: runs.map(run => (run.providerHTTPAttempts ?? []).map(attempt => attempt.sl)),
      note: 'Limits, scheduler logical batch overlap, and CDP-observed physical HTTP overlap are separate measurements; batches are not equated with requests.',
    } } : {}),
    providerAttemptCounts: runs.map(run => run.providerTranslationAttempts),
    providerBatchSizes: runs.map(run => run.providerBatchSizes),
    startupMetadataFixtureCount: runs.map(run => run.requests.filter(request => request.category === 'startup-metadata-fixture').length),
    longTaskSamples: runs.map(run => run.derivedTimings?.longTasks ?? null),
    longTaskSummary,
    longTaskCalibration: runs.map(run => run.longTaskCalibration ?? { supported: false, reason: 'calibration was not run' }),
    dynamicCohorts: Object.fromEntries([...new Set(runs.flatMap(run => (run.derivedTimings?.dynamicCohorts ?? []).map(cohort => cohort.id)))].map(id => [id, {
      insertionToFirstAccepted: intervals(run => run.derivedTimings?.dynamicCohorts?.find(cohort => cohort.id === id)?.insertedAt,
        run => run.derivedTimings?.dynamicCohorts?.find(cohort => cohort.id === id)?.firstAcceptedAt),
      insertionToAllAccepted: intervals(run => run.derivedTimings?.dynamicCohorts?.find(cohort => cohort.id === id)?.insertedAt,
        run => run.derivedTimings?.dynamicCohorts?.find(cohort => cohort.id === id)?.completionAt),
    }])),
    ...(runs.every(run => run.scenario === 'spa-navigation') ? (() => {
      const longTaskSamples = runs.map(run => longTasksWithinInterval(run.derivedTimings?.longTasks,
        run.spaNavigationTiming?.navStartedAt, run.spaNavigationTiming?.terminalAt));
      const longTaskSummary = longTaskSamples.some(entries => entries === null)
        ? { ...summarizeLongTasks(null), unavailableReason: 'One or more SPA trials lacked calibrated long-task observations or navigation boundaries.' }
        : { ...summarizeLongTasks(longTaskSamples.flat()), unavailableReason: null };
      return { spaNavigation: {
        navigationToFirstAcceptedWrite: summarizeIntervals(runs.map(run => run.spaNavigationTiming?.navStartedAt), runs.map(run => run.spaNavigationTiming?.firstAcceptedAt)),
        navigationToBCompletion: summarizeIntervals(runs.map(run => run.spaNavigationTiming?.navStartedAt), runs.map(run => run.spaNavigationTiming?.terminalAt)),
        longTaskMeasurementBoundary: 'Calibrated fixture-document PerformanceObserver tasks whose full intervals fall between native pushState click start (performance.now) and B-session terminal receipt; excludes route A and Restore.',
        longTaskSamples,
        longTaskSummary,
        longTaskCalibration: runs.map(run => run.longTaskCalibration ?? { supported: false, reason: 'calibration was not run' }),
        rawTrials: runs.map(run => run.spaNavigationTiming ?? null),
      } };
     })() : {}),
   };
}

const harness = {
  command: 'node scripts/dev/page-translation/e2e-benchmark/run.mjs',
  artifactPath,
  provenance: {},
  settings,
  scenarios: scenarios.map(scenario => {
    const fixture = createFixture(scenario, { providerLane: usesBandedProviderScroll(providerLane?.provider) });
    return { scenario, targetCount: fixture.targetCount, visibleIds: fixture.visibleIds, viewport: fixture.viewport, scroll: fixture.scroll, responseDelayMs: fixture.responseDelayMs };
  }),
  fixtureWarmupSemantics: 'Each trial starts a fresh Chrome process/profile; warmups are discarded cold-profile runs, not persistent-process/JIT warmups.',
  requestedModes: modes,
  ...(providerLane ? { lane: providerLane.lane, provider: providerLane.provider, optimizationLevel: providerLane.optimizationLevel } : {}),
  warmups,
  measuredSamples: samples,
  startedAt: now(),
  builds: [],
  results: [],
  plannedMeasuredOrder: [],
  cleanupErrors: [],
  nonPerformanceProbes: {
    cancellationStaleResponse: {
      status: 'not-run',
      reason: 'Not implemented in this bounded pass; it needs a separate held-Fetch cancellation trial. No cancellation stale-write claim is made.',
    },
    ...(cancellationProbes.length ? { cancellation: { requested: cancellationProbes, cases: [] } } : {}),
    ...(staleSuccessProbes.length ? { successfulStaleReply: { requested: staleSuccessProbes, cases: [] } } : {}),
  },
  networkGuardScope: 'Fetch request-stage guard is installed before the test extension service worker resumes and before the top-level fixture page navigates. It covers that worker and the page target, including its isolated content world; iframe targets and Chrome process/component-extension telemetry are outside the measured scope.',
  limitations: {
    runtimeMessageHandoff: 'Not observed with a transparent runtime.sendMessage call-through; scheduler request entry and background admission remain separately timestamped.',
    performanceScope: 'Small fixture is 12 static targets. Large fixtures use a four-target visible window with three DOM/visual orders; results remain exploratory. The 800ms initial batch timer and 1000-item queue emergency bound can mask priority benefits.',
    heapLeak: 'Not measured; no heap-leak claim.',
  },
  status: 'running',
};
let primaryError;
const buildDirs = [];

async function writeArtifact() {
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeBenchmarkArtifact(artifactPath, harness);
}

async function compileMode(mode, { successfulReplyGate = false } = {}) {
  const outputDir = await mkdtemp(resolve(tmpdir(), `page-translation-${mode}-`));
  buildDirs.push(outputDir);
  const built = { mode, outputDir, startedAt: now(), successfulReplyGate };
  try {
    const result = await buildBenchmarkExtension({
      outputDir,
      mode,
      workerEntry: resolve(root, 'scripts/dev/page-translation/e2e-benchmark/worker-entry.mjs'),
      contentEntry: resolve(root, 'scripts/dev/page-translation/e2e-benchmark/content-entry.mjs'),
      successfulReplyGate,
      onBuildEnvironment: environment => { built.environment = environment; },
    });
    built.outputDir = result;
    built.status = 'passed';
  } catch (error) {
    built.status = 'failed';
    built.error = error.message;
    throw error;
  } finally {
    built.completedAt = now();
    harness.builds.push(built);
  }
  return built.outputDir;
}

function validateHarnessBuildParity() {
  const parity = validateBuildParity(harness.builds, modes);
  harness.buildParity = parity;
  if (!parity.ok) throw new Error(`Build parity gate failed: ${parity.issues.join('; ')}`);
  return parity;
}

function validateSuccessfulReplyHarnessBuildParity() {
  const parity = validateSuccessfulReplyBuildParity(harness.builds, modes);
  harness.buildParity = parity;
  if (!parity.ok) throw new Error(`Successful stale-reply build parity gate failed: ${parity.issues.join('; ')}`);
  return parity;
}

async function runNetworkGuardNegativeProbe(extensionPath, mode = 'legacy') {
  const probeArtifactPath = `${artifactPath.replace(/\.json$/i, '')}-network-guard-probe.json`;
  const run = await runTrial({ mode, scenario: 'small', ordinal: 1, globalRunOrder: ++globalRunOrder, phase: 'non-performance-network-guard-probe', extensionPath, settings, providerLane, fixtureConfig: createFixture('small'), networkGuardProbe: true });
  const blockedRequests = run.networkGuardProbe?.map(result => ({ world: result.world, url: result.url, method: result.request.method, blocked: result.request.blocked, reason: result.request.error })) ?? [];
  const probe = {
    command: 'runTrial legacy negative network guard probe (non-performance; excluded from aggregates)',
    status: run.status,
    expected: { worlds: ['page-main-world', 'extension-isolated-world'], result: 'request intercepted and blocked before network access' },
    blockedRequests,
    run,
    artifactPath: probeArtifactPath,
  };
  await mkdir(dirname(probeArtifactPath), { recursive: true });
  await writeFile(probeArtifactPath, JSON.stringify(probe, null, 2));
  harness.nonPerformanceProbes.networkGuard = { artifactPath: probeArtifactPath, status: probe.status, blockedRequests };
  if (probe.status !== 'passed') throw new Error(`Negative network guard probe failed; see ${probeArtifactPath}`);
}

let globalRunOrder = 0;
async function runRecordedTrial(options) {
  const run = await runTrial({ ...options, globalRunOrder: ++globalRunOrder, settings, providerLane });
  harness.results.push(run);
  if (run.browser?.browserVersion) harness.provenance.browserVersion = run.browser.browserVersion;
  if (run.status !== 'passed') throw new Error(`${run.mode}/${run.scenario} ${run.phase} ${run.ordinal} failed: ${run.error?.message ?? run.cleanupErrors.join('; ')}`);
  return run;
}

try {
  if (!requestedModes.length || requestedModes.some(mode => !['legacy', 'sliced', 'viewport'].includes(mode))) throw new TypeError(`Unsupported BENCH_MODES: ${requestedModes.join(',')}`);
  if (!isolatedProbes.length) {
    validateSampleCount(samples);
    if (!Number.isInteger(warmups) || warmups < 1 || warmups > 3) throw new TypeError('BENCH_WARMUPS must be 1, 2, or 3.');
  }
  harness.provenance = {
    gitSha: git('rev-parse', 'HEAD'),
    branch: git('branch', '--show-current'),
    workingTree: git('status', '--short'),
    trackedChanges: { unstaged: git('diff', '--name-only'), staged: git('diff', '--cached', '--name-only') },
    browserVersion: null,
    fileSha256: Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, await hashFile(path)]))),
  };
  if (resilienceProbes.length) {
    const probe = resilienceProbes[0];
    const custom429 = probe === 'custom-429' || probe === 'custom-cancellation';
    const provider = probe === 'gemini-structured-recovery' ? 'gemini' : custom429 ? 'custom' : 'googlev2';
    harness.command = `BENCH_RESILIENCE_PROBES=${probe} BENCH_LANE=provider BENCH_PROVIDER=${provider} BENCH_OPTIMIZATION_LEVEL=3 BENCH_MODES=sliced BENCH_SCENARIOS=scroll-through BENCH_SCROLL_SCHEDULING=fluid node scripts/dev/page-translation/e2e-benchmark/run.mjs`;
    harness.warmups = 0;
    harness.measuredSamples = 0;
    harness.resilienceProbe = { requested: probe, scenario: 'scroll-through', schedulingMode: 'fluid', status: 'running' };
    const extensionPath = await compileMode('sliced');
    validateHarnessBuildParity();
    await runNetworkGuardNegativeProbe(extensionPath, 'sliced');
    const run = await runTrial({
      mode: 'sliced', scenario: 'scroll-through', ordinal: 1, globalRunOrder: ++globalRunOrder,
       phase: `isolated-${probe}-resilience`, extensionPath, settings, providerLane, resilienceProbe: probe,
      fixtureConfig: createFixture('scroll-through', { providerLane: true }), schedulingMode: 'fluid',
    });
    harness.results.push(run);
    harness.provenance.browserVersion = run.browser?.browserVersion ?? null;
    const rawPath = `${artifactPath.replace(/\.json$/i, '')}-resilience-${probe}.json`;
    await mkdir(dirname(rawPath), { recursive: true });
    await writeFile(rawPath, JSON.stringify({
      command: harness.command, status: run.status, provenance: harness.provenance,
      builds: harness.builds, buildParity: harness.buildParity,
      probe: { requested: probe, scenario: 'scroll-through', schedulingMode: 'fluid' }, run,
    }, null, 2));
    harness.resilienceProbe = { requested: probe, status: run.status, artifactPath: rawPath,
      validation: run.resilience?.validation ?? null };
    harness.comparisonGate = { comparisonsAllowed: false, reason: 'Isolated resilience correctness probe; no performance aggregation.' };
    if (run.status !== 'passed') throw new Error(run.error?.message ?? `${probe} resilience probe failed.`);
    harness.status = 'passed';
  } else if (shouldRunProviderPerformanceLane(providerLane, customStaleSuccess)) {
    harness.command = `BENCH_LANE=provider BENCH_PROVIDER=${providerLane.provider} BENCH_OPTIMIZATION_LEVEL=${providerLane.optimizationLevel} BENCH_MODES=sliced node scripts/dev/page-translation/e2e-benchmark/run.mjs`;
    harness.warmups = warmups;
    harness.measuredSamples = samples;
    harness.executionPlan = {
      lane: 'provider', provider: providerLane.provider, optimizationLevel: providerLane.optimizationLevel,
      discoveryMode: 'sliced', scenarios, warmups, measuredSamples: samples,
      transport: 'Synthetic locally fulfilled Edge fixture; no live provider requests.',
      aggregation: 'Provider attempts are per physical intercepted HTTP request; no discovery comparison artifacts.',
    };
    const slicedOutput = await compileMode('sliced');
    validateHarnessBuildParity();
    await runNetworkGuardNegativeProbe(slicedOutput, 'sliced');
    for (const scenario of scenarios) {
      const fixture = createFixture(scenario, { providerLane: usesBandedProviderScroll(providerLane?.provider) });
      for (let ordinal = 1; ordinal <= warmups; ordinal++) {
        await runRecordedTrial({ mode: 'sliced', scenario, ordinal, phase: 'warmup', extensionPath: slicedOutput, fixtureConfig: fixture, schedulingMode: scenario === 'scroll-through' ? scrollSchedulingMode : null });
      }
    }
    for (const scenario of scenarios) for (let ordinal = 1; ordinal <= samples; ordinal++) {
      harness.plannedMeasuredOrder.push({ scenario, ordinal, modes: ['sliced'] });
      await runRecordedTrial({ mode: 'sliced', scenario, ordinal, phase: 'measured', extensionPath: slicedOutput, fixtureConfig: createFixture(scenario, { providerLane: usesBandedProviderScroll(providerLane?.provider) }), schedulingMode: scenario === 'scroll-through' ? scrollSchedulingMode : null });
    }
    harness.scenarioSummaries = {};
    for (const scenario of scenarios) {
      harness.scenarioSummaries[scenario] = {
        sliced: measureScenarioRuns(harness.results, scenario, 'sliced', measureMode),
      };
    }
    harness.comparisonGate = { comparisonsAllowed: false, reason: 'Provider lane is separate from discovery/comparison artifacts.' };
    harness.status = harness.results.every(run => run.status === 'passed') ? 'passed' : 'failed';
  } else if (cancellationProbes.length) {
    harness.command = `BENCH_CANCELLATION_PROBES=${cancellationProbes.join(',')} BENCH_MODES=sliced node scripts/dev/page-translation/e2e-benchmark/run.mjs`;
    harness.warmups = 0;
    harness.measuredSamples = 0;
    harness.cancellationExecutionPlan = { mode: 'sliced', scenario: 'early-visible', trialCount: cancellationProbes.length, warmups: 0, performanceSamples: 0, performanceAggregation: false };
    harness.comparisonOrdering = 'Dedicated Sliced-only cancellation probes; no performance aggregation or mode comparison is performed.';
    const slicedOutput = await compileMode('sliced');
    await runNetworkGuardNegativeProbe(slicedOutput, 'sliced');
    for (const [index, probe] of cancellationProbes.entries()) {
      const caseRecord = { probe, ordinal: index + 1, status: 'running', resultIndex: harness.results.length };
      harness.nonPerformanceProbes.cancellation.cases.push(caseRecord);
      try {
        const trial = await runRecordedTrial({
          mode: 'sliced', scenario: 'early-visible', ordinal: index + 1,
          phase: 'cancellation-probe', extensionPath: slicedOutput,
          fixtureConfig: createFixture('early-visible'), cancellationProbe: probe,
        });
        caseRecord.status = trial.status;
        caseRecord.sessionA = trial.cancellation?.sessionA ?? null;
        caseRecord.sessionB = trial.cancellation?.sessionB ?? null;
      } catch (error) {
        caseRecord.status = 'failed';
        caseRecord.error = error.message;
        throw error;
      }
    }
    harness.cancellationGate = { passed: harness.nonPerformanceProbes.cancellation.cases.every(item => item.status === 'passed') };
    harness.comparisonGate = { comparisonsAllowed: false, reason: 'Not run for cancellation probes.' };
    harness.nonPerformanceProbes.cancellationStaleResponse = {
      status: 'not-proven',
      reason: 'The probes use real controller cancellation and held Fetch requests, but do not fabricate a successful late provider response. Per-case Fetch release outcome and provider-root/physical-promise settlement classify whether the stale-success guard was exercised.',
    };
    harness.status = harness.cancellationGate.passed ? 'passed' : 'failed';
  } else if (staleSuccessProbes.length) {
    harness.command = `${customStaleSuccess ? 'BENCH_LANE=provider BENCH_PROVIDER=custom BENCH_OPTIMIZATION_LEVEL=3 BENCH_SCROLL_SCHEDULING=fluid ' : ''}BENCH_STALE_SUCCESS_PROBES=${staleSuccessProbes.join(',')} BENCH_MODES=sliced BENCH_SCENARIOS=early-visible node scripts/dev/page-translation/e2e-benchmark/run.mjs`;
    harness.warmups = 0;
    harness.measuredSamples = 0;
    harness.successfulReplyExecutionPlan = {
      mode: 'sliced', scenario: 'early-visible', cases: staleSuccessProbes.length,
      warmups: 0, performanceSamples: 0, performanceAggregation: false,
      ...(customStaleSuccess ? { schedulingMode: probeSchedulingMode,
        schedulingModeSemantics: 'Fluid is recorded as requested probe configuration only; Early-visible has no scroll scheduler settings enabled.' } : {}),
      perCase: 'A genuine successful safeSendMessage result is gated after production send/timeout/cancellation checks; B provider work remains held while A reply is released.',
    };
    harness.comparisonOrdering = 'Dedicated Sliced-only successful stale-reply correctness probes; no performance aggregation or mode comparison is performed.';
    const slicedOutput = await compileMode('sliced');
    await runNetworkGuardNegativeProbe(slicedOutput, 'sliced');
    const staleSuccessOutput = await compileMode('sliced', { successfulReplyGate: true });
    if (customStaleSuccess) validateSuccessfulReplyHarnessBuildParity();
    for (const [index, probe] of staleSuccessProbes.entries()) {
      const caseRecord = { probe, ordinal: index + 1, status: 'running', resultIndex: harness.results.length };
      harness.nonPerformanceProbes.successfulStaleReply.cases.push(caseRecord);
      try {
        const trial = await runRecordedTrial({
          mode: 'sliced', scenario: 'early-visible', ordinal: index + 1,
          phase: 'successful-stale-reply-probe', extensionPath: staleSuccessOutput,
          fixtureConfig: createFixture('early-visible', { providerLane: customStaleSuccess }), staleSuccessProbe: probe,
          probeSchedulingMode: customStaleSuccess ? probeSchedulingMode : null,
        });
        caseRecord.status = trial.status;
        caseRecord.sessionA = trial.staleSuccess?.sessionA ?? null;
        caseRecord.sessionB = trial.staleSuccess?.sessionB ?? null;
      } catch (error) {
        caseRecord.status = 'failed';
        caseRecord.error = error.message;
        throw error;
      }
    }
    harness.successfulStaleReplyGate = {
      passed: harness.nonPerformanceProbes.successfulStaleReply.cases.every(item => item.status === 'passed'),
      cases: harness.nonPerformanceProbes.successfulStaleReply.cases,
    };
    harness.comparisonGate = { comparisonsAllowed: false, reason: 'Not run for successful stale-reply probes.' };
    harness.status = harness.successfulStaleReplyGate.passed ? 'passed' : 'failed';
  } else {
    harness.comparisonOrdering = 'Legacy warmups qualify first. Every selected mode then receives complete discarded warmups before measured rounds; measured mode order is a deterministic cyclic rotation of all selected modes by scenario index plus zero-based measured ordinal.';
    const scenarioPlans = scenarios.map((scenario, index) => ({ scenario, index, fixture: createFixture(scenario, { providerLane: usesBandedProviderScroll(providerLane?.provider) }), schedulingMode: scenario === 'scroll-through' ? scrollSchedulingMode : null }));
    harness.schedulingMode = scrollSchedulingMode;
    const legacyOutput = await compileMode('legacy');
    const legacyRuns = [];
    harness.scenarioSummaries = {};
    for (const plan of scenarioPlans) {
      for (let ordinal = 1; ordinal <= warmups; ordinal++) {
        const run = await runRecordedTrial({ mode: 'legacy', scenario: plan.scenario, ordinal, phase: 'warmup', extensionPath: legacyOutput, fixtureConfig: plan.fixture, schedulingMode: plan.schedulingMode });
        legacyRuns.push(run);
      }
    }
    const qualificationParity = validateBuildParity(harness.builds, ['legacy']);
    harness.legacyQualificationGate = validateRunGate({
      legacyResults: legacyRuns,
      measuredSamples: [],
      allResults: harness.results,
      expectedModes: ['legacy'], expectedScenarios: scenarios, expectedSamples: 0, expectedWarmups: warmups,
      buildParity: qualificationParity,
    });
    if (!harness.legacyQualificationGate.comparisonsAllowed) throw new Error(`Legacy qualification failed: ${harness.legacyQualificationGate.issues.join('; ')}`);

    const modeOutputs = new Map([['legacy', legacyOutput]]);
    for (const mode of modes) if (mode !== 'legacy') modeOutputs.set(mode, await compileMode(mode));
    validateHarnessBuildParity();
    await runNetworkGuardNegativeProbe(legacyOutput);

    const candidateModes = modes.filter(mode => mode !== 'legacy');
    for (const plan of scenarioPlans) {
      for (const mode of modes) {
        if (mode === 'legacy') continue;
        for (let ordinal = 1; ordinal <= warmups; ordinal++) {
          await runRecordedTrial({ mode, scenario: plan.scenario, ordinal, phase: 'warmup', extensionPath: modeOutputs.get(mode), fixtureConfig: plan.fixture, schedulingMode: plan.schedulingMode });
        }
      }
    }
    for (const plan of scenarioPlans) {
      for (let ordinal = 1; ordinal <= samples; ordinal++) {
        const order = modeOrder(modes, plan.index, ordinal - 1);
        harness.plannedMeasuredOrder.push({ scenario: plan.scenario, ordinal, modes: order });
        for (const mode of order) {
          await runRecordedTrial({ mode, scenario: plan.scenario, ordinal, phase: 'measured', extensionPath: modeOutputs.get(mode), fixtureConfig: plan.fixture, schedulingMode: plan.schedulingMode });
        }
      }
    }

    const legacy = harness.results.filter(run => run.mode === 'legacy');
    const measured = harness.results.filter(run => run.phase === 'measured');
    harness.comparisonGate = validateRunGate({
      legacyResults: legacy, measuredSamples: measured,
      allResults: harness.results,
      expectedModes: modes, expectedScenarios: scenarios, expectedSamples: samples, expectedWarmups: warmups,
      buildParity: harness.buildParity,
    });
    if (!harness.comparisonGate.comparisonsAllowed) throw new Error(`Comparisons gated: ${harness.comparisonGate.issues.join('; ')}`);
    harness.scenarioSummaries = {};
    harness.comparisons = {};
    for (const plan of scenarioPlans) {
      harness.scenarioSummaries[plan.scenario] = {};
      for (const mode of modes) {
        harness.scenarioSummaries[plan.scenario][mode] = measureScenarioRuns(harness.results, plan.scenario, mode, measureMode);
      }
      for (const mode of candidateModes) {
        const summary = harness.scenarioSummaries[plan.scenario][mode];
        const baseline = harness.scenarioSummaries[plan.scenario].legacy.times;
        harness.comparisons[plan.scenario] ??= {};
        harness.comparisons[plan.scenario][mode] = Object.fromEntries(Object.keys(summary.times).map(metric => {
          const baselineP50 = baseline[metric]?.p50;
          const modeP50 = summary.times[metric]?.p50;
          return [metric, { baselineP50: baselineP50 ?? null, modeP50: modeP50 ?? null, delta: Number.isFinite(baselineP50) && Number.isFinite(modeP50) ? modeP50 - baselineP50 : null }];
        }));
      }
    }
    harness.status = harness.results.every(run => run.status === 'passed') ? 'passed' : 'failed';
  }
} catch (error) {
  primaryError = error;
  harness.status = 'failed';
  harness.error = { name: error.name, message: error.message, stack: error.stack };
} finally {
  await Promise.all(buildDirs.map(async directory => {
    try { await rm(directory, { recursive: true, force: true }); }
    catch (error) { harness.cleanupErrors.push(`Build ${directory}: ${error.message}`); }
  }));
  if (harness.cleanupErrors.length) harness.status = 'failed';
  harness.primaryError = primaryError?.message ?? null;
  if (providerLane) {
    try {
      harness.buildParity = customStaleSuccess
        ? validateSuccessfulReplyBuildParity(harness.builds, modes)
        : validateBuildParity(harness.builds, modes);
    }
    catch (error) { harness.buildParity = { ok: false, issues: [error.message] }; }
    harness.providerLaneFinalization = providerLaneFinalization({
      buildParity: harness.buildParity, cleanupErrors: harness.cleanupErrors, primaryError,
    });
    if (!harness.providerLaneFinalization.passed) harness.status = 'failed';
  } else if (!isolatedProbes.length) {
    let finalBuildParity = harness.buildParity;
    try { finalBuildParity = validateBuildParity(harness.builds, modes); }
    catch (error) { finalBuildParity = { ok: false, issues: [error.message] }; }
    harness.buildParity = finalBuildParity;
    if (!harness.legacyQualificationGate) {
      const qualificationParity = validateBuildParity(harness.builds, ['legacy']);
      harness.legacyQualificationGate = validateRunGate({
        legacyResults: harness.results.filter(run => run.mode === 'legacy'), measuredSamples: [],
        allResults: harness.results,
        expectedModes: ['legacy'], expectedScenarios: scenarios, expectedSamples: 0, expectedWarmups: warmups,
        buildParity: qualificationParity,
      });
    }
    harness.comparisonGate = validateRunGate({
      legacyResults: harness.results.filter(run => run.mode === 'legacy'),
      measuredSamples: harness.results.filter(run => run.phase === 'measured'),
      allResults: harness.results,
      expectedModes: modes, expectedScenarios: scenarios, expectedSamples: samples, expectedWarmups: warmups,
      buildParity: finalBuildParity,
    });
    if (harness.cleanupErrors.length) {
      harness.comparisonGate.comparisonsAllowed = false;
      harness.comparisonGate.issues.push('build cleanup failed');
    }
    if (primaryError) {
      harness.comparisonGate.comparisonsAllowed = false;
      harness.comparisonGate.issues.push(`benchmark execution failed: ${primaryError.message}`);
    }
    if (!harness.comparisonGate.comparisonsAllowed) {
      delete harness.comparisons;
      delete harness.scenarioSummaries;
    }
  }
  harness.finishedAt = now();
  await writeArtifact();
}
process.stdout.write(`${JSON.stringify({ status: harness.status, artifactPath, runs: harness.results.length, error: harness.error?.message })}\n`);
if (harness.status !== 'passed') process.exitCode = 1;
