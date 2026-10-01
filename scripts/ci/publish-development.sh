#!/usr/bin/env bash
set -euo pipefail

if [[ "${GITHUB_EVENT_NAME:-}" != workflow_run ]]; then
  printf 'Notice: skipping development publication outside workflow_run.\n'
  exit 0
fi

for name in SOURCE_RUN_ID SOURCE_RUN_NUMBER SOURCE_RUN_ATTEMPT SOURCE_WORKFLOW_ID; do
  value=${!name:-}
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    printf 'Error: %s must be a positive integer.\n' "$name" >&2
    exit 1
  fi
done
: "${SOURCE_SHA:?SOURCE_SHA is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
if [[ ! "$SOURCE_SHA" =~ ^[[:xdigit:]]{40}$ ]]; then
  printf 'Error: SOURCE_SHA must be a 40-character hexadecimal commit SHA.\n' >&2
  exit 1
fi
SOURCE_SHA=${SOURCE_SHA,,}

publish_dir=${PUBLISH_DIR:?PUBLISH_DIR is required}
shopt -s nullglob
chrome_inputs=("$publish_dir"/Translate-It-v*-for-Chrome.zip)
firefox_inputs=("$publish_dir"/Translate-It-v*-for-Firefox.zip)
if (( ${#chrome_inputs[@]} != 1 )) || [[ ! -f "${chrome_inputs[0]:-}" || -L "${chrome_inputs[0]:-}" ]]; then
  printf 'Error: expected exactly one regular versioned Chrome ZIP in %s.\n' "$publish_dir" >&2
  exit 1
fi
if (( ${#firefox_inputs[@]} != 1 )) || [[ ! -f "${firefox_inputs[0]:-}" || -L "${firefox_inputs[0]:-}" ]]; then
  printf 'Error: expected exactly one regular versioned Firefox ZIP in %s.\n' "$publish_dir" >&2
  exit 1
fi

chrome_public="$publish_dir/Translate-It-development-for-Chrome.zip"
firefox_public="$publish_dir/Translate-It-development-for-Firefox.zip"
cp -- "${chrome_inputs[0]}" "$chrome_public"
cp -- "${firefox_inputs[0]}" "$firefox_public"
[[ -f "$chrome_public" && ! -L "$chrome_public" && -f "$firefox_public" && ! -L "$firefox_public" ]] || {
  printf 'Error: stable development ZIP copies are not regular files.\n' >&2
  exit 1
}

repo=$GITHUB_REPOSITORY
tag_endpoint="repos/$repo/git/refs/tags/development"
chrome_name=${chrome_public##*/}
firefox_name=${firefox_public##*/}

# Tag-endpoint GET 404s for drafts, so discovery uses the authenticated release
# listing and selects by tag name. Paginated output arrives as one JSON array
# per page, so slurp the pages and flatten them before selecting.
fetch_releases() {
  local pages_json
  pages_json=$(gh api --paginate --slurp "repos/$repo/releases") || return 1
  if [[ -z "$pages_json" ]]; then
    printf '[]'
    return 0
  fi
  jq -c 'add // []' <<<"$pages_json"
}
releases_json=$(fetch_releases) || {
  printf 'Error: could not list development releases.\n' >&2
  exit 1
}
match_count=$(jq -er '[.[] | select(.tag_name == "development")] | length' <<<"$releases_json") || {
  printf 'Error: could not parse development release listing.\n' >&2
  exit 1
}
if (( match_count > 1 )); then
  printf 'Error: found %s development releases; refusing to guess.\n' "$match_count" >&2
  exit 1
fi
release_exists=false
(( match_count == 1 )) && release_exists=true

release_id=''
release_body=''
release_draft=''
marker_state=''
current_run_number=0
current_run_attempt=0
backup_dir=''
backup_body=''
backup_tag_sha=''
if [[ "$release_exists" == true ]]; then
  release_json=$(jq -c '[.[] | select(.tag_name == "development")][0]' <<<"$releases_json") || {
    printf 'Error: could not read the existing development release.\n' >&2
    exit 1
  }
  release_id=$(jq -er '.id | select(type == "number" and . > 0 and floor == .)' <<<"$release_json") || {
    printf 'Error: invalid development release ID.\n' >&2
    exit 1
  }
  release_body=$(jq -er '.body | select(type == "string")' <<<"$release_json") || {
    printf 'Error: existing development release has no readable source marker body.\n' >&2
    exit 1
  }
  jq -e '.draft | type == "boolean"' <<<"$release_json" >/dev/null || {
    printf 'Error: existing development release has no readable draft flag.\n' >&2
    exit 1
  }
  release_draft=$(jq -r '.draft' <<<"$release_json")
  marker_prefix='<!-- translate-it-development-source: '
  markers=()
  while IFS= read -r line; do
    [[ "$line" == *'<!-- translate-it-development-source:'* ]] && markers+=("$line")
  done <<<"$release_body"
  if (( ${#markers[@]} != 1 )); then
    printf 'Error: existing development release must contain exactly one source marker.\n' >&2
    exit 1
  fi
  marker=${markers[0]}
  if [[ "$marker" != "$marker_prefix"*' -->' ]]; then
    printf 'Error: existing development release source marker is malformed.\n' >&2
    exit 1
  fi
  marker_json=${marker#"$marker_prefix"}
  marker_json=${marker_json% -->}
  parsed_marker=$(jq -er '
    select(type == "object" and (keys == ["run_attempt", "run_id", "run_number", "sha", "state", "workflow_id"]))
    | select(.workflow_id | type == "number" and . > 0 and floor == .)
    | select(.run_number | type == "number" and . > 0 and floor == .)
    | select(.run_attempt | type == "number" and . > 0 and floor == .)
    | select(.run_id | type == "number" and . > 0 and floor == .)
    | select(.sha | type == "string" and test("^[0-9a-f]{40}$"))
    | select(.state == "publishing" or .state == "published")
    | @json
  ' <<<"$marker_json") || {
    printf 'Error: existing development release source marker is malformed.\n' >&2
    exit 1
  }
  # Require canonical JSON too, rejecting duplicate keys and ambiguous encodings.
  [[ "$parsed_marker" == "$marker_json" ]] || {
    printf 'Error: existing development release source marker is not canonical.\n' >&2
    exit 1
  }
  marker_state=$(jq -r '.state' <<<"$parsed_marker")
  marker_workflow_id=$(jq -r '.workflow_id' <<<"$parsed_marker")
  if [[ "$marker_workflow_id" != "$SOURCE_WORKFLOW_ID" ]]; then
    printf 'Error: development release marker belongs to workflow %s, not %s.\n' "$marker_workflow_id" "$SOURCE_WORKFLOW_ID" >&2
    exit 1
  fi
  current_run_number=$(jq -r '.run_number' <<<"$parsed_marker")
  current_run_attempt=$(jq -r '.run_attempt' <<<"$parsed_marker")
  if (( SOURCE_RUN_NUMBER < current_run_number )) || { (( SOURCE_RUN_NUMBER == current_run_number )) && (( SOURCE_RUN_ATTEMPT < current_run_attempt )); }; then
    printf 'Notice: skipping older source run %s attempt %s; published high-water is %s attempt %s.\n' "$SOURCE_RUN_NUMBER" "$SOURCE_RUN_ATTEMPT" "$current_run_number" "$current_run_attempt"
    exit 0
  fi
fi

make_marker() {
  local state=$1
  printf '<!-- translate-it-development-source: {"workflow_id":%s,"run_number":%s,"run_attempt":%s,"run_id":%s,"sha":"%s","state":"%s"} -->' \
    "$SOURCE_WORKFLOW_ID" "$SOURCE_RUN_NUMBER" "$SOURCE_RUN_ATTEMPT" "$SOURCE_RUN_ID" "$SOURCE_SHA" "$state"
}

check_ancestry() {
  local status
  status=$(gh api "repos/$repo/compare/$SOURCE_SHA...main" --jq .status) || {
    printf 'Error: could not compare source commit with main.\n' >&2
    return 1
  }
  if [[ "$status" != ahead && "$status" != identical ]]; then
    printf 'Notice: skipping development publication; source commit is not an ancestor of main (compare status: %s).\n' "$status"
    return 2
  fi
}

move_tag_to() {
  local sha=$1 recheck=$2 tag_response
  if tag_response=$(gh api --include --method PATCH "$tag_endpoint" -f "sha=$sha" -F force=true 2>&1); then
    return 0
  elif [[ "$tag_response" =~ (^|$'\n')HTTP/[0-9.]+[[:space:]]+404([[:space:]]|$'\r'|$'\n') ]]; then
    if [[ "$recheck" == true ]]; then check_ancestry || return $?; fi
    gh api --method POST "repos/$repo/git/refs" -f ref=refs/tags/development -f "sha=$sha"
  else
    printf 'Error: failed to move development tag; response was not a confirmed 404.\n%s\n' "$tag_response" >&2
    return 1
  fi
}

ensure_tag() {
  check_ancestry || return $?
  move_tag_to "$SOURCE_SHA" true
}

delete_assets_named() {
  local name=$1 assets_json=$2 ids id
  ids=$(jq -r --arg name "$name" '.[] | select(.name == $name) | .id | select(type == "number")' <<<"$assets_json") || {
    printf 'Error: could not parse release assets.\n' >&2
    return 1
  }
  for id in $ids; do
    gh api --method DELETE "repos/$repo/releases/assets/$id" || return 1
  done
}

upload_asset() {
  local name=$1 file=$2
  gh api --method POST "https://uploads.github.com/repos/$repo/releases/$release_id/assets?name=$name" -H "Content-Type: application/zip" --input "$file"
}

verify_assets() {
  local assets_json=$1
  jq -e --arg chrome "$chrome_name" --arg firefox "$firefox_name" '
    ([.[] | select(.name == $chrome)] | length == 1)
    and ([.[] | select(.name == $firefox)] | length == 1)
  ' <<<"$assets_json" >/dev/null || {
    printf 'Error: stable development assets are not both present on the release.\n' >&2
    return 1
  }
}

sync_assets() {
  local assets_json
  assets_json=$(gh api "repos/$repo/releases/$release_id/assets") || {
    printf 'Error: could not list release assets.\n' >&2
    return 1
  }
  delete_assets_named "$chrome_name" "$assets_json" || return 1
  delete_assets_named "$firefox_name" "$assets_json" || return 1
  upload_asset "$chrome_name" "$chrome_public" || return 1
  upload_asset "$firefox_name" "$firefox_public" || return 1
  assets_json=$(gh api "repos/$repo/releases/$release_id/assets") || {
    printf 'Error: could not re-list release assets.\n' >&2
    return 1
  }
  verify_assets "$assets_json"
}

# Snapshot the currently public state before any mutation so a failed update
# of a published release can be rolled back. Performs no mutations itself.
capture_backup() {
  local assets_json chrome_asset_id firefox_asset_id
  backup_body=$release_body
  backup_tag_sha=$(gh api "repos/$repo/git/refs/tags/development" --jq .object.sha) || {
    printf 'Error: could not read the current development tag SHA; refusing to mutate.\n' >&2
    return 1
  }
  [[ "$backup_tag_sha" =~ ^[0-9a-fA-F]{40}$ ]] || {
    printf 'Error: current development tag SHA is unparseable; refusing to mutate.\n' >&2
    return 1
  }
  backup_dir=$(mktemp -d) || return 1
  assets_json=$(gh api "repos/$repo/releases/$release_id/assets") || {
    printf 'Error: could not list release assets for backup.\n' >&2
    return 1
  }
  verify_assets "$assets_json" || {
    printf 'Error: stable development assets are not both present for backup; refusing to mutate.\n' >&2
    return 1
  }
  chrome_asset_id=$(jq -er --arg name "$chrome_name" '[.[] | select(.name == $name) | .id | select(type == "number")] | if length == 1 then .[0] else empty end' <<<"$assets_json") || {
    printf 'Error: could not resolve the backed-up Chrome asset ID.\n' >&2
    return 1
  }
  firefox_asset_id=$(jq -er --arg name "$firefox_name" '[.[] | select(.name == $name) | .id | select(type == "number")] | if length == 1 then .[0] else empty end' <<<"$assets_json") || {
    printf 'Error: could not resolve the backed-up Firefox asset ID.\n' >&2
    return 1
  }
  gh api -H "Accept: application/octet-stream" "repos/$repo/releases/assets/$chrome_asset_id" >"$backup_dir/$chrome_name" || {
    printf 'Error: could not download the backed-up Chrome asset.\n' >&2
    return 1
  }
  gh api -H "Accept: application/octet-stream" "repos/$repo/releases/assets/$firefox_asset_id" >"$backup_dir/$firefox_name" || {
    printf 'Error: could not download the backed-up Firefox asset.\n' >&2
    return 1
  }
  if [[ ! -s "$backup_dir/$chrome_name" || ! -s "$backup_dir/$firefox_name" ]]; then
    printf 'Error: backed-up assets are empty; refusing to mutate.\n' >&2
    return 1
  fi
}

# Restore the pre-publication public state after a failed update. Every step
# is fail-closed: on any failure emit an explicit recovery-failed error and
# return non-zero without claiming restoration.
rollback_published() {
  local assets_json
  printf 'Notice: rolling back the failed development publication.\n'
  gh api --method PATCH "repos/$repo/releases/$release_id" \
    -f name='Development Build' -F prerelease=true -f make_latest=false -F draft=true -f "body=$publishing_marker" || {
    printf 'Error: rollback/recovery failed at re-draft step; prior public state may not be restored.\n' >&2
    return 1
  }
  printf 'Notice: rollback re-drafted the release.\n'
  assets_json=$(gh api "repos/$repo/releases/$release_id/assets") || {
    printf 'Error: rollback/recovery failed listing assets; prior public state may not be restored.\n' >&2
    return 1
  }
  delete_assets_named "$chrome_name" "$assets_json" || {
    printf 'Error: rollback/recovery failed deleting assets; prior public state may not be restored.\n' >&2
    return 1
  }
  delete_assets_named "$firefox_name" "$assets_json" || {
    printf 'Error: rollback/recovery failed deleting assets; prior public state may not be restored.\n' >&2
    return 1
  }
  upload_asset "$chrome_name" "$backup_dir/$chrome_name" || {
    printf 'Error: rollback/recovery failed re-uploading the backed-up Chrome asset; prior public state may not be restored.\n' >&2
    return 1
  }
  upload_asset "$firefox_name" "$backup_dir/$firefox_name" || {
    printf 'Error: rollback/recovery failed re-uploading the backed-up Firefox asset; prior public state may not be restored.\n' >&2
    return 1
  }
  printf 'Notice: rollback re-uploaded the backed-up assets.\n'
  assets_json=$(gh api "repos/$repo/releases/$release_id/assets") || {
    printf 'Error: rollback/recovery failed re-listing assets; prior public state may not be restored.\n' >&2
    return 1
  }
  verify_assets "$assets_json" || {
    printf 'Error: rollback/recovery failed verifying assets; prior public state may not be restored.\n' >&2
    return 1
  }
  move_tag_to "$backup_tag_sha" false || {
    printf 'Error: rollback/recovery failed moving the tag; prior public state may not be restored.\n' >&2
    return 1
  }
  printf 'Notice: rollback restored the development tag.\n'
  gh api --method PATCH "repos/$repo/releases/$release_id" \
    -f name='Development Build' -F prerelease=true -f make_latest=false -F draft=false -f "body=$backup_body" || {
    printf 'Error: rollback/recovery failed restoring the release body; prior public state may not be restored.\n' >&2
    return 1
  }
  printf 'Notice: rollback restored the prior public state.\n'
}

check_ancestry || {
  status=$?
  (( status == 2 )) && exit 0
  exit "$status"
}

publishing_marker=$(make_marker publishing)
need_backup=false
if [[ "$release_exists" == false ]]; then
  gh release create development "$chrome_public" "$firefox_public" \
    --title 'Development Build' --prerelease --latest=false --target "$SOURCE_SHA" --draft --notes "$publishing_marker"
  # Tag-endpoint GET 404s for drafts, so re-list to obtain the numeric REST ID.
  releases_json=$(fetch_releases) || {
    printf 'Error: could not re-list development releases after creation.\n' >&2
    exit 1
  }
  match_count=$(jq -er '[.[] | select(.tag_name == "development")] | length' <<<"$releases_json") || {
    printf 'Error: could not parse development release listing after creation.\n' >&2
    exit 1
  }
  if (( match_count != 1 )); then
    printf 'Error: expected exactly one development release after creation.\n' >&2
    exit 1
  fi
  release_id=$(jq -er '[.[] | select(.tag_name == "development")][0] | .id | select(type == "number" and . > 0 and floor == .)' <<<"$releases_json") || {
    printf 'Error: invalid newly created development release ID.\n' >&2
    exit 1
  }
  assets_json=$(gh api "repos/$repo/releases/$release_id/assets") || {
    printf 'Error: could not list newly created release assets.\n' >&2
    exit 1
  }
  verify_assets "$assets_json" || exit 1
else
  # A draft holding a publishing marker is an interrupted retry with no
  # assumed prior public state; anything else has public state worth backup.
  if [[ "$release_draft" != true || "$marker_state" != publishing ]]; then
    need_backup=true
  fi
  if [[ "$need_backup" == true ]]; then
    capture_backup || exit 1
  fi
  gh api --method PATCH "repos/$repo/releases/$release_id" \
    -f name='Development Build' -F prerelease=true -f make_latest=false -F draft=true -f "body=$publishing_marker" || exit 1
  if ! sync_assets; then
    if [[ "$need_backup" == true ]]; then rollback_published || true; fi
    exit 1
  fi
fi

if ! ensure_tag; then
  if [[ "$need_backup" == true ]]; then rollback_published || true; fi
  exit 1
fi

published_marker=$(make_marker published)
if ! gh api --method PATCH "repos/$repo/releases/$release_id" \
  -f name='Development Build' -F prerelease=true -f make_latest=false -F draft=false -f "body=$published_marker"; then
  if [[ "$need_backup" == true ]]; then rollback_published || true; fi
  exit 1
fi

if [[ -n "$backup_dir" ]]; then rm -rf "$backup_dir"; fi
