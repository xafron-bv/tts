// Runs in MAIN world on naturalreaders.com to capture WebSocket URL + settings
(function() {
  const OrigWS = window.WebSocket;
  const origSend = OrigWS.prototype.send;

  window.WebSocket = function(url, protocols) {
    const isTTS = typeof url === 'string' && url.includes('execute-api') && url.includes('prod-wpro');
    const sock = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);

    if (isTTS) {
      window.postMessage({ type: 'TTS_READER_WS_CAPTURED', url }, '*');

      // Intercept send() to capture outgoing TTS request settings
      const origSockSend = sock.send.bind(sock);
      sock.send = function(data) {
        try {
          const msg = typeof data === 'string' ? JSON.parse(data) : null;
          if (msg && msg.t && msg.rn) {
            window.postMessage({
              type: 'TTS_READER_SETTINGS_CAPTURED',
              settings: {
                email: msg.e || '',
                voice: msg.rn || 'aoede',
                speed: msg.s ? msg.s / 180 : 1.5,
                instructions: (msg.ins || '').replace(/^Reading Style:\n?/, ''),
                provider: msg.v || 'vtx',
                model: msg.model || '25flash-default',
                gender: msg.gdr || 'f',
                language: msg.l || '23',
                version: msg.vn || '10.8.26',
              },
            }, '*');
          }
        } catch {}
        return origSockSend(data);
      };
    }

    return sock;
  };
  window.WebSocket.prototype = OrigWS.prototype;
  Object.defineProperty(window.WebSocket, 'CONNECTING', { value: 0 });
  Object.defineProperty(window.WebSocket, 'OPEN', { value: 1 });
  Object.defineProperty(window.WebSocket, 'CLOSING', { value: 2 });
  Object.defineProperty(window.WebSocket, 'CLOSED', { value: 3 });
})();
