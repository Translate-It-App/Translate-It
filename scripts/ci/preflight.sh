#!/usr/bin/env bash
# CI preflight: decide whether the expensive verify job must run.
#
# Outputs `run_full=true|false` to $GITHUB_OUTPUT and exits 0, except when
# docs/Changelog.md was deleted or renamed (exit 1), since that file is
# bundled into the extension and must exist.
#
# Fail-safe principle: any uncertainty (API failure, unknown count, unknown
# paths, empty file list) runs full CI. Only an explicitly docs/metadata-only
# change set skips it.
#
# Required environment:
#   GITHUB_EVENT_NAME  (provided by the GitHub runner)
#   GITHUB_REPOSITORY  (provided by the GitHub runner, owner/repo)
#   PR_NUMBER          (pull request number, passed explicitly from the workflow)
#   GITHUB_OUTPUT      (provided by the GitHub runner)
#   GH_TOKEN           (for `gh` authentication)
set -euo pipefail

if [ "${GITHUB_EVENT_NAME:-}" = "workflow_dispatch" ]; then
  echo "Manual run requested; full CI will run."
  echo "run_full=true" >> "$GITHUB_OUTPUT"
  exit 0
fi

repo="${GITHUB_REPOSITORY:-}"
pr_number="${PR_NUMBER:-}"
if [ -z "$repo" ] || [ -z "$pr_number" ]; then
  echo "::warning::Missing PR context; running full CI."
  echo "run_full=true" >> "$GITHUB_OUTPUT"
  exit 0
fi

if ! TOTAL="$(gh api "repos/$repo/pulls/$pr_number" -q '.changed_files')"; then
  echo "::warning::Could not fetch PR changed-file count (API request failed); running full CI."
  echo "run_full=true" >> "$GITHUB_OUTPUT"
  exit 0
fi
case "$TOTAL" in
  ''|*[!0-9]*)
    echo "Could not determine changed-file count; defaulting to full CI."
    echo "run_full=true" >> "$GITHUB_OUTPUT"
    exit 0
    ;;
esac
if [ "$TOTAL" -gt 3000 ]; then
  echo "PR touches $TOTAL files, exceeding the pull-request files API limit; running full CI."
  echo "run_full=true" >> "$GITHUB_OUTPUT"
  exit 0
fi
if ! CHANGED="$(gh api "repos/$repo/pulls/$pr_number/files" --paginate -q '.[] | [.filename, .status, (.previous_filename // "")] | @tsv')"; then
  echo "::warning::Could not fetch PR file list (API request failed); running full CI."
  echo "run_full=true" >> "$GITHUB_OUTPUT"
  exit 0
fi
if [ -z "$CHANGED" ]; then
  echo "No changed files detected; defaulting to full CI."
  echo "run_full=true" >> "$GITHUB_OUTPUT"
  exit 0
fi
echo "Changed files:"
echo "$CHANGED"
run_full="false"
changelog_gone="false"
while IFS="$(printf '\t')" read -r f status prev; do
  [ -z "$f" ] && continue
  if { [ "$f" = "docs/Changelog.md" ] && [ "$status" = "removed" ]; } || [ "$prev" = "docs/Changelog.md" ]; then
    changelog_gone="true"
  fi
  for p in "$f" "$prev"; do
    [ -z "$p" ] && continue
    case "$p" in
      docs/*|openspec/*|.github/ISSUE_TEMPLATE/*|.github/FUNDING.yml|README.md|PARTNERSHIPS.md|SPONSORSHIP.md|CONTEXT.md|AGENTS.md|LICENSE|NOTICE)
        ;;
      *)
        run_full="true"
        break
        ;;
    esac
  done
done <<< "$CHANGED"
if [ "$changelog_gone" = "true" ]; then
  echo "::error::docs/Changelog.md was deleted or renamed. It is bundled into the extension and must exist."
  exit 1
fi
echo "run_full=$run_full" >> "$GITHUB_OUTPUT"
if [ "$run_full" = "true" ]; then
  echo "CI-relevant changes detected; full CI will run."
else
  echo "Only docs/metadata changes detected; skipping full CI."
fi
