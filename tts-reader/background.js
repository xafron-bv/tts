const NR_ONLINE_URL = 'https://www.naturalreaders.com/online/';
const REFRESH_SETTLE_MS = 500;
const REFRESH_TIMEOUT_MS = 15000;
const EXPIRATION_SKEW_MS = 30000;

let refreshState = null;

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-reader') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_READER' });
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PUSH_TO_CLI' && msg.config) {
    pushToCli(msg.config);
  }
  if (msg.type === 'REFRESH_CREDENTIALS') {
    refreshCredentials().then(ok => sendResponse({ ok }));
    return true; // keep channel open for async response
  }
});

function pushToCli(config) {
  fetch('http://localhost:18412/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  }).catch(() => {});
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

// Open naturalreaders.com in a background tab to trigger Cognito auth.
// capture.js + content.js on that page intercept the credentials automatically.
async function refreshCredentials() {
  if (refreshState) {
    return refreshState.promise;
  }

  let resolveRefresh;
  const promise = new Promise((resolve) => {
    resolveRefresh = resolve;
  });

  const state = {
    promise,
    tabId: null,
    timeoutId: null,
    storageListener: null,
    finished: false,
    finish(ok) {
      if (state.finished) return;
      state.finished = true;
      if (state.timeoutId) {
        clearTimeout(state.timeoutId);
        state.timeoutId = null;
      }
      if (state.storageListener) {
        chrome.storage.onChanged.removeListener(state.storageListener);
        state.storageListener = null;
      }

      const tabId = state.tabId;
      state.tabId = null;

      if (refreshState === state) {
        refreshState = null;
      }

      if (tabId !== null) {
        chrome.tabs.remove(tabId).catch(() => {});
      }

      resolveRefresh(ok);
    }
  };

  refreshState = state;

  try {
    const { awsCredentials } = await chrome.storage.local.get(['awsCredentials']);
    if (credsValid(awsCredentials)) {
      state.finish(true);
      return promise;
    }

    state.storageListener = (changes, areaName) => {
      const creds = areaName === 'local' ? changes.awsCredentials?.newValue : null;
      if (!credsValid(creds)) return;
      setTimeout(() => state.finish(true), REFRESH_SETTLE_MS);
    };
    chrome.storage.onChanged.addListener(state.storageListener);
    state.timeoutId = setTimeout(() => state.finish(false), REFRESH_TIMEOUT_MS);

    const tab = await chrome.tabs.create({ url: NR_ONLINE_URL, active: false });
    if (tab.id === undefined) {
      throw new Error('Refresh tab missing id');
    }
    state.tabId = tab.id;
  } catch {
    state.finish(false);
  }

  return promise;
}

// Clean up if the refresh tab is closed externally
chrome.tabs.onRemoved.addListener((tabId) => {
  if (refreshState && tabId === refreshState.tabId) {
    refreshState.finish(false);
  }
});

// Push credentials + signed URL to CLI when they change
chrome.storage.onChanged.addListener((changes) => {
  if (changes.awsCredentials && changes.awsCredentials.newValue) {
    const creds = changes.awsCredentials.newValue;
    chrome.storage.local.get(['wsUrl', 'wsBaseUrl', 'ttsSettings'], (d) => {
      const config = { ...(d.ttsSettings || {}) };
      if (d.wsUrl) config.ws_url = d.wsUrl;
      if (d.wsBaseUrl) config.ws_base_url = d.wsBaseUrl;
      config.aws_credentials = {
        access_key: creds.accessKeyId,
        secret_key: creds.secretAccessKey,
        session_token: creds.sessionToken,
        expiration: creds.expiration,
      };
      pushToCli(config);
    });
  }
});
