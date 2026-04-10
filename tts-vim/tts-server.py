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
from pathlib import Path

import numpy as np
import sounddevice as sd
import websockets

CONFIG_FILE = Path.home() / ".config" / "tts-reader" / "config.json"
SAMPLE_RATE = 24000
MAX_RETRIES = 4
BASE_RETRY_DELAY = 0.5
PREFETCH_AHEAD = 2


def emit(event, **kwargs):
    sys.stdout.write(json.dumps({"event": event, **kwargs}) + "\n")
    sys.stdout.flush()


def load_config():
    if CONFIG_FILE.exists():
        return json.loads(CONFIG_FILE.read_text())
    return {}


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

        try:
            async with websockets.connect(
                self.config["ws_url"],
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
        except Exception as e:
            if "websockets" in type(e).__module__:
                emit("error", message=f"WebSocket error — run tts-read --login to refresh")
            else:
                emit("error", message=str(e))
        finally:
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
            "t": self.sentences[idx], "responseId": rid,
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
