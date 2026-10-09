import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBashEnvPreload, resolveGit } from './test-helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'preflight.sh');
const realGit = resolveGit();
const row = (filename, status, previous = '') => `${filename}\t${status}\t${previous}`;
const identity = {
  GIT_AUTHOR_NAME: 'CI Test',
  GIT_AUTHOR_EMAIL: 'ci@example.test',
  GIT_COMMITTER_NAME: 'CI Test',
  GIT_COMMITTER_EMAIL: 'ci@example.test',
};
const git = (cwd, ...args) => execFileSync(realGit, args, { cwd, stdio: 'pipe', env: { ...process.env, ...identity } }).toString().trim();

function setup(dir, { change, merge = false, diverged = false, shallow = false } = {}) {
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'docs'));
  writeFileSync(join(repo, 'docs/Changelog.md'), 'current\n');
  writeFileSync(join(repo, 'src.js'), 'x\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  let before = git(repo, 'rev-parse', 'HEAD');
  if (diverged) {
    git(repo, 'checkout', '-qb', 'diverged');
    writeFileSync(join(repo, 'diverged.js'), 'diverged\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'diverged before');
    before = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
  }
  if (merge) {
    git(repo, 'checkout', '-qb', 'side');
    writeFileSync(join(repo, 'docs/side.md'), 'side\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'side');
    git(repo, 'checkout', '-q', 'main');
    writeFileSync(join(repo, 'docs/main.md'), 'main\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'main change');
    git(repo, 'merge', '--no-ff', '-qm', 'merge side', 'side');
  } else {
    change?.(repo);
    git(repo, 'add', '-A');
    git(repo, 'commit', '--allow-empty', '-qm', 'change');
  }
  const after = git(repo, 'rev-parse', 'HEAD');
  const origin = join(dir, 'origin.git');
  execFileSync(realGit, ['init', '--bare', '-q', '-b', 'main', origin], { env: { ...process.env, ...identity } });
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '--all', 'origin');
  if (shallow) {
    const checkout = join(dir, 'shallow-checkout');
    execFileSync(realGit, ['clone', '-q', '--depth=1', `file://${origin}`, checkout], { env: { ...process.env, ...identity } });
    return { repo: checkout, before, after };
  }
  return { repo, before, after };
}

function addWrappers(dir, { failGit = '', logGit = false, countFail = false, filesFail = false, fakeDiffStatus = '' } = {}) {
  const callLog = join(dir, 'gh-calls.log');
  const gitLog = join(dir, 'git-calls.log');
  writeFileSync(join(dir, 'gh'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${callLog}'\nif [[ "$*" == *"/files"* ]]; then ${filesFail ? 'exit 1' : 'printf \'%s\' "$GH_MOCK_FILES"'}; else ${countFail ? 'exit 1' : 'printf \'%s\' "$GH_MOCK_COUNT"'}; fi\n`, { mode: 0o755 });
  // The git wrapper only exists to log calls, force failures, or fake diff
  // output. When none of those are needed, `git` resolves to the real
  // executable directly, avoiding an extra shell process per invocation.
  if (logGit || failGit || fakeDiffStatus) {
    writeFileSync(join(dir, 'git'), `#!/usr/bin/env bash\n${logGit ? `printf '%s\\n' "$*" >> '${gitLog}'` : ''}\nif [ -n '${failGit}' ] && [[ "$*" == *'${failGit}'* ]]; then exit 1; fi\n${fakeDiffStatus ? `if [ "$1" = diff ]; then printf '${fakeDiffStatus}'; exit 0; fi` : ''}\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  }
  return { callLog, gitLog };
}

function run({ event = 'pull_request', files = '', count, before, after, forced = 'false', omitForced = false, repo, failGit = '', logGit = false, countFail = false, filesFail = false, fakeDiffStatus = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-test-'));
  try {
    const outputFile = join(dir, 'github-output');
    const { callLog, gitLog } = addWrappers(dir, { failGit, logGit, countFail, filesFail, fakeDiffStatus });
    const env = {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH}`,
      GITHUB_EVENT_NAME: event,
      GITHUB_REPOSITORY: 'owner/repo',
      PR_NUMBER: '123',
      GH_TOKEN: 'fake-token',
      GITHUB_OUTPUT: outputFile,
      GH_MOCK_COUNT: count ?? String(files ? files.split('\n').length : 1),
      GH_MOCK_FILES: files,
      BEFORE_SHA: before ?? '',
      AFTER_SHA: after ?? '',
      FORCED_PUSH: forced,
    };
    if (omitForced) delete env.FORCED_PUSH;
    let status = 0;
    let stdout = '';
    try {
      stdout = execFileSync('bash', [SCRIPT], { env: createBashEnvPreload(dir, env), cwd: repo, encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      if (typeof err.status !== 'number') throw err;
      status = err.status;
      stdout = err.stdout?.toString() ?? '';
    }
    return {
      status,
      output: existsSync(outputFile) ? readFileSync(outputFile, 'utf8') : '',
      calls: existsSync(callLog) ? readFileSync(callLog, 'utf8') : '',
      gitCalls: existsSync(gitLog) ? readFileSync(gitLog, 'utf8') : '',
      stdout,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runPush(changeOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-push-'));
  try {
    const { repo, before, after } = setup(dir, changeOptions);
    const result = run({ event: 'push', before, after, repo, ...changeOptions.run });
    return { ...result, before, after };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectDecision(result, runFull) {
  expect(result.status).toBe(0);
  expect(result.output).toContain(`run_full=${runFull}`);
}

describe('ci preflight decision script', () => {
  it('PR code-only, docs-only, mixed, and unknown paths retain classification', () => {
    expectDecision(run({ files: row('src/background.js', 'modified') }), 'true');
    expectDecision(run({ files: [row('docs/a.md', 'modified'), row('openspec/x.md', 'added')].join('\n') }), 'false');
    expectDecision(run({ files: [row('docs/a.md', 'modified'), row('docs/b.md', 'added')].join('\n') }), 'false');
    expectDecision(run({ files: [row('docs/a.md', 'modified'), row('src/x.js', 'modified')].join('\n') }), 'true');
    expectDecision(run({ files: row('newtool/config.yml', 'added') }), 'true');
  }, 30000);

  it('PR Changelog edit skips while deletion and rename fail', () => {
    expectDecision(run({ files: row('docs/Changelog.md', 'modified') }), 'false');
    for (const files of [row('docs/Changelog.md', 'removed'), row('docs/History.md', 'renamed', 'docs/Changelog.md')]) {
      const result = run({ files });
      expect(result.status).toBe(1);
      expect(result.output).not.toContain('run_full=');
    }
  }, 30000);

  it('PR rename policy and API count/failure fallbacks remain intact', () => {
    expectDecision(run({ files: row('docs/foo.js', 'renamed', 'src/foo.js') }), 'true');
    expectDecision(run({ files: row('docs/b.md', 'renamed', 'docs/a.md') }), 'false');
    const tooMany = run({ count: '3001', files: row('docs/a.md', 'modified') });
    expectDecision(tooMany, 'true');
    expect(tooMany.calls).not.toContain('/files');
    expectDecision(run({ count: 'null', files: row('docs/a.md', 'modified') }), 'true');
    expectDecision(run({ count: '2', files: row('docs/a.md', 'modified') }), 'true');
    expectDecision(run({ files: row('docs/History.md', 'renamed') }), 'true');
    expectDecision(run({ files: row('docs/a.md', 'mystery') }), 'true');
  }, 30000);

  it('PR API failures default full; dispatch uses neither API nor git', () => {
    expectDecision(run({ count: '' }), 'true');
    expectDecision(run({ countFail: true }), 'true');
    expectDecision(run({ filesFail: true, files: row('docs/a.md', 'modified') }), 'true');
    const dispatch = run({ event: 'workflow_dispatch', logGit: true });
    expectDecision(dispatch, 'true');
    expect(dispatch.calls).toBe('');
    expect(dispatch.gitCalls).toBe('');
  }, 30000);

  it('push documentation-only history skips full CI', () => {
    expectDecision(runPush({ shallow: true, change: repo => {
      writeFileSync(join(repo, 'docs/update.md'), 'x\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'first docs change');
      writeFileSync(join(repo, 'docs/another.md'), 'y\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'second docs change');
    } }), 'false');
  }, 30000);

  it('push code changes run full CI', () => {
    expectDecision(runPush({ change: repo => writeFileSync(join(repo, 'src2.js'), 'x\n') }), 'true');
  }, 30000);

  it('push mixed documentation and code changes run full CI', () => {
    expectDecision(runPush({ change: repo => { writeFileSync(join(repo, 'docs/update.md'), 'x\n'); writeFileSync(join(repo, 'src2.js'), 'x\n'); } }), 'true');
  }, 30000);

  it('push unknown paths run full CI', () => {
    expectDecision(runPush({ change: repo => writeFileSync(join(repo, 'other.cfg'), 'x\n') }), 'true');
  }, 30000);

  it('push Changelog deletion fails', () => {
    const deleted = runPush({ change: repo => rmSync(join(repo, 'docs/Changelog.md')) });
    expect(deleted.status).toBe(1);
  }, 30000);

  it('push Changelog rename fails', () => {
    const renamed = runPush({ change: repo => git(repo, 'mv', 'docs/Changelog.md', 'docs/History.md') });
    expect(renamed.status).toBe(1);
  }, 30000);

  it('push other documentation changes run when forced', () => {
    expectDecision(runPush({ change: repo => writeFileSync(join(repo, 'docs/update.md'), 'x\n'), run: { forced: 'true' } }), 'true');
  }, 30000);

  it('forced push with deleted Changelog fails without a decision', () => {
    const change = repo => rmSync(join(repo, 'docs/Changelog.md'));
    const forcedGone = runPush({ change, run: { forced: 'true' } });
    expect(forcedGone.status).toBe(1);
    expect(forcedGone.output).not.toContain('run_full=');
  }, 30000);

  it('forced push with renamed Changelog fails without a decision', () => {
    const change = repo => git(repo, 'mv', 'docs/Changelog.md', 'docs/History.md');
    const forcedGone = runPush({ change, run: { forced: 'true' } });
    expect(forcedGone.status).toBe(1);
    expect(forcedGone.output).not.toContain('run_full=');
  }, 30000);

  it('push code-to-docs renames classify both paths', () => {
    expectDecision(runPush({ change: repo => git(repo, 'mv', 'src.js', 'docs/src.js') }), 'true');
  }, 30000);

  it('push documentation renames skip', () => {
    expectDecision(runPush({ change: repo => { writeFileSync(join(repo, 'docs/old.md'), 'x\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'add doc'); git(repo, 'mv', 'docs/old.md', 'docs/new.md'); } }), 'false');
  }, 30000);

  it('shallow forced push with unavailable before runs full for documentation changes', () => {
    const base = { shallow: true, run: { forced: 'true', before: 'a'.repeat(40) } };
    expectDecision(runPush({ ...base, change: repo => writeFileSync(join(repo, 'docs/update.md'), 'x\n') }), 'true');
  }, 30000);

  it('shallow forced push with unavailable before rejects Changelog deletion', () => {
    const base = { shallow: true, run: { forced: 'true', before: 'a'.repeat(40) } };
    const gone = runPush({ ...base, change: repo => rmSync(join(repo, 'docs/Changelog.md')) });
    expect(gone.status).toBe(1);
    expect(gone.output).not.toContain('run_full=');
  }, 30000);

  it('shallow forced push with unavailable before rejects Changelog rename', () => {
    const base = { shallow: true, run: { forced: 'true', before: 'a'.repeat(40) } };
    const gone = runPush({ ...base, change: repo => git(repo, 'mv', 'docs/Changelog.md', 'docs/History.md') });
    expect(gone.status).toBe(1);
    expect(gone.output).not.toContain('run_full=');
  }, 30000);

  it('zero before SHA never skips the Changelog check', () => {
    const gone = runPush({ change: repo => rmSync(join(repo, 'docs/Changelog.md')), run: { before: '0'.repeat(40) } });
    expect(gone.status).toBe(1);
    expect(gone.output).not.toContain('run_full=');
  }, 30000);

  it('invalid before SHA never skips the Changelog check', () => {
    const gone = runPush({ change: repo => rmSync(join(repo, 'docs/Changelog.md')), run: { before: 'not-a-sha' } });
    expect(gone.status).toBe(1);
    expect(gone.output).not.toContain('run_full=');
  }, 30000);

  it('failed fetch never skips the Changelog check', () => {
    const gone = runPush({ change: repo => rmSync(join(repo, 'docs/Changelog.md')), run: { failGit: 'fetch' } });
    expect(gone.status).toBe(1);
    expect(gone.output).not.toContain('run_full=');
  }, 30000);

  it('push accepts merge commits', () => {
    expectDecision(runPush({ merge: true, shallow: true }), 'false');
  }, 30000);

  it('push with zero before SHA defaults to full', () => {
    const zero = runPush({ run: { before: '0'.repeat(40) } });
    expectDecision(zero, 'true');
  }, 30000);

  it('push with invalid before SHA defaults to full', () => {
    const invalid = runPush({ run: { before: 'not-a-sha' } });
    expectDecision(invalid, 'true');
  }, 30000);

  it('push with failed fetch defaults to full', () => {
    const fetchFail = runPush({ run: { failGit: 'fetch' } });
    expectDecision(fetchFail, 'true');
  }, 30000);

  it('push with failed diff defaults to full', () => {
    const diffFail = runPush({ run: { failGit: 'diff' } });
    expectDecision(diffFail, 'true');
  }, 30000);

  it('push with unknown diff status defaults to full', () => {
    const unknownStatus = runPush({ run: { fakeDiffStatus: 'Q\\0docs/unknown.md\\0' } });
    expectDecision(unknownStatus, 'true');
  }, 30000);

  it('push does not call GitHub API', () => {
    const normal = runPush({ change: repo => writeFileSync(join(repo, 'docs/a.md'), 'a\n'), run: { logGit: true } });
    expect(normal.calls).toBe('');
    expect(normal.gitCalls).toContain('fetch --no-tags --depth=64');
  }, 30000);

  it('forced push defaults to full', () => {
    expectDecision(runPush({ run: { forced: 'true' } }), 'true');
  }, 30000);

  it('push with missing forced status defaults to full', () => {
    expectDecision(runPush({ run: { omitForced: true } }), 'true');
  }, 30000);

  it('push with unknown forced status defaults to full', () => {
    expectDecision(runPush({ run: { forced: 'unknown' } }), 'true');
  }, 30000);

  it('push with non-ancestor history defaults to full', () => {
    expectDecision(runPush({ diverged: true, run: { forced: 'false' } }), 'true');
  }, 30000);

  it('push with unavailable before history defaults to full', () => {
    const invalid = runPush({ run: { before: 'f'.repeat(40) } });
    expectDecision(invalid, 'true');
  }, 30000);

  it('push with zero after SHA defaults to full', () => {
    const afterZero = runPush({ run: { after: '0'.repeat(40) } });
    expectDecision(afterZero, 'true');
  }, 30000);
});
