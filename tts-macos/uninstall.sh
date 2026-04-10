#!/bin/bash
set -e

echo "Uninstalling tts-read..."

# Remove symlink
LINK="$HOME/.local/bin/tts-read"
if [ -L "$LINK" ]; then
  rm "$LINK"
  echo "  Removed $LINK"
fi

# Remove config
CONFIG_DIR="$HOME/.config/tts-reader"
if [ -d "$CONFIG_DIR" ]; then
  read -p "  Remove config ($CONFIG_DIR)? [y/N] " answer
  if [[ "$answer" =~ ^[Yy]$ ]]; then
    rm -rf "$CONFIG_DIR"
    echo "  Removed $CONFIG_DIR"
  else
    echo "  Kept $CONFIG_DIR"
  fi
fi

# Remove pip packages
read -p "  Uninstall Python packages (numpy, sounddevice, websockets)? [y/N] " answer
if [[ "$answer" =~ ^[Yy]$ ]]; then
  pip3 uninstall -y numpy sounddevice websockets 2>/dev/null || true
  echo "  Packages removed"
else
  echo "  Kept packages"
fi

echo ""
echo "Done."
