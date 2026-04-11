(function() {
  'use strict';
  if (window.__ttsReaderInit) return;
  window.__ttsReaderInit = true;

  const SAMPLE_RATE = 24000;
  const PREFETCH_AHEAD = 2;
  const MAX_RETRIES = 4;
  const BASE_RETRY_DELAY = 500; // ms
  const MAX_RECONNECT_ATTEMPTS = 3;
  const BASE_RECONNECT_DELAY = 2000; // ms
  const DEFAULT_WS_BASE = 'wss://xujs4waht8.execute-api.us-east-1.amazonaws.com/prod-wpro/';
  const EXPIRATION_SKEW_MS = 30000;

  // ── State ──────────────────────────────────────────────────────
  let config = null;
  let ws = null;
  let wsReconnecting = false;
  let reconnectAttempt = 0;
  let chunks = [];          // { text, element }[]
  let currentIdx = -1;
  let playing = false;
  let audioCtx = null;
  let scheduledEnd = 0;     // AudioContext time when current audio ends
  let activeSources = [];   // AudioBufferSourceNodes currently scheduled
  let sentenceBuffers = new Map(); // idx -> { responseId, pcm: Float32Array[], done, totalSamples }
  let responseToIdx = new Map();   // responseId -> sentence idx
  let retryCount = new Map();      // idx -> number of retries so far
  let retryTimers = new Map();     // idx -> setTimeout id
  let shadow = null;
  let playerHost = null;
  let highlightStyle = null;
  let onEndTimer = null;

  // ── AWS Sig V4 presigned URL for WebSocket ─────────────────────
  async function signWssUrl(baseUrl, creds) {
    const url = new URL(baseUrl);
    const host = url.host;
    const path = url.pathname || '/';
    const region = 'us-east-1';
    const service = 'execute-api';

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const credScope = `${dateStamp}/${region}/${service}/aws4_request`;

    const qsParams = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${creds.accessKeyId}/${credScope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-SignedHeaders': 'host',
    };
    if (creds.sessionToken) {
      qsParams['X-Amz-Security-Token'] = creds.sessionToken;
    }

    const canonicalQs = Object.keys(qsParams).sort()
      .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(qsParams[k]))
      .join('&');

    const canonicalReq = [
      'GET', path, canonicalQs,
      'host:' + host, '',
      'host',
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    ].join('\n');

    const crHash = await sha256Hex(canonicalReq);
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credScope, crHash].join('\n');

    const enc = s => new TextEncoder().encode(s);
    const kDate = await hmacSha256(enc('AWS4' + creds.secretAccessKey), enc(dateStamp));
    const kRegion = await hmacSha256(kDate, enc(region));
    const kService = await hmacSha256(kRegion, enc(service));
    const kSigning = await hmacSha256(kService, enc('aws4_request'));
    const sig = bufToHex(await hmacSha256(kSigning, enc(stringToSign)));

    return `wss://${host}${path}?${canonicalQs}&X-Amz-Signature=${sig}`;
  }

  async function hmacSha256(key, data) {
    const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
  }

  async function sha256Hex(str) {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return bufToHex(new Uint8Array(h));
  }

  function bufToHex(buf) {
    return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
  }

  function parseExpirationMs(expiration) {
    if (!expiration) return null;
    if (typeof expiration === 'number' && Number.isFinite(expiration)) {
      return expiration > 1e12 ? expiration : expiration * 1000;
    }
    const parsed = Date.parse(expiration);
    return Number.isNaN(parsed) ? null : parsed;
  }

  function credsValid(creds) {
    if (!creds?.accessKeyId) return false;
    const expirationMs = parseExpirationMs(creds.expiration);
    if (expirationMs === null) return !creds.expiration;
    return Date.now() + EXPIRATION_SKEW_MS < expirationMs;
  }

  async function ensureConnectionData() {
    let data = await chrome.storage.local.get(['awsCredentials', 'wsBaseUrl', 'wsUrl', 'ttsSettings']);

    if (!credsValid(data.awsCredentials)) {
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'REFRESH_CREDENTIALS' });
        if (resp?.ok) {
          data = await chrome.storage.local.get(['awsCredentials', 'wsBaseUrl', 'wsUrl', 'ttsSettings']);
        }
      } catch {}
    }

    return data;
  }

  async function getSignedWsUrl() {
    const data = await ensureConnectionData();

    if (credsValid(data.awsCredentials)) {
      const base = data.wsBaseUrl || DEFAULT_WS_BASE;
      return signWssUrl(base, data.awsCredentials);
    }
    return data.wsUrl || null; // fallback to captured signed URL
  }

  // ── Capture bridge (naturalreaders.com) ────────────────────────
  if (location.hostname === 'www.naturalreaders.com') {
    window.addEventListener('message', (e) => {
      if (e.data?.type === 'TTS_READER_WS_CAPTURED') {
        chrome.storage.local.set({
          wsUrl: e.data.url,
          wsBaseUrl: e.data.baseUrl,
        });
        chrome.storage.local.get('ttsSettings', (d) => {
          chrome.runtime.sendMessage({
            type: 'PUSH_TO_CLI',
            config: { ws_url: e.data.url, ...(d.ttsSettings || {}) },
          });
        });
      }
      if (e.data?.type === 'TTS_READER_CREDENTIALS_CAPTURED') {
        chrome.storage.local.set({ awsCredentials: e.data.credentials });
        // Sign a fresh URL and push to CLI
        chrome.storage.local.get(['wsBaseUrl', 'ttsSettings'], async (d) => {
          const base = d.wsBaseUrl || DEFAULT_WS_BASE;
          try {
            const signedUrl = await signWssUrl(base, e.data.credentials);
            chrome.storage.local.set({ wsUrl: signedUrl });
            chrome.runtime.sendMessage({
              type: 'PUSH_TO_CLI',
              config: { ws_url: signedUrl, ...(d.ttsSettings || {}) },
            });
          } catch {}
        });
      }
      if (e.data?.type === 'TTS_READER_SETTINGS_CAPTURED') {
        const s = e.data.settings;
        const settings = {
          email: s.email,
          voice: s.voice,
          speed: s.speed,
          instructions: s.instructions,
          provider: s.provider,
          model: s.model,
          gender: s.gender,
          language: s.language,
          version: s.version,
        };
        chrome.storage.local.set({ ttsSettings: settings });
        chrome.storage.local.get(['wsUrl', 'awsCredentials', 'wsBaseUrl'], async (d) => {
          let wsUrl = d.wsUrl;
          if (!wsUrl && d.awsCredentials) {
            try { wsUrl = await signWssUrl(d.wsBaseUrl || DEFAULT_WS_BASE, d.awsCredentials); } catch {}
          }
          if (wsUrl) {
            chrome.runtime.sendMessage({
              type: 'PUSH_TO_CLI',
              config: { ws_url: wsUrl, ...settings },
            });
          }
        });
      }
    });
  }

  // ── Message listener ───────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'START_READER') startReader(msg.settings);
    if (msg.type === 'TOGGLE_READER') {
      if (playerHost) { playing ? pause() : resume(); }
      else startReader();
    }
  });

  async function startReader(settings) {
    const data = await ensureConnectionData();
    if (credsValid(data.awsCredentials) || data.wsUrl) {
      activate({ ...(data.ttsSettings || {}), ...(settings || {}) });
      return;
    }
    showNotConnectedHint();
  }

  function showNotConnectedHint() {
    const hint = document.createElement('div');
    hint.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);' +
      'background:#1a1a2e;color:#e0e0e0;padding:12px 24px;border-radius:10px;' +
      'font:13px -apple-system,system-ui,sans-serif;z-index:2147483647;' +
      'box-shadow:0 4px 16px rgba(0,0,0,0.4);max-width:420px;text-align:center;';
    hint.innerHTML = 'TTS Reader: Could not refresh NaturalReader session.<br><span style="font-size:11px;color:#999;">' +
      'Sign in at <b>naturalreaders.com</b> if this keeps happening.</span>';
    document.body.appendChild(hint);
    setTimeout(() => hint.remove(), 5000);
  }

  // ── Activate ───────────────────────────────────────────────────
  function activate(settings) {
    if (playerHost) { deactivate(); return; }
    config = settings;
    chunks = extractContent();
    if (!chunks.length) return;
    currentIdx = 0;
    audioCtx = new AudioContext();
    injectHighlightCSS();
    createPlayerUI();
    connectAndPlay();
  }

  function deactivate() {
    stopPlayback();
    if (ws) { ws.close(); ws = null; }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    if (playerHost) { playerHost.remove(); playerHost = null; shadow = null; }
    if (highlightStyle) { highlightStyle.remove(); highlightStyle = null; }
    clearHighlight();
    chunks = [];
    sentenceBuffers.clear();
    responseToIdx.clear();
    for (const t of retryTimers.values()) clearTimeout(t);
    retryTimers.clear();
    retryCount.clear();
    currentIdx = -1;
    playing = false;
    document.removeEventListener('keydown', handleKeys);
  }

  // ── Text extraction ────────────────────────────────────────────
  const CONTENT_ROOT_SEL = 'article, main, [role="main"], .post-content, .article-body, .entry-content';
  const CONTENT_ELS_SEL = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, td, dd';

  function extractContent() {
    const sel = window.getSelection();
    const selText = sel.toString().trim();
    if (selText.length > 10) {
      const selChunks = splitText(selText, null);
      const restChunks = extractAfterSelection(sel);
      return [...selChunks, ...restChunks];
    }

    const root = document.querySelector(CONTENT_ROOT_SEL) || document.body;
    const els = root.querySelectorAll(CONTENT_ELS_SEL);
    const result = [];
    for (const el of els) {
      const text = el.innerText?.trim();
      if (!text || text.length < 3) continue;
      for (const s of splitSentences(text)) {
        if (s.length >= 2) result.push({ text: s, element: el });
      }
    }
    return result;
  }

  function splitText(text, el) {
    return splitSentences(text.replace(/\s+/g, ' ').trim())
      .filter(s => s.length >= 2)
      .map(s => ({ text: s, element: el }));
  }

  function splitSentences(text) {
    const raw = text.match(/[^.!?]+(?:[.!?]+["'\u201D\u2019)}\]]*\s*|$)/g) || [text];
    const result = [];
    for (const s of raw) {
      const t = s.trim();
      if (!t) continue;
      if (t.length <= 600) { result.push(t); continue; }
      // Split long sentences on commas / semicolons
      let remaining = t;
      while (remaining.length > 600) {
        let i = remaining.lastIndexOf(', ', 600);
        if (i < 200) i = remaining.lastIndexOf('; ', 600);
        if (i < 200) i = remaining.lastIndexOf(' ', 600);
        if (i < 100) i = 600;
        result.push(remaining.slice(0, i + 1).trim());
        remaining = remaining.slice(i + 1).trim();
      }
      if (remaining) result.push(remaining);
    }
    return result;
  }

  function extractAfterSelection(sel) {
    if (!sel.rangeCount) return [];
    const range = sel.getRangeAt(0);
    const endNode = range.endContainer;
    const root = document.querySelector(CONTENT_ROOT_SEL) || document.body;
    const els = root.querySelectorAll(CONTENT_ELS_SEL);
    const result = [];
    let pastSelection = false;

    for (const el of els) {
      if (!pastSelection) {
        if (el.contains(endNode)) {
          pastSelection = true;
          // Extract remaining text in this element after the selection
          try {
            const rest = document.createRange();
            rest.setStart(range.endContainer, range.endOffset);
            rest.setEndAfter(el.lastChild || el);
            const remaining = rest.toString().trim();
            if (remaining.length >= 2) {
              for (const s of splitSentences(remaining)) {
                if (s.length >= 2) result.push({ text: s, element: el });
              }
            }
          } catch {}
          continue;
        }
        const pos = endNode.compareDocumentPosition(el);
        if (!(pos & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        pastSelection = true;
      }
      const text = el.innerText?.trim();
      if (!text || text.length < 3) continue;
      for (const s of splitSentences(text)) {
        if (s.length >= 2) result.push({ text: s, element: el });
      }
    }
    return result;
  }

  // ── WebSocket ──────────────────────────────────────────────────
  async function connectWS() {
    if (ws?.readyState === WebSocket.OPEN) return;

    // Sign a fresh URL each time we connect
    let url = await getSignedWsUrl();
    if (!url) {
      throw new Error('Not signed in. Install NaturalReader extension and sign in.');
    }

    return new Promise((resolve, reject) => {
      ws = new WebSocket(url);
      ws.onopen = () => { wsReconnecting = false; resolve(); };
      ws.onerror = () => reject(new Error('WebSocket error'));
      ws.onclose = () => {
        ws = null;
        if (playing && !wsReconnecting) {
          wsReconnecting = true;
          reconnectAttempt = 0;
          attemptReconnect();
        }
      };
      ws.onmessage = (e) => {
        try { handleWSMsg(JSON.parse(e.data)); } catch {}
      };
    });
  }

  function attemptReconnect() {
    reconnectAttempt++;
    if (reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
      showError(`Reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts`);
      wsReconnecting = false;
      return;
    }
    const delay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempt - 1);
    showError(`Connection lost. Reconnecting... (${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})`);
    setTimeout(() => {
      connectWS().then(() => clearError()).catch(() => attemptReconnect());
    }, delay);
  }

  function sendTTS(idx, isRetry) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!isRetry && sentenceBuffers.has(idx)) return; // already requested

    // Clean up old state for retries
    if (isRetry) {
      const old = sentenceBuffers.get(idx);
      if (old) responseToIdx.delete(old.responseId);
      sentenceBuffers.delete(idx);
    }

    const responseId = 'tts-stream-' + crypto.randomUUID();
    sentenceBuffers.set(idx, { responseId, pcm: [], done: false, totalSamples: 0 });
    responseToIdx.set(responseId, idx);

    ws.send(JSON.stringify({
      e: config.email || '',
      l: config.language || '23',
      rn: config.voice || 'aoede',
      s: Math.round((config.speed || 1.5) * 180),
      v: config.provider || 'vtx',
      vn: config.version || '10.8.26',
      sm: 'true',
      ins: config.instructions ? ('Reading Style:\n' + config.instructions) : '',
      ca: 'true',
      model: config.model || '25flash-default',
      gdr: config.gender || 'f',
      t: chunks[idx].text,
      responseId,
      af: 'wav',
    }));
  }

  function handleWSMsg(data) {
    if (!data.event) return;
    const idx = responseToIdx.get(data.responseId);

    if (data.event === 'Tts_AudioChunk' && idx !== undefined) {
      const buf = sentenceBuffers.get(idx);
      if (!buf) return;
      const pcm = base64ToPCM(data.audioContent);
      buf.pcm.push(pcm);
      buf.totalSamples += pcm.length;

      // Stream chunks for current sentence
      if (idx === currentIdx && playing) scheduleChunk(pcm);
    }

    if (data.event === 'Tts_StreamingDone' && idx !== undefined) {
      const buf = sentenceBuffers.get(idx);
      if (buf) {
        buf.done = true;
        // If this was the current sentence, set up the end transition
        if (idx === currentIdx && playing) scheduleEndTransition();
      }
    }

    if (data.event === 'Tts_Error' && idx !== undefined) {
      console.warn(`TTS error for sentence ${idx}: [${data.errorCode}] ${data.errorMessage}`);
      retrySentence(idx);
    }
  }

  function retrySentence(idx) {
    const attempt = (retryCount.get(idx) || 0) + 1;
    retryCount.set(idx, attempt);

    if (attempt > MAX_RETRIES) {
      console.error(`TTS: giving up on sentence ${idx} after ${MAX_RETRIES} retries`);
      // If this is the current sentence, skip to next
      if (idx === currentIdx && playing) {
        showError('Skipping sentence (TTS failed)');
        setTimeout(() => { clearError(); playNext(); }, 1500);
      }
      return;
    }

    const delay = BASE_RETRY_DELAY * Math.pow(2, attempt - 1); // 500, 1000, 2000, 4000
    console.log(`TTS: retrying sentence ${idx} in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`);

    // If this is the current sentence, stop any partial playback so we can restart cleanly
    if (idx === currentIdx && playing) {
      stopPlayback();
      showError(`Retrying... (attempt ${attempt}/${MAX_RETRIES})`);
    }

    const timer = setTimeout(() => {
      retryTimers.delete(idx);
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      sendTTS(idx, true);
      // If this is the current sentence, we need to stream it
      // (handleWSMsg will schedule chunks as they arrive since idx === currentIdx)
      if (idx === currentIdx && playing) clearError();
    }, delay);
    retryTimers.set(idx, timer);
  }

  // ── Audio playback ─────────────────────────────────────────────
  function base64ToPCM(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const view = new DataView(bytes.buffer);
    const samples = new Float32Array(bytes.length >> 1);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = view.getInt16(i * 2, true) / 32768;
    }
    return samples;
  }

  function scheduleChunk(pcm) {
    if (!audioCtx || !playing) return;
    const buf = audioCtx.createBuffer(1, pcm.length, SAMPLE_RATE);
    buf.getChannelData(0).set(pcm);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);

    const when = Math.max(scheduledEnd, audioCtx.currentTime + 0.02);
    src.start(when);
    scheduledEnd = when + buf.duration;
    activeSources.push(src);
  }

  function scheduleEndTransition() {
    if (onEndTimer) clearTimeout(onEndTimer);
    const delay = Math.max(0, (scheduledEnd - audioCtx.currentTime) * 1000);
    onEndTimer = setTimeout(() => playNext(), delay);
  }

  function playBuffered(idx) {
    const buf = sentenceBuffers.get(idx);
    if (!buf || !buf.pcm.length) return;

    // Concatenate all PCM chunks
    const total = new Float32Array(buf.totalSamples);
    let off = 0;
    for (const chunk of buf.pcm) { total.set(chunk, off); off += chunk.length; }

    const abuf = audioCtx.createBuffer(1, total.length, SAMPLE_RATE);
    abuf.getChannelData(0).set(total);
    const src = audioCtx.createBufferSource();
    src.buffer = abuf;
    src.connect(audioCtx.destination);

    const when = Math.max(scheduledEnd, audioCtx.currentTime + 0.02);
    src.start(when);
    scheduledEnd = when + abuf.duration;
    activeSources = [src];

    const delay = Math.max(0, (scheduledEnd - audioCtx.currentTime) * 1000);
    onEndTimer = setTimeout(() => playNext(), delay);
  }

  function stopPlayback() {
    if (onEndTimer) { clearTimeout(onEndTimer); onEndTimer = null; }
    for (const src of activeSources) { try { src.stop(); } catch {} }
    activeSources = [];
    scheduledEnd = 0;
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }

  // ── Playback control ──────────────────────────────────────────
  async function connectAndPlay() {
    try {
      await connectWS();
      playSentence(0);
    } catch (err) {
      showError(err?.message || 'Failed to connect. Check NaturalReader extension.');
    }
  }

  function playSentence(idx) {
    if (idx >= chunks.length) { finish(); return; }
    stopPlayback();
    currentIdx = idx;
    playing = true;
    highlight(idx);
    updateUI();

    const buf = sentenceBuffers.get(idx);
    if (buf?.done) {
      // Already fully prefetched — play buffered
      playBuffered(idx);
    } else if (buf && buf.pcm.length > 0) {
      // Partially prefetched — play what we have, then stream the rest
      for (const pcm of buf.pcm) scheduleChunk(pcm);
    } else {
      // Not yet requested — request and stream
      sendTTS(idx);
    }

    // Prefetch upcoming sentences
    for (let i = 1; i <= PREFETCH_AHEAD; i++) {
      const next = idx + i;
      if (next < chunks.length) sendTTS(next);
    }
  }

  function playNext() {
    if (currentIdx + 1 < chunks.length) playSentence(currentIdx + 1);
    else finish();
  }

  function playPrev() {
    if (currentIdx > 0) {
      // Clear prefetched buffers for clean restart
      sentenceBuffers.delete(currentIdx - 1);
      responseToIdx.forEach((v, k) => { if (v === currentIdx - 1) responseToIdx.delete(k); });
      playSentence(currentIdx - 1);
    }
  }

  function pause() {
    if (!playing) return;
    playing = false;
    audioCtx?.suspend();
    if (onEndTimer) clearTimeout(onEndTimer);
    updateUI();
  }

  function resume() {
    if (playing) return;
    playing = true;
    audioCtx?.resume();
    // Re-schedule end transition
    const buf = sentenceBuffers.get(currentIdx);
    if (buf?.done) scheduleEndTransition();
    updateUI();
  }

  function finish() {
    playing = false;
    clearHighlight();
    updateUI();
  }

  // ── Highlighting ───────────────────────────────────────────────
  function injectHighlightCSS() {
    highlightStyle = document.createElement('style');
    highlightStyle.textContent = `
      .tts-reader-hl {
        background: rgba(67, 97, 238, 0.13) !important;
        outline: 2px solid rgba(67, 97, 238, 0.25) !important;
        outline-offset: 2px !important;
        border-radius: 4px !important;
        transition: background 0.2s, outline 0.2s !important;
      }
    `;
    document.head.appendChild(highlightStyle);
  }

  function highlight(idx) {
    clearHighlight();
    const el = chunks[idx]?.element;
    if (el) {
      el.classList.add('tts-reader-hl');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function clearHighlight() {
    document.querySelectorAll('.tts-reader-hl').forEach(el => el.classList.remove('tts-reader-hl'));
  }

  // ── Keyboard ───────────────────────────────────────────────────
  function handleKeys(e) {
    if (!playerHost) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;

    if (e.code === 'Space') { e.preventDefault(); playing ? pause() : resume(); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); playNext(); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); playPrev(); }
    else if (e.code === 'Escape') { e.preventDefault(); deactivate(); }
  }

  // ── Player UI (Shadow DOM) ─────────────────────────────────────
  function createPlayerUI() {
    playerHost = document.createElement('div');
    playerHost.id = 'tts-reader-root';
    shadow = playerHost.attachShadow({ mode: 'closed' });

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .bar {
          position: fixed; bottom: 0; left: 0; right: 0; z-index: 2147483647;
          background: rgba(15, 15, 30, 0.95); backdrop-filter: blur(12px);
          color: #e0e0e0; font-family: -apple-system, system-ui, sans-serif;
          display: flex; align-items: center; gap: 10px;
          padding: 10px 20px; font-size: 13px;
          border-top: 1px solid rgba(255,255,255,0.08);
          box-shadow: 0 -4px 24px rgba(0,0,0,0.3);
        }
        button {
          background: none; border: none; color: #e0e0e0; cursor: pointer;
          width: 36px; height: 36px; border-radius: 8px; font-size: 18px;
          display: flex; align-items: center; justify-content: center;
          transition: background 0.15s;
        }
        button:hover { background: rgba(255,255,255,0.1); }
        button.play-btn {
          width: 42px; height: 42px; font-size: 22px;
          background: #4361ee; border-radius: 50%; color: #fff;
        }
        button.play-btn:hover { background: #3a56d4; }
        .progress {
          flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0;
        }
        .progress-text {
          display: flex; justify-content: space-between; font-size: 11px; color: #999;
        }
        .progress-bar {
          height: 3px; background: rgba(255,255,255,0.1); border-radius: 2px;
          overflow: hidden; cursor: pointer;
        }
        .progress-fill {
          height: 100%; background: #4361ee; border-radius: 2px;
          transition: width 0.3s ease;
        }
        .sentence-preview {
          flex: 2; font-size: 12px; color: #bbb; overflow: hidden;
          text-overflow: ellipsis; white-space: nowrap; min-width: 0;
        }
        .speed-btn {
          font-size: 12px; font-weight: 600; width: auto; padding: 0 10px;
          color: #8b9cf7;
        }
        .close-btn { color: #888; font-size: 14px; }
        .close-btn:hover { color: #e74c3c; }
        .error {
          position: fixed; bottom: 70px; left: 50%; transform: translateX(-50%);
          background: #e74c3c; color: #fff; padding: 8px 16px; border-radius: 8px;
          font-size: 12px; z-index: 2147483647; display: none;
          font-family: -apple-system, system-ui, sans-serif;
        }
        .error.show { display: block; }
        .kbd { font-size: 10px; color: #666; margin-left: auto; white-space: nowrap; }
      </style>

      <div class="error" id="error"></div>
      <div class="bar">
        <button id="prev" title="Previous (←)">⏮</button>
        <button class="play-btn" id="playPause" title="Play/Pause (Space)">▶</button>
        <button id="next" title="Next (→)">⏭</button>

        <div class="progress">
          <div class="progress-bar" id="progressBar">
            <div class="progress-fill" id="progressFill" style="width:0%"></div>
          </div>
          <div class="progress-text">
            <span id="counter">0 / 0</span>
            <span id="percent">0%</span>
          </div>
        </div>

        <div class="sentence-preview" id="preview"></div>

        <button class="speed-btn" id="speedBtn" title="Cycle speed">${config.speed || 1.5}x</button>
        <span class="kbd">Space/←/→/Esc</span>
        <button class="close-btn" id="close" title="Close (Esc)">✕</button>
      </div>
    `;

    document.body.appendChild(playerHost);

    // Bind events
    const $ = (id) => shadow.getElementById(id);
    $('playPause').onclick = () => playing ? pause() : resume();
    $('prev').onclick = () => playPrev();
    $('next').onclick = () => playNext();
    $('close').onclick = () => deactivate();
    $('speedBtn').onclick = () => cycleSpeed();
    $('progressBar').onclick = (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      const idx = Math.floor(pct * chunks.length);
      playSentence(Math.max(0, Math.min(idx, chunks.length - 1)));
    };

    document.addEventListener('keydown', handleKeys);
    updateUI();
  }

  function updateUI() {
    if (!shadow) return;
    const $ = (id) => shadow.getElementById(id);
    const pp = $('playPause');
    if (pp) pp.textContent = playing ? '⏸' : '▶';
    const pct = chunks.length ? ((currentIdx + 1) / chunks.length * 100) : 0;
    const fill = $('progressFill');
    if (fill) fill.style.width = pct + '%';
    const counter = $('counter');
    if (counter) counter.textContent = `${currentIdx + 1} / ${chunks.length}`;
    const percent = $('percent');
    if (percent) percent.textContent = Math.round(pct) + '%';
    const preview = $('preview');
    if (preview && chunks[currentIdx]) {
      preview.textContent = chunks[currentIdx].text;
      preview.title = chunks[currentIdx].text;
    }
  }

  function cycleSpeed() {
    const speeds = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];
    const cur = config.speed || 1.5;
    const i = speeds.indexOf(cur);
    config.speed = speeds[(i + 1) % speeds.length];
    const btn = shadow?.getElementById('speedBtn');
    if (btn) btn.textContent = config.speed + 'x';
    // Clear prefetched buffers (generated at old speed)
    for (const [idx, buf] of sentenceBuffers) {
      if (idx > currentIdx) {
        responseToIdx.delete(buf.responseId);
        sentenceBuffers.delete(idx);
      }
    }
    // Re-prefetch at new speed
    for (let i = 1; i <= PREFETCH_AHEAD; i++) {
      const next = currentIdx + i;
      if (next < chunks.length) sendTTS(next);
    }
    chrome.storage.local.get('ttsSettings', (d) => {
      chrome.storage.local.set({ ttsSettings: { ...d.ttsSettings, speed: config.speed } });
    });
  }

  function showError(msg) {
    if (!shadow) return;
    const el = shadow.getElementById('error');
    if (el) { el.textContent = msg; el.classList.add('show'); }
  }

  function clearError() {
    if (!shadow) return;
    const el = shadow.getElementById('error');
    if (el) el.classList.remove('show');
  }
})();
