# TTS Reader

Read any text aloud using NaturalReaders' HD Pro voices. Streams audio with sentence prefetching for near-zero gaps. Retries on failure with exponential backoff.

Requires a [NaturalReaders](https://www.naturalreaders.com) account.

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
./install.sh          # installs deps, symlinks tts-read to ~/.local/bin
tts-read --login      # opens NaturalReaders, auto-imports config from extension
```

`--login` starts a local server, opens NaturalReaders in your browser — play any voice and the Chrome extension pushes the config automatically. To edit settings manually: `~/.config/tts-reader/config.json`.

Requires Python 3, Homebrew, and `pip3 install numpy sounddevice websockets && brew install portaudio`.

### Use

```bash
tts-read                        # read clipboard
tts-read file.txt               # read a file
echo "hello" | tts-read         # pipe text
tts-read -s 2 -v puck           # 2x speed, different voice
```

### Global shortcut

**skhd** — add to `~/.skhdrc`:
```
alt - r : pbpaste | ~/.local/bin/tts-read
```

**macOS Shortcuts** (no extra tools needed):

1. Open **Shortcuts.app** → click **+** to create a new shortcut
2. Name it something like "Read Clipboard Aloud"
3. Add a **Run Shell Script** action (search for it in the actions sidebar)
4. Set the shell to `/bin/zsh` and paste:
   ```
   export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
   pbpaste | tts-read
   ```
5. In the shortcut's info panel (ⓘ), check **Use as Quick Action** → **Services Menu**
6. Go to **System Settings → Keyboard → Keyboard Shortcuts → Services → General**, find your shortcut and assign a key (e.g. ⌥R)

The `PATH` export is needed because Shortcuts doesn't inherit your shell profile, so it won't find `tts-read` or Homebrew-installed dependencies like `python3` otherwise.

---

## Vim / Neovim Plugin (`tts-vim/`)

Read text aloud from inside vim with sentence highlighting and playback controls.

### Install

**vim-plug:**
```vim
Plug 'xafron-bv/tts', { 'rtp': 'tts-vim', 'do': 'pip3 install --user numpy sounddevice websockets' }
```
Then `:PlugInstall`.

**Manual / symlink:**
```bash
# vim
ln -s ~/devel/tts/tts-vim ~/.vim/pack/tts/start/tts-vim

# neovim
ln -s ~/devel/tts/tts-vim ~/.local/share/nvim/site/pack/tts/start/tts-vim
```

Same Python dependencies as the CLI (`pip3 install numpy sounddevice websockets && brew install portaudio`). Uses the same config at `~/.config/tts-reader/config.json` — run `tts-read --login` first if you haven't.

### Controls

| Mapping | Command | Action |
|---------|---------|--------|
| `<Leader>tr` | `:TTSPlay` | Read buffer (or visual selection) |
| `<Leader>tf` | `:.,$TTSPlay` | Read from current line to end |
| `<Leader>tp` | `:TTSPause` | Toggle pause / resume |
| `<Leader>tn` | `:TTSNext` | Next sentence |
| `<Leader>tb` | `:TTSPrev` | Previous sentence |
| `<Leader>t]` | | Speed up |
| `<Leader>t[` | | Speed down |
| `<Leader>ts` | `:TTSStop` | Stop |

The current sentence is highlighted and the view scrolls to follow. Set `let g:tts_no_mappings = 1` to disable default mappings and define your own.

---

## Config

The Chrome extension stores settings in `chrome.storage.local` (auto-captured from naturalreaders.com). The CLI stores settings at `~/.config/tts-reader/config.json`.

Use `tts-read --login` to auto-import config from the Chrome extension — no manual copy-pasting needed.

The WebSocket URL contains temporary AWS credentials that expire. When connections start failing, run `tts-read --login` again (or revisit naturalreaders.com) to refresh.
