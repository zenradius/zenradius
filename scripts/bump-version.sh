#!/usr/bin/env bash
set -euo pipefail
if [ ! -f version.txt ]; then
  echo "ZenRadius V.0.0.0" > version.txt
fi
LINE=$(cat version.txt | tr -d '\r\n')
VER=$(echo "$LINE" | grep -oE 'V\.[0-9]+(\.[0-9]+)*' | sed 's/^V\.//' || echo "0.0.0")
IFS='.' read -r MAJOR MINOR PATCH <<< "$VER"
PATCH=${PATCH:-0}
PATCH=$((PATCH+1))
NEW_VER="${MAJOR}.${MINOR}.${PATCH}"
echo "Bumping version to V.${NEW_VER}"
echo "ZenRadius V.${NEW_VER}" > version.txt
git add version.txt
git commit -m "chore: bump version to V.${NEW_VER}" || { echo "No changes to commit"; exit 0; }
git push
