#!/bin/bash
set -e

echo "Installing tts-read dependencies..."
pip3 install numpy sounddevice websockets

if ! command -v brew &>/dev/null; then
  echo "Warning: Homebrew not found. Install portaudio manually."
elif ! brew list portaudio &>/dev/null 2>&1; then
  echo "Installing portaudio..."
  brew install portaudio
else
  echo "portaudio already installed."
fi

# Symlink to /usr/local/bin
TARGET="/usr/local/bin/tts-read"
SCRIPT="$(cd "$(dirname "$0")" && pwd)/tts-read"

if [ -L "$TARGET" ] || [ -e "$TARGET" ]; then
  echo "Updating $TARGET -> $SCRIPT"
  ln -sf "$SCRIPT" "$TARGET"
else
  echo "Linking $TARGET -> $SCRIPT"
  ln -s "$SCRIPT" "$TARGET"
fi

echo ""
echo "Done! Run: tts-read --setup"
