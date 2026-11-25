# Website release metadata deployment

When a stable GitHub Release is published, the `Update Website Release Metadata`
workflow triggers a Cloudflare Pages deployment so the website can rebuild its
release metadata.

Before enabling the workflow:

1. In the Cloudflare dashboard, open the website Pages project and create a
   Deploy Hook for the production branch.
2. In the Extension GitHub repository, open **Settings → Secrets and variables
   → Actions** and add a repository secret named `CLOUDFLARE_DEPLOY_HOOK`.
3. Save the full Deploy Hook URL as the secret value. Do not put the URL in
   workflow files or logs.

The workflow skips prereleases and releases tagged `development`. A missing
secret, failed request, or non-success HTTP response fails the workflow.
