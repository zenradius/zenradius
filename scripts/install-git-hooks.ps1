# Install local git hook to remind maintainers to bump version.txt
$ErrorActionPreference = "Stop"

$hookDir = ".git/hooks"
if (!(Test-Path $hookDir)) {
    Write-Error "Not a git repository root (or .git/hooks missing): $hookDir"
    exit 1
}

$prePushPath = Join-Path $hookDir "pre-push"

$hookContent = @'
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
'@

# Write with LF line endings so it runs correctly under git's bash
$hookContent = $hookContent -replace "`r`n", "`n"
[System.IO.File]::WriteAllText($prePushPath, $hookContent)

Write-Host "Git hook installed: $prePushPath"
