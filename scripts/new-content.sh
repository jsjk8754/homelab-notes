#!/usr/bin/env sh
set -eu

usage() {
  printf 'Usage: %s <notes|projects> <slug>\n' "$0" >&2
  exit 2
}

[ "$#" -eq 2 ] || usage
section=$1
slug=$2

case "$section" in
  notes|projects) ;;
  *) usage ;;
esac

case "$slug" in
  ''|*[!a-z0-9-]*|-*|*-) printf 'Slug must use lowercase letters, numbers, and interior hyphens.\n' >&2; exit 2 ;;
esac

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
hugo_bin=${HUGO_BIN:-hugo}
target="$section/$slug/index.md"

cd "$project_dir"
"$hugo_bin" new content "$target"
printf 'Created content/%s\n' "$target"
