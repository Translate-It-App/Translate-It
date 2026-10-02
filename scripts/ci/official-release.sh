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
  local tag=$RELEASE_TAG version sha tag_response releases_json match_count release_id output tag_exists ref_sha release_json
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
  else
    gh api --method POST "repos/$repo/git/refs" -f "ref=refs/tags/$tag" -f "sha=$sha" || fail "could not create tag $tag."
  fi

  gh release create "$tag" --draft --title "$release_title" --target "$sha" --notes "Official release $tag." || fail "could not create draft release $tag."

  releases_json=$(fetch_releases) || fail 'could not verify the created draft release.'
  release_id=$(jq -er --arg tag "$tag" '[.[] | select(.tag_name == $tag)] | if length == 1 and .[0].draft == true then .[0].id | select(type == "number" and . > 0 and floor == .) else empty end' <<<"$releases_json") || fail 'expected exactly one numeric draft release for the new tag.'
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
  jq -e --argjson id "$RELEASE_ID" --arg tag "$RELEASE_TAG" --argjson draft "$draft" \
    '.id == $id and .tag_name == $tag and .draft == $draft' <<<"$json" >/dev/null
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

finalize() {
  local publish_dir=${PUBLISH_DIR:-dist/Publish} chrome_inputs firefox_inputs chrome_name firefox_name
  local json listed publish_response
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

  json=$(release_json) || fail 'could not recheck release before publishing.'
  verify_release "$json" true || fail 'release is no longer the expected draft.'
  verify_tag_sha
  publish_response=$(gh api --method PATCH "repos/$repo/releases/$RELEASE_ID" \
    -f "name=$release_title" -F prerelease=false -f make_latest=true -F draft=false) || fail 'could not confirm publication; publication may already have succeeded and manual inspection of the GitHub Release is required.'
  jq -e --argjson id "$RELEASE_ID" --arg tag "$RELEASE_TAG" --arg title "$release_title" \
    '.id == $id and .tag_name == $tag and .name == $title and .draft == false and .prerelease == false' <<<"$publish_response" >/dev/null || fail 'publish response did not verify; publication may already have succeeded and manual inspection is required.'
}

case "$command" in
  prepare) prepare ;;
  finalize) finalize ;;
  *) fail 'usage: official-release.sh {prepare|finalize}.' ;;
esac
