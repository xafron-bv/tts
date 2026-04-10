(function() {
  const NR_EXT_ID = 'kohfgcgbkjodfcfkcackpagifgbcmimk';
  const NR_CWS_URL = 'https://chromewebstore.google.com/detail/natural-reader-ai-text-to/' + NR_EXT_ID;
  const EXPIRATION_SKEW_MS = 30000;

  const els = {
    voice: document.getElementById('voice'),
    speed: document.getElementById('speed'),
    speedLabel: document.getElementById('speedLabel'),
    instructions: document.getElementById('instructions'),
    save: document.getElementById('save'),
    start: document.getElementById('start'),
    status: document.getElementById('status'),
    setupBox: document.getElementById('setupBox'),
    setupMsg: document.getElementById('setupMsg'),
    installLink: document.getElementById('installLink'),
  };

  function checkNRExtension() {
    return new Promise(resolve => {
      const img = new Image();
      const timeout = setTimeout(() => resolve(false), 1500);
      img.onload = () => { clearTimeout(timeout); resolve(true); };
      img.onerror = () => { clearTimeout(timeout); resolve(false); };
      img.src = `chrome-extension://${NR_EXT_ID}/assets/img/128N.png`;
    });
  }

  function parseExpirationMs(expiration) {
    if (!expiration) return null;
    if (typeof expiration === 'number' && Number.isFinite(expiration)) {
      return expiration > 1e12 ? expiration : expiration * 1000;
    }
    const parsed = Date.parse(expiration);
    return Number.isNaN(parsed) ? null : parsed;
  }

  function credsExpired(creds) {
    if (!creds?.accessKeyId) return false;
    const expirationMs = parseExpirationMs(creds.expiration);
    if (expirationMs === null) return !!creds.expiration;
    return Date.now() + EXPIRATION_SKEW_MS >= expirationMs;
  }

  async function init() {
    const data = await chrome.storage.local.get(['ttsSettings', 'awsCredentials', 'wsUrl']);
    const s = data.ttsSettings || {};

    if (s.voice) els.voice.value = s.voice;
    if (s.speed) {
      els.speed.value = s.speed;
      els.speedLabel.textContent = s.speed + 'x';
    }
    if (s.instructions) els.instructions.value = s.instructions;

    const creds = data.awsCredentials;
    const hasCreds = creds && creds.accessKeyId;
    const hasUrl = !!data.wsUrl;
    const expired = credsExpired(creds);

    if (hasCreds && !expired) {
      els.status.textContent = 'Connected';
      els.status.classList.add('connected');
      els.setupBox.style.display = 'none';
    } else if (hasUrl && !hasCreds) {
      els.status.textContent = 'URL captured';
      els.status.classList.add('connected');
      els.setupBox.style.display = 'none';
    } else if (expired) {
      // Auto-refresh in background
      els.status.textContent = 'Refreshing...';
      els.status.classList.add('expired');
      els.setupBox.style.display = 'none';
      const resp = await chrome.runtime.sendMessage({ type: 'REFRESH_CREDENTIALS' });
      if (resp && resp.ok) {
        els.status.textContent = 'Connected';
        els.status.className = 'status connected';
      } else {
        els.status.textContent = 'Session expired';
        els.status.className = 'status expired';
        els.setupBox.style.display = '';
        els.setupMsg.textContent = 'Could not refresh session. Make sure you are signed in to NaturalReader.';
      }
    } else {
      els.status.textContent = 'Not connected';
      els.setupBox.style.display = '';
      const nrInstalled = await checkNRExtension();
      if (nrInstalled) {
        els.setupMsg.textContent = 'Sign in to NaturalReader extension, then click Refresh.';
      } else {
        els.setupMsg.textContent = 'Install the NaturalReader extension and sign in.';
        els.installLink.style.display = '';
      }
    }
  }

  init();

  els.speed.addEventListener('input', () => {
    els.speedLabel.textContent = els.speed.value + 'x';
  });

  function getSettings(callback) {
    chrome.storage.local.get('ttsSettings', (data) => {
      const existing = data.ttsSettings || {};
      const overrides = {};
      if (els.voice.value.trim()) overrides.voice = els.voice.value.trim();
      if (els.instructions.value.trim()) overrides.instructions = els.instructions.value.trim();
      overrides.speed = parseFloat(els.speed.value) || existing.speed || 1.5;
      callback({ ...existing, ...overrides });
    });
  }

  els.save.addEventListener('click', () => {
    getSettings((settings) => {
      chrome.storage.local.set({ ttsSettings: settings }, () => {
        els.save.textContent = 'Saved!';
        setTimeout(() => els.save.textContent = 'Save Settings', 1200);
      });
    });
  });

  els.start.addEventListener('click', () => {
    getSettings(async (settings) => {
      chrome.storage.local.set({ ttsSettings: settings });
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'START_READER', settings });
        window.close();
      }
    });
  });
})();
