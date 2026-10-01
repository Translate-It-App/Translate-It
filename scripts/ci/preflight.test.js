import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'preflight.sh');

const row = (filename, status, previous = '') => `${filename}\t${status}\t${previous}`;

function makeGhMock(dir, { count = '1', countFail = false, files = '', filesFail = false } = {}) {
  const log = join(dir, 'gh-calls.log');
  writeFileSync(
    join(dir, 'gh'),
    `#!/usr/bin/env bash
echo "$@" >> ${log}
if [[ "$*" == *"/files"* ]]; then
  if [ "${filesFail ? '1' : ''}" = "1" ]; then echo "mock files API failure" >&2; exit 1; fi
  printf '%s' "$GH_MOCK_FILES"
else
  if [ "${countFail ? '1' : ''}" = "1" ]; then echo "mock count API failure" >&2; exit 1; fi
  printf '%s' "$GH_MOCK_COUNT"
fi
`,
    { mode: 0o755 }
  );
  return log;
}

function runPreflight({ event = 'pull_request', count = '1', files = '', countFail = false, filesFail = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-test-'));
  const outputFile = join(dir, 'github-output');
  const callLog = makeGhMock(dir, { countFail, filesFail });
  const env = {
    ...process.env,
    PATH: `${dir}${delimiter}${process.env.PATH}`,
    GITHUB_EVENT_NAME: event,
    GITHUB_REPOSITORY: 'owner/repo',
    PR_NUMBER: '123',
    GH_TOKEN: 'fake-token',
    GITHUB_OUTPUT: outputFile,
    GH_MOCK_COUNT: count,
    GH_MOCK_FILES: files,
  };
  let status = 0;
  try {
    execFileSync('bash', [SCRIPT], { env, encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    status = err.status ?? 1;
  }
  const output = existsSync(outputFile) ? readFileSync(outputFile, 'utf8') : '';
  const calls = existsSync(callLog) ? readFileSync(callLog, 'utf8') : '';
  rmSync(dir, { recursive: true, force: true });
  return { status, output, calls };
}

function expectDecision(result, runFull) {
  expect(result.status).toBe(0);
  expect(result.output).toContain(`run_full=${runFull}`);
}

describe('ci preflight decision script', () => {
  let savedEnv;
  beforeEach(() => {
    savedEnv = { ...process.env };
  });
  afterEach(() => {
    process.env = savedEnv;
  });

  it('code-only change => full CI', () => {
    expectDecision(runPreflight({ files: row('src/background.js', 'modified') }), 'true');
  });

  it('docs-only change => skip', () => {
    const files = [row('docs/guides/foo.md', 'modified'), row('openspec/specs/x.md', 'added')].join('\n');
    expectDecision(runPreflight({ files }), 'false');
  });

  it('mixed docs + code => full CI', () => {
    const files = [row('docs/a.md', 'modified'), row('src/x.js', 'modified')].join('\n');
    expectDecision(runPreflight({ files }), 'true');
  });

  it('unknown path => full CI', () => {
    expectDecision(runPreflight({ files: row('newtool/config.yml', 'added') }), 'true');
  });

  it('Changelog content edit => skip', () => {
    expectDecision(runPreflight({ files: row('docs/Changelog.md', 'modified') }), 'false');
  });

  it('Changelog deletion => preflight failure', () => {
    const result = runPreflight({ files: row('docs/Changelog.md', 'removed') });
    expect(result.status).toBe(1);
    expect(result.output).not.toContain('run_full=');
  });

  it('Changelog rename => preflight failure', () => {
    const result = runPreflight({ files: row('docs/History.md', 'renamed', 'docs/Changelog.md') });
    expect(result.status).toBe(1);
    expect(result.output).not.toContain('run_full=');
  });

  it('code path renamed into docs => full CI', () => {
    expectDecision(runPreflight({ files: row('docs/foo.js', 'renamed', 'src/foo.js') }), 'true');
  });

  it('docs-to-docs rename => skip', () => {
    expectDecision(runPreflight({ files: row('docs/b.md', 'renamed', 'docs/a.md') }), 'false');
  });

  it('>3000 changed files => full CI without classifying', () => {
    const files = row('docs/a.md', 'modified');
    const result = runPreflight({ count: '3001', files });
    expectDecision(result, 'true');
    expect(result.calls).not.toContain('/files');
  });

  it('malformed/empty changed-file count => full CI', () => {
    expectDecision(runPreflight({ count: '', files: row('docs/a.md', 'modified') }), 'true');
    expectDecision(runPreflight({ count: 'null', files: row('docs/a.md', 'modified') }), 'true');
  });

  it('first GitHub API request failure => full CI with success exit', () => {
    const result = runPreflight({ countFail: true, files: row('docs/a.md', 'modified') });
    expectDecision(result, 'true');
  });

  it('file-list API request failure => full CI with success exit', () => {
    const result = runPreflight({ filesFail: true, files: row('docs/a.md', 'modified') });
    expectDecision(result, 'true');
  });

  it('workflow_dispatch => full CI without API access', () => {
    const result = runPreflight({ event: 'workflow_dispatch' });
    expectDecision(result, 'true');
    expect(result.calls).toBe('');
  });
});
