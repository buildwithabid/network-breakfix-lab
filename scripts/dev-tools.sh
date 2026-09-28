#!/usr/bin/env bash
# Installs pinned developer tools into ./.tools/bin (no root needed). Idempotent.
set -Eeuo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/versions.env
source "$REPO_DIR/scripts/versions.env"
BIN="$REPO_DIR/.tools/bin"
mkdir -p "$BIN"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch() { # url sha256 dest
  curl -fsSL -o "$3" "$1"
  echo "$2  $3" | sha256sum -c --quiet - || { echo "checksum mismatch for $1" >&2; exit 1; }
}

if [[ "$("$BIN/gitleaks" version 2>/dev/null || true)" != "$GITLEAKS_VERSION" ]]; then
  fetch "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
    "$GITLEAKS_SHA256" "$tmp/gitleaks.tar.gz"
  tar -xzf "$tmp/gitleaks.tar.gz" -C "$tmp" gitleaks
  install -m 0755 "$tmp/gitleaks" "$BIN/gitleaks"
fi
if ! "$BIN/shellcheck" --version 2>/dev/null | grep -q "version: ${SHELLCHECK_VERSION}$"; then
  fetch "https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.linux.x86_64.tar.xz" \
    "$SHELLCHECK_SHA256" "$tmp/shellcheck.tar.xz"
  tar -xJf "$tmp/shellcheck.tar.xz" -C "$tmp"
  install -m 0755 "$tmp/shellcheck-v${SHELLCHECK_VERSION}/shellcheck" "$BIN/shellcheck"
fi
git -C "$REPO_DIR" config core.hooksPath .githooks
echo "gitleaks $("$BIN/gitleaks" version), shellcheck ${SHELLCHECK_VERSION}; git hooks from .githooks"
