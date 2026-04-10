#!/bin/bash
set -e

echo "Uninstalling tts-read..."

# Stop and remove config agent
AGENT_LABEL="com.tts-reader.config-agent"
PLIST="$HOME/Library/LaunchAgents/${AGENT_LABEL}.plist"
launchctl bootout "gui/$(id -u)/${AGENT_LABEL}" 2>/dev/null || true
if [ -f "$PLIST" ]; then
  rm "$PLIST"
  echo "  Removed config agent"
fi

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

# Remove venv
VENV_DIR="$HOME/.local/share/tts-reader/venv"
if [ -d "$VENV_DIR" ]; then
  read -p "  Remove virtual environment ($VENV_DIR)? [y/N] " answer
  if [[ "$answer" =~ ^[Yy]$ ]]; then
    rm -rf "$VENV_DIR"
    echo "  Removed $VENV_DIR"
  else
    echo "  Kept $VENV_DIR"
  fi
fi

echo ""
echo "Done."
