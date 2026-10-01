import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = readFileSync(join(root, '.github/workflows/development-release.yml'), 'utf8');
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
const qualify = workflow.slice(workflow.indexOf('  qualify:'), workflow.indexOf('\n  publish:'));
const publish = workflow.slice(workflow.indexOf('  publish:'));
const artifactStep = qualify.slice(qualify.indexOf('      - name: Find exact run artifact'));
const shellMatch = artifactStep.match(/        run: \|\n([\s\S]*)$/);
const artifactScript = shellMatch?.[1].split('\n').map(line => line ? line.slice(10) : '').join('\n');

function runQualification({ ids = '', apiFailure = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'development-workflow-test-'));
  const gh = join(dir, 'gh');
  const callsFile = join(dir, 'calls.jsonl');
  const outputFile = join(dir, 'output');
  writeFileSync(gh, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_CALLS, JSON.stringify(args) + '\\n');
if (process.env.MOCK_API_FAILURE === 'true') process.exit(1);
process.stdout.write(process.env.MOCK_ARTIFACT_IDS);
`);
  chmodSync(gh, 0o755);

  try {
    const result = spawnSync('bash', ['-c', artifactScript], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}${delimiter}${process.env.PATH}`,
        SOURCE_RUN_ID: '123',
        SOURCE_RUN_ATTEMPT: '2',
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_OUTPUT: outputFile,
        MOCK_CALLS: callsFile,
        MOCK_ARTIFACT_IDS: ids,
        MOCK_API_FAILURE: String(apiFailure),
      },
    });
    return {
      ...result,
      output: existsSync(outputFile) ? readFileSync(outputFile, 'utf8') : '',
      calls: readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('development workflow qualification', () => {
  it('gates only successful same-repository main pushes and scopes publish permissions/concurrency', () => {
    expect(workflow).toContain('workflows: [CI]');
    expect(workflow).toContain('types: [completed]');
    expect(qualify).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(qualify).toContain("github.event.workflow_run.event == 'push'");
    expect(qualify).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(qualify).toContain('github.event.workflow_run.head_repository.full_name == github.repository');
    expect(publish).toContain('needs: qualify');
    expect(publish).toContain("if: needs.qualify.outputs.available == 'true'");
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(qualify).toContain('permissions:\n      actions: read');
    expect(publish).toContain('permissions:\n      actions: read\n      contents: write');
    expect(publish).toContain('group: ci-development-release\n      queue: max');
    expect(publish).not.toContain('cancel-in-progress: true');
  });

  it('downloads the exact artifact from the triggering run and attempt', () => {
    expect(publish).toContain('name: translate-it-development-transport-${{ github.event.workflow_run.id }}-${{ github.event.workflow_run.run_attempt }}');
    expect(publish).toContain('run-id: ${{ github.event.workflow_run.id }}');
    expect(publish).toContain('github-token: ${{ github.token }}');
    expect(publish).toContain('repository: ${{ github.repository }}');
    expect(publish).toContain('path: ${{ runner.temp }}/development-artifacts');
    expect(publish).toContain('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
    expect(publish).toContain('actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c');
  });

  it('keeps CI transport main-only, one-day, and cancellable by ref', () => {
    expect(ci).toContain('group: ci-${{ github.ref }}\n  cancel-in-progress: true');
    expect(ci).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(ci).toContain('name: translate-it-development-transport-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(ci).toContain('retention-days: 1');
    expect(ci).toContain('dist/Publish/Translate-It-v*-for-Chrome.zip\n            dist/Publish/Translate-It-v*-for-Firefox.zip');
  });

  it('runs the workflow artifact qualification shell and accepts exactly one matching artifact', () => {
    expect(shellMatch).not.toBeNull();
    const result = runQualification({ ids: '5678' });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.output).toBe('available=true\n');
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toContain('repos/owner/repo/actions/runs/123/artifacts?per_page=100');
    expect(result.calls[0]).toContain('--paginate');
    expect(result.calls[0].join(' ')).not.toContain('latest');
  });

  it('marks an absent artifact unavailable and fails closed on duplicates or API errors', () => {
    const absent = runQualification();
    expect(absent.status).toBe(0);
    expect(absent.output).toBe('available=false\n');

    const duplicate = runQualification({ ids: '5678\n9012' });
    expect(duplicate.status).not.toBe(0);

    const failed = runQualification({ apiFailure: true });
    expect(failed.status).not.toBe(0);
  });
});
