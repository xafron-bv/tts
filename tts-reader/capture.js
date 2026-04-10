// Runs in MAIN world on naturalreaders.com to capture WebSocket URL + settings + AWS credentials
(function() {
  const COGNITO_HOST = 'cognito-identity';

  // ── Hook WebSocket to capture signed URL + base endpoint ────
  const OrigWS = window.WebSocket;

  window.WebSocket = function(url, protocols) {
    const isTTS = typeof url === 'string' && url.includes('execute-api') && url.includes('prod-wpro');
    const sock = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);

    if (isTTS) {
      window.postMessage({
        type: 'TTS_READER_WS_CAPTURED',
        url,
        baseUrl: url.split('?')[0],
      }, '*');

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

  // ── Hook fetch to capture Cognito Identity credentials ──────
  const origFetch = window.fetch;
  window.fetch = function(...args) {
    const result = origFetch.apply(this, args);
    try {
      const reqUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      if (reqUrl && reqUrl.includes(COGNITO_HOST)) {
        result.then(r => r.clone().json()).then(data => {
          if (data && data.Credentials) {
            window.postMessage({
              type: 'TTS_READER_CREDENTIALS_CAPTURED',
              credentials: {
                accessKeyId: data.Credentials.AccessKeyId,
                secretAccessKey: data.Credentials.SecretKey,
                sessionToken: data.Credentials.SessionToken,
                expiration: data.Credentials.Expiration,
              },
            }, '*');
          }
        }).catch(() => {});
      }
    } catch {}
    return result;
  };

  // ── Hook XHR (AWS SDK v2 / Amplify uses XHR in browser) ─────
  const origXHROpen = XMLHttpRequest.prototype.open;
  const origXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__ttsCapUrl = url;
    return origXHROpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    if (this.__ttsCapUrl && this.__ttsCapUrl.includes(COGNITO_HOST)) {
      this.addEventListener('load', function() {
        try {
          const data = JSON.parse(this.responseText);
          if (data && data.Credentials) {
            window.postMessage({
              type: 'TTS_READER_CREDENTIALS_CAPTURED',
              credentials: {
                accessKeyId: data.Credentials.AccessKeyId,
                secretAccessKey: data.Credentials.SecretKey,
                sessionToken: data.Credentials.SessionToken,
                expiration: data.Credentials.Expiration,
              },
            }, '*');
          }
        } catch {}
      });
    }
    return origXHRSend.apply(this, arguments);
  };
})();
