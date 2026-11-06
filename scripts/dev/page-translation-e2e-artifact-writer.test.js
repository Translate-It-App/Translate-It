// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { serializeBenchmarkArtifact, writeBenchmarkArtifact } from './page-translation-e2e-benchmark/artifact-writer.mjs';

async function runActualFinalization({ failAt = null, cleanupFailure = false } = {}) {
  const runner = await readFile(new URL('./page-translation-e2e-benchmark/run.mjs', import.meta.url), 'utf8');
  const start = runner.indexOf('let globalRunOrder = 0;');
  expect(start).toBeGreaterThanOrEqual(0);
  const source = `(async () => {\nlet primaryError;\n${runner.slice(start)}\n})()`;
  const directory = await mkdtemp(join(tmpdir(), 'benchmark-finalization-'));
  const path = join(directory, 'artifact.json');
  const harness = { artifactPath: path, results: [], provenance: {}, cleanupErrors: [], status: 'running' };
  const writes = [];
  const compiles = [];
  const fixture = scenario => ({ scenario });
  const context = {
    harness,
    artifactPath: path,
    requestedModes: ['legacy', 'sliced', 'viewport'],
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
    validateRunGate: ({ legacyResults, measuredSamples }) => {
      const failed = [...legacyResults, ...measuredSamples].some(run => run.status !== 'passed');
      return { comparisonsAllowed: !failed, failedLegacy: legacyResults.some(run => run.status !== 'passed'), failedMeasured: measuredSamples.some(run => run.status !== 'passed') };
    },
    candidateModeOrder: () => ['sliced', 'viewport'],
    measureMode: runs => ({ n: runs.length, times: {} }),
    compileMode: async mode => { compiles.push(mode); context.buildDirs.push(`${mode}-build`); return `${mode}-bundle`; },
    runNetworkGuardNegativeProbe: async () => {},
    runTrial: async options => {
      const failed = failAt && options.mode === failAt.mode && options.phase === failAt.phase && options.ordinal === failAt.ordinal;
      return {
        ...options,
        status: failed ? 'failed' : 'passed',
        cleanupErrors: failed ? ['fixture cleanup error'] : [],
        ...(failed ? { error: { message: 'fixture trial failure' }, rawDOM: { translated: [['target-1', 'raw failed DOM']] } } : {}),
      };
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
    expect(artifact.results).toHaveLength(15);
    expect(writes).toEqual([{ count: 15, status: 'passed' }]);
    expect(compiles).toEqual(['legacy', 'sliced', 'viewport']);
    expect(artifact.status).toBe('passed');
    expect(artifact.finishedAt).toBe(123);
  });

  it('persists prior and failed Legacy trials once after catch/finally and starts no candidate work', async () => {
    const { artifact, writes, compiles } = await runActualFinalization({ failAt: { mode: 'legacy', phase: 'measured', ordinal: 1 } });
    expect(artifact.results).toHaveLength(2);
    expect(artifact.results[0].status).toBe('passed');
    expect(artifact.results[1]).toMatchObject({
      status: 'failed', error: { message: 'fixture trial failure' },
      cleanupErrors: ['fixture cleanup error'], rawDOM: { translated: [['target-1', 'raw failed DOM']] },
    });
    expect(writes).toEqual([{ count: 2, status: 'failed' }]);
    expect(compiles).toEqual(['legacy']);
    expect(artifact.error.message).toContain('legacy/small measured 1 failed');
    expect(artifact.primaryError).toBe(artifact.error.message);
    expect(artifact.finishedAt).toBe(123);
    expect(artifact.cleanupErrors).toEqual([]);
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
});
