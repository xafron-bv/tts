#!/usr/bin/env python3
"""TTS playback server for the vim plugin. JSON-line protocol over stdin/stdout."""

import sys
import json
import asyncio
import threading
import queue
import base64
import uuid
import re
import time
from pathlib import Path

import hashlib
import hmac as hmac_mod
from datetime import datetime, timezone
from urllib.parse import quote

import numpy as np
import sounddevice as sd
import websockets
import websockets.exceptions

CONFIG_FILE = Path.home() / ".config" / "tts-reader" / "config.json"
SAMPLE_RATE = 24000
MAX_RETRIES = 4
MAX_CONNECT_RETRIES = 3
BASE_RETRY_DELAY = 0.5
PREFETCH_AHEAD = 2
EXPIRATION_SKEW_S = 30
DEFAULT_WS_BASE = "wss://xujs4waht8.execute-api.us-east-1.amazonaws.com/prod-wpro/"


def emit(event, **kwargs):
    sys.stdout.write(json.dumps({"event": event, **kwargs}) + "\n")
    sys.stdout.flush()


def load_config():
    if CONFIG_FILE.exists():
        return json.loads(CONFIG_FILE.read_text())
    return {}


def strip_markdown(text):
    """Remove markdown formatting for cleaner TTS reading."""
    # Fenced code blocks
    text = re.sub(r'```[^\n]*\n.*?```', '', text, flags=re.DOTALL)
    text = re.sub(r'~~~[^\n]*\n.*?~~~', '', text, flags=re.DOTALL)
    # Inline code — keep content, strip backticks
    text = re.sub(r'`([^`]+)`', r'\1', text)
    # Images
    text = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', text)
    # Links [text](url) → text
    text = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', text)
    # Reference-style links [text][ref] → text
    text = re.sub(r'\[([^\]]+)\]\[[^\]]*\]', r'\1', text)
    # Footnote definitions
    text = re.sub(r'^\[\^[^\]]+\]:\s*.*$', '', text, flags=re.MULTILINE)
    # Footnote references
    text = re.sub(r'\[\^[^\]]+\]', '', text)
    # Header markers (with or without space, and trailing #)
    text = re.sub(r'^#{1,6}\s*', '', text, flags=re.MULTILINE)
    text = re.sub(r'\s*#{1,6}\s*$', '', text, flags=re.MULTILINE)
    # Horizontal rules
    text = re.sub(r'^\s*[-*_]{3,}\s*$', '', text, flags=re.MULTILINE)
    # Bold/italic (order matters: bold first, then italic)
    text = re.sub(r'\*\*\*(.+?)\*\*\*', r'\1', text)
    text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
    text = re.sub(r'___(.+?)___', r'\1', text)
    text = re.sub(r'__(.+?)__', r'\1', text)
    text = re.sub(r'\*(.+?)\*', r'\1', text)
    text = re.sub(r'(?<!\w)_(.+?)_(?!\w)', r'\1', text)
    text = re.sub(r'~~(.+?)~~', r'\1', text)
    # List markers (unordered and ordered)
    text = re.sub(r'^[ \t]*[-*+]\s+', '', text, flags=re.MULTILINE)
    text = re.sub(r'^[ \t]*\d+[.)]\s+', '', text, flags=re.MULTILINE)
    # Blockquote markers
    text = re.sub(r'^(?:>\s?)+', '', text, flags=re.MULTILINE)
    # HTML tags
    text = re.sub(r'<[^>]+>', '', text)
    # Strip any remaining backticks, stray asterisks, underscores used as emphasis
    text = re.sub(r'`', '', text)
    text = re.sub(r'(?<!\w)\*+(?!\w)', '', text)
    text = re.sub(r'(?<!\w)_+(?!\w)', '', text)
    return text


def sign_wss_url(base_url, creds):
    """Sign a WebSocket URL using AWS Signature V4."""
    from urllib.parse import urlparse

    parsed = urlparse(base_url)
    host = parsed.hostname
    if parsed.port:
        host += f":{parsed.port}"
    path = parsed.path or "/"
    region = "us-east-1"
    service = "execute-api"

    now = datetime.now(timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    cred_scope = f"{date_stamp}/{region}/{service}/aws4_request"

    qs_params = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": f"{creds['access_key']}/{cred_scope}",
        "X-Amz-Date": amz_date,
        "X-Amz-SignedHeaders": "host",
    }
    if creds.get("session_token"):
        qs_params["X-Amz-Security-Token"] = creds["session_token"]

    canonical_qs = "&".join(
        f"{quote(k, safe='')}={quote(v, safe='')}"
        for k, v in sorted(qs_params.items())
    )

    canonical_request = "\n".join([
        "GET", path, canonical_qs,
        f"host:{host}", "",
        "host",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ])

    cr_hash = hashlib.sha256(canonical_request.encode()).hexdigest()
    string_to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, cred_scope, cr_hash])

    def hmac_sha256(key, msg):
        return hmac_mod.new(key, msg.encode("utf-8"), hashlib.sha256).digest()

    k_date = hmac_sha256(("AWS4" + creds["secret_key"]).encode("utf-8"), date_stamp)
    k_region = hmac_mod.new(k_date, region.encode(), hashlib.sha256).digest()
    k_service = hmac_mod.new(k_region, service.encode(), hashlib.sha256).digest()
    k_signing = hmac_mod.new(k_service, b"aws4_request", hashlib.sha256).digest()
    sig = hmac_mod.new(k_signing, string_to_sign.encode(), hashlib.sha256).hexdigest()

    return f"wss://{host}{path}?{canonical_qs}&X-Amz-Signature={sig}"


def parse_expiration_epoch(expiration):
    if expiration is None:
        return None
    if isinstance(expiration, (int, float)):
        return expiration / 1000 if expiration > 1e12 else float(expiration)
    try:
        return datetime.fromisoformat(str(expiration).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return None


def creds_expired(creds):
    if not creds or not creds.get("access_key"):
        return True
    exp = parse_expiration_epoch(creds.get("expiration"))
    if exp is None:
        return False
    return time.time() + EXPIRATION_SKEW_S >= exp


def creds_stale(config):
    creds = config.get("aws_credentials")
    if not creds or not creds.get("access_key"):
        return not config.get("ws_url")
    return creds_expired(creds)


def get_ws_url(config):
    """Get a signed WebSocket URL from config, signing fresh if credentials are available."""
    creds = config.get("aws_credentials")
    if creds and creds.get("access_key") and not creds_expired(creds):
        base = config.get("ws_base_url", DEFAULT_WS_BASE)
        return sign_wss_url(base, creds)
    return config.get("ws_url", "")


async def auto_login(timeout=30):
    """Open NaturalReaders and wait for the config agent to push fresh credentials."""
    import webbrowser
    import urllib.request
    import urllib.error
    try:
        urllib.request.urlopen("http://127.0.0.1:18412/config", timeout=1)
    except urllib.error.HTTPError:
        pass
    except urllib.error.URLError:
        emit("error", message="Config agent not running; run: bash tts-macos/install.sh")
        return False

    before = CONFIG_FILE.stat().st_mtime if CONFIG_FILE.exists() else 0
    emit("error", message="Refreshing credentials — opening NaturalReaders…")
    webbrowser.open("https://www.naturalreaders.com/online/")

    deadline = time.time() + timeout
    while time.time() < deadline:
        await asyncio.sleep(0.5)
        if CONFIG_FILE.exists() and CONFIG_FILE.stat().st_mtime > before:
            return True
    return False


def split_sentences(text):
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []
    raw = re.findall(r'[^.!?]+(?:[.!?]+["\'\u201d\u2019)}\]]*\s*|$)', text)
    result = []
    for s in raw:
        t = s.strip()
        if not t:
            continue
        if len(t) <= 600:
            result.append(t)
            continue
        remaining = t
        while len(remaining) > 600:
            i = remaining.rfind(", ", 0, 600)
            if i < 200:
                i = remaining.rfind("; ", 0, 600)
            if i < 200:
                i = remaining.rfind(" ", 0, 600)
            if i < 100:
                i = 600
            result.append(remaining[: i + 1].strip())
            remaining = remaining[i + 1 :].strip()
        if remaining:
            result.append(remaining)
    return [s for s in result if len(s) >= 2]


def base64_to_pcm(b64):
    raw = base64.b64decode(b64)
    return (np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0).reshape(
        -1, 1
    )


def audio_worker(audio_q, pause_event):
    try:
        stream = sd.OutputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32")
        stream.start()
        while True:
            pause_event.wait()
            item = audio_q.get()
            if item is None:
                break
            if isinstance(item, tuple) and item[0] == "marker":
                item[1].set()
                continue
            stream.write(item)
        stream.stop()
        stream.close()
    except Exception as e:
        emit("error", message=f"Audio: {e}")


class TTSServer:
    def __init__(self):
        self.config = load_config()
        self.sentences = []
        self.current_idx = 0
        self.speed = self.config.get("speed", 1.5)
        self.stop_requested = False
        self.jumped = False

        self.cmd_queue = asyncio.Queue()
        self.audio_q = queue.Queue()
        self.pause_event = threading.Event()
        self.pause_event.set()

        self.ws = None
        self.ws_state = {}
        self.rid_for = {}
        self.recv_task = None
        self.audio_thread = None

    # ── Main loop ─────────────────────────────────────────────

    async def run(self):
        loop = asyncio.get_event_loop()

        def on_stdin():
            line = sys.stdin.readline()
            if not line:
                self.cmd_queue.put_nowait({"cmd": "quit"})
                return
            line = line.strip()
            if line:
                try:
                    self.cmd_queue.put_nowait(json.loads(line))
                except json.JSONDecodeError:
                    pass

        loop.add_reader(sys.stdin.fileno(), on_stdin)
        emit("ready")

        try:
            while True:
                cmd = await self.cmd_queue.get()
                if cmd["cmd"] == "quit":
                    break
                elif cmd["cmd"] == "play":
                    await self.handle_play(cmd)
        finally:
            loop.remove_reader(sys.stdin.fileno())
            self.cleanup()

    # ── Play orchestration ────────────────────────────────────

    async def handle_play(self, cmd):
        self.teardown_playback()

        self.sentences = split_sentences(cmd.get("text", ""))
        if not self.sentences:
            emit("error", message="No readable text")
            return

        self.current_idx = 0
        self.stop_requested = False
        self.speed = cmd.get("speed", self.speed)

        emit("sentences", total=len(self.sentences))

        self.pause_event.set()
        self.audio_thread = threading.Thread(
            target=audio_worker, args=(self.audio_q, self.pause_event), daemon=True
        )
        self.audio_thread.start()

        last_error = None
        for attempt in range(1, MAX_CONNECT_RETRIES + 1):
            self.config = load_config()

            if creds_stale(self.config):
                if not await auto_login():
                    last_error = "Could not refresh credentials"
                    break
                self.config = load_config()

            ws_url = get_ws_url(self.config)
            if not ws_url:
                last_error = "No WebSocket URL available"
                break

            try:
                async with websockets.connect(
                    ws_url,
                    origin="https://www.naturalreaders.com",
                    user_agent_header="Mozilla/5.0",
                    close_timeout=5,
                ) as ws:
                    self.ws = ws
                    self.recv_task = asyncio.create_task(self.receiver())

                    for i in range(min(PREFETCH_AHEAD + 1, len(self.sentences))):
                        await self.send_tts(i)

                    await self.play_loop()

                    self.recv_task.cancel()
                    try:
                        await self.recv_task
                    except asyncio.CancelledError:
                        pass
                break
            except (websockets.exceptions.ConnectionClosed, OSError) as e:
                last_error = e
            except Exception as e:
                if "websockets" in type(e).__module__:
                    last_error = e
                else:
                    emit("error", message=str(e))
                    last_error = e
                    break

            if attempt < MAX_CONNECT_RETRIES:
                emit("error", message=f"Connection attempt {attempt}/{MAX_CONNECT_RETRIES} failed ({last_error}), retrying…")
                await asyncio.sleep(BASE_RETRY_DELAY * (2 ** (attempt - 1)))
            else:
                emit("error", message=f"Failed to connect after {MAX_CONNECT_RETRIES} attempts: {last_error}")

        self.ws = None
        self.audio_q.put(None)
        if self.audio_thread:
            self.audio_thread.join(timeout=5)
        self.audio_thread = None
        self.ws_state.clear()
        self.rid_for.clear()
        emit("finished" if not self.stop_requested else "stopped")

    async def play_loop(self):
        while 0 <= self.current_idx < len(self.sentences) and not self.stop_requested:
            emit("playing", index=self.current_idx, text=self.sentences[self.current_idx])
            self.jumped = False

            play_task = asyncio.create_task(self.play_sentence(self.current_idx))

            while not play_task.done():
                cmd_task = asyncio.create_task(self.cmd_queue.get())
                done, _ = await asyncio.wait(
                    {play_task, cmd_task}, return_when=asyncio.FIRST_COMPLETED
                )

                if cmd_task in done:
                    if await self.handle_play_cmd(cmd_task.result(), play_task):
                        break
                else:
                    cmd_task.cancel()
                    try:
                        await cmd_task
                    except asyncio.CancelledError:
                        pass
                    break

            if not play_task.done():
                play_task.cancel()
                try:
                    await play_task
                except asyncio.CancelledError:
                    pass

            if self.stop_requested:
                break
            if not self.jumped:
                self.current_idx += 1

            pf = self.current_idx + PREFETCH_AHEAD
            if 0 <= pf < len(self.sentences) and pf not in self.rid_for:
                await self.send_tts(pf)

    async def handle_play_cmd(self, cmd, play_task):
        c = cmd.get("cmd")
        if c == "stop":
            self.stop_requested = True
            self.clear_audio()
            play_task.cancel()
            return True
        if c == "next":
            self.current_idx = min(self.current_idx + 1, len(self.sentences) - 1)
            self.jumped = True
            self.clear_audio()
            play_task.cancel()
            return True
        if c == "prev":
            self.current_idx = max(0, self.current_idx - 1)
            self.jumped = True
            self.clear_audio()
            old = self.rid_for.pop(self.current_idx, None)
            if old:
                self.ws_state.pop(old, None)
            play_task.cancel()
            return True
        if c == "pause":
            self.pause_event.clear()
            emit("paused", index=self.current_idx)
        elif c == "resume":
            self.pause_event.set()
            emit("resumed", index=self.current_idx)
        elif c == "speed":
            self.speed = cmd.get("value", self.speed)
            for idx in list(self.rid_for):
                if idx > self.current_idx:
                    self.ws_state.pop(self.rid_for.pop(idx), None)
            for i in range(1, PREFETCH_AHEAD + 1):
                pf = self.current_idx + i
                if 0 <= pf < len(self.sentences) and pf not in self.rid_for:
                    await self.send_tts(pf)
            emit("speed", value=self.speed)
        elif c == "play":
            self.stop_requested = True
            self.clear_audio()
            play_task.cancel()
            self.cmd_queue.put_nowait(cmd)
            return True
        return False

    # ── Single sentence playback ──────────────────────────────

    async def play_sentence(self, idx):
        if idx not in self.rid_for:
            await self.send_tts(idx)

        rid = self.rid_for[idx]
        s = self.ws_state[rid]
        queued = 0
        retries = 0

        while True:
            while queued < len(s["chunks"]):
                self.audio_q.put(s["chunks"][queued])
                queued += 1

            if s["done"]:
                break
            if s.get("error"):
                retries += 1
                if retries > MAX_RETRIES:
                    emit("error", message=f"Skipping sentence {idx + 1}")
                    break
                await asyncio.sleep(BASE_RETRY_DELAY * (2 ** (retries - 1)))
                self.ws_state.pop(self.rid_for.pop(idx, None), None)
                await self.send_tts(idx)
                rid = self.rid_for[idx]
                s = self.ws_state[rid]
                queued = 0
                continue

            s["event"].clear()
            try:
                await asyncio.wait_for(s["event"].wait(), timeout=30)
            except asyncio.TimeoutError:
                s["error"] = "Timeout"

        # Wait for audio to finish playing this sentence
        marker = threading.Event()
        self.audio_q.put(("marker", marker))
        while not marker.is_set():
            await asyncio.sleep(0.05)

    # ── WebSocket ─────────────────────────────────────────────

    async def send_tts(self, idx):
        if not self.ws or idx in self.rid_for:
            return
        rid = "tts-stream-" + str(uuid.uuid4())
        self.ws_state[rid] = {"chunks": [], "done": False, "error": None, "event": asyncio.Event()}
        self.rid_for[idx] = rid
        c = self.config
        await self.ws.send(json.dumps({
            "e": c.get("email", ""), "l": c.get("language", "23"),
            "rn": c.get("voice", "aoede"), "s": round(self.speed * 180),
            "v": c.get("provider", "vtx"), "vn": c.get("version", "10.8.26"),
            "sm": "true", "ca": "true", "af": "wav",
            "ins": ("Reading Style:\n" + c["instructions"]) if c.get("instructions") else "",
            "model": c.get("model", "25flash-default"), "gdr": c.get("gender", "f"),
            "t": strip_markdown(self.sentences[idx]), "responseId": rid,
        }))

    async def receiver(self):
        try:
            async for raw in self.ws:
                try:
                    data = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                rid = data.get("responseId")
                if not rid or rid not in self.ws_state:
                    continue
                s = self.ws_state[rid]
                ev = data.get("event")
                if ev == "Tts_AudioChunk":
                    s["chunks"].append(base64_to_pcm(data["audioContent"]))
                    s["event"].set()
                elif ev == "Tts_StreamingDone":
                    s["done"] = True
                    s["event"].set()
                elif ev == "Tts_Error":
                    s["error"] = data.get("errorMessage", "TTS error")
                    s["event"].set()
        except asyncio.CancelledError:
            pass
        except websockets.exceptions.ConnectionClosed:
            emit("error", message="WebSocket disconnected")

    # ── Helpers ───────────────────────────────────────────────

    def clear_audio(self):
        self.pause_event.set()
        while not self.audio_q.empty():
            try:
                self.audio_q.get_nowait()
            except queue.Empty:
                break

    def teardown_playback(self):
        self.stop_requested = True
        self.clear_audio()

    def cleanup(self):
        self.clear_audio()
        self.audio_q.put(None)
        if self.audio_thread:
            self.audio_thread.join(timeout=2)


if __name__ == "__main__":
    try:
        asyncio.run(TTSServer().run())
    except KeyboardInterrupt:
        pass
