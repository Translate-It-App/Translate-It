import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { buildBenchmarkExtension } from './build.mjs';
import { writeBenchmarkArtifact } from './artifact-writer.mjs';
import { runIframeAdmissionCanary } from './iframe-admission-canary.mjs';

const SAMPLE_COUNT = 5;

export function validateDynamicIframeBenchmarkOptIn(environment = process.env) {
  if (environment.BENCH_DYNAMIC_IFRAME !== '1') {
    throw new Error('Dynamic iframe benchmark is opt-in; set BENCH_DYNAMIC_IFRAME=1 explicitly.');
  }
  const requestedSamples = environment.BENCH_DYNAMIC_IFRAME_SAMPLES ?? String(SAMPLE_COUNT);
  if (requestedSamples !== String(SAMPLE_COUNT)) {
    throw new TypeError(`BENCH_DYNAMIC_IFRAME_SAMPLES must remain ${SAMPLE_COUNT} for the approved comparison.`);
  }
  return { sampleCount: SAMPLE_COUNT };
}

function outputPath() {
  const requested = process.env.BENCH_DYNAMIC_IFRAME_OUTPUT
    ?? '/tmp/opencode/page-translation-dynamic-iframe-benchmark.json';
  const path = resolve(requested);
  if (!path.startsWith('/tmp/opencode/')) {
    throw new TypeError('BENCH_DYNAMIC_IFRAME_OUTPUT must be inside /tmp/opencode/.');
  }
  return path;
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    minMs: sorted[0],
    maxMs: sorted.at(-1),
    samplesMs: values,
  };
}

export async function runDynamicIframeBenchmark({ artifactPath = outputPath() } = {}) {
  const { sampleCount } = validateDynamicIframeBenchmarkOptIn();
  if (!resolve(artifactPath).startsWith('/tmp/opencode/')) {
    throw new TypeError('Dynamic iframe benchmark artifact must be inside /tmp/opencode/.');
  }

  const extensionPath = await mkdtemp('/tmp/opencode/page-translation-dynamic-iframe-build-');
  const artifact = {
    kind: 'dynamic-iframe-continuity-benchmark',
    status: 'running',
    optIn: process.env.BENCH_DYNAMIC_IFRAME,
    discovery: 'sliced',
    measuredSamplesPerRace: sampleCount,
    warmups: 0,
    performanceSamples: sampleCount * 2,
    limitation: 'Correctness-gated local Edge fixture; translation latency is local harness completion, not live-provider or user-perceived latency.',
    artifactPath,
    extensionBuild: null,
    races: { stop: [], restore: [] },
    summaries: null,
    error: null,
  };
  try {
    artifact.extensionBuild = await buildBenchmarkExtension({
      outputDir: extensionPath,
      mode: 'sliced',
      workerEntry: resolve('scripts/dev/page-translation/e2e-benchmark/worker-entry.mjs'),
      contentEntry: resolve('scripts/dev/page-translation/e2e-benchmark/content-entry.mjs'),
      iframeAdmissionCanary: true,
    });
    for (const mode of ['stop', 'restore']) {
      for (let sampleIndex = 1; sampleIndex <= sampleCount; sampleIndex += 1) {
        const trialPath = `/tmp/opencode/page-translation-dynamic-iframe-${mode}-sample-${sampleIndex}.json`;
        const trial = await runIframeAdmissionCanary({
          outputPath: trialPath,
          extensionPath,
          raceMode: mode,
          sampleIndex,
        });
        artifact.races[mode].push({
          sampleIndex,
          artifactPath: trialPath,
          status: trial.status,
          insertToTranslationLatencyMs: trial.admission?.insertToTranslationLatencyMs ?? null,
          readyAdmissionRoundTripMs: trial.admission?.readyAdmissionRoundTripMs ?? null,
          startAcceptanceRoundTripMs: trial.admission?.startAcceptanceRoundTripMs ?? null,
          raceValidation: trial.heldStartRevocationRace?.validation ?? null,
          race: trial.heldStartRevocationRace ?? null,
          error: trial.error ?? null,
        });
        if (trial.status !== 'passed') {
          throw new Error(`${mode} sample ${sampleIndex} failed: ${trial.error?.message ?? 'canary validation failed'}`);
        }
      }
    }

    artifact.summaries = Object.fromEntries(['stop', 'restore'].map(mode => [mode, {
      insertToTranslation: summarize(artifact.races[mode].map(sample => sample.insertToTranslationLatencyMs)),
      readyAdmissionRoundTrip: summarize(artifact.races[mode].map(sample => sample.readyAdmissionRoundTripMs)),
      startAcceptanceRoundTrip: summarize(artifact.races[mode].map(sample => sample.startAcceptanceRoundTripMs)),
    }]));
    artifact.status = 'passed';
  } catch (error) {
    artifact.status = 'failed';
    artifact.error = { name: error?.name ?? 'Error', message: error?.message ?? String(error) };
  } finally {
    await rm(extensionPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await writeBenchmarkArtifact(artifactPath, artifact);
  }
  return artifact;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const artifact = await runDynamicIframeBenchmark();
  console.log(JSON.stringify({
    status: artifact.status,
    artifactPath: artifact.artifactPath,
    summaries: artifact.summaries,
    error: artifact.error,
  }, null, 2));
  if (artifact.status !== 'passed') process.exitCode = 1;
}
