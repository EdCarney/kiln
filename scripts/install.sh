#!/bin/bash
# Install or upgrade Kiln from the latest GitHub release, then open it.
#   curl -fsSL https://raw.githubusercontent.com/EdCarney/kiln/main/scripts/install.sh | bash
# Set KILN_INSTALL_DIR to install somewhere other than /Applications:
#   curl -fsSL .../install.sh | KILN_INSTALL_DIR=~/Applications bash
# Your data in ~/Library/Application Support/Kiln is untouched.
#
# curl doesn't set the quarantine flag that a browser download gets, so macOS doesn't block
# the unsigned app.
set -euo pipefail

REPO=EdCarney/kiln
INSTALL_DIR="${KILN_INSTALL_DIR:-/Applications}"

# Everything runs from main, so a partially downloaded script does nothing.
main() {
  [ "$(uname -s)" = Darwin ] || fail "Kiln is a macOS app."

  # Check the folder first, so a bad path fails before anything is downloaded or quit.
  # Expand a quoted ~ ("~/Applications"), create the folder if needed, and make it absolute.
  local dir="$INSTALL_DIR"
  case "$dir" in
    '~') dir="$HOME" ;;
    '~/'*) dir="$HOME/${dir#'~/'}" ;;
  esac
  mkdir -p "$dir" 2>/dev/null || fail "Can't create $dir."
  dir="$(cd "$dir" && pwd)"
  [ -w "$dir" ] || fail "Can't write to $dir. Use an administrator account, or set KILN_INSTALL_DIR=~/Applications."
  local target="$dir/Kiln.app"

  # uname -m says x86_64 in a shell running under Rosetta, so ask the hardware instead.
  local arch=x64
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then arch=arm64; fi

  # Global, not local: the EXIT trap runs after main has returned.
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  local url="https://github.com/$REPO/releases/latest/download/Kiln-$arch.zip"
  echo "Downloading $url"
  curl -fL --progress-bar -o "$tmp/Kiln.zip" "$url"
  ditto -x -k "$tmp/Kiln.zip" "$tmp"
  [ -d "$tmp/Kiln.app" ] || fail "The download didn't contain Kiln.app."
  xattr -dr com.apple.quarantine "$tmp/Kiln.app" 2>/dev/null || true

  if running; then
    echo "Quitting Kiln"
    osascript -e 'quit app "Kiln"' || true
    for _ in $(seq 20); do running || break; sleep 0.5; done
    if running; then fail "Kiln is still running. Quit it and run this again."; fi
  fi

  rm -rf "$target"
  ditto "$tmp/Kiln.app" "$target"
  echo "Installed $target ($arch)"
  open "$target"
}

running() { pgrep -f 'Kiln.app/Contents/MacOS/Kiln' >/dev/null; }

fail() {
  echo "Error: $1" >&2
  exit 1
}

main "$@"
