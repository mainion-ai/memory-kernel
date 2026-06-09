#!/usr/bin/env bash
#
# changelog-section.sh — extract one version's section from a Keep-a-Changelog
# CHANGELOG.md. Single source of truth for "given a version, emit its section",
# shared by:
#   - .github/workflows/release.yml  — release notes (uses --body-only)
#   - scripts/sync-to-public.sh      — synthetic-commit message body (heading kept)
#
# Keeping the extraction in one place avoids the two-copies drift the
# docs-hygiene gate exists to prevent.
#
# Usage:
#   changelog-section.sh <version> [--body-only] [--file <path>]
#
#   <version>     version without a leading "v", e.g. 1.28.5
#   --body-only   omit the "## [<version>] — <date>" heading line (body only)
#   --file <path> CHANGELOG path (default: <repo-root>/CHANGELOG.md)
#
# Prints the section to stdout. If the version has no section, prints nothing
# and exits 0 — callers decide whether that's an error (release.yml's
# five-place version gate already guarantees the section exists at release
# time; sync-to-public falls back to a bare "Release <tag>" message).
#
# Matching: from the "## [<version>]" heading up to (but not including) the
# next "## [" heading. The version is matched as the literal substring
# "[<version>]" so the date suffix and surrounding prose don't affect it.
set -euo pipefail

VERSION=""
BODY_ONLY=0
FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --body-only) BODY_ONLY=1; shift ;;
    --file) FILE="${2:-}"; shift 2 ;;
    -*) echo "changelog-section: unknown option '$1'" >&2; exit 2 ;;
    *)
      if [[ -z "$VERSION" ]]; then
        VERSION="$1"; shift
      else
        echo "changelog-section: unexpected argument '$1'" >&2; exit 2
      fi
      ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  echo "changelog-section: usage: changelog-section.sh <version> [--body-only] [--file <path>]" >&2
  exit 2
fi

if [[ -z "$FILE" ]]; then
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
  FILE="$REPO_ROOT/CHANGELOG.md"
fi

if [[ ! -f "$FILE" ]]; then
  echo "changelog-section: CHANGELOG not found: $FILE" >&2
  exit 2
fi

awk -v v="$VERSION" -v bodyonly="$BODY_ONLY" '
  BEGIN { in_section = 0 }
  /^## \[/ {
    if (in_section) exit
    if (index($0, "[" v "]") > 0) {
      in_section = 1
      if (bodyonly == "1") next   # skip the heading line in body-only mode
    }
  }
  in_section { print }
' "$FILE"
