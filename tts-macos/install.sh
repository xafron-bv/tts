#!/bin/bash
set -e

echo "Installing tts-read dependencies..."
pip3 install --user numpy sounddevice websockets

if ! command -v brew &>/dev/null; then
  echo "Warning: Homebrew not found. Install portaudio manually."
elif ! brew list portaudio &>/dev/null 2>&1; then
  echo "Installing portaudio..."
  brew install portaudio
else
  echo "portaudio already installed."
fi

# Symlink to ~/.local/bin (no sudo needed)
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"

TARGET="$BIN_DIR/tts-read"
SCRIPT="$(cd "$(dirname "$0")" && pwd)/tts-read"

ln -sf "$SCRIPT" "$TARGET"
echo "Linked $TARGET -> $SCRIPT"

# Check if ~/.local/bin is in PATH
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
  SHELL_NAME="$(basename "$SHELL")"
  case "$SHELL_NAME" in
    zsh)  RC="$HOME/.zshrc" ;;
    bash) RC="$HOME/.bash_profile" ;;
    *)    RC="$HOME/.profile" ;;
  esac

  echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$RC"
  echo "Added ~/.local/bin to PATH in $RC"
  echo "Run: source $RC   (or open a new terminal)"
fi

echo ""
echo "Done! Run: tts-read --setup"
