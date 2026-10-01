import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'publish-development.sh');
const SHA = 'a'.repeat(40);
const SOURCE = { SOURCE_RUN_ID: '300', SOURCE_RUN_NUMBER: '20', SOURCE_RUN_ATTEMPT: '2', SOURCE_WORKFLOW_ID: '900', SOURCE_SHA: SHA };
const marker = ({ run_number = 20, run_attempt = 1, run_id = 250, sha = 'b'.repeat(40), state = 'published' } = {}) =>
  `<!-- translate-it-development-source: {"workflow_id":900,"run_number":${run_number},"run_attempt":${run_attempt},"run_id":${run_id},"sha":"${sha}","state":"${state}"} -->`;

function run({ chrome = true, firefox = true, extraChrome = false, source = SOURCE, probe = 'exists', body = marker(), compare = 'ahead', compares, tag = 'exists', fail = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'publish-development-test-'));
  const publishDir = join(dir, 'development-artifacts');
  mkdirSync(publishDir, { recursive: true });
  if (chrome) writeFileSync(join(publishDir, 'Translate-It-v1.2.3-for-Chrome.zip'), 'chrome payload');
  if (firefox) writeFileSync(join(publishDir, 'Translate-It-v1.2.3-for-Firefox.zip'), 'firefox payload');
  if (extraChrome) writeFileSync(join(publishDir, 'Translate-It-v2-for-Chrome.zip'), 'duplicate');
  const callsFile = join(dir, 'calls.jsonl');
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_CALLS, JSON.stringify(args) + '\\n');
const calls = fs.readFileSync(process.env.MOCK_CALLS, 'utf8').trim().split('\\n').filter(Boolean).map(line => JSON.parse(line));
const endpoint = args.find(arg => arg.startsWith('repos/')) || '';
if (args[0] === 'api' && endpoint.endsWith('/releases/tags/development')) {
  if (args.includes('--include')) {
    if (process.env.MOCK_PROBE === '404') { process.stdout.write('HTTP/2 404 Not Found\\r\\n\\r\\n{}'); process.exit(1); }
    if (process.env.MOCK_PROBE === 'error') { process.stdout.write('HTTP/2 403 Forbidden\\r\\n\\r\\n{}'); process.exit(1); }
    process.stdout.write('HTTP/2 200 OK\\r\\n\\r\\n{}'); process.exit(0);
  }
  process.stdout.write(JSON.stringify({ id: 123, body: process.env.MOCK_BODY })); process.exit(0);
}
if (args[0] === 'api' && endpoint.includes('/compare/')) {
  if (process.env.MOCK_FAIL === 'compare') process.exit(2);
  const index = calls.filter(call => call.some(arg => arg.includes('/compare/'))).length - 1;
  const statuses = (process.env.MOCK_COMPARES || process.env.MOCK_COMPARE).split(',');
  process.stdout.write(statuses[Math.min(index, statuses.length - 1)]); process.exit(0);
}
if (args[0] === 'release' && args[1] === 'create' && process.env.MOCK_FAIL === 'create') process.exit(2);
if (args[0] === 'release' && args[1] === 'upload' && process.env.MOCK_FAIL === 'upload') process.exit(2);
if (args[0] === 'api' && endpoint.endsWith('/releases/123') && process.env.MOCK_FAIL === 'metadata') process.exit(2);
if (args[0] === 'api' && endpoint.endsWith('/git/refs/tags/development')) {
  if (process.env.MOCK_FAIL === 'tag') { process.stdout.write('HTTP/2 500 Server Error\\r\\n'); process.exit(1); }
  if (process.env.MOCK_TAG === 'missing') { process.stdout.write('HTTP/2 404 Not Found\\r\\n'); process.exit(1); }
  process.stdout.write('HTTP/2 200 OK\\r\\n'); process.exit(0);
}
if (args[0] === 'api' && endpoint.endsWith('/git/refs')) process.stdout.write('{}');
` , { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${dir}${delimiter}${process.env.PATH}`,
    GH_TOKEN: 'fake-token',
    GITHUB_EVENT_NAME: 'workflow_run',
    GITHUB_REPOSITORY: 'owner/repo',
    PUBLISH_DIR: publishDir,
    ...source,
    MOCK_CALLS: callsFile,
    MOCK_PROBE: probe,
    MOCK_BODY: body,
    MOCK_COMPARE: compare,
    MOCK_COMPARES: compares || '',
    MOCK_TAG: tag,
    MOCK_FAIL: fail,
  };
  const result = spawnSync('bash', [SCRIPT], { cwd: dir, env, encoding: 'utf8' });
  const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const output = {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    calls,
    files: {
      chrome: join(publishDir, 'Translate-It-development-for-Chrome.zip'),
      firefox: join(publishDir, 'Translate-It-development-for-Firefox.zip'),
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
  return output;
}

const mutations = calls => calls.filter(args => args[0] === 'release' && ['create', 'upload'].includes(args[1])
  || args[0] === 'api' && args.includes('--method') && ['PATCH', 'POST'].includes(args[args.indexOf('--method') + 1]));

describe('development workflow_run publisher', () => {
  it('creates a first release with both ZIPs and a publishing marker, then moves the tag', () => {
    const result = run({ probe: '404' });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(result.files.chrome, 'utf8')).toBe('chrome payload');
    expect(readFileSync(result.files.firefox, 'utf8')).toBe('firefox payload');
    const create = result.calls.find(args => args[0] === 'release' && args[1] === 'create');
    expect(create).toEqual(['release', 'create', 'development', result.files.chrome, result.files.firefox, '--title', 'Development Build', '--prerelease', '--latest=false', '--target', SHA, '--notes', marker({ run_number: 20, run_attempt: 2, run_id: 300, sha: SHA, state: 'publishing' })]);
    expect(result.calls).toContainEqual(['api', '--include', '--method', 'PATCH', 'repos/owner/repo/git/refs/tags/development', '-f', `sha=${SHA}`, '-F', 'force=true']);
    expect(result.calls).toContainEqual(['api', '--method', 'PATCH', 'repos/owner/repo/releases/123', '-f', 'name=Development Build', '-F', 'prerelease=true', '-f', 'make_latest=false', '-f', `body=${marker({ run_number: 20, run_attempt: 2, run_id: 300, sha: SHA, state: 'published' })}`]);
    expect(result.calls.some(args => args[0] === 'release' && args[1] === 'view')).toBe(false);
    result.cleanup();
  });

  it('updates an existing marked release, assets, tag, and published marker in order', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.calls).toContainEqual(['api', '--method', 'PATCH', 'repos/owner/repo/releases/123', '-f', 'name=Development Build', '-F', 'prerelease=true', '-f', 'make_latest=false', '-f', `body=${marker({ run_number: 20, run_attempt: 2, run_id: 300, sha: SHA, state: 'publishing' })}`]);
    expect(result.calls.some(args => args[0] === 'release' && args[1] === 'view')).toBe(false);
    expect(result.calls).toContainEqual(['release', 'upload', 'development', result.files.chrome, result.files.firefox, '--clobber']);
    expect(result.calls).toContainEqual(['api', '--include', '--method', 'PATCH', 'repos/owner/repo/git/refs/tags/development', '-f', `sha=${SHA}`, '-F', 'force=true']);
    const upload = result.calls.findIndex(args => args[0] === 'release' && args[1] === 'upload');
    const tagMove = result.calls.findIndex(args => args.includes('repos/owner/repo/git/refs/tags/development'));
    expect(tagMove).toBeGreaterThan(upload);
    expect(result.calls.filter(args => args.some(arg => arg.includes('/compare/')))).toHaveLength(2);
    result.cleanup();
  });

  it('skips older run tuples before mutation, and permits equal publishing retries', () => {
    const older = run({ body: marker({ run_number: 21, run_attempt: 1 }) });
    expect(older.status).toBe(0);
    expect(mutations(older.calls)).toEqual([]);
    older.cleanup();
    const retry = run({ body: marker({ run_number: 20, run_attempt: 2, state: 'publishing' }) });
    expect(retry.status).toBe(0);
    expect(mutations(retry.calls).length).toBeGreaterThan(0);
    retry.cleanup();
  });

  it('allows ancestor candidates when main has advanced, including force-shifted main', () => {
    const docsDescendant = run({ compare: 'ahead' });
    expect(docsDescendant.status).toBe(0);
    expect(docsDescendant.calls.some(args => args.some(arg => arg.includes(`/compare/${SHA}...main`)))).toBe(true);
    docsDescendant.cleanup();
    const shifted = run({ compare: 'ahead' });
    expect(shifted.status).toBe(0);
    expect(mutations(shifted.calls).length).toBeGreaterThan(0);
    shifted.cleanup();
  });

  it('rejects missing inputs before release mutation and rejects malformed/missing markers', () => {
    for (const options of [{ chrome: false }, { firefox: false }, { chrome: false, firefox: false }, { extraChrome: true }]) {
      const result = run(options);
      expect(result.status).not.toBe(0);
      expect(result.calls).toEqual([]);
      expect(mutations(result.calls)).toEqual([]);
      result.cleanup();
    }
    for (const body of ['', 'unparseable marker', '<!-- translate-it-development-source: {} -->', `${marker()}\n${marker()}`]) {
      const result = run({ body });
      expect(result.status).not.toBe(0);
      expect(mutations(result.calls)).toEqual([]);
      result.cleanup();
    }
  });

  it('fails closed on comparison errors or non-ancestor statuses', () => {
    for (const options of [{ compare: 'diverged' }, { compare: 'behind' }]) {
      const result = run(options);
      expect(result.status).toBe(0);
      expect(mutations(result.calls)).toEqual([]);
      result.cleanup();
    }
    const failed = run({ fail: 'compare' });
    expect(failed.status).not.toBe(0);
    expect(mutations(failed.calls)).toEqual([]);
    failed.cleanup();
  });

  it('leaves a publishing marker and does not move the tag if ancestry fails after upload', () => {
    const result = run({ compares: 'ahead,diverged' });
    expect(result.status).not.toBe(0);
    expect(result.calls.some(args => args[0] === 'release' && args[1] === 'upload')).toBe(true);
    expect(result.calls.some(args => args.includes('repos/owner/repo/git/refs/tags/development'))).toBe(false);
    expect(result.calls).toContainEqual(['api', '--method', 'PATCH', 'repos/owner/repo/releases/123', '-f', 'name=Development Build', '-F', 'prerelease=true', '-f', 'make_latest=false', '-f', `body=${marker({ run_number: 20, run_attempt: 2, run_id: 300, sha: SHA, state: 'publishing' })}`]);
    result.cleanup();
  });

  it('creates a missing tag only on explicit 404, and fails on other tag errors', () => {
    const missing = run({ tag: 'missing' });
    expect(missing.status).toBe(0);
    expect(missing.calls).toContainEqual(['api', '--method', 'POST', 'repos/owner/repo/git/refs', '-f', 'ref=refs/tags/development', '-f', `sha=${SHA}`]);
    missing.cleanup();
    const failed = run({ fail: 'tag' });
    expect(failed.status).not.toBe(0);
    expect(failed.calls.some(args => args.includes('/git/refs') && args.includes('POST'))).toBe(false);
    failed.cleanup();
  });

  it('keeps an all-decimal source SHA a string in the tag PATCH', () => {
    const decimalSha = '1'.repeat(40);
    const result = run({ source: { ...SOURCE, SOURCE_SHA: decimalSha } });
    expect(result.status).toBe(0);
    expect(result.calls).toContainEqual(['api', '--include', '--method', 'PATCH', 'repos/owner/repo/git/refs/tags/development', '-f', `sha=${decimalSha}`, '-F', 'force=true']);
    result.cleanup();
  });
});
