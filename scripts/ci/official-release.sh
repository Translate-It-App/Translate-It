#!/usr/bin/env bash
set -euo pipefail

command=${1:-}
repo=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}
release_title="Translate It! ${RELEASE_TAG:-}"

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

valid_tag() {
  [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

fetch_releases() {
  local pages_json flattened
  pages_json=$(gh api --paginate --slurp "repos/$repo/releases") || return 1
  if [[ -z "$pages_json" ]]; then
    printf '[]'
  else
    flattened=$(jq -c 'add // []' <<<"$pages_json") || return 1
    jq -e 'type == "array"' <<<"$flattened" >/dev/null || return 1
    printf '%s' "$flattened"
  fi
}

prepare() {
  local tag=$RELEASE_TAG version sha tag_response releases_json match_count release_id output tag_exists ref_sha release_json custom_notes generated_json generated_notes body vue_version generated_details changed_section change_entries metadata nc_prefix fc_prefix probe
  output=${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}
  [[ -w "$output" ]] || fail 'GITHUB_OUTPUT is not writable.'
  valid_tag "$tag" || fail 'RELEASE_TAG must match vMAJOR.MINOR.PATCH.'
  version=$(jq -er '.version | select(type == "string" and length > 0)' package.json) || fail 'could not read package version.'
  [[ "$tag" == "v$version" ]] || fail "release tag $tag does not match package version v$version."
  sha=$(gh api "repos/$repo/commits/main" --jq .sha) || fail 'could not resolve main commit SHA.'
  [[ "$sha" =~ ^[[:xdigit:]]{40}$ ]] || fail 'main commit SHA is invalid.'
  sha=${sha,,}
  local checkout_sha
  checkout_sha=$(git rev-parse HEAD) || fail 'could not resolve checked out commit.'
  [[ "$checkout_sha" =~ ^[[:xdigit:]]{40}$ && "${checkout_sha,,}" == "$sha" ]] || fail 'checked out commit does not match the resolved main commit.'

  if tag_response=$(gh api --include "repos/$repo/git/ref/tags/$tag" 2>&1); then
    tag_exists=true
  elif [[ "$tag_response" =~ (^|$'\n')HTTP/[0-9.]+[[:space:]]+404([[:space:]]|$'\r'|$'\n') ]]; then
    tag_exists=false
  else
    printf 'Error: could not verify whether tag %s exists.\n%s\n' "$tag" "$tag_response" >&2
    exit 1
  fi

  releases_json=$(fetch_releases) || fail 'could not list releases.'
  match_count=$(jq -er --arg tag "$tag" '[.[] | select(.tag_name == $tag)] | length' <<<"$releases_json") || fail 'could not parse release listing.'
  (( match_count <= 1 )) || fail "found multiple releases for tag $tag."

  if [[ "$tag_exists" == true ]]; then
    ref_sha=$(gh api "repos/$repo/git/ref/tags/$tag" --jq .object.sha) || fail "could not read existing tag $tag."
    [[ "$ref_sha" =~ ^[[:xdigit:]]{40}$ && "${ref_sha,,}" == "$sha" ]] || fail "existing tag $tag does not point at the resolved main commit."
    if (( match_count == 1 )); then
      release_json=$(jq -c --arg tag "$tag" '[.[] | select(.tag_name == $tag)][0]' <<<"$releases_json") || fail 'could not read existing release.'
      jq -e --arg title "$release_title" '.draft == true and .name == $title' <<<"$release_json" >/dev/null || fail "existing release for $tag is not the expected draft."
      release_id=$(jq -er '.id | select(type == "number" and . > 0 and floor == .)' <<<"$release_json") || fail 'existing draft release has an invalid ID.'
      printf 'tag=%s\nsha=%s\nrelease_id=%s\n' "$tag" "$sha" "$release_id" >>"$output"
      return 0
    fi
  elif (( match_count > 0 )); then
    fail "found an unexpected release for tag $tag without its Git ref."
  fi

  vue_version=$(pnpm list vue --depth=0 --json --lockfile-only) || fail 'could not resolve Vue version from the pnpm lockfile.'
  vue_version=$(jq -er 'select(type == "array" and length == 1) | .[0].dependencies.vue.version | select(type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))' <<<"$vue_version") || fail 'resolved Vue version is missing, ambiguous, or not a concrete semantic version.'
  custom_notes=$(node "$(dirname "${BASH_SOURCE[0]}")/release-notes.mjs" "$tag" docs/Changelog.md "$vue_version") || fail "could not parse release notes for $tag."

  generated_json=$(gh api --method POST "repos/$repo/releases/generate-notes" -f "tag_name=$tag" -f "target_commitish=$sha") || fail "could not generate release notes for $tag."
  generated_notes=$(jq -er '.body | select(type == "string" and test("\\S"))' <<<"$generated_json") || fail 'generated release notes are empty or invalid.'
  [[ "${generated_notes%%$'\n'*}" == "## What's Changed" ]] || fail "generated release notes do not start with '## What's Changed'."
  generated_details=${generated_notes#"## What's Changed"}
  while [[ "$generated_details" == $'\n'* ]]; do generated_details=${generated_details#$'\n'}; done
  while [[ "$generated_details" == *$'\n' ]]; do generated_details=${generated_details%$'\n'}; done
  [[ -n "$generated_details" ]] || fail 'generated release notes contain no changes after the heading.'
  change_entries=$generated_details
  metadata=''
  probe=$'\n'"$generated_details"
  nc_prefix=${probe%%$'\n## New Contributors'*}
  fc_prefix=${probe%%$'\n**Full Changelog**:'*}
  if [[ "$nc_prefix" != "$probe" && ( "$fc_prefix" == "$probe" || ${#nc_prefix} -le ${#fc_prefix} ) ]]; then
    change_entries=${nc_prefix#$'\n'}
    metadata="### New Contributors"${probe#*$'\n## New Contributors'}
  elif [[ "$fc_prefix" != "$probe" ]]; then
    change_entries=${fc_prefix#$'\n'}
    metadata="**Full Changelog**:"${probe#*$'\n**Full Changelog**:'}
  fi
  while [[ "$change_entries" == *$'\n' ]]; do change_entries=${change_entries%$'\n'}; done
  [[ -n "$change_entries" ]] || fail 'generated release notes contain no changes after the heading.'
  changed_section=$(printf -- "---\n\n<details>\n<summary><h4>What's Changed</h4></summary>\n\n%s\n\n</details>" "$change_entries")
  if [[ -n "$metadata" ]]; then
    body=$(printf '%s\n\n%s\n\n%s' "$custom_notes" "$changed_section" "$metadata")
  else
    body=$(printf '%s\n\n%s' "$custom_notes" "$changed_section")
  fi
  [[ "$body" =~ [^[:space:]] ]] || fail 'composed release notes are empty.'

  if [[ "$tag_exists" != true ]]; then
    gh api --method POST "repos/$repo/git/refs" -f "ref=refs/tags/$tag" -f "sha=$sha" || fail "could not create tag $tag."
  fi

  release_json=$(gh api --method POST "repos/$repo/releases" \
    -f "tag_name=$tag" \
    -f "name=$release_title" \
    -f "target_commitish=$sha" \
    -f "body=$body" \
    -F "draft=true") || fail "could not create draft release $tag."
  release_id=$(jq -er --arg tag "$tag" --arg title "$release_title" '
    select(.tag_name == $tag and .draft == true and .name == $title)
    | .id | select(type == "number" and . > 0 and floor == .)
  ' <<<"$release_json") || fail 'draft creation response does not match expected ID, tag, title, or draft state.'
  printf 'tag=%s\nsha=%s\nrelease_id=%s\n' "$tag" "$sha" "$release_id" >>"$output"
}

release_json() {
  gh api "repos/$repo/releases/$RELEASE_ID"
}

assets_json() {
  gh api "repos/$repo/releases/$RELEASE_ID/assets"
}

verify_tag_sha() {
  local ref_sha
  ref_sha=$(gh api "repos/$repo/git/ref/tags/$RELEASE_TAG" --jq .object.sha) || fail 'could not read release tag ref.'
  [[ "$ref_sha" =~ ^[[:xdigit:]]{40}$ ]] || fail 'release tag ref SHA is invalid.'
  [[ "${ref_sha,,}" == "$EXPECTED_SHA" ]] || fail 'release tag no longer points at EXPECTED_SHA.'
}

verify_release() {
  local json=$1 draft=$2
  jq -e --argjson id "$RELEASE_ID" --arg tag "$RELEASE_TAG" --argjson draft "$draft" --arg expected_title "$release_title" \
    '.id == $id and .tag_name == $tag and .draft == $draft and .name == $expected_title' <<<"$json" >/dev/null
}

replace_asset() {
  local name=$1 file=$2 listed ids id
  listed=$(assets_json) || fail "could not list existing release assets before replacing $name."
  jq -e 'type == "array"' <<<"$listed" >/dev/null || fail 'release assets response is invalid.'
  ids=$(jq -r --arg name "$name" '.[] | select(.name == $name) | .id | select(type == "number" and . > 0 and floor == .)' <<<"$listed") || fail 'could not parse existing release assets.'
  for id in $ids; do
    gh api --method DELETE "repos/$repo/releases/assets/$id" || fail "could not delete existing asset $name."
  done
  gh api --method POST "https://uploads.github.com/repos/$repo/releases/$RELEASE_ID/assets?name=$name" \
    -H 'Content-Type: application/zip' --input "$file" || fail "could not upload asset $name."
}

finalize_draft() {
  local publish_dir=${PUBLISH_DIR:-dist/Publish} chrome_inputs firefox_inputs chrome_name firefox_name
  local json listed
  : "${RELEASE_TAG:?RELEASE_TAG is required}"
  : "${RELEASE_ID:?RELEASE_ID is required}"
  : "${EXPECTED_SHA:?EXPECTED_SHA is required}"
  valid_tag "$RELEASE_TAG" || fail 'RELEASE_TAG must match vMAJOR.MINOR.PATCH.'
  [[ "$RELEASE_ID" =~ ^[1-9][0-9]*$ ]] || fail 'RELEASE_ID must be a positive integer.'
  [[ "$EXPECTED_SHA" =~ ^[[:xdigit:]]{40}$ ]] || fail 'EXPECTED_SHA must be a 40-character hexadecimal SHA.'
  EXPECTED_SHA=${EXPECTED_SHA,,}

  shopt -s nullglob
  chrome_inputs=("$publish_dir"/Translate-It-v*-for-Chrome.zip)
  firefox_inputs=("$publish_dir"/Translate-It-v*-for-Firefox.zip)
  (( ${#chrome_inputs[@]} == 1 )) || fail "expected exactly one Chrome ZIP in $publish_dir."
  [[ -f "${chrome_inputs[0]}" && ! -L "${chrome_inputs[0]}" ]] || fail 'Chrome ZIP must be a regular file.'
  (( ${#firefox_inputs[@]} == 1 )) || fail "expected exactly one Firefox ZIP in $publish_dir."
  [[ -f "${firefox_inputs[0]}" && ! -L "${firefox_inputs[0]}" ]] || fail 'Firefox ZIP must be a regular file.'
  chrome_name=${chrome_inputs[0]##*/}
  firefox_name=${firefox_inputs[0]##*/}
  [[ "$chrome_name" == "Translate-It-${RELEASE_TAG}-for-Chrome.zip" ]] || fail 'Chrome ZIP does not match RELEASE_TAG.'
  [[ "$firefox_name" == "Translate-It-${RELEASE_TAG}-for-Firefox.zip" ]] || fail 'Firefox ZIP does not match RELEASE_TAG.'

  json=$(release_json) || fail 'could not read release by ID.'
  verify_release "$json" true || fail 'release ID, tag, or draft state does not match.'
  verify_tag_sha

  # A resumed draft may only carry the two expected browser ZIPs. Refuse to
  # touch a release holding anything else; unknown assets are never deleted
  # automatically and must never become public with this release.
  listed=$(assets_json) || fail 'could not list current release assets.'
  jq -e --arg chrome "$chrome_name" --arg firefox "$firefox_name" '
    type == "array"
    and ([.[] | select(.name != $chrome and .name != $firefox)] | length == 0)
  ' <<<"$listed" >/dev/null || fail 'release contains unexpected assets; refusing to modify the release.'

  replace_asset "$chrome_name" "${chrome_inputs[0]}"
  replace_asset "$firefox_name" "${firefox_inputs[0]}"
  listed=$(assets_json) || fail 'could not verify uploaded release assets.'
  # GitHub-generated source links are not normal release assets and are not
  # part of this check; the published asset set must be exactly the two
  # official browser ZIPs.
  jq -e --arg chrome "$chrome_name" --arg firefox "$firefox_name" '
    type == "array"
    and length == 2
    and ([.[] | select(.name == $chrome)] | length == 1)
    and ([.[] | select(.name == $firefox)] | length == 1)
  ' <<<"$listed" >/dev/null || fail 'expected exactly the two official browser ZIPs on the release.'

  json=$(release_json) || fail 'could not recheck release draft.'
  verify_release "$json" true || fail 'release is no longer the expected draft.'
  verify_tag_sha
}

case "$command" in
  prepare) prepare ;;
  finalize-draft) finalize_draft ;;
  *) fail 'usage: official-release.sh {prepare|finalize-draft}.' ;;
esac
