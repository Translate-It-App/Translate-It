import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(root, 'scripts/ci/official-release.sh');
const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
const developmentWorkflow = readFileSync(join(root, '.github/workflows/development-release.yml'), 'utf8');
const scriptSource = readFileSync(script, 'utf8');
const releaseNotesSource = readFileSync(join(root, 'scripts/ci/release-notes.mjs'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = packageJson.version;
const tag = `v${version}`;
const releaseTitle = `Translate It! ${tag}`;
const sha = 'a'.repeat(40);
const chromeName = `Translate-It-${tag}-for-Chrome.zip`;
const firefoxName = `Translate-It-${tag}-for-Firefox.zip`;
const generatedChanges = `## What's Changed\n\n* ci: fixture change\n* fix: fixture fix\n\n## New Contributors\n* @octocat made their first contribution in https://github.com/owner/repo/pull/1\n\n**Full Changelog**: https://github.com/owner/repo/compare/v1.19.0...${tag}`;

function run({ command = 'prepare', releaseTag = tag, releaseId = '77', expectedSha = sha,
  tagExists = false, existingRelease = false, existingReleaseDraft = true, existingReleaseTitle = releaseTag, duplicateRelease = false, createdReleaseId = '77', mainFailure = '', tagFailure = '', listFailure = '',
  checkoutSha = sha, checkoutFailure = false, tagShaSequence = [], tagFailOnRead = 0, zipVersion = tag,
  releaseDraft = true, releaseTagName = tag, releaseName = releaseTitle, releaseSha = sha, releasePrerelease = true,
  initialAssets = [], chrome = true, firefox = true, duplicateChrome = false, duplicateFirefox = false,
  uploadFailure = '', publishFailure = false, finalTitleLie = false, extraFinalAsset = '', createResponse = '',
  changelog, generatedBody = generatedChanges, generatedResponse = 'valid', generatedFailure = false,
  vueJson = '[{"dependencies":{"vue":{"version":"3.5.31"}}}]', vueFailure = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'official-release-test-'));
  const cwd = changelog === undefined ? root : dir;
  if (changelog !== undefined) {
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version, dependencies: { vue: packageJson.dependencies.vue } }));
    writeFileSync(join(dir, 'docs/Changelog.md'), changelog);
  }
  const publishDir = join(dir, 'publish');
  mkdirSync(publishDir, { recursive: true });
  if (chrome) writeFileSync(join(publishDir, `Translate-It-${zipVersion}-for-Chrome.zip`), 'chrome package');
  if (firefox) writeFileSync(join(publishDir, `Translate-It-${zipVersion}-for-Firefox.zip`), 'firefox package');
  if (duplicateChrome) writeFileSync(join(publishDir, 'Translate-It-v999.0.0-for-Chrome.zip'), 'duplicate chrome');
  if (duplicateFirefox) writeFileSync(join(publishDir, 'Translate-It-v999.0.0-for-Firefox.zip'), 'duplicate firefox');

  const callsFile = join(dir, 'calls.jsonl');
  const outputFile = join(dir, 'github-output');
  const stateFile = join(dir, 'state.json');
  const pnpmCallsFile = join(dir, 'pnpm-calls.jsonl');
  writeFileSync(callsFile, '');
  writeFileSync(outputFile, '');
  writeFileSync(pnpmCallsFile, '');
  const releaseCandidate = { id: 66, tag_name: releaseTag, name: existingReleaseTitle, body: 'Maintainer-edited draft body', draft: existingReleaseDraft };
  const releases = existingRelease ? [releaseCandidate, ...(duplicateRelease ? [{ ...releaseCandidate, id: 67 }] : [])] : [];
  const state = {
    tagExists,
    refSha: releaseSha,
    refShaSequence: tagShaSequence,
    refReadCount: 0,
    mainSha: sha,
    release: { id: Number(releaseId), tag_name: releaseTagName, draft: releaseDraft, prerelease: releasePrerelease, name: releaseName, body: 'release notes' },
    releases,
    assets: initialAssets,
    nextAssetId: 100,
    generatedBody,
    generatedResponse,
    generatedFailure,
  };
  writeFileSync(stateFile, JSON.stringify(state));

  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const stateFile = process.env.MOCK_STATE;
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const callsFile = process.env.MOCK_CALLS;
fs.appendFileSync(callsFile, JSON.stringify(args) + '\\n');
const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\\n').filter(Boolean).map(line => JSON.parse(line));
const endpoint = args.find(value => value.startsWith('repos/') || value.startsWith('https://')) || '';
const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : '';
if (args[0] === 'api' && endpoint === 'repos/owner/repo/commits/main') {
  if (process.env.MOCK_MAIN_FAILURE) { process.stdout.write('HTTP/2 500 Server Error\\r\\n'); process.exit(1); }
  process.stdout.write(state.mainSha); process.exit(0);
}
if (args[0] === 'api' && endpoint === 'repos/owner/repo/git/ref/tags/' + process.env.MOCK_TAG && args.includes('--include')) {
  if (process.env.MOCK_TAG_FAILURE) { process.stdout.write('HTTP/2 403 Forbidden\\r\\n'); process.exit(1); }
  if (state.tagExists) { process.stdout.write('HTTP/2 200 OK\\r\\n'); process.exit(0); }
  process.stdout.write('HTTP/2 404 Not Found\\r\\n'); process.exit(1);
}
if (args[0] === 'api' && args.includes('--paginate') && args.includes('--slurp') && endpoint === 'repos/owner/repo/releases') {
  if (process.env.MOCK_LIST_FAILURE) { process.stderr.write('HTTP/2 500 Server Error\\r\\n'); process.exit(1); }
  const releases = state.releases.slice();
  if (state.release && state.release.created) releases.push(state.release);
  process.stdout.write(JSON.stringify([releases])); process.exit(0);
}
if (args[0] === 'api' && endpoint === 'repos/owner/repo/git/refs' && method === 'POST') {
  state.tagExists = true;
  const shaArg = args.find(value => value.startsWith('sha='));
  state.refSha = shaArg.slice(4);
  save(); process.stdout.write('{}'); process.exit(0);
}
if (args[0] === 'api' && endpoint === 'repos/owner/repo/releases/generate-notes' && method === 'POST') {
  if (state.generatedFailure) { process.stderr.write('generate notes failed'); process.exit(1); }
  if (state.generatedResponse === 'empty') process.stdout.write(JSON.stringify({ body: '' }));
  else if (state.generatedResponse === 'malformed') process.stdout.write(JSON.stringify({ body: 42 }));
  else process.stdout.write(JSON.stringify({ body: state.generatedBody }));
  process.exit(0);
}
if (args[0] === 'api' && method === 'POST' && endpoint === 'repos/owner/repo/releases') {
  const fields = {};
  for (let i = 0; i < args.length - 1; i++) {
    if ((args[i] === '-f' || args[i] === '-F') && args[i + 1].includes('=')) {
      const [key, ...rest] = args[i + 1].split('=');
      fields[key] = rest.join('=');
    }
  }
  const releaseTag = fields.tag_name;
  const title = fields.name;
  const body = fields.body;
  const draft = fields.draft === 'true';
  state.release = { id: Number(process.env.MOCK_CREATED_RELEASE_ID), tag_name: releaseTag, name: title, body, draft, prerelease: false, created: true };
  save();
  const lie = process.env.MOCK_CREATE_RESPONSE_LIE;
  let response = state.release;
  if (lie === 'invalidId') response = { ...response, id: 'not-a-number' };
  if (lie === 'wrongTag') response = { ...response, tag_name: 'v9.9.9' };
  if (lie === 'notDraft') response = { ...response, draft: false };
  if (lie === 'wrongTitle') response = { ...response, name: 'Unexpected Title' };
  process.stdout.write(JSON.stringify(response)); process.exit(0);
}
if (args[0] === 'api' && endpoint === 'repos/owner/repo/releases/' + process.env.MOCK_RELEASE_ID && !method) {
  process.stdout.write(JSON.stringify(state.release)); process.exit(0);
}
if (args[0] === 'api' && endpoint === 'repos/owner/repo/git/ref/tags/' + process.env.MOCK_TAG && !method) {
  if (args.includes('--jq')) {
    state.refReadCount++;
    if (Number(process.env.MOCK_REF_FAIL_ON_READ) === state.refReadCount) { process.stderr.write('ref lookup failed'); process.exit(1); }
    const sequence = state.refShaSequence;
    const refSha = sequence.length ? sequence[Math.min(state.refReadCount - 1, sequence.length - 1)] : state.refSha;
    save(); process.stdout.write(refSha); process.exit(0);
  }
  process.stdout.write(JSON.stringify({ object: { sha: state.refSha } })); process.exit(0);
}
if (args[0] === 'api' && endpoint === 'repos/owner/repo/releases/' + process.env.MOCK_RELEASE_ID + '/assets' && !method) {
  const assets = state.assets.slice();
  const uploaded = calls.some(call => call.some(value => String(value).startsWith('https://uploads.github.com/')));
  if (process.env.MOCK_FINAL_EXTRA && uploaded) assets.push({ id: 999, name: process.env.MOCK_FINAL_EXTRA });
  process.stdout.write(JSON.stringify(assets)); process.exit(0);
}
if (args[0] === 'api' && method === 'DELETE' && endpoint.startsWith('repos/owner/repo/releases/assets/')) {
  const id = Number(endpoint.split('/').pop());
  state.assets = state.assets.filter(asset => asset.id !== id);
  save(); process.exit(0);
}
if (args[0] === 'api' && method === 'POST' && endpoint.startsWith('https://uploads.github.com/')) {
  const uploads = calls.filter(call => call.some(value => String(value).startsWith('https://uploads.github.com/')));
  const failureIndex = process.env.MOCK_UPLOAD_FAILURE === 'first' ? 0 : process.env.MOCK_UPLOAD_FAILURE === 'second' ? 1 : -1;
  if (uploads.length - 1 === failureIndex) { process.stderr.write('upload failed'); process.exit(1); }
  const name = new URL(endpoint).searchParams.get('name');
  state.assets.push({ id: state.nextAssetId++, name });
  save(); process.exit(0);
}
if (args[0] === 'api' && method === 'PATCH' && endpoint === 'repos/owner/repo/releases/' + process.env.MOCK_RELEASE_ID) {
  if (process.env.MOCK_PUBLISH_FAILURE) { process.stderr.write('publish failed'); process.exit(1); }
  for (let i = 0; i < args.length - 1; i++) {
    if ((args[i] === '-f' || args[i] === '-F') && args[i + 1].includes('=')) {
      const [key, ...rest] = args[i + 1].split('=');
      const value = rest.join('=');
      if (key === 'name') state.release.name = value;
      if (key === 'draft') state.release.draft = value === 'true';
      if (key === 'prerelease') state.release.prerelease = value === 'true';
      if (key === 'tag_name') state.release.tag_name = value;
    }
  }
  save();
  const response = process.env.MOCK_FINAL_TITLE_LIE ? { ...state.release, name: 'unexpected release title' } : state.release;
  process.stdout.write(JSON.stringify(response)); process.exit(0);
}
process.stderr.write('unexpected gh call: ' + JSON.stringify(args)); process.exit(2);
`, { mode: 0o755 });

  const git = join(dir, 'git');
  writeFileSync(git, `#!/usr/bin/env node
if (process.argv.slice(2).join(' ') !== 'rev-parse HEAD') process.exit(2);
if (process.env.MOCK_GIT_FAILURE) { process.stderr.write('git failed'); process.exit(1); }
process.stdout.write(process.env.MOCK_CHECKOUT_SHA);
`, { mode: 0o755 });

  const pnpm = join(dir, 'pnpm');
  writeFileSync(pnpm, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.MOCK_PNPM_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.MOCK_VUE_FAILURE) { process.stderr.write('vue resolution failed'); process.exit(1); }
process.stdout.write(process.env.MOCK_VUE_JSON);
`, { mode: 0o755 });

  const env = {
    ...process.env,
    PATH: `${dir}${delimiter}${process.env.PATH}`,
    GH_TOKEN: 'test-token',
    GITHUB_REPOSITORY: 'owner/repo',
    RELEASE_TAG: releaseTag,
    RELEASE_ID: releaseId,
    EXPECTED_SHA: expectedSha,
    PUBLISH_DIR: publishDir,
    GITHUB_OUTPUT: outputFile,
    MOCK_STATE: stateFile,
    MOCK_CALLS: callsFile,
    MOCK_PNPM_CALLS: pnpmCallsFile,
    MOCK_VUE_JSON: vueJson,
    MOCK_VUE_FAILURE: vueFailure ? '1' : '',
    MOCK_TAG: releaseTag,
    MOCK_RELEASE_ID: releaseId,
    MOCK_CREATED_RELEASE_ID: createdReleaseId,
    MOCK_MAIN_FAILURE: mainFailure,
    MOCK_TAG_FAILURE: tagFailure,
    MOCK_LIST_FAILURE: listFailure,
    MOCK_UPLOAD_FAILURE: uploadFailure,
    MOCK_PUBLISH_FAILURE: publishFailure ? '1' : '',
    MOCK_FINAL_EXTRA: extraFinalAsset,
    MOCK_FINAL_TITLE_LIE: finalTitleLie ? '1' : '',
    MOCK_CHECKOUT_SHA: checkoutSha,
    MOCK_GIT_FAILURE: checkoutFailure ? '1' : '',
    MOCK_REF_FAIL_ON_READ: String(tagFailOnRead),
    MOCK_CREATE_RESPONSE_LIE: createResponse,
    MOCK_GENERATED_BODY: generatedBody,
  };
  env.MOCK_GENERATED_FAILURE = generatedFailure ? '1' : '';
  env.MOCK_GENERATED_RESPONSE = generatedResponse;
  env.MOCK_REF_SHA_SEQUENCE = tagShaSequence.join(',');
  const result = spawnSync('bash', [script, command], { cwd, env, encoding: 'utf8' });
  const calls = readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    calls,
    pnpmCalls: readFileSync(pnpmCallsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    state: JSON.parse(readFileSync(stateFile, 'utf8')),
    output: readFileSync(outputFile, 'utf8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const isReleasePatch = args => args[0] === 'api' && args.includes('--method') && args.includes('PATCH') && args.includes('repos/owner/repo/releases/77');
const releaseCreate = calls => calls.find(args => args[0] === 'api' && args.includes('--method') && args.includes('POST') && args.includes('repos/owner/repo/releases'));
const releaseBody = calls => releaseCreate(calls)?.find(value => value.startsWith('body='))?.slice('body='.length);
const expectedReleaseCreate = (calls, expectedTag = tag, expectedSha = sha) => [
  'api', '--method', 'POST', 'repos/owner/repo/releases', '-f', `tag_name=${expectedTag}`,
  '-f', `name=Translate It! ${expectedTag}`, '-f', `target_commitish=${expectedSha}`,
  '-f', `body=${releaseBody(calls)}`, '-F', 'draft=true',
];
const generatedNotesCall = calls => calls.find(args => args[0] === 'api' && args.includes('--method') && args.includes('POST') && args.includes('repos/owner/repo/releases/generate-notes'));
const changelogEntry = (items = '- Added a fixture feature.') => `#### ${tag} – Released on October 04, 2026\n\n##### Added\n\n${items}\n\n---\n\n#### v0.0.1 – Released on January 01, 2000\n\n- OLD_ENTRY_MUST_NOT_APPEAR\n`;
const mutations = calls => calls.filter(args => args[0] === 'api' && args.includes('--method') && ['POST', 'PATCH', 'DELETE'].includes(args[args.indexOf('--method') + 1])
  || args[0] === 'release' && args[1] === 'create');

describe('official release helper', () => {
  it('rejects invalid tags and package-version mismatches before mutation', () => {
    for (const releaseTag of ['release', 'v1.2', 'v1.2.3-rc.1', `v${version.slice(0, -1)}9`]) {
      const result = run({ releaseTag });
      expect(result.status).not.toBe(0);
      expect(mutations(result.calls)).toEqual([]);
      result.cleanup();
    }
  });

  it('fails closed when a tag, release, or preparatory API request is unavailable', () => {
    for (const options of [
      { existingRelease: true },
      { tagExists: true, releaseSha: 'b'.repeat(40) },
      { tagExists: true, existingRelease: true, existingReleaseDraft: false },
      { tagExists: true, existingRelease: true, existingReleaseTitle: 'Wrong Title' },
      { tagExists: true, existingRelease: true, duplicateRelease: true, existingReleaseTitle: releaseTitle },
      { tagFailure: '403' },
      { mainFailure: '500' },
      { listFailure: '500' },
    ]) {
      const result = run(options);
      expect(result.status).not.toBe(0);
      expect(result.calls.some(args => args[0] === 'api' && args.includes('--method') && args.includes('POST') && args.includes('repos/owner/repo/git/refs'))).toBe(false);
      expect(releaseCreate(result.calls)).toBeUndefined();
      result.cleanup();
    }
  }, 30000);

  it('recovers a pre-existing tag with no release by creating only the draft', () => {
    const result = run({ tagExists: true, createdReleaseId: '66' });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.calls.some(args => args.includes('repos/owner/repo/git/refs') && args.includes('POST'))).toBe(false);
    expect(releaseCreate(result.calls)).toEqual(expectedReleaseCreate(result.calls));
    const generatedIndex = result.calls.indexOf(generatedNotesCall(result.calls));
    const createIndex = result.calls.indexOf(releaseCreate(result.calls));
    expect(generatedIndex).toBeGreaterThan(-1);
    expect(generatedIndex).toBeLessThan(createIndex);
    expect(result.output).toBe(`tag=${tag}\nsha=${sha}\nrelease_id=66\n`);
    result.cleanup();
  });

  it('reuses a matching existing draft when both tag and release already exist', () => {
    const result = run({ tagExists: true, existingRelease: true, existingReleaseTitle: releaseTitle });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.output).toBe(`tag=${tag}\nsha=${sha}\nrelease_id=66\n`);
    expect(releaseCreate(result.calls)).toBeUndefined();
    expect(generatedNotesCall(result.calls)).toBeUndefined();
    expect(result.calls.some(args => args[0] === 'api' && args.includes('--method') && args.includes('PATCH'))).toBe(false);
    expect(result.calls.some(args => args.includes('repos/owner/repo/git/refs') && args.includes('POST'))).toBe(false);
    expect(result.pnpmCalls).toEqual([]);
    expect(result.state.releases[0].body).toBe('Maintainer-edited draft body');
    result.cleanup();
  });

  it('does not create a tag when the checked-out main commit drifts or cannot be read', () => {
    for (const options of [{ checkoutSha: 'b'.repeat(40) }, { checkoutFailure: true }]) {
      const result = run(options);
      expect(result.status).not.toBe(0);
      expect(result.calls.some(args => args.includes('repos/owner/repo/git/refs') && args.includes('POST'))).toBe(false);
      expect(releaseCreate(result.calls)).toBeUndefined();
      result.cleanup();
    }
  }, 30000);

  it('creates the Git tag and a draft release at main and exports its identity', () => {
    const result = run();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.calls).toContainEqual(['api', '--method', 'POST', 'repos/owner/repo/git/refs', `-f`, `ref=refs/tags/${tag}`, `-f`, `sha=${sha}`]);
    expect(releaseCreate(result.calls)).toEqual(expectedReleaseCreate(result.calls));
    expect(result.state.release.name).toBe(releaseTitle);
    expect(result.output).toBe(`tag=${tag}\nsha=${sha}\nrelease_id=77\n`);
    expect(result.calls.some(isReleasePatch)).toBe(false);
    expect(result.state.release.draft).toBe(true);
    expect(result.calls.some(args => args[0] === 'api' && args.includes('--method') && args.includes('PATCH'))).toBe(false);
    const generatedCall = generatedNotesCall(result.calls);
    const tagCreateIndex = result.calls.findIndex(args => args.includes('repos/owner/repo/git/refs') && args.includes('POST'));
    const generatedIndex = result.calls.indexOf(generatedCall);
    const createIndex = result.calls.indexOf(releaseCreate(result.calls));
    expect(generatedCall).toEqual(['api', '--method', 'POST', 'repos/owner/repo/releases/generate-notes', '-f', `tag_name=${tag}`, '-f', `target_commitish=${sha}`]);
    expect(generatedIndex).toBeLessThan(tagCreateIndex);
    expect(tagCreateIndex).toBeLessThan(createIndex);
    expect(releaseBody(result.calls)).toContain("<summary><h4>What's Changed</h4></summary>");
    result.cleanup();
  });

  it('retrieves and validates generated notes before creating the missing tag, and creates no tag when they fail', () => {
    const success = run();
    expect(success.status, `${success.stdout}\n${success.stderr}`).toBe(0);
    const generatedIndex = success.calls.indexOf(generatedNotesCall(success.calls));
    const tagCreateIndex = success.calls.findIndex(args => args.includes('repos/owner/repo/git/refs') && args.includes('POST'));
    const createIndex = success.calls.indexOf(releaseCreate(success.calls));
    expect(generatedIndex).toBeGreaterThan(-1);
    expect(generatedIndex).toBeLessThan(tagCreateIndex);
    expect(tagCreateIndex).toBeLessThan(createIndex);
    success.cleanup();

    for (const options of [
      { generatedFailure: true },
      { generatedResponse: 'empty' },
      { generatedResponse: 'malformed' },
      { generatedBody: "## What's Changed\n\n## New Contributors\n* @dev" },
    ]) {
      const result = run(options);
      expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
      expect(generatedNotesCall(result.calls)).toBeTruthy();
      expect(result.calls.some(args => args.includes('repos/owner/repo/git/refs') && args.includes('POST'))).toBe(false);
      expect(releaseCreate(result.calls)).toBeUndefined();
      expect(result.output).toBe('');
      result.cleanup();
    }
  }, 30000);

  it('builds the custom changelog section with links and badges before generated notes, stopping at the separator', () => {
    const customItem = '- Added [fixture feature](https://example.test/feature) with [@maintainer](https://github.com/maintainer).';
    const vueVersion = '9.9.9';
    const result = run({ changelog: changelogEntry(customItem), generatedBody: generatedChanges, vueJson: JSON.stringify([{ dependencies: { vue: { version: vueVersion } } }]) });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const body = releaseBody(result.calls);
    expect(body).toContain(`#### 🌍 Translate It ${tag} – Released on 04 October 2026`);
    expect(body).toContain('<div align="center">');
    const badgeUrls = [
      `https://img.shields.io/badge/version-${version}-blue.svg`,
      'https://img.shields.io/badge/Chrome%20&%20Firefox-Supported-brightgreen',
      'https://img.shields.io/badge/Bundled%20with-Vite-646CFF?logo=vite&logoColor=white',
      `https://img.shields.io/badge/Vue.js-${vueVersion}-4FC08D?logo=vue.js&logoColor=4FC08D`,
    ];
    for (const badgeUrl of badgeUrls) expect(body).toContain(`<img src="${badgeUrl}"`);
    for (const img of body.match(/<img[^>]*>/g)) expect(img.endsWith(' />')).toBe(true);
    expect(body.match(/<img src="https:\/\/img\.shields\.io\/badge\//g)).toHaveLength(4);
    expect(body).not.toContain('i18n-Multi--Language');
    expect(body).toContain(`<img src="https://img.shields.io/badge/version-${version}-blue.svg" alt="Version" />`);
    expect(body).toContain('<img src="https://img.shields.io/badge/Chrome%20&%20Firefox-Supported-brightgreen" alt="Browser Support" />');
    expect(body).toContain('<img src="https://img.shields.io/badge/Bundled%20with-Vite-646CFF?logo=vite&logoColor=white" alt="Vite" />');
    expect(body).toContain(`<img src="https://img.shields.io/badge/Vue.js-${vueVersion}-4FC08D?logo=vue.js&logoColor=4FC08D" alt="Vue.js ${vueVersion}" />`);
    expect(body).toContain(`<div align="center">\n\n<a href="https://github.com/Translate-It-App/Translate-It/releases">\n  <img src="https://img.shields.io/badge/version-${version}-blue.svg" alt="Version" />\n</a>`);
    expect(body).not.toContain('webpack.js.org');
    expect(body).not.toContain('Bundled%20with-Webpack');
    expect(body).not.toContain('Bundled with Webpack');
    expect(body).not.toContain('Vue.js-^');
    expect(body).not.toContain(`Vue.js-${packageJson.dependencies.vue}`);
    expect(result.pnpmCalls).toEqual([['list', 'vue', '--depth=0', '--json', '--lockfile-only']]);
    expect(body).not.toContain(`version-${tag}-blue.svg`);
    expect(body).toContain('https://chromewebstore.google.com/detail/translate-it/jfkpmcnebiamnbbkpmmldomjijiahmbd');
    expect(body).toContain('https://addons.mozilla.org/firefox/addon/translate-it');
    expect(body).toContain('https://github.com/Translate-It-App/Translate-It/raw/refs/heads/main/docs/Store/Chrome-Store.png');
    expect(body).toContain('https://github.com/Translate-It-App/Translate-It/raw/refs/heads/main/docs/Store/Firefox-Store.png');
    expect(body).toContain(`<a href="https://chromewebstore.google.com/detail/translate-it/jfkpmcnebiamnbbkpmmldomjijiahmbd/" target="_blank">\n  <img src="https://github.com/Translate-It-App/Translate-It/raw/refs/heads/main/docs/Store/Chrome-Store.png" alt="Install on Chrome" height="60" />\n</a>`);
    expect(body).toContain(`<a href="https://addons.mozilla.org/firefox/addon/translate-it/" target="_blank">\n  <img src="https://github.com/Translate-It-App/Translate-It/raw/refs/heads/main/docs/Store/Firefox-Store.png" alt="Install on Firefox" height="60" />\n</a>`);
    expect(body).toContain(customItem);
    expect(body).not.toContain('OLD_ENTRY_MUST_NOT_APPEAR');
    expect(body.indexOf('Released on 04 October 2026')).toBeLessThan(body.indexOf(badgeUrls[0]));
    expect(body.indexOf(customItem)).toBeLessThan(body.indexOf('### 🧩 Install Now'));
    expect(body.indexOf('### 🧩 Install Now')).toBeLessThan(body.indexOf('Chrome-Store.png'));
    expect(body.indexOf('Firefox-Store.png')).toBeLessThan(body.indexOf('* ci: fixture change'));
    expect(body.indexOf(customItem)).toBeLessThan(body.indexOf('* ci: fixture change'));
    expect(generatedNotesCall(result.calls)).toEqual(['api', '--method', 'POST', 'repos/owner/repo/releases/generate-notes', '-f', `tag_name=${tag}`, '-f', `target_commitish=${sha}`]);
    result.cleanup();
  });

  it("uses the What's Changed title as the collapsed summary and keeps metadata outside", () => {
    const result = run({});
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const body = releaseBody(result.calls);
    const lines = body.split('\n');
    expect(body).toContain("<summary><h4>What's Changed</h4></summary>");
    expect(body).not.toContain('View changes');
    expect(body).not.toContain("<h3>What's Changed</h3>");
    expect(lines).not.toContain("## What's Changed");
    expect(lines).not.toContain("### What's Changed");
    expect(body).toContain('---\n\n<details>');
    expect(body.match(/---\n\n<details>/g)).toHaveLength(1);
    expect(body).toContain('<details>');
    expect(body).not.toContain('<details open');
    expect(body).toContain("<summary><h4>What's Changed</h4></summary>\n\n* ci: fixture change");
    expect(body).toContain('* fix: fixture fix');
    expect(lines).toContain('### New Contributors');
    expect(lines).not.toContain('## New Contributors');
    expect(body).toContain('@octocat made their first contribution');
    expect(body).toContain(`**Full Changelog**: https://github.com/owner/repo/compare/v1.19.0...${tag}`);
    expect(body.indexOf('* fix: fixture fix')).toBeLessThan(body.indexOf('</details>'));
    expect(body.indexOf('</details>')).toBeLessThan(body.indexOf('### New Contributors'));
    expect(body.indexOf('### New Contributors')).toBeLessThan(body.indexOf('**Full Changelog**'));
    expect(body.indexOf('**Full Changelog**')).toBeGreaterThan(body.indexOf('</details>'));
    expect(body.trimEnd().endsWith(`**Full Changelog**: https://github.com/owner/repo/compare/v1.19.0...${tag}`)).toBe(true);
    result.cleanup();
  });

  it('keeps GitHub metadata outside the collapse and handles bodies without New Contributors or without metadata', () => {
    const cases = [
      {
        generatedBody: "## What's Changed\n\n* only change\n\n**Full Changelog**: https://example.test/compare",
        metadata: '**Full Changelog**: https://example.test/compare',
        inside: '* only change',
      },
      {
        generatedBody: "## What's Changed\n\n* change one\n\n## New Contributors\n* @dev",
        metadata: '### New Contributors',
        inside: '* change one',
      },
      {
        generatedBody: "## What's Changed\n\n* lone change\n* another change",
        metadata: null,
        inside: '* lone change',
      },
    ];
    for (const { generatedBody, metadata, inside } of cases) {
      const result = run({ generatedBody });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const body = releaseBody(result.calls);
      expect(body).toContain('---\n\n<details>');
      expect(body).toContain(`<summary><h4>What's Changed</h4></summary>\n\n${inside}`);
      const closeIndex = body.indexOf('</details>');
      expect(closeIndex).toBeGreaterThan(-1);
      expect(body.indexOf(inside)).toBeLessThan(closeIndex);
      if (metadata) {
        expect(body).toContain(metadata);
        expect(body.indexOf(metadata)).toBeGreaterThan(closeIndex);
      } else {
        expect(body).not.toContain('**Full Changelog**');
        expect(body).not.toContain('New Contributors');
        expect(body.trimEnd().endsWith('</details>')).toBe(true);
      }
      result.cleanup();
    }
  }, 30000);

  it('keeps Vue version discovery dynamic and fails closed on invalid pnpm results before Draft creation', () => {
    expect(releaseNotesSource.includes('3.5.31')).toBe(false);
    const invalidResults = [
      { vueJson: '' },
      { vueJson: 'not json' },
      { vueJson: '[{"dependencies":{"vue":{"version":"9.9.9"}}},{"dependencies":{"vue":{"version":"8.8.8"}}}]' },
      { vueJson: '[{"dependencies":{"vue":{"version":"^3.5.31"}}}]' },
      { vueJson: '[{"dependencies":{"vue":{"version":"3.5.31-beta"}}}]' },
      { vueFailure: true },
    ];
    for (const options of invalidResults) {
      const result = run(options);
      expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
      expect(result.pnpmCalls).toEqual([['list', 'vue', '--depth=0', '--json', '--lockfile-only']]);
      expect(generatedNotesCall(result.calls)).toBeUndefined();
      expect(releaseCreate(result.calls)).toBeUndefined();
      expect(result.calls.some(args => args.includes('repos/owner/repo/git/refs') && args.includes('POST'))).toBe(false);
      expect(result.output).toBe('');
      result.cleanup();
    }
  }, 30000);

  it('preserves changelog categories, links, bold, and code while converting app links', () => {
    const itemAdded = '- Added [external link](https://example.test) and [Settings [advanced]](#/providers) with **bold** and `code`.';
    const changelog = `#### ${tag} – Released on October 04, 2026\n\n##### Added\n\n${itemAdded}\n\n##### Fixed\n\n- Fixed a fixture issue.\n\n##### Changed\n\n- Changed a fixture behavior.\n\n---\n`;
    const result = run({ changelog });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const body = releaseBody(result.calls);
    expect(body).toContain(itemAdded.replace('[Settings [advanced]](#/providers)', 'Settings [advanced]'));
    expect(body).toContain('##### Fixed\n\n- Fixed a fixture issue.');
    expect(body).toContain('##### Changed\n\n- Changed a fixture behavior.');
    expect(body).toContain('[external link](https://example.test)');
    expect(body).toContain('**bold**');
    expect(body).toContain('`code`');
    result.cleanup();
  });

  it('rejects missing, duplicate, malformed-heading, and invalid-date changelog entries before creating a Draft', () => {
    const cases = [
      '#### v0.0.1 – Released on January 01, 2000\n\n- No matching tag.\n',
      `${changelogEntry()}\n${changelogEntry()}`,
      `${changelogEntry()}\n#### ${tag}: duplicate\n\n- Duplicate malformed heading.\n`,
      changelogEntry().replace(`#### ${tag} – Released on October 04, 2026`, `#### ${tag} – Released`),
      changelogEntry().replace('October 04, 2026', 'October 99, 2026'),
      `#### ${tag} – Released on October 04, 2026\n\n##### Added\n\n---\n`,
    ];
    for (const changelog of cases) {
      const result = run({ changelog });
      expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
      expect(releaseCreate(result.calls)).toBeUndefined();
      expect(result.calls.some(args => args.includes('repos/owner/repo/git/refs') && args.includes('POST'))).toBe(false);
      expect(result.output).toBe('');
      result.cleanup();
    }
  }, 30000);

  it('fails closed when GitHub-generated notes fail or return an empty or malformed body', () => {
    for (const options of [
      { generatedFailure: true },
      { generatedResponse: 'empty' },
      { generatedResponse: 'malformed' },
      { generatedBody: ' \n\t ' },
      { generatedBody: '## Wrong Heading\n\n* unexpected' },
      { generatedBody: 'No heading at all' },
      { generatedBody: "## What's Changed" },
      { generatedBody: "## What's Changed\n\n## New Contributors\n* @dev" },
    ]) {
      const result = run(options);
      expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
      expect(generatedNotesCall(result.calls)).toBeTruthy();
      expect(releaseCreate(result.calls)).toBeUndefined();
      expect(result.calls.some(args => args.includes('repos/owner/repo/git/refs') && args.includes('POST'))).toBe(false);
      expect(result.output).toBe('');
      result.cleanup();
    }
  }, 30000);

  it('retries an existing valid Draft by replacing and verifying both official ZIPs', () => {
    const result = run({ command: 'finalize-draft', initialAssets: [
      { id: 10, name: chromeName },
      { id: 12, name: firefoxName },
    ] });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const uploads = result.calls.map((args, index) => ({ args, index })).filter(({ args }) => args.some(value => String(value).startsWith('https://uploads.github.com/')));
    expect(uploads).toHaveLength(2);
    for (const { args } of uploads) {
      expect(args).toContain(`https://uploads.github.com/repos/owner/repo/releases/77/assets?name=${args.at(-1).split('/').at(-1)}`);
      expect(args).toContain('Content-Type: application/zip');
      expect(args).toContain('--input');
    }
    const lastUpload = Math.max(...uploads.map(({ index }) => index));
    expect(result.calls).toContainEqual(['api', '--method', 'DELETE', 'repos/owner/repo/releases/assets/10']);
    expect(result.calls).toContainEqual(['api', '--method', 'DELETE', 'repos/owner/repo/releases/assets/12']);
    for (const [assetId, name] of [[10, chromeName], [12, firefoxName]]) {
      const remove = result.calls.findIndex(args => args.includes(`repos/owner/repo/releases/assets/${assetId}`) && args.includes('DELETE'));
      const upload = uploads.find(({ args }) => args.some(value => String(value).endsWith(`?name=${name}`))).index;
      expect(upload).toBeGreaterThan(remove);
    }
    expect(lastUpload).toBeGreaterThan(-1);
    expect(result.calls.filter(args => args[0] === 'api' && args[1] === 'repos/owner/repo/releases/77' && !args.includes('--method'))).toHaveLength(2);
    expect(result.calls.some(args => args.some(value => value === 'draft=false' || value === 'make_latest=true'))).toBe(false);
    expect(result.calls.some(isReleasePatch)).toBe(false);
    expect(result.state.release).toMatchObject({ id: 77, tag_name: tag, draft: true });
    expect(result.state.assets.map(asset => asset.name)).toEqual([chromeName, firefoxName]);
    const assetChecks = result.calls.map((args, index) => ({ args, index }))
      .filter(({ args }) => args[0] === 'api' && args[1] === 'repos/owner/repo/releases/77/assets' && !args.includes('--method'));
    expect(assetChecks).toHaveLength(4);
    expect(assetChecks.at(-1).index).toBeGreaterThan(lastUpload);
    expect(result.calls.some(args => args[0] === 'release' && ['upload', 'edit'].includes(args[1]))).toBe(false);
    expect(result.calls.some(args => args.some(value => String(value).includes('/releases/tags/')))).toBe(false);
    result.cleanup();
  });

  it('rejects a draft containing unexpected assets before any mutation', () => {
    const result = run({ command: 'finalize-draft', initialAssets: [
      { id: 10, name: chromeName },
      { id: 11, name: 'unrelated.zip' },
      { id: 12, name: firefoxName },
    ] });
    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(result.stderr).toContain('unexpected assets');
    expect(result.calls.some(args => args.includes('--method') && ['DELETE', 'POST', 'PATCH'].includes(args[args.indexOf('--method') + 1]))).toBe(false);
    result.cleanup();
  });

  it('requires exactly the two expected assets after upload before succeeding', () => {
    for (const extraFinalAsset of ['unrelated.zip', chromeName]) {
      const result = run({ command: 'finalize-draft', extraFinalAsset });
      expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
      // Both expected ZIPs were uploaded, but verification must fail closed.
      expect(result.calls.filter(args => args.some(value => String(value).startsWith('https://uploads.github.com/')))).toHaveLength(2);
      expect(result.calls.some(args => isReleasePatch(args))).toBe(false);
      expect(result.state.release.draft).toBe(true);
      result.cleanup();
    }
  });

  it('rejects missing or duplicate browser ZIPs before any GitHub mutation', () => {
    for (const options of [{ chrome: false }, { firefox: false }, { duplicateChrome: true }, { duplicateFirefox: true }]) {
      const result = run({ ...options, command: 'finalize-draft' });
      expect(result.status).not.toBe(0);
      expect(result.calls).toEqual([]);
      result.cleanup();
    }
  });

  it('rejects browser ZIPs whose version does not match RELEASE_TAG before any GitHub mutation', () => {
    const result = run({ command: 'finalize-draft', zipVersion: 'v9.0.0' });
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
    result.cleanup();
  });

  it('rejects tag drift, wrong release identity, and already-published releases before upload', () => {
    for (const options of [
      { releaseSha: 'b'.repeat(40) },
      { releaseDraft: false },
      { releaseTagName: 'v9.9.9' },
      { releaseName: 'Wrong Title' },
    ]) {
      const result = run({ ...options, command: 'finalize-draft' });
      expect(result.status).not.toBe(0);
      expect(result.calls.some(args => args.some(value => String(value).startsWith('https://uploads.github.com/')))).toBe(false);
      expect(result.calls.some(isReleasePatch)).toBe(false);
      if (options.releaseName) expect(result.state.release.draft).toBe(true);
      result.cleanup();
    }
  }, 30000);

  it('fails closed on a wrong release title without publishing or mutating the draft', () => {
    const result = run({ command: 'finalize-draft', releaseName: 'Wrong Title' });
    expect(result.status).not.toBe(0);
    expect(result.calls.some(isReleasePatch)).toBe(false);
    expect(result.calls.filter(args => args.some(value => String(value).startsWith('https://uploads.github.com/')))).toHaveLength(0);
    expect(result.state.release.draft).toBe(true);
    result.cleanup();
  });

  it('rejects a malformed draft creation response without exporting anything', () => {
    for (const createResponse of ['invalidId', 'wrongTag', 'notDraft', 'wrongTitle']) {
      const result = run({ createResponse });
      expect(result.status).not.toBe(0);
      expect(result.output).toBe('');
      expect(result.calls.some(isReleasePatch)).toBe(false);
      result.cleanup();
    }
  }, 30000);

  it('lists releases only once when creating a new draft from scratch', () => {
    const result = run();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.calls.filter(args => args[0] === 'api' && args.includes('--paginate') && args.includes('--slurp') && args.includes('repos/owner/repo/releases'))).toHaveLength(1);
    expect(releaseCreate(result.calls)).toEqual(expectedReleaseCreate(result.calls));
    expect(result.output).toBe(`tag=${tag}\nsha=${sha}\nrelease_id=77\n`);
    result.cleanup();
  });

  it('leaves the release draft if either upload fails', () => {
    for (const options of [{ uploadFailure: 'first' }, { uploadFailure: 'second' }]) {
      const result = run({ ...options, command: 'finalize-draft' });
      expect(result.status).not.toBe(0);
      expect(result.calls.some(args => isReleasePatch(args))).toBe(false);
      expect(result.state.release.draft).toBe(true);
      result.cleanup();
    }
  }, 30000);

  it('rechecks the tag ref after uploads and fails if it drifts or becomes unreadable', () => {
    for (const options of [
      { tagShaSequence: [sha, 'b'.repeat(40)] },
      { tagFailOnRead: 2 },
    ]) {
      const result = run({ ...options, command: 'finalize-draft' });
      expect(result.status).not.toBe(0);
      expect(result.calls.filter(args => args.includes(`repos/owner/repo/git/ref/tags/${tag}`) && args.includes('--jq'))).toHaveLength(2);
      expect(result.calls.filter(args => args.some(value => String(value).startsWith('https://uploads.github.com/')))).toHaveLength(2);
      expect(result.calls.some(isReleasePatch)).toBe(false);
      expect(result.state.release.draft).toBe(true);
      result.cleanup();
    }
  }, 30000);

  it('preserves workflow permissions, pinned actions, build/attest/finalize ordering, and development trigger', () => {
    expect(workflow).toMatch(/workflow_dispatch:[\s\S]*?inputs:[\s\S]*?version:[\s\S]*?required:\s*true/);
    expect(workflow).toContain('name: Build and Prepare Official Release Draft');
    expect(workflow).not.toContain('Build and Publish Official Release');
    expect(workflow).toContain('name: Official Release');
    expect(workflow).toContain('run-name: "Translate It! ${{ inputs.version }}"');
    expect(workflow).toMatch(/run-name:\s*"Translate It! \$\{\{ inputs\.version \}\}"/);
    expect(workflow).not.toMatch(/run-name:[^\n]*v\d+\.\d+\.\d+/);
    for (const permission of ['contents: write', 'id-token: write', 'attestations: write']) expect(workflow).toContain(permission);
    for (const pin of [
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      'actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6',
    ]) expect(workflow).toContain(pin);
    const order = [
      'name: Prepare draft release',
      'name: Checkout release commit',
      'name: Verify checked out release commit',
      'pnpm install --frozen-lockfile',
      'pnpm run publish',
      'name: Assert official browser ZIPs',
      'name: Attest release ZIP files',
      'name: Attach and verify Draft release',
    ].map(value => workflow.indexOf(value));
    expect(order.every(index => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(workflow).toContain('env:\n          RELEASE_TAG: ${{ steps.prepare.outputs.tag }}\n        run: |');
    expect(workflow).toContain('Translate-It-${RELEASE_TAG}-for-Chrome.zip');
    expect(workflow).toContain('Translate-It-${RELEASE_TAG}-for-Firefox.zip');
    expect(workflow).toContain('subject-path: |\n            dist/Publish/Translate-It-${{ steps.prepare.outputs.tag }}-for-Chrome.zip\n            dist/Publish/Translate-It-${{ steps.prepare.outputs.tag }}-for-Firefox.zip');
    expect(workflow.trimEnd().endsWith('run: bash scripts/ci/official-release.sh finalize-draft')).toBe(true);
    expect(workflow).not.toContain('translate-it-development-transport');
    expect(workflow).not.toMatch(/PATCH[^\n]*untagged-/);
    expect(developmentWorkflow).toContain('workflow_run:');
    expect(developmentWorkflow).toContain('workflows: [CI]');
    expect(scriptSource).not.toMatch(/gh\s+release\s+(upload|edit)/);
    expect(scriptSource).not.toContain('/releases/tags/');
  });
});
