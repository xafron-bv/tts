# TTS Reader

Read any text aloud using NaturalReaders' HD Pro voices. Streams audio with sentence prefetching for near-zero gaps. Retries on failure with exponential backoff.

Requires a [NaturalReaders](https://www.naturalreaders.com) account and the Chrome extension to stay authenticated.

## Chrome Extension (`tts-reader/`)

Reads the current webpage aloud with a floating player bar.

### Install

1. Go to `chrome://extensions`, enable **Developer mode**
2. Click **Load unpacked**, select the `tts-reader/` folder

### Setup

3. Visit [naturalreaders.com](https://www.naturalreaders.com) and play any voice — the extension auto-captures the WebSocket URL, email, voice, speed, and reading style
4. Open the extension popup to verify settings are populated

### Use

- Click the extension icon → **Start Reading** (reads the current page)
- Or press **Alt+R** to toggle
- Select text first to read only that selection

### Controls

| Key | Action |
|-----|--------|
| Space | Play / Pause |
| ← → | Previous / Next sentence |
| Esc | Close reader |

Click the speed button to cycle through 1x–3x. Click the progress bar to jump to any sentence.

---

## macOS CLI (`tts-macos/`)

Read text from clipboard, files, or stdin. Works great with vim and terminal workflows.

### Install

```bash
cd tts-macos
./install.sh          # installs deps, config agent, symlinks tts-read to ~/.local/bin
tts-read --login      # opens NaturalReaders, auto-imports config from extension
```

`install.sh` creates a Python venv at `~/.local/share/tts-reader/venv/`, installs a background config agent as a launchd service, and symlinks `tts-read` to `~/.local/bin`.

`--login` opens NaturalReaders in your browser — play any voice and the Chrome extension pushes the config automatically. To edit settings manually: `~/.config/tts-reader/config.json`.

Requires Python 3 and Homebrew (for portaudio).

### Use

```bash
tts-read                        # read clipboard
tts-read file.txt               # read a file
echo "hello" | tts-read         # pipe text
tts-read -s 2 -v puck           # 2x speed, different voice
```

### Keyboard controls

| Key | Action |
|-----|--------|
| Space | Pause / Resume |
| j | Next sentence |
| k | Previous sentence |
| ] | Speed up |
| [ | Speed down |
| q | Quit |

Controls are available when running in a terminal. When piped from a macOS Shortcut (no terminal), playback runs non-interactively.

### Global shortcut

1. Open **Shortcuts.app** → click **+** to create a new shortcut
2. Name it something like "Read Aloud"
3. Add a **Run Shell Script** action (search for it in the actions sidebar)
4. Set the shell to `/bin/zsh` and paste:
   ```
   export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
   saved="$(pbpaste)"
   osascript -e 'tell application "System Events" to keystroke "c" using command down'
   sleep 0.2
   pbpaste | tts-read
   echo -n "$saved" | pbcopy
   ```
5. In the shortcut's info panel (ⓘ), check **Use as Quick Action** → **Services Menu**
6. Go to **System Settings → Keyboard → Keyboard Shortcuts → Services → General**, find your shortcut and assign a key (e.g. ⌥R)
7. Grant Shortcuts accessibility access: **System Settings → Privacy & Security → Accessibility** → enable **Shortcuts**

Select text in any app and press your shortcut — it copies the selection, reads it aloud, then restores your previous clipboard contents.

The `PATH` export is needed because Shortcuts doesn't inherit your shell profile, so it won't find `tts-read` or Homebrew-installed dependencies like `python3` otherwise.

---

## Vim / Neovim Plugin (`tts-vim/`)

Read text aloud from inside vim with sentence highlighting and playback controls.

### Install

**vim-plug:**
```vim
Plug 'xafron-bv/tts', { 'rtp': 'tts-vim' }
```
Then `:PlugInstall`.

**Manual / symlink:**
```bash
# vim
ln -s ~/devel/tts/tts-vim ~/.vim/pack/tts/start/tts-vim

# neovim
ln -s ~/devel/tts/tts-vim ~/.local/share/nvim/site/pack/tts/start/tts-vim
```

Uses the same venv and config as the CLI — install the macOS CLI first (`./install.sh` + `tts-read --login`).

### Controls

| Mapping | Command | Action |
|---------|---------|--------|
| `<Leader>tt` | `:TTSPlay` | Read buffer (or visual selection) |
| `<Leader>tg` | `:.,$TTSPlay` | Read from current line to end |
| `<Leader>tp` | `:TTSPause` | Toggle pause / resume |
| `<Leader>tj` | `:TTSNext` | Next sentence |
| `<Leader>tk` | `:TTSPrev` | Previous sentence |
| `<Leader>t]` | | Speed up |
| `<Leader>t[` | | Speed down |
| `<Leader>tq` | `:TTSStop` | Stop |

The current sentence is highlighted and the view scrolls to follow. Set `let g:tts_no_mappings = 1` to disable default mappings and define your own.

---

## How authentication works

NaturalReaders uses a signed WebSocket URL with temporary AWS credentials that expire after a few hours. The Chrome extension is required to keep the CLI and vim plugin authenticated.

When you visit naturalreaders.com, the extension intercepts the fresh WebSocket URL and pushes it to a local config agent (`localhost:18412`). The agent writes it to `~/.config/tts-reader/config.json`. The CLI and vim plugin re-read this file before each connection, so they always use the latest URL.

This means authentication stays fresh automatically as long as:
1. The Chrome extension is installed
2. You visit naturalreaders.com occasionally (the URL refreshes on each visit)
3. The config agent is running (`install.sh` sets it up as a launchd service)

If connections start failing with a 403, just open naturalreaders.com in Chrome — the extension will push a fresh URL to the config agent within seconds. Run `tts-read --login` for first-time setup.
