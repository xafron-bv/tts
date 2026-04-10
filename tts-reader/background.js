chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-reader') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_READER' });
    }
  }
});

// Push captured config to CLI local server (if running)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'PUSH_TO_CLI' && msg.config) {
    fetch('http://localhost:18412/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.config),
    }).catch(() => {}); // silent if CLI server not running
  }
});
