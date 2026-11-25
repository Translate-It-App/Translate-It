import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = readFileSync(join(root, '.github/workflows/update-website.yml'), 'utf8');

describe('website metadata deployment workflow', () => {
  it('runs only for published stable releases, excluding development', () => {
    expect(workflow).toContain('release:\n    types: [published]');
    expect(workflow).toContain("github.event.release.prerelease == false && github.event.release.tag_name != 'development'");
    expect(workflow).toContain('contents: read');
  });

  it('uses the deploy hook secret without logging its URL and fails for unsuccessful responses', () => {
    expect(workflow).toContain('DEPLOY_HOOK_URL: ${{ secrets.CLOUDFLARE_DEPLOY_HOOK }}');
    expect(workflow).toContain('curl --request POST');
    expect(workflow).toContain("--output /dev/null --write-out '%{http_code}'");
    expect(workflow).toContain('if [[ ! "$http_status" =~ ^2[0-9]{2}$ ]]');
    expect(workflow).not.toContain('echo "$DEPLOY_HOOK_URL"');
    expect(workflow).not.toContain('printf "$DEPLOY_HOOK_URL"');
  });
});
