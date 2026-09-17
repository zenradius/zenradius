#!/usr/bin/env bash
# Install local git hook to remind maintainers to bump version.txt
set -euo pipefail
HOOK_DIR=".git/hooks"
PREPUSH="$HOOK_DIR/pre-push"
cat > "$PREPUSH" <<'HOOK'
#!/usr/bin/env bash
# Prevent pushing when files changed but version.txt wasn't updated
changed=$(git diff --name-only --staged)
if [ -z "$changed" ]; then
  exit 0
fi
non_version=$(echo "$changed" | grep -v -x 'version.txt' || true)
has_version=$(echo "$changed" | grep -x 'version.txt' || true)
if [ -n "$non_version" ] && [ -z "$has_version" ]; then
  echo "ERROR: You changed files but didn't update version.txt. Please bump version.txt before pushing."
  echo "Changed files:"; echo "$changed"
  exit 1
fi
exit 0
HOOK
chmod +x "$PREPUSH"
echo "Git hook installed: $PREPUSH"
