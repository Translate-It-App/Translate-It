#!/usr/bin/env bash
# CI preflight: decide whether the expensive verify job must run.
# Any uncertainty runs full CI. Deleting or renaming docs/Changelog.md fails
# preflight because that file is bundled into the extension and must exist.
set -euo pipefail

write_decision() {
  printf 'run_full=%s\n' "$1" >> "$GITHUB_OUTPUT"
}

# Shared PR/push policy. Inputs are the new filename, status, and old filename.
classify_change() {
  local filename="$1" status="$2" previous="$3" path
  if { [ "$filename" = "docs/Changelog.md" ] && [[ "$status" == removed || "$status" == D ]]; } ||
     { [ "$previous" = "docs/Changelog.md" ] && [[ "$status" == renamed || "$status" == R* ]]; }; then
    changelog_gone=true
  fi
  for path in "$filename" "$previous"; do
    [ -z "$path" ] && continue
    case "$path" in
      docs/*|openspec/*|.github/ISSUE_TEMPLATE/*|.github/FUNDING.yml|README.md|PARTNERSHIPS.md|SPONSORSHIP.md|CONTEXT.md|AGENTS.md|LICENSE|NOTICE) ;;
      *) run_full=true; break ;;
    esac
  done
}

finish_classification() {
  if [ "$changelog_gone" = true ]; then
    echo "::error::docs/Changelog.md was deleted or renamed. It is bundled into the extension and must exist."
    return 1
  fi
  write_decision "$run_full"
  if [ "$run_full" = true ]; then
    echo "CI-relevant changes detected; full CI will run."
  else
    echo "Only docs/metadata changes detected; skipping full CI."
  fi
}

fallback_full() {
  echo "::warning::$1; running full CI."
  write_decision true
  exit 0
}

if [ "${GITHUB_EVENT_NAME:-}" = workflow_dispatch ]; then
  echo "Manual run requested; full CI will run."
  write_decision true
  exit 0
fi

if [ "${GITHUB_EVENT_NAME:-}" = push ]; then
  before="${BEFORE_SHA:-}"
  after="${AFTER_SHA:-}"
  forced="${FORCED_PUSH:-}"
  [[ "$after" =~ ^[[:xdigit:]]{40}$ ]] || fallback_full "Invalid push after SHA"
  [[ "$after" != 0000000000000000000000000000000000000000 ]] || fallback_full "Zero push after SHA"
  head_sha=""
  if ! head_sha="$(git rev-parse HEAD 2>/dev/null)" || [ "$head_sha" != "$after" ]; then
    fallback_full "Checkout does not match push after SHA"
  fi
  if ! git cat-file -e "$after^{commit}" 2>/dev/null; then
    fallback_full "Push commit is unavailable"
  fi
  if ! git cat-file -e "$after:docs/Changelog.md" 2>/dev/null; then
    echo "::error::docs/Changelog.md is missing in the pushed commit. It is bundled into the extension and must exist."
    exit 1
  fi
  [[ "$before" =~ ^[[:xdigit:]]{40}$ ]] || fallback_full "Invalid push before SHA"
  [[ "$before" != 0000000000000000000000000000000000000000 ]] || fallback_full "Zero push before SHA"
  if ! git fetch --no-tags --depth=64 origin "$after" >/dev/null 2>&1; then
    fallback_full "Could not fetch push commits"
  fi
  if ! git cat-file -e "$before^{commit}" 2>/dev/null; then
    fallback_full "Push commit history is incomplete"
  fi
  [[ "$forced" = false ]] || fallback_full "Missing or invalid forced-push flag"
  if ! git merge-base --is-ancestor "$before" "$after" >/dev/null 2>&1; then
    fallback_full "Push is not a verified fast-forward"
  fi
  tmp_file="$(mktemp)" || fallback_full "Could not create diff file"
  trap 'rm -f "$tmp_file"' EXIT
  if ! git diff --no-ext-diff --name-status -z -M "$before" "$after" -- > "$tmp_file" 2>/dev/null; then
    fallback_full "Could not read push diff"
  fi
  [ -s "$tmp_file" ] || fallback_full "Push diff is empty"

  run_full=false
  changelog_gone=false
  malformed=false
  while :; do
    status=""
    if ! IFS= read -r -d '' status; then
      [ -z "$status" ] || malformed=true
      break
    fi
    if ! IFS= read -r -d '' filename; then malformed=true; break; fi
    previous=""
    case "$status" in
      A|M|D|T) ;;
      R[0-9][0-9][0-9]|C[0-9][0-9][0-9])
        previous="$filename"
        if ! IFS= read -r -d '' filename; then malformed=true; break; fi
        ;;
      *) malformed=true; break ;;
    esac
    [ -n "$filename" ] || { malformed=true; break; }
    classify_change "$filename" "$status" "$previous"
  done < "$tmp_file"
  [ "$malformed" = false ] || fallback_full "Malformed or unknown push diff record"
  finish_classification
  exit $?
fi

repo="${GITHUB_REPOSITORY:-}"
pr_number="${PR_NUMBER:-}"
if [ -z "$repo" ] || [ -z "$pr_number" ]; then
  fallback_full "Missing PR context"
fi
if ! TOTAL="$(gh api "repos/$repo/pulls/$pr_number" -q '.changed_files')"; then
  fallback_full "Could not fetch PR changed-file count (API request failed)"
fi
case "$TOTAL" in
  ''|*[!0-9]*) fallback_full "Could not determine changed-file count" ;;
esac
if [ "$TOTAL" -gt 3000 ]; then
  echo "PR touches $TOTAL files, exceeding the pull-request files API limit; running full CI."
  write_decision true
  exit 0
fi
if ! CHANGED="$(gh api "repos/$repo/pulls/$pr_number/files" --paginate -q '.[] | [.filename, .status, (.previous_filename // "")] | @tsv')"; then
  fallback_full "Could not fetch PR file list (API request failed)"
fi
[ -n "$CHANGED" ] || fallback_full "No changed files detected"
echo "Changed files:"
echo "$CHANGED"
row_count=0
malformed=false
while IFS="$(printf '\t')" read -r filename status previous; do
  case "$status" in
    added|removed|modified|renamed|copied|changed) ;;
    *) malformed=true; break ;;
  esac
  [ -n "$filename" ] || { malformed=true; break; }
  if [ "$status" = renamed ] && [ -z "$previous" ]; then
    malformed=true
    break
  fi
  row_count=$((row_count + 1))
done <<< "$CHANGED"
[ "$malformed" = false ] || fallback_full "Malformed or unknown PR file record"
[ "$row_count" -eq "$TOTAL" ] || fallback_full "PR file count does not match changed-file count"
run_full=false
changelog_gone=false
while IFS="$(printf '\t')" read -r filename status previous; do
  classify_change "$filename" "$status" "$previous"
done <<< "$CHANGED"
finish_classification
