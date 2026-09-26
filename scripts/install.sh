#!/bin/bash
# Install or upgrade Ollmost from the latest GitHub release, then open it.
#   curl -fsSL https://raw.githubusercontent.com/EdCarney/ollmost/main/scripts/install.sh | bash
# Set OLLMOST_INSTALL_DIR to install somewhere other than /Applications:
#   curl -fsSL .../install.sh | OLLMOST_INSTALL_DIR=~/Applications bash
# Your data in ~/Library/Application Support/Ollmost is untouched.
# Coming from Kiln: Ollmost moves Kiln's data on its first launch, and this removes Kiln.app afterwards.
#
# curl doesn't set the quarantine flag that a browser download gets, so macOS doesn't block
# the unsigned app.
set -euo pipefail

REPO=EdCarney/ollmost
INSTALL_DIR="${OLLMOST_INSTALL_DIR:-/Applications}"

# Everything runs from main, so a partially downloaded script does nothing.
main() {
  [ "$(uname -s)" = Darwin ] || fail "Ollmost is a macOS app."

  # Check the folder first, so a bad path fails before anything is downloaded or quit.
  # Expand a quoted ~ ("~/Applications"), create the folder if needed, and make it absolute.
  local dir="$INSTALL_DIR"
  case "$dir" in
    '~') dir="$HOME" ;;
    '~/'*) dir="$HOME/${dir#'~/'}" ;;
  esac
  mkdir -p "$dir" 2>/dev/null || fail "Can't create $dir."
  dir="$(cd "$dir" && pwd)"
  [ -w "$dir" ] || fail "Can't write to $dir. Use an administrator account, or set OLLMOST_INSTALL_DIR=~/Applications."
  local target="$dir/Ollmost.app"

  # uname -m says x86_64 in a shell running under Rosetta, so ask the hardware instead.
  local arch=x64
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then arch=arm64; fi

  # Global, not local: the EXIT trap runs after main has returned.
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  local url="https://github.com/$REPO/releases/latest/download/Ollmost-$arch.zip"
  echo "Downloading $url"
  curl -fL --progress-bar -o "$tmp/Ollmost.zip" "$url"
  ditto -x -k "$tmp/Ollmost.zip" "$tmp"
  [ -d "$tmp/Ollmost.app" ] || fail "The download didn't contain Ollmost.app."
  xattr -dr com.apple.quarantine "$tmp/Ollmost.app" 2>/dev/null || true

  if running; then
    echo "Quitting Ollmost"
    osascript -e 'quit app "Ollmost"' || true
    for _ in $(seq 20); do running || break; sleep 0.5; done
    if running; then fail "Ollmost is still running. Quit it and run this again."; fi
  fi

  # Kiln was renamed Ollmost (#60). Ollmost moves Kiln's data on its first launch, which needs Kiln closed.
  if kiln_running; then
    echo "Quitting Kiln"
    osascript -e 'quit app "Kiln"' || true
    for _ in $(seq 20); do kiln_running || break; sleep 0.5; done
    if kiln_running; then fail "Kiln is still running. Quit it and run this again."; fi
  fi

  rm -rf "$target"
  ditto "$tmp/Ollmost.app" "$target"
  echo "Installed $target ($arch)"
  open "$target"
  remove_kiln "$dir"
}

running() { pgrep -f 'Ollmost.app/Contents/MacOS/Ollmost' >/dev/null; }

kiln_running() { pgrep -f 'Kiln.app/Contents/MacOS/Kiln' >/dev/null; }

# Remove Kiln.app from the install folder once Ollmost has moved Kiln's data (on its first launch), and only if it
# really is Kiln, not another app with that name.
remove_kiln() {
  local old="$1/Kiln.app" data="$HOME/Library/Application Support/Kiln"
  [ -d "$old" ] || return 0
  [ "$(defaults read "$old/Contents/Info" CFBundleIdentifier 2>/dev/null)" = local.kiln.app ] || return 0
  for _ in $(seq 120); do [ -e "$data/kiln.db" ] || break; sleep 0.5; done
  if [ -e "$data/kiln.db" ]; then
    echo "Kept $old: your Kiln data hasn't moved yet. Open Ollmost, and delete Kiln.app once your chats show up."
  else
    rm -rf "$old"
    echo "Removed $old (Kiln is now Ollmost)"
  fi
}

fail() {
  echo "Error: $1" >&2
  exit 1
}

main "$@"
