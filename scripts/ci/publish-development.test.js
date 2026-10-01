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
const marker = ({ workflow_id = 900, run_number = 20, run_attempt = 1, run_id = 250, sha = 'b'.repeat(40), state = 'published' } = {}) =>
  `<!-- translate-it-development-source: {"workflow_id":${workflow_id},"run_number":${run_number},"run_attempt":${run_attempt},"run_id":${run_id},"sha":"${sha}","state":"${state}"} -->`;

const OLD_SHA = 'c'.repeat(40);
const OLD_MARKER = marker();

function run({ chrome = true, firefox = true, extraChrome = false, source = SOURCE, list = 'one', body = OLD_MARKER, draft = 'false', compare = 'ahead', compares, tag = 'exists', fail = '', assets = 'both', tagsha = 'ok', download = 'ok' } = {}) {
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
const endpoint = args.find(arg => arg.startsWith('repos/') || arg.startsWith('https://')) || '';
const isReleasesList = args[0] === 'api' && args.includes('--paginate') && args.includes('--slurp') && endpoint === 'repos/owner/repo/releases';
if (isReleasesList) {
  if (process.env.MOCK_FAIL === 'list') process.exit(2);
  const n = calls.filter(call => call.includes('--paginate') && call.some(a => a === 'repos/owner/repo/releases')).length - 1;
  const mode = process.env.MOCK_LIST;
  const dev = () => ({ id: 123, tag_name: 'development', body: process.env.MOCK_BODY, draft: process.env.MOCK_DRAFT === 'true' });
  const other = id => ({ id, tag_name: 'v9.' + id, body: '', draft: false });
  // Slurp form: one JSON array per page wrapped as array-of-pages.
  if (mode === 'none') { process.stdout.write(JSON.stringify([[]])); process.exit(0); }
  if (mode === 'two') { process.stdout.write(JSON.stringify([[{ id: 111, tag_name: 'development', body: 'x', draft: false }, { id: 222, tag_name: 'development', body: 'y', draft: false }]])); process.exit(0); }
  if (mode === 'create-first') { process.stdout.write(n === 0 ? JSON.stringify([[]]) : JSON.stringify([[dev()]])); process.exit(0); }
  if (mode === 'paged-found') { process.stdout.write(JSON.stringify([[other(100)], [dev()]])); process.exit(0); }
  if (mode === 'paged-dupes') { process.stdout.write(JSON.stringify([[{ id: 111, tag_name: 'development', body: 'x', draft: false }], [{ id: 222, tag_name: 'development', body: 'y', draft: false }]])); process.exit(0); }
  if (mode === 'paged-none') { process.stdout.write(n === 0 ? JSON.stringify([[other(100)], [other(101)]]) : JSON.stringify([[other(100)], [dev()]])); process.exit(0); }
  process.stdout.write(JSON.stringify([[dev()]])); process.exit(0);
}
if (args[0] === 'api' && endpoint.includes('/compare/')) {
  if (process.env.MOCK_FAIL === 'compare') process.exit(2);
  const index = calls.filter(call => call.some(arg => arg.includes('/compare/'))).length - 1;
  const statuses = (process.env.MOCK_COMPARES || process.env.MOCK_COMPARE).split(',');
  process.stdout.write(statuses[Math.min(index, statuses.length - 1)]); process.exit(0);
}
if (args[0] === 'api' && endpoint.includes('/releases/123/assets') && !args.includes('--method')) {
  if (process.env.MOCK_ASSETS === 'missing-one') { process.stdout.write(JSON.stringify([{ id: 11, name: 'Translate-It-development-for-Chrome.zip' }])); process.exit(0); }
  process.stdout.write(JSON.stringify([{ id: 11, name: 'Translate-It-development-for-Chrome.zip' }, { id: 22, name: 'Translate-It-development-for-Firefox.zip' }])); process.exit(0);
}
if (args[0] === 'api' && args.includes('--method') && args.includes('DELETE') && endpoint.includes('/releases/assets/')) {
  if (process.env.MOCK_FAIL === 'delete') process.exit(2);
  process.exit(0);
}
if (args[0] === 'api' && args.includes('--method') && args.includes('POST') && endpoint.startsWith('https://uploads.github.com/')) {
  const n = calls.filter(call => call.some(a => a.startsWith('https://uploads.github.com/'))).length - 1;
  if (process.env.MOCK_FAIL === 'upload-second' && n === 1) process.exit(2);
  if (process.env.MOCK_FAIL === 'upload-rollback') process.exit(2);
  if (process.env.MOCK_FAIL === 'upload') process.exit(2);
  process.exit(0);
}
if (args[0] === 'api' && endpoint === 'repos/owner/repo/git/ref/tags/development' && args.includes('--jq')) {
  if (process.env.MOCK_TAG === 'missing') process.exit(1);
  if (process.env.MOCK_TAG_SHA === 'fail') process.exit(2);
  if (process.env.MOCK_TAG_SHA === 'bad') { process.stdout.write('not-a-sha'); process.exit(0); }
  process.stdout.write('${OLD_SHA}'); process.exit(0);
}
if (args[0] === 'api' && endpoint === 'repos/owner/repo/git/ref/tags/development' && args.includes('--include')) {
  const mode = process.env.MOCK_TAG;
  if (mode === 'missing' || mode === 'rollback-missing') { process.stdout.write('HTTP/2 404 Not Found\\r\\n'); process.exit(1); }
  if (['get-403', 'get-409', 'get-500', 'get-error'].includes(mode)) {
    const response = { 'get-403': 'HTTP/2 403 Forbidden', 'get-409': 'HTTP/2 409 Conflict', 'get-500': 'HTTP/2 500 Server Error', 'get-error': 'network error' }[mode];
    process.stdout.write(response + '\\r\\n'); process.exit(1);
  }
  process.stdout.write('HTTP/2 200 OK\\r\\n'); process.exit(0);
}
if (args[0] === 'api' && endpoint.startsWith('repos/owner/repo/releases/assets/') && !args.includes('--method')) {
  if (process.env.MOCK_DOWNLOAD === 'fail') process.exit(2);
  if (process.env.MOCK_DOWNLOAD === 'empty') process.exit(0);
  const assetId = endpoint.split('/').pop();
  process.stdout.write(assetId === '11' ? 'old-chrome-bytes' : 'old-firefox-bytes'); process.exit(0);
}
if (args[0] === 'release' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ id: 'RE_kgDOGraphQLNodeId', databaseId: 123, body: process.env.MOCK_BODY }));
  process.exit(0);
}
if (args[0] === 'release' && args[1] === 'create' && process.env.MOCK_FAIL === 'create') process.exit(2);
if (args[0] === 'release' && args[1] === 'upload') { process.stderr.write('tag-based upload helper must not be used'); process.exit(3); }
if (args[0] === 'api' && endpoint.endsWith('/releases/123') && args.includes('--method') && args.includes('PATCH')) {
  if (process.env.MOCK_FAIL === 'metadata') process.exit(2);
  if (process.env.MOCK_FAIL === 'publish' && args.some(a => a.includes('draft=false'))) {
    const p = calls.filter(call => call.some(a => a.includes('draft=false'))).length - 1;
    if (p === 0) process.exit(2);
  }
}
if (args[0] === 'api' && endpoint === 'repos/owner/repo/git/refs/tags/development' && args.includes('--method') && args.includes('PATCH')) {
  if (process.env.MOCK_TAG === 'missing') { process.stdout.write('HTTP/2 422 Unprocessable Entity\\r\\n'); process.exit(1); }
  if (process.env.MOCK_TAG === 'patch-422') {
    const patches = calls.filter(call => call.includes('repos/owner/repo/git/refs/tags/development') && call.includes('PATCH')).length - 1;
    if (patches === 0) { process.stdout.write('HTTP/2 422 Unprocessable Entity\\r\\n'); process.exit(1); }
  }
  if (process.env.MOCK_FAIL === 'tag') { process.stdout.write('HTTP/2 500 Server Error\\r\\n'); process.exit(1); }
  if (process.env.MOCK_FAIL === 'tag-once') {
    const t = calls.filter(call => call.some(a => a === 'repos/owner/repo/git/refs/tags/development') && call.includes('PATCH')).length - 1;
    if (t === 0) { process.stdout.write('HTTP/2 500 Server Error\\r\\n'); process.exit(1); }
  }
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
    MOCK_LIST: list,
    MOCK_BODY: body,
    MOCK_DRAFT: draft,
    MOCK_COMPARE: compare,
    MOCK_COMPARES: compares || '',
    MOCK_TAG: tag,
    MOCK_FAIL: fail,
    MOCK_ASSETS: assets,
    MOCK_TAG_SHA: tagsha,
    MOCK_DOWNLOAD: download,
  };
  const result = spawnSync('bash', [SCRIPT], { cwd: dir, env, encoding: 'utf8' });
  const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return {
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
}

const mutations = calls => calls.filter(args => args[0] === 'release' && args[1] === 'create'
  || args[0] === 'api' && args.includes('--method') && ['PATCH', 'POST', 'DELETE'].includes(args[args.indexOf('--method') + 1]));
const publishingMarker = marker({ run_number: 20, run_attempt: 2, run_id: 300, sha: SHA, state: 'publishing' });
const publishedMarker = marker({ run_number: 20, run_attempt: 2, run_id: 300, sha: SHA, state: 'published' });
const draftPatch = body => ['api', '--method', 'PATCH', 'repos/owner/repo/releases/123', '-f', 'name=Development Build', '-F', 'prerelease=true', '-f', 'make_latest=false', '-F', 'draft=true', '-f', `body=${body}`];
const publishPatch = body => ['api', '--method', 'PATCH', 'repos/owner/repo/releases/123', '-f', 'name=Development Build', '-F', 'prerelease=true', '-f', 'make_latest=false', '-F', 'draft=false', '-f', `body=${body}`];
const restorePatch = (body, draft) => ['api', '--method', 'PATCH', 'repos/owner/repo/releases/123', '-f', 'name=Development Build', '-F', 'prerelease=true', '-f', 'make_latest=false', '-F', `draft=${draft}`, '-f', `body=${body}`];
const tagPatch = sha => ['api', '--method', 'PATCH', 'repos/owner/repo/git/refs/tags/development', '-f', `sha=${sha}`, '-F', 'force=true'];
const tagRead = ['api', '--include', 'repos/owner/repo/git/ref/tags/development'];
const tagCreate = sha => ['api', '--method', 'POST', 'repos/owner/repo/git/refs', '-f', 'ref=refs/tags/development', '-f', `sha=${sha}`];
const uploadCalls = calls => calls.filter(args => args.some(a => String(a).startsWith('https://uploads.github.com/')));
const restoredUploads = (calls, stableName, payload) => uploadCalls(calls).filter(args =>
  args.some(a => String(a).endsWith(`?name=${stableName}`)) && (() => {
    const i = args.indexOf('--input');
    return i >= 0 && readFileSync(args[i + 1], 'utf8') === payload;
  })());

describe('development workflow_run publisher', () => {
  it('drafts a published existing release before any asset or tag mutation', () => {
    const result = run();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.calls).toContainEqual(draftPatch(publishingMarker));
    const draftIdx = result.calls.findIndex(args => JSON.stringify(args) === JSON.stringify(draftPatch(publishingMarker)));
    const firstAssetOrTag = result.calls.findIndex(args =>
      (args.includes('DELETE') || args.some(a => String(a).startsWith('https://uploads.github.com/')) || (args.includes('repos/owner/repo/git/refs/tags/development') && (args.includes('--method') || args.includes('--include')))));
    expect(draftIdx).toBeGreaterThanOrEqual(0);
    expect(firstAssetOrTag).toBeGreaterThan(draftIdx);
    expect(result.calls.some(args => args[0] === 'release' && args[1] === 'view')).toBe(false);
    expect(result.calls.some(args => args[0] === 'release' && args[1] === 'upload')).toBe(false);
    result.cleanup();
  });

  it('requests backup asset binaries with an explicit octet-stream Accept header', () => {
    const result = run();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const downloads = result.calls.filter(args =>
      args[0] === 'api' && args.some(a => String(a).startsWith('repos/owner/repo/releases/assets/')) && !args.includes('--method'));
    expect(downloads).toHaveLength(2);
    for (const args of downloads) {
      expect(args).toContain('-H');
      expect(args).toContain('Accept: application/octet-stream');
    }
    result.cleanup();
  });

  it('orders success as draft, delete, uploads, tag, publish with numeric REST id', () => {
    const result = run();
    expect(result.status).toBe(0);
    const idx = wanted => result.calls.findIndex(args => JSON.stringify(args) === JSON.stringify(wanted));
    const draft = idx(draftPatch(publishingMarker));
    const uploads = result.calls.map((args, i) => ({ args, i })).filter(({ args }) => args.some(a => String(a).startsWith('https://uploads.github.com/'))).map(({ i }) => i);
    const tag = idx(tagPatch(SHA));
    const publish = idx(publishPatch(publishedMarker));
    expect(draft).toBeGreaterThanOrEqual(0);
    expect(uploads).toHaveLength(2);
    expect(tag).toBeGreaterThan(Math.max(...uploads));
    expect(publish).toBeGreaterThan(tag);
    expect(result.calls.filter(args => args.some(arg => arg.includes('/compare/'))).length).toBeGreaterThanOrEqual(2);
    expect(result.calls.some(args => args.includes('repos/owner/repo/releases/tags/development'))).toBe(false);
    expect(result.calls).toContainEqual(['api', '--method', 'POST', 'https://uploads.github.com/repos/owner/repo/releases/123/assets?name=Translate-It-development-for-Chrome.zip', '-H', 'Content-Type: application/zip', '--input', result.files.chrome]);
    expect(result.calls).toContainEqual(['api', '--method', 'POST', 'https://uploads.github.com/repos/owner/repo/releases/123/assets?name=Translate-It-development-for-Firefox.zip', '-H', 'Content-Type: application/zip', '--input', result.files.firefox]);
    expect(result.calls.some(args => args.includes('--paginate') && args.includes('--slurp'))).toBe(true);
    expect(result.calls).toContainEqual(['api', 'repos/owner/repo/git/ref/tags/development', '--jq', '.object.sha']);
    expect(result.calls).toContainEqual(tagRead);
    expect(uploads).toHaveLength(2);
    for (const i of uploads) {
      const input = result.calls[i][result.calls[i].indexOf('--input') + 1];
      expect([result.files.chrome, result.files.firefox]).toContain(input);
    }
    expect(result.stderr).not.toContain('rollback/recovery failed');
    result.cleanup();
  });

  it('discovers slurped pages with the match on page two, dupes across pages, or none', () => {
    const found = run({ list: 'paged-found' });
    expect(found.status, `${found.stdout}\n${found.stderr}`).toBe(0);
    expect(found.calls).toContainEqual(draftPatch(publishingMarker));
    found.cleanup();
    const dupes = run({ list: 'paged-dupes' });
    expect(dupes.status).not.toBe(0);
    expect(mutations(dupes.calls)).toEqual([]);
    dupes.cleanup();
    const none = run({ list: 'paged-none', body: '' });
    expect(none.status, `${none.stdout}\n${none.stderr}`).toBe(0);
    expect(none.calls.some(args => args[0] === 'release' && args[1] === 'create')).toBe(true);
    none.cleanup();
  }, 30000);

  it('rolls back a second-file upload failure to the prior public state', () => {
    const result = run({ fail: 'upload-second' });
    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(result.calls).toContainEqual(draftPatch(publishingMarker));
    expect(result.calls.some(args => JSON.stringify(args) === JSON.stringify(publishPatch(publishedMarker)))).toBe(false);
    expect(result.calls).toContainEqual(tagPatch(OLD_SHA));
    expect(result.calls.some(args => JSON.stringify(args) === JSON.stringify(tagPatch(SHA)))).toBe(false);
    expect(result.calls).toContainEqual(restorePatch(OLD_MARKER, false));
    expect(restoredUploads(result.calls, 'Translate-It-development-for-Chrome.zip', 'old-chrome-bytes')).toHaveLength(1);
    expect(restoredUploads(result.calls, 'Translate-It-development-for-Firefox.zip', 'old-firefox-bytes')).toHaveLength(1);
    expect(result.stderr).not.toContain('rollback/recovery failed');
    result.cleanup();
  }, 30000);

  it('restores a pre-existing draft release after a second-file upload failure', () => {
    const result = run({ draft: 'true', body: marker({ state: 'published' }), fail: 'upload-second' });
    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(restoredUploads(result.calls, 'Translate-It-development-for-Chrome.zip', 'old-chrome-bytes')).toHaveLength(1);
    expect(restoredUploads(result.calls, 'Translate-It-development-for-Firefox.zip', 'old-firefox-bytes')).toHaveLength(1);
    expect(result.calls).toContainEqual(tagPatch(OLD_SHA));
    expect(result.calls).toContainEqual(restorePatch(OLD_MARKER, true));
    expect(result.calls.some(args => args[0] === 'api' && args.includes('--method') && args.includes('PATCH') && args.includes('-F') && args.includes('draft=false'))).toBe(false);
    expect(result.calls.some(args => JSON.stringify(args) === JSON.stringify(publishPatch(publishedMarker)))).toBe(false);
    expect(result.stderr).not.toContain('rollback/recovery failed');
    result.cleanup();
  }, 30000);

  it('rolls back when ancestry drifts after upload instead of moving the tag forward', () => {
    const result = run({ compares: 'ahead,diverged' });
    expect(result.status).not.toBe(0);
    expect(result.calls).toContainEqual(draftPatch(publishingMarker));
    expect(result.calls.some(args => JSON.stringify(args) === JSON.stringify(publishPatch(publishedMarker)))).toBe(false);
    expect(result.calls).toContainEqual(tagPatch(OLD_SHA));
    expect(result.calls.some(args => JSON.stringify(args) === JSON.stringify(tagPatch(SHA)))).toBe(false);
    expect(result.calls).toContainEqual(publishPatch(OLD_MARKER));
    result.cleanup();
  }, 30000);

  it('rolls back a tag-move failure and a final-publish failure', () => {
    const tagFail = run({ fail: 'tag-once' });
    expect(tagFail.status).not.toBe(0);
    expect(tagFail.calls).toContainEqual(tagPatch(OLD_SHA));
    expect(tagFail.calls).toContainEqual(publishPatch(OLD_MARKER));
    expect(tagFail.calls.some(args => JSON.stringify(args) === JSON.stringify(publishPatch(publishedMarker)))).toBe(false);
    expect(tagFail.stderr).not.toContain('rollback/recovery failed');
    tagFail.cleanup();
    const publishFail = run({ fail: 'publish' });
    expect(publishFail.status).not.toBe(0);
    expect(publishFail.calls).toContainEqual(tagPatch(SHA));
    expect(publishFail.calls).toContainEqual(publishPatch(OLD_MARKER));
    expect(publishFail.stderr).not.toContain('rollback/recovery failed');
    publishFail.cleanup();
  }, 30000);

  it('creates a missing tag only after an exact-reference GET 404 and ancestry recheck', () => {
    const result = run({ tag: 'missing', draft: 'true', body: marker({ run_number: 20, run_attempt: 2, run_id: 300, sha: SHA, state: 'publishing' }) });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const read = result.calls.findIndex(args => JSON.stringify(args) === JSON.stringify(tagRead));
    const rechecks = result.calls.map((args, index) => ({ args, index })).filter(({ args }) => args.some(arg => arg.includes('/compare/')));
    const create = result.calls.findIndex(args => JSON.stringify(args) === JSON.stringify(tagCreate(SHA)));
    expect(read).toBeGreaterThanOrEqual(0);
    expect(rechecks.at(-1).index).toBeGreaterThan(read);
    expect(create).toBeGreaterThan(rechecks.at(-1).index);
    expect(result.calls.some(args => JSON.stringify(args) === JSON.stringify(tagPatch(SHA)))).toBe(false);
    result.cleanup();
  }, 30000);

  it('fails closed on non-404 exact-tag GET errors without PATCH or POST', () => {
    for (const tag of ['get-403', 'get-409', 'get-500', 'get-error']) {
      const result = run({ tag, draft: 'true', body: marker({ run_number: 20, run_attempt: 2, run_id: 300, sha: SHA, state: 'publishing' }) });
      expect(result.status).not.toBe(0);
      expect(result.calls.some(args => args.includes('repos/owner/repo/git/refs/tags/development') && args.includes('PATCH'))).toBe(false);
      expect(result.calls.some(args => args.includes('repos/owner/repo/git/refs') && args.includes('POST'))).toBe(false);
      result.cleanup();
    }
  }, 30000);

  it('does not POST after an existing-tag PATCH failure and rolls back with a fresh GET', () => {
    const result = run({ tag: 'patch-422' });
    expect(result.status).not.toBe(0);
    expect(result.calls).toContainEqual(tagRead);
    expect(result.calls).toContainEqual(tagPatch(SHA));
    expect(result.calls).toContainEqual(tagPatch(OLD_SHA));
    expect(result.calls.some(args => args.includes('repos/owner/repo/git/refs') && args.includes('POST'))).toBe(false);
    expect(result.stderr).not.toContain('rollback/recovery failed');
    result.cleanup();
  }, 30000);

  it('recreates a disappeared tag at the backup SHA during rollback without ancestry recheck', () => {
    const result = run({ tag: 'rollback-missing', fail: 'upload-second' });
    expect(result.status).not.toBe(0);
    expect(result.calls).toContainEqual(tagCreate(OLD_SHA));
    expect(result.calls.some(args => JSON.stringify(args) === JSON.stringify(tagPatch(OLD_SHA)))).toBe(false);
    expect(result.stderr).not.toContain('rollback/recovery failed');
    result.cleanup();
  }, 30000);

  it('fails backup capture before any mutation when downloads or tag SHA are unreadable', () => {
    for (const options of [{ download: 'fail' }, { download: 'empty' }, { tagsha: 'fail' }, { tagsha: 'bad' }]) {
      const result = run(options);
      expect(result.status).not.toBe(0);
      expect(mutations(result.calls)).toEqual([]);
      result.cleanup();
    }
  }, 30000);

  it('reports recovery failure when a rollback step itself fails', () => {
    const result = run({ fail: 'upload-rollback' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('rollback/recovery failed');
    expect(result.calls.some(args => JSON.stringify(args) === JSON.stringify(publishPatch(publishedMarker)))).toBe(false);
    result.cleanup();
  });

  it('attempts no rollback when first creation fails', () => {
    const result = run({ list: 'create-first', body: '', fail: 'create' });
    expect(result.status).not.toBe(0);
    expect(result.calls.some(args => args.includes('--method') && args.includes('PATCH') && args.some(a => String(a).includes('/releases/123')))).toBe(false);
    expect(result.calls.some(args => args.includes('DELETE') || args.some(a => String(a).startsWith('https://uploads.github.com/')))).toBe(false);
    expect(result.calls.some(args => args.includes('/git/refs/tags/development'))).toBe(false);
    expect(result.stderr).not.toContain('rollback');
    result.cleanup();
  });

  it('creates the first release as a draft and publishes only after the tag', () => {
    const result = run({ list: 'create-first', body: '', tag: 'missing' });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const create = result.calls.find(args => args[0] === 'release' && args[1] === 'create');
    expect(create).toEqual(['release', 'create', 'development', result.files.chrome, result.files.firefox, '--title', 'Development Build', '--prerelease', '--latest=false', '--target', SHA, '--draft', '--notes', publishingMarker]);
    const tag = result.calls.findIndex(args => JSON.stringify(args) === JSON.stringify(tagCreate(SHA)));
    const publish = result.calls.findIndex(args => JSON.stringify(args) === JSON.stringify(publishPatch(publishedMarker)));
    expect(tag).toBeGreaterThanOrEqual(0);
    expect(result.calls.some(args => JSON.stringify(args) === JSON.stringify(tagPatch(SHA)))).toBe(false);
    expect(publish).toBeGreaterThan(tag);
    expect(result.calls).toContainEqual(['api', '--method', 'PATCH', 'repos/owner/repo/releases/123', '-f', 'name=Development Build', '-F', 'prerelease=true', '-f', 'make_latest=false', '-F', 'draft=false', '-f', `body=${publishedMarker}`]);
    expect(result.calls.some(args => args[0] === 'release' && args[1] === 'view')).toBe(false);
    result.cleanup();
  });

  it('retries an existing draft publishing marker', () => {
    const retry = run({ body: marker({ run_number: 20, run_attempt: 2, run_id: 300, sha: SHA, state: 'publishing' }), draft: 'true', tag: 'missing' });
    expect(retry.status).toBe(0);
    expect(mutations(retry.calls).length).toBeGreaterThan(0);
    expect(retry.calls).toContainEqual(tagCreate(SHA));
    expect(retry.calls.some(args => JSON.stringify(args) === JSON.stringify(tagPatch(SHA)))).toBe(false);
    expect(retry.calls.filter(args => args[0] === 'release' && args[1] === 'create')).toHaveLength(0);
    expect(retry.calls.findIndex(args => JSON.stringify(args) === JSON.stringify(tagCreate(SHA)))).toBeLessThan(retry.calls.findIndex(args => JSON.stringify(args) === JSON.stringify(publishPatch(publishedMarker))));
    retry.cleanup();
  });

  it('skips older high-water and allows an equal retry', () => {
    const older = run({ body: marker({ run_number: 21, run_attempt: 1 }) });
    expect(older.status).toBe(0);
    expect(mutations(older.calls)).toEqual([]);
    older.cleanup();
    const equal = run({ body: marker({ run_number: 20, run_attempt: 2, state: 'publishing' }) });
    expect(equal.status).toBe(0);
    expect(mutations(equal.calls).length).toBeGreaterThan(0);
    equal.cleanup();
  }, 30000);

  it('fails closed on duplicate listing, list errors, and bad markers', () => {
    const dupes = run({ list: 'two' });
    expect(dupes.status).not.toBe(0);
    expect(mutations(dupes.calls)).toEqual([]);
    dupes.cleanup();
    const apiError = run({ fail: 'list' });
    expect(apiError.status).not.toBe(0);
    expect(mutations(apiError.calls)).toEqual([]);
    apiError.cleanup();
    for (const body of ['', 'unparseable marker', '<!-- translate-it-development-source: {} -->', `${marker()}\n${marker()}`]) {
      const result = run({ body });
      expect(result.status).not.toBe(0);
      expect(mutations(result.calls)).toEqual([]);
      result.cleanup();
    }
  }, 30000);

  it('makes no gh calls when stable inputs are missing or ambiguous', () => {
    for (const options of [{ chrome: false }, { firefox: false }, { chrome: false, firefox: false }, { extraChrome: true }]) {
      const result = run(options);
      expect(result.status).not.toBe(0);
      expect(result.calls).toEqual([]);
      result.cleanup();
    }
  }, 30000);

  it('creates a missing tag only on explicit 404', () => {
    const missing = run({ tag: 'missing', draft: 'true', body: marker({ run_number: 20, run_attempt: 2, run_id: 300, sha: SHA, state: 'publishing' }) });
    expect(missing.status).toBe(0);
    expect(missing.calls).toContainEqual(tagCreate(SHA));
    missing.cleanup();
    const failed = run({ fail: 'tag' });
    expect(failed.status).not.toBe(0);
    expect(failed.calls.some(args => args.includes('/git/refs') && args.includes('POST'))).toBe(false);
    expect(failed.stderr).toContain('rollback/recovery failed');
    failed.cleanup();
  }, 30000);

  it('keeps decimal SHAs raw in the tag PATCH', () => {
    const decimalSha = '1'.repeat(40);
    const decimal = run({ source: { ...SOURCE, SOURCE_SHA: decimalSha } });
    expect(decimal.status).toBe(0);
    expect(decimal.calls).toContainEqual(tagPatch(decimalSha));
    decimal.cleanup();
  });
});
