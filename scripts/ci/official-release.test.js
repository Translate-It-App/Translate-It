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
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const tag = `v${version}`;
const releaseTitle = `Translate It! ${tag}`;
const sha = 'a'.repeat(40);
const chromeName = `Translate-It-${tag}-for-Chrome.zip`;
const firefoxName = `Translate-It-${tag}-for-Firefox.zip`;

function run({ command = 'prepare', releaseTag = tag, releaseId = '77', expectedSha = sha,
  tagExists = false, existingRelease = false, existingReleaseDraft = true, existingReleaseTitle = releaseTag, duplicateRelease = false, createdReleaseId = '77', mainFailure = '', tagFailure = '', listFailure = '',
  checkoutSha = sha, checkoutFailure = false, tagShaSequence = [], tagFailOnRead = 0, zipVersion = tag,
  releaseDraft = true, releaseTagName = tag, releaseSha = sha, releasePrerelease = true,
  initialAssets = [], chrome = true, firefox = true, duplicateChrome = false, duplicateFirefox = false,
  uploadFailure = '', publishFailure = false, finalTitleLie = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'official-release-test-'));
  const publishDir = join(dir, 'publish');
  mkdirSync(publishDir, { recursive: true });
  if (chrome) writeFileSync(join(publishDir, `Translate-It-${zipVersion}-for-Chrome.zip`), 'chrome package');
  if (firefox) writeFileSync(join(publishDir, `Translate-It-${zipVersion}-for-Firefox.zip`), 'firefox package');
  if (duplicateChrome) writeFileSync(join(publishDir, 'Translate-It-v999.0.0-for-Chrome.zip'), 'duplicate chrome');
  if (duplicateFirefox) writeFileSync(join(publishDir, 'Translate-It-v999.0.0-for-Firefox.zip'), 'duplicate firefox');

  const callsFile = join(dir, 'calls.jsonl');
  const outputFile = join(dir, 'github-output');
  const stateFile = join(dir, 'state.json');
  writeFileSync(callsFile, '');
  writeFileSync(outputFile, '');
  const releaseCandidate = { id: 66, tag_name: releaseTag, name: existingReleaseTitle, body: '', draft: existingReleaseDraft };
  const releases = existingRelease ? [releaseCandidate, ...(duplicateRelease ? [{ ...releaseCandidate, id: 67 }] : [])] : [];
  const state = {
    tagExists,
    refSha: releaseSha,
    refShaSequence: tagShaSequence,
    refReadCount: 0,
    mainSha: sha,
    release: { id: Number(releaseId), tag_name: releaseTagName, draft: releaseDraft, prerelease: releasePrerelease, name: releaseTagName, body: 'release notes' },
    releases,
    assets: initialAssets,
    nextAssetId: 100,
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
if (args[0] === 'release' && args[1] === 'create') {
  const releaseTag = args[2];
  const title = args[args.indexOf('--title') + 1];
  const notes = args[args.indexOf('--notes') + 1];
  state.release = { id: Number(process.env.MOCK_CREATED_RELEASE_ID), tag_name: releaseTag, name: title, body: notes, draft: args.includes('--draft'), prerelease: true, created: true };
  save(); process.stdout.write('draft created'); process.exit(0);
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
  process.stdout.write(JSON.stringify(state.assets)); process.exit(0);
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
    MOCK_TAG: releaseTag,
    MOCK_RELEASE_ID: releaseId,
    MOCK_CREATED_RELEASE_ID: createdReleaseId,
    MOCK_MAIN_FAILURE: mainFailure,
    MOCK_TAG_FAILURE: tagFailure,
    MOCK_LIST_FAILURE: listFailure,
    MOCK_UPLOAD_FAILURE: uploadFailure,
    MOCK_PUBLISH_FAILURE: publishFailure ? '1' : '',
    MOCK_FINAL_TITLE_LIE: finalTitleLie ? '1' : '',
    MOCK_CHECKOUT_SHA: checkoutSha,
    MOCK_GIT_FAILURE: checkoutFailure ? '1' : '',
    MOCK_REF_FAIL_ON_READ: String(tagFailOnRead),
  };
  env.MOCK_REF_SHA_SEQUENCE = tagShaSequence.join(',');
  const result = spawnSync('bash', [script, command], { cwd: root, env, encoding: 'utf8' });
  const calls = readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    calls,
    state: JSON.parse(readFileSync(stateFile, 'utf8')),
    output: readFileSync(outputFile, 'utf8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const isReleasePatch = args => args[0] === 'api' && args.includes('--method') && args.includes('PATCH') && args.includes('repos/owner/repo/releases/77');
const releaseCreate = calls => calls.find(args => args[0] === 'release' && args[1] === 'create');
const mutations = calls => calls.filter(args => args[0] === 'release' && args[1] === 'create'
  || args[0] === 'api' && args.includes('--method') && ['POST', 'PATCH', 'DELETE'].includes(args[args.indexOf('--method') + 1]));

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
    expect(releaseCreate(result.calls)).toEqual(['release', 'create', tag, '--draft', '--title', releaseTitle, '--target', sha, '--notes', `Official release ${tag}.`]);
    expect(result.output).toBe(`tag=${tag}\nsha=${sha}\nrelease_id=66\n`);
    result.cleanup();
  });

  it('reuses a matching existing draft when both tag and release already exist', () => {
    const result = run({ tagExists: true, existingRelease: true, existingReleaseTitle: releaseTitle });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.output).toBe(`tag=${tag}\nsha=${sha}\nrelease_id=66\n`);
    expect(releaseCreate(result.calls)).toBeUndefined();
    expect(result.calls.some(args => args.includes('repos/owner/repo/git/refs') && args.includes('POST'))).toBe(false);
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
    expect(releaseCreate(result.calls)).toEqual(['release', 'create', tag, '--draft', '--title', releaseTitle, '--target', sha, '--notes', `Official release ${tag}.`]);
    expect(result.state.release.name).toBe(releaseTitle);
    expect(result.output).toBe(`tag=${tag}\nsha=${sha}\nrelease_id=77\n`);
    expect(result.calls.some(isReleasePatch)).toBe(false);
    result.cleanup();
  });

  it('finalizes by uploading release-ID assets and publishes only after verification', () => {
    const result = run({ command: 'finalize', initialAssets: [
      { id: 10, name: chromeName },
      { id: 11, name: 'unrelated.zip' },
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
    const publish = result.calls.findIndex(args => isReleasePatch(args));
    expect(result.calls).toContainEqual(['api', '--method', 'DELETE', 'repos/owner/repo/releases/assets/10']);
    expect(result.calls).toContainEqual(['api', '--method', 'DELETE', 'repos/owner/repo/releases/assets/12']);
    expect(result.calls.some(args => args.includes('repos/owner/repo/releases/assets/11') && args.includes('--method') && args.includes('DELETE'))).toBe(false);
    for (const [assetId, name] of [[10, chromeName], [12, firefoxName]]) {
      const remove = result.calls.findIndex(args => args.includes(`repos/owner/repo/releases/assets/${assetId}`) && args.includes('DELETE'));
      const upload = uploads.find(({ args }) => args.some(value => String(value).endsWith(`?name=${name}`))).index;
      expect(upload).toBeGreaterThan(remove);
    }
    const draftRecheck = result.calls.map((args, index) => ({ args, index }))
      .filter(({ args, index }) => index < publish && args[0] === 'api' && args[1] === 'repos/owner/repo/releases/77' && !args.includes('--method'))
      .at(-1).index;
    expect(publish).toBeGreaterThan(lastUpload);
    expect(publish).toBeGreaterThan(draftRecheck);
    expect(result.calls[publish]).toEqual(['api', '--method', 'PATCH', 'repos/owner/repo/releases/77', '-f', `name=${releaseTitle}`, '-F', 'prerelease=false', '-f', 'make_latest=true', '-F', 'draft=false']);
    expect(result.calls.filter(args => args[0] === 'api' && args[1] === 'repos/owner/repo/releases/77' && !args.includes('--method'))).toHaveLength(2);
    expect(result.state.release).toMatchObject({ id: 77, tag_name: tag, draft: false, prerelease: false, name: releaseTitle });
    expect(result.state.assets.map(asset => asset.name)).toEqual(['unrelated.zip', chromeName, firefoxName]);
    expect(result.calls.some(args => args[0] === 'release' && ['upload', 'edit'].includes(args[1]))).toBe(false);
    expect(result.calls.some(args => args.some(value => String(value).includes('/releases/tags/')))).toBe(false);
    result.cleanup();
  });

  it('rejects missing or duplicate browser ZIPs before any GitHub mutation', () => {
    for (const options of [{ chrome: false }, { firefox: false }, { duplicateChrome: true }, { duplicateFirefox: true }]) {
      const result = run({ ...options, command: 'finalize' });
      expect(result.status).not.toBe(0);
      expect(result.calls).toEqual([]);
      result.cleanup();
    }
  });

  it('rejects browser ZIPs whose version does not match RELEASE_TAG before any GitHub mutation', () => {
    const result = run({ command: 'finalize', zipVersion: 'v9.0.0' });
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
    result.cleanup();
  });

  it('rejects tag drift, wrong release identity, and already-published releases before upload', () => {
    for (const options of [
      { releaseSha: 'b'.repeat(40) },
      { releaseDraft: false },
      { releaseTagName: 'v9.9.9' },
    ]) {
      const result = run({ ...options, command: 'finalize' });
      expect(result.status).not.toBe(0);
      expect(result.calls.some(args => args.some(value => String(value).startsWith('https://uploads.github.com/')))).toBe(false);
      expect(result.calls.some(isReleasePatch)).toBe(false);
      result.cleanup();
    }
  }, 30000);

  it('leaves the release draft if either upload fails', () => {
    for (const options of [{ uploadFailure: 'first' }, { uploadFailure: 'second' }]) {
      const result = run({ ...options, command: 'finalize' });
      expect(result.status).not.toBe(0);
      expect(result.calls.some(args => isReleasePatch(args))).toBe(false);
      expect(result.state.release.draft).toBe(true);
      result.cleanup();
    }
  }, 30000);

  it('treats a failed publish PATCH as ambiguous and requires manual inspection', () => {
    const result = run({ command: 'finalize', publishFailure: true });
    expect(result.status).not.toBe(0);
    expect(result.calls.some(args => isReleasePatch(args))).toBe(true);
    expect(result.stderr).toContain('publication may already have succeeded');
    expect(result.stderr).toContain('manual inspection');
    expect(result.stderr).not.toContain('it remains a draft');
    result.cleanup();
  }, 30000);

  it('fails final verification when GitHub persists the wrong release title', () => {
    const result = run({ command: 'finalize', finalTitleLie: true });
    expect(result.status).not.toBe(0);
    expect(result.calls.some(isReleasePatch)).toBe(true);
    expect(result.state.release.draft).toBe(false);
    expect(result.stderr).toContain('publication may already have succeeded and manual inspection is required');
    expect(result.calls.filter(args => args[0] === 'api' && args[1] === 'repos/owner/repo/releases/77' && !args.includes('--method')).length).toBe(2);
    result.cleanup();
  });

  it('rechecks the tag ref after uploads and refuses to publish if it drifts or becomes unreadable', () => {
    for (const options of [
      { tagShaSequence: [sha, 'b'.repeat(40)] },
      { tagFailOnRead: 2 },
    ]) {
      const result = run({ ...options, command: 'finalize' });
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
      'name: Finalize and publish release',
    ].map(value => workflow.indexOf(value));
    expect(order.every(index => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(workflow).toContain('env:\n          RELEASE_TAG: ${{ steps.prepare.outputs.tag }}\n        run: |');
    expect(workflow).toContain('Translate-It-${RELEASE_TAG}-for-Chrome.zip');
    expect(workflow).toContain('Translate-It-${RELEASE_TAG}-for-Firefox.zip');
    expect(workflow).toContain('subject-path: |\n            dist/Publish/Translate-It-${{ steps.prepare.outputs.tag }}-for-Chrome.zip\n            dist/Publish/Translate-It-${{ steps.prepare.outputs.tag }}-for-Firefox.zip');
    expect(workflow.trimEnd().endsWith('run: bash scripts/ci/official-release.sh finalize')).toBe(true);
    expect(workflow).not.toContain('translate-it-development-transport');
    expect(workflow).not.toMatch(/PATCH[^\n]*untagged-/);
    expect(developmentWorkflow).toContain('workflow_run:');
    expect(developmentWorkflow).toContain('workflows: [CI]');
    expect(scriptSource).not.toMatch(/gh\s+release\s+(upload|edit)/);
    expect(scriptSource).not.toContain('/releases/tags/');
  });
});
