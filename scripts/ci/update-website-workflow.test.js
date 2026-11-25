import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBashEnvPreload } from './test-helpers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = readFileSync(join(root, '.github/workflows/update-website.yml'), 'utf8').replace(/\r\n?/g, '\n');
const shellMatch = workflow.match(/        run: \|\n([\s\S]*)$/);
const workflowScript = shellMatch?.[1].split('\n').map(line => line ? line.slice(10) : '').join('\n');

function runDeploy({ secret = 'https://secret.example/deploy', curlFailure = false, httpStatus = '202' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'update-website-workflow-test-'));
  const curl = join(dir, 'curl');
  const callsFile = join(dir, 'calls.jsonl');
  writeFileSync(curl, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
appendFileSync(process.env.MOCK_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.MOCK_CURL_FAILURE === 'true') process.exit(7);
process.stdout.write(process.env.MOCK_HTTP_STATUS);
`);
  chmodSync(curl, 0o755);

  try {
    const result = spawnSync('bash', ['-c', workflowScript], {
      cwd: dir,
      encoding: 'utf8',
      env: createBashEnvPreload(dir, {
        ...process.env,
        PATH: `${dir}${delimiter}${process.env.PATH}`,
        DEPLOY_HOOK_URL: secret,
        MOCK_CALLS: callsFile,
        MOCK_CURL_FAILURE: String(curlFailure),
        MOCK_HTTP_STATUS: httpStatus,
      }),
    });
    if (result.error) throw result.error;
    return {
      ...result,
      calls: existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('website metadata deployment workflow', () => {
  it('runs only for published stable releases, excluding development', () => {
    expect(workflow).toContain('release:\n    types: [published]');
    expect(workflow).toContain("github.event.release.prerelease == false && github.event.release.tag_name != 'development'");
    expect(workflow).toContain('contents: read');
  });

  it('uses the deploy hook secret without logging its URL and fails for unsuccessful responses', () => {
    expect(shellMatch).not.toBeNull();
    expect(workflow).toContain('DEPLOY_HOOK_URL: ${{ secrets.CLOUDFLARE_DEPLOY_HOOK }}');
    expect(workflow).toContain('curl --request POST');
    expect(workflow).toContain("--output /dev/null --write-out '%{http_code}'");
    expect(workflow).toContain('if [[ ! "$http_status" =~ ^2[0-9]{2}$ ]]');
    expect(workflow).not.toContain('echo "$DEPLOY_HOOK_URL"');
    expect(workflow).not.toContain('printf "$DEPLOY_HOOK_URL"');
  });

  it('fails without the secret before invoking curl', () => {
    const result = runDeploy({ secret: '' });
    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(result.calls).toHaveLength(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain('https://secret.example/deploy');
  });

  it('fails on network errors without exposing the secret URL', () => {
    const result = runDeploy({ curlFailure: true });
    expect(result.status).not.toBe(0);
    expect(result.calls).toHaveLength(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain('https://secret.example/deploy');
    expect(result.stderr).toContain('request failed before receiving an HTTP response');
  });

  it('fails on non-2xx responses without exposing the secret URL', () => {
    const result = runDeploy({ httpStatus: '503' });
    expect(result.status).not.toBe(0);
    expect(result.calls).toHaveLength(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain('https://secret.example/deploy');
    expect(result.stderr).toContain('returned HTTP 503');
  });

  it('accepts successful 2xx responses without exposing the secret URL', () => {
    const result = runDeploy({ httpStatus: '202' });
    expect(result.status).toBe(0);
    expect(result.calls).toHaveLength(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain('https://secret.example/deploy');
    expect(result.stdout).toContain('accepted the request (HTTP 202)');
  });
});
