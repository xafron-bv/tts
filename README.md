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

`--login` starts a local server, opens NaturalReaders in your browser — play any voice and the Chrome extension pushes the config automatically. Alternatively, use `--setup` for manual config entry.

Requires Python 3, Homebrew, and `pip3 install numpy sounddevice websockets && brew install portaudio`.

### Use

```bash
tts-read                        # read clipboard
tts-read file.txt               # read a file
echo "hello" | tts-read         # pipe text
tts-read -s 2 -v puck           # 2x speed, different voice
```

### Vim

```vim
:w !tts-read                    " read current buffer
:'<,'>w !tts-read               " read selection

" .vimrc mapping
vnoremap <leader>r :w !tts-read<CR>
nnoremap <leader>r :w !tts-read<CR>
```

### Global shortcut

**skhd** — add to `~/.skhdrc`:
```
alt - r : pbpaste | ~/.local/bin/tts-read
```

**macOS Shortcuts** — create a shortcut running `pbpaste | ~/.local/bin/tts-read`, assign a key in System Settings → Keyboard → Shortcuts → Services.

---

## Config

The Chrome extension stores settings in `chrome.storage.local` (auto-captured from naturalreaders.com). The CLI stores settings at `~/.config/tts-reader/config.json`.

Use `tts-read --login` to auto-import config from the Chrome extension — no manual copy-pasting needed.

The WebSocket URL contains temporary AWS credentials that expire. When connections start failing, run `tts-read --login` again (or revisit naturalreaders.com) to refresh.
