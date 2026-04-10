#!/bin/bash
set -e

echo "Installing tts-read dependencies..."

if ! command -v brew &>/dev/null; then
  echo "Warning: Homebrew not found. Install portaudio manually."
elif ! brew list portaudio &>/dev/null 2>&1; then
  echo "Installing portaudio..."
  brew install portaudio
else
  echo "portaudio already installed."
fi

VENV_DIR="$HOME/.local/share/tts-reader/venv"
if [ ! -d "$VENV_DIR" ]; then
  echo "Creating virtual environment..."
  python3 -m venv "$VENV_DIR"
fi
echo "Installing Python packages..."
"$VENV_DIR/bin/pip" install --upgrade numpy sounddevice websockets

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

# ── Config agent (receives fresh WebSocket URLs from Chrome extension) ──
AGENT_LABEL="com.tts-reader.config-agent"
PLIST="$HOME/Library/LaunchAgents/${AGENT_LABEL}.plist"
AGENT_SCRIPT="$(cd "$(dirname "$0")" && pwd)/tts-config-agent"

# Stop old agent if running
launchctl bootout "gui/$(id -u)/${AGENT_LABEL}" 2>/dev/null || true

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${VENV_DIR}/bin/python3</string>
    <string>${AGENT_SCRIPT}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>/tmp/tts-config-agent.log</string>
</dict>
</plist>
PLIST

launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Config agent installed and running."

echo ""
echo "Done! Run: tts-read --login"
