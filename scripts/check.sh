#!/usr/bin/env sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
hugo_bin=${HUGO_BIN:-hugo}
base_url=${CHECK_BASE_URL:-https://example.invalid/homelab-notes/}
temporary_destination=false

if [ -n "${BUILD_DESTINATION:-}" ]; then
  destination=$BUILD_DESTINATION
  case "$destination" in
    /*) ;;
    *) destination="$project_dir/$destination" ;;
  esac
else
  destination=$(mktemp -d "${TMPDIR:-/tmp}/homelab-notes.XXXXXX")
  temporary_destination=true
fi

cleanup() {
  if [ "$temporary_destination" = true ]; then
    rm -rf -- "$destination"
  fi
}
trap cleanup EXIT HUP INT TERM

case "$base_url" in
  */) ;;
  *) base_url="$base_url/" ;;
esac

cd "$project_dir"
python3 -m unittest discover -s scripts/tests -p 'test_*.py'

"$hugo_bin" \
  --environment production \
  --panicOnWarning \
  --minify \
  --cleanDestinationDir \
  --destination "$destination" \
  --baseURL "$base_url"

python3 scripts/verify-site.py \
  --public-dir "$destination" \
  --content-dir content \
  --base-url "$base_url" \
  --required-path / \
  --required-path /about/ \
  --required-path /projects/ \
  --required-path /notes/

printf 'Site verification passed: %s\n' "$base_url"
