// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { serializeBenchmarkArtifact, writeBenchmarkArtifact } from './page-translation-e2e-benchmark/artifact-writer.mjs';
import { validateBuildParity } from './page-translation-e2e-benchmark/build-environment.mjs';
import { createCancellationRequestLifecycle, promoteRequestDiagnostics } from './page-translation-e2e-benchmark/cancellation-probes.mjs';
import { validateRunGate } from './page-translation-e2e-benchmark/metrics.mjs';

async function runActualFinalization({ failAt = null, cleanupFailure = false, measureFailureAfter = null, trialCleanupErrors = [], trialCleanupReport = null, trialDiagnostics = null } = {}) {
  const runner = await readFile(new URL('./page-translation-e2e-benchmark/run.mjs', import.meta.url), 'utf8');
  const start = runner.indexOf('let globalRunOrder = 0;');
  expect(start).toBeGreaterThanOrEqual(0);
  const source = `(async () => {\nlet primaryError;\n${runner.slice(start)}\n})()`;
  const directory = await mkdtemp(join(tmpdir(), 'benchmark-finalization-'));
  const path = join(directory, 'artifact.json');
  const harness = { artifactPath: path, results: [], builds: [], plannedMeasuredOrder: [], provenance: {}, cleanupErrors: [], status: 'running' };
  const writes = [];
  const compiles = [];
  let measuredSummaryCalls = 0;
  const fixture = scenario => ({ scenario });
  const buildProfile = {
    mode: 'production', nodeEnv: 'production', browser: 'chrome',
    defines: { browser: 'chrome', isProduction: true, isDevelopment: false, nodeEnv: 'production' },
    build: { minify: 'terser', dropConsole: true, dropDebugger: true, sourcemap: false, cssMinify: true, esbuildDrop: ['console', 'debugger'], target: 'esnext' },
  };
  const context = {
    harness,
    artifactPath: path,
    requestedModes: ['legacy', 'sliced', 'viewport'],
    cancellationProbes: [],
    modes: ['legacy', 'sliced', 'viewport'],
    scenarios: ['small'],
    samples: 4,
    warmups: 1,
    sourcePaths: [],
    buildDirs: [],
    now: () => 123,
    git: () => 'fake-git',
    hashFile: async () => 'fake-hash',
    createFixture: fixture,
    validateSampleCount: () => 4,
    validateRunGate,
    validateBuildParity,
    validateHarnessBuildParity: () => {
      harness.buildParity = context.validateBuildParity(harness.builds, context.modes);
      if (!harness.buildParity.ok) throw new Error('Build parity failed');
      return harness.buildParity;
    },
    modeOrder: (selectedModes, scenarioIndex, ordinalIndex) => {
      const offset = (scenarioIndex + ordinalIndex) % selectedModes.length;
      return [...selectedModes.slice(offset), ...selectedModes.slice(0, offset)];
    },
    measureMode: runs => {
      measuredSummaryCalls++;
      if (measureFailureAfter === measuredSummaryCalls) throw new Error('synthetic summary failure');
      return { n: runs.length, times: {} };
    },
    compileMode: async mode => {
      compiles.push(mode);
      context.buildDirs.push(`${mode}-build`);
      context.harness.builds.push({ mode, status: 'passed', environment: { worker: buildProfile, content: buildProfile } });
      return `${mode}-bundle`;
    },
    runNetworkGuardNegativeProbe: async () => {},
    runTrial: async options => {
      const failed = failAt && options.mode === failAt.mode && options.phase === failAt.phase && options.ordinal === failAt.ordinal;
      const run = {
        ...options,
        status: failed || trialCleanupErrors.length ? 'failed' : 'passed',
        cleanupErrors: [...(failed ? ['fixture cleanup error'] : []), ...trialCleanupErrors],
        ...(trialCleanupReport ? { cancellation: { cleanup: { requestLifecycle: trialCleanupReport } } } : {}),
        ...(failed ? { error: { message: 'fixture trial failure' }, rawDOM: { translated: [['target-1', 'raw failed DOM']] } } : {}),
      };
      if (trialDiagnostics) {
        run.cancellation ??= {};
        run.cancellation.observationErrors = trialDiagnostics.observationErrors ?? [];
        run.transportErrors = trialDiagnostics.transportErrors ?? [];
        promoteRequestDiagnostics(run);
      }
      return run;
    },
    writeArtifact: async () => {
      writes.push({ count: harness.results.length, status: harness.status });
      await writeBenchmarkArtifact(path, harness);
    },
    rm: async path => { if (cleanupFailure) throw new Error(`cleanup failed: ${path}`); },
    process: { stdout: { write() {} }, exitCode: 0 },
  };

  try {
    await vm.runInNewContext(source, context);
    return { artifact: JSON.parse(await readFile(path, 'utf8')), writes, compiles };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('streamed benchmark artifact serialization', () => {
  it('preserves JSON.stringify pretty output and schema for empty and populated artifacts', async () => {
    for (const artifact of [
      { status: 'running', results: [] },
      { status: 'failed', results: [{ ordinal: 1, rawDOM: { translated: [['a', 'value']] } }, { ordinal: 2 }], summaries: { legacy: null } },
    ]) {
      const chunks = [];
      for await (const chunk of serializeBenchmarkArtifact(artifact)) chunks.push(chunk);
      expect(chunks.join('')).toBe(JSON.stringify(artifact, null, 2));
    }
  });

  it('writes all raw trials incrementally for a 40-sample-sized matrix and retains failed-run details', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'benchmark-artifact-stream-'));
    const path = join(directory, 'matrix.json');
    try {
      const results = Array.from({ length: 369 }, (_, index) => ({
        globalRunOrder: index + 1,
        phase: index === 368 ? 'failed' : 'measured',
        rawRequests: Array.from({ length: 100 }, (_, request) => ({ body: `request-${index}-${request}` })),
      }));
      results[368].error = { message: 'last trial failed' };
      Object.defineProperty(results, 'toJSON', { value() { throw new Error('must not stringify the complete results array'); } });
      const artifact = { status: 'failed', measuredSamples: 40, results, summary: { incomplete: true } };
      const chunks = [];
      for await (const chunk of serializeBenchmarkArtifact(artifact)) chunks.push(chunk);
      expect(chunks.filter(chunk => chunk.includes('"globalRunOrder"')).length).toBe(369);
      expect(chunks.join('').length).toBeGreaterThan(chunks.reduce((max, chunk) => Math.max(max, chunk.length), 0));

      await writeBenchmarkArtifact(path, artifact);
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      expect(parsed.results).toHaveLength(369);
      expect(parsed.results[368]).toEqual({
        globalRunOrder: 369,
        phase: 'failed',
        rawRequests: Array.from({ length: 100 }, (_, request) => ({ body: `request-368-${request}` })),
        error: { message: 'last trial failed' },
      });
      expect(parsed.summary).toEqual({ incomplete: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps the prior complete artifact if a trial fails during streamed serialization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'benchmark-artifact-atomic-'));
    const path = join(directory, 'artifact.json');
    try {
      const prior = { status: 'running', results: [{ ordinal: 1 }] };
      await writeBenchmarkArtifact(path, prior);
      await expect(writeBenchmarkArtifact(path, { status: 'failed', results: [{ raw: 1n }] })).rejects.toThrow(/BigInt/);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(prior);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('writes the successful runner report once after all 4+-trial mode work and finalization', async () => {
    const { artifact, writes, compiles } = await runActualFinalization();
    expect(artifact.error).toBeUndefined();
    expect(artifact.results).toHaveLength(15);
    expect(writes).toEqual([{ count: 15, status: 'passed' }]);
    expect(compiles).toEqual(['legacy', 'sliced', 'viewport']);
    expect(artifact.status).toBe('passed');
    expect(artifact.finishedAt).toBe(123);
    expect(artifact.plannedMeasuredOrder.slice(0, 2)).toEqual([
      { scenario: 'small', ordinal: 1, modes: ['legacy', 'sliced', 'viewport'] },
      { scenario: 'small', ordinal: 2, modes: ['sliced', 'viewport', 'legacy'] },
    ]);
    expect(artifact.results.filter(run => run.phase === 'measured').slice(0, 6).map(run => run.mode)).toEqual([
      'legacy', 'sliced', 'viewport', 'sliced', 'viewport', 'legacy',
    ]);
  });

  it('persists a failed rotated Legacy measured trial after its candidate trials and gates comparisons', async () => {
    const { artifact, writes, compiles } = await runActualFinalization({ failAt: { mode: 'legacy', phase: 'measured', ordinal: 2 } });
    expect(artifact.results).toHaveLength(9);
    expect(artifact.results.slice(-1)[0]).toMatchObject({
      status: 'failed', error: { message: 'fixture trial failure' },
      cleanupErrors: ['fixture cleanup error'], rawDOM: { translated: [['target-1', 'raw failed DOM']] },
    });
    expect(artifact.results.slice(6, 8).map(run => run.mode)).toEqual(['sliced', 'viewport']);
    expect(writes).toEqual([{ count: 9, status: 'failed' }]);
    expect(compiles).toEqual(['legacy', 'sliced', 'viewport']);
    expect(artifact.comparisonGate.comparisonsAllowed).toBe(false);
    expect(artifact.comparisons).toBeUndefined();
    expect(artifact.scenarioSummaries).toBeUndefined();
    expect(artifact.error.message).toContain('legacy/small measured 2 failed');
    expect(artifact.primaryError).toBe(artifact.error.message);
    expect(artifact.finishedAt).toBe(123);
    expect(artifact.cleanupErrors).toEqual([]);
  });

  it('retains a complete raw matrix but closes the gate after summary generation fails', async () => {
    const { artifact, writes } = await runActualFinalization({ measureFailureAfter: 2 });
    expect(artifact.results).toHaveLength(15);
    expect(artifact.results.every(run => run.status === 'passed')).toBe(true);
    expect(writes).toEqual([{ count: 15, status: 'failed' }]);
    expect(artifact.status).toBe('failed');
    expect(artifact.error.message).toBe('synthetic summary failure');
    expect(artifact.primaryError).toBe('synthetic summary failure');
    expect(artifact.comparisonGate.comparisonsAllowed).toBe(false);
    expect(artifact.comparisonGate.issues).toContain('benchmark execution failed: synthetic summary failure');
    expect(artifact.scenarioSummaries).toBeUndefined();
    expect(artifact.comparisons).toBeUndefined();
  });

  it('stops at failed Legacy warmup qualification without candidate trials or summaries', async () => {
    const { artifact, writes, compiles } = await runActualFinalization({ failAt: { mode: 'legacy', phase: 'warmup', ordinal: 1 } });
    expect(artifact.results).toHaveLength(1);
    expect(compiles).toEqual(['legacy']);
    expect(artifact.legacyQualificationGate.comparisonsAllowed).toBe(false);
    expect(artifact.comparisons).toBeUndefined();
    expect(artifact.scenarioSummaries).toBeUndefined();
    expect(writes).toEqual([{ count: 1, status: 'failed' }]);
  });

  it('includes final build-cleanup failures in the single completed report', async () => {
    const { artifact, writes } = await runActualFinalization({ cleanupFailure: true });
    expect(writes).toEqual([{ count: 15, status: 'failed' }]);
    expect(artifact.status).toBe('failed');
    expect(artifact.cleanupErrors).toEqual([
      'Build legacy-build: cleanup failed: legacy-build',
      'Build sliced-build: cleanup failed: sliced-build',
      'Build viewport-build: cleanup failed: viewport-build',
    ]);
    expect(artifact.primaryError).toBeNull();
    expect(artifact.finishedAt).toBe(123);
  });

  it('persists unexpected held-Fetch cleanup errors and raw request outcomes through runner finalization', async () => {
    const lifecycle = createCancellationRequestLifecycle(async () => { throw new Error('Session closed unexpectedly.'); });
    const request = lifecycle.reserve({ requestId: 'fetch-unexpected-error', sessionId: 'A' });
    const handler = lifecycle.trackHandler(request, (async () => request.release('fail'))());
    const cleanup = await lifecycle.closeAndDrain({ disableFetch: async () => {}, timeoutMs: 500 });
    await handler;
    expect(cleanup.ok).toBe(false);
    expect(cleanup.errors).toContain('Fetch fetch-unexpected-error teardown release failed: Session closed unexpectedly.');
    expect(cleanup.reservations[0].releaseOutcome).toMatchObject({ ok: false, error: 'Session closed unexpectedly.' });

    const { artifact, writes } = await runActualFinalization({
      trialCleanupErrors: cleanup.errors,
      trialCleanupReport: cleanup,
    });
    expect(writes).toEqual([{ count: 1, status: 'failed' }]);
    expect(artifact.status).toBe('failed');
    expect(artifact.results[0].cleanupErrors).toEqual(cleanup.errors);
    expect(artifact.results[0].cancellation.cleanup.requestLifecycle.reservations[0].releaseOutcome.error)
      .toBe('Session closed unexpectedly.');
    expect(artifact.finishedAt).toBe(123);
  });

  it('promotes observation and transport diagnostics to failure and persists them even after Fetch ACK', async () => {
    const trialDiagnostics = {
      observationErrors: [{ requestId: 'fetch-1', issues: ['provider/controller correlation failed'], fetchAck: 'fulfilled' }],
      transportErrors: ['request handler failed after a response ACK'],
    };
    const { artifact, writes } = await runActualFinalization({ trialDiagnostics });
    expect(writes).toEqual([{ count: 1, status: 'failed' }]);
    expect(artifact.status).toBe('failed');
    expect(artifact.results[0].status).toBe('failed');
    expect(artifact.results[0].error.cancellationDiagnostics).toEqual(trialDiagnostics);
    expect(artifact.results[0].cancellation.diagnosticFailures).toEqual(trialDiagnostics);
    expect(artifact.finishedAt).toBe(123);
  });

  it('bounds a never-settling held Fetch, reports it, and persists the failed cleanup record', async () => {
    vi.useFakeTimers();
    try {
      const lifecycle = createCancellationRequestLifecycle(async () => new Promise(() => {}));
      const request = lifecycle.reserve({ requestId: 'fetch-never-settles', sessionId: 'A' });
      lifecycle.trackHandler(request, (async () => request.release('fail'))());
      const cleanupPromise = lifecycle.closeAndDrain({ disableFetch: async () => {}, timeoutMs: 50 });
      let targetClosed = false;
      await vi.advanceTimersByTimeAsync(50);
      const cleanup = await cleanupPromise;
      expect(targetClosed).toBe(false);
      expect(cleanup.ok).toBe(false);
      expect(cleanup.handlerCount).toBe(1);
      expect(cleanup.errors).toEqual(expect.arrayContaining([
        expect.stringContaining('Request handlers did not drain before deadline'),
        expect.stringContaining('Fetch release commands did not settle before deadline'),
      ]));
      targetClosed = true;

      vi.useRealTimers();
      const { artifact, writes } = await runActualFinalization({
        trialCleanupErrors: cleanup.errors,
        trialCleanupReport: cleanup,
      });
      expect(writes).toEqual([{ count: 1, status: 'failed' }]);
      expect(artifact.status).toBe('failed');
      expect(artifact.results[0].cleanupErrors).toEqual(cleanup.errors);
      expect(artifact.results[0].cancellation.cleanup.requestLifecycle.reservations[0]).toMatchObject({
        requestId: 'fetch-never-settles', releaseOutcome: null, handlerSettled: false,
      });
      expect(artifact.finishedAt).toBe(123);
    } finally {
      vi.useRealTimers();
    }
  });

});
