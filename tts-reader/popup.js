(function() {
  const els = {
    wsUrl: document.getElementById('wsUrl'),
    email: document.getElementById('email'),
    voice: document.getElementById('voice'),
    speed: document.getElementById('speed'),
    speedLabel: document.getElementById('speedLabel'),
    instructions: document.getElementById('instructions'),
    save: document.getElementById('save'),
    start: document.getElementById('start'),
    status: document.getElementById('status'),
  };

  // Load saved settings
  chrome.storage.local.get(['ttsSettings', 'wsUrl'], (data) => {
    if (data.wsUrl) {
      els.wsUrl.value = data.wsUrl;
    }
    const s = data.ttsSettings || {};
    if (s.email) els.email.value = s.email;
    if (s.voice) els.voice.value = s.voice;
    if (s.speed) {
      els.speed.value = s.speed;
      els.speedLabel.textContent = s.speed + 'x';
    }
    if (s.instructions) els.instructions.value = s.instructions;

    // Update status
    const hasUrl = !!data.wsUrl;
    const hasSettings = !!(s.email && s.voice);
    if (hasUrl && hasSettings) {
      els.status.textContent = 'Ready';
      els.status.classList.add('connected');
    } else if (hasUrl) {
      els.status.textContent = 'URL captured';
      els.status.classList.add('connected');
    }
  });

  els.speed.addEventListener('input', () => {
    els.speedLabel.textContent = els.speed.value + 'x';
  });

  function getSettings(callback) {
    chrome.storage.local.get('ttsSettings', (data) => {
      const existing = data.ttsSettings || {};
      const overrides = {};
      // Only override captured values with non-empty popup values
      if (els.wsUrl.value.trim()) overrides.wsUrl = els.wsUrl.value.trim();
      if (els.email.value.trim()) overrides.email = els.email.value.trim();
      if (els.voice.value.trim()) overrides.voice = els.voice.value.trim();
      if (els.instructions.value.trim()) overrides.instructions = els.instructions.value.trim();
      overrides.speed = parseFloat(els.speed.value) || existing.speed || 1.5;
      callback({ ...existing, ...overrides });
    });
  }

  els.save.addEventListener('click', () => {
    getSettings((settings) => {
      chrome.storage.local.set({
        wsUrl: settings.wsUrl,
        ttsSettings: settings,
      }, () => {
        els.save.textContent = 'Saved!';
        setTimeout(() => els.save.textContent = 'Save Settings', 1200);
      });
    });
  });

  els.start.addEventListener('click', () => {
    getSettings(async (settings) => {
      if (!settings.wsUrl) {
        els.wsUrl.focus();
        els.wsUrl.style.borderColor = '#e74c3c';
        return;
      }
      chrome.storage.local.set({ wsUrl: settings.wsUrl, ttsSettings: settings });
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'START_READER', settings });
        window.close();
      }
    });
  });
})();
