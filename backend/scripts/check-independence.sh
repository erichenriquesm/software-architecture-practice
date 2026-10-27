#!/bin/sh
set -eu

service=${1:?usage: scripts/check-independence.sh <service-dir>}
backend=$(cd "$(dirname "$0")/.." && pwd)
source="$backend/$service"
[ -d "$source" ] || { echo "independence: $source not found" >&2; exit 2; }

copy=$(mktemp -d "${TMPDIR:-/tmp}/independence-XXXXXX")
trap 'rm -rf "$copy"' EXIT
cp -R "$source" "$copy/$service"
rm -rf "$copy/$service/node_modules" "$copy/$service/dist"

docker build --quiet --target build -t "independence-check-$service" "$copy/$service" > /dev/null
docker image rm "independence-check-$service" > /dev/null
echo "independence ok: $service builds and passes its checks outside backend/"
