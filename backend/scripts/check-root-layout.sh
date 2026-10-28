#!/bin/sh
set -eu

root="${1:-.}"
status=0

for name in backend frontend sdd .gitignore; do
  if [ ! -e "$root/$name" ]; then
    echo "missing root entry: $name"
    status=1
  fi
done

extra=$(ls -A "$root" | grep -vxE '\.git|\.claude|\.planning|\.DS_Store|backend|frontend|sdd|\.gitignore' || true)
if [ -n "$extra" ]; then
  echo "$extra" | while IFS= read -r name; do
    echo "unexpected root entry: $name"
  done
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "root layout ok"
fi
exit "$status"
