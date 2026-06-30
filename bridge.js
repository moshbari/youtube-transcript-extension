// bridge.js — injected only on pulltranscript.com.
//
// Lets the PullTranscript web app pull YouTube transcripts THROUGH this
// extension, which runs in the user's own browser (their residential IP +
// logged-in YouTube session). That sidesteps the server-side IP blocks /
// rate limits that make server-side YouTube scraping unreliable.
//
// Protocol (window.postMessage, same-origin page <-> this content script):
//   page -> bridge : { source:'pulltranscript-app', type:'ping' }
//   page -> bridge : { source:'pulltranscript-app', type:'scrape', requestId, url }
//   bridge -> page : { source:'yt-scraper-ext', type:'ready', version }
//   bridge -> page : { source:'yt-scraper-ext', type:'result', requestId, ok, segments, text, title, error }
//
// The page never needs the extension's ID — presence is announced here.

(function () {
  const EXT = 'yt-scraper-ext';
  // Accept handshakes from any of our own web apps. tella-to-youtube uses this
  // to push a whole batch of freshly-uploaded YouTube links straight into the
  // extension's batch scraper (no copy-paste).
  const APPS = ['pulltranscript-app', 'tella-app'];
  const version = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';

  const announce = () => {
    window.postMessage({ source: EXT, type: 'ready', version }, window.location.origin);
  };

  window.addEventListener('message', (event) => {
    // Only trust messages from this same page.
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || !APPS.includes(msg.source)) return;

    if (msg.type === 'ping') {
      announce();
      return;
    }

    // Push a whole list of YouTube URLs into the extension's batch scraper.
    if (msg.type === 'scrapeBatch') {
      const requestId = msg.requestId;
      const urls = Array.isArray(msg.urls) ? msg.urls : [];
      const reply = (payload) =>
        window.postMessage({ source: EXT, type: 'batchAccepted', requestId, ...payload }, window.location.origin);
      try {
        chrome.runtime.sendMessage({ action: 'bridgeBatch', urls }, (resp) => {
          if (chrome.runtime.lastError) {
            reply({ ok: false, error: chrome.runtime.lastError.message || 'Extension error' });
            return;
          }
          reply(resp || { ok: false, error: 'No response from extension' });
        });
      } catch (e) {
        reply({ ok: false, error: (e && e.message) || 'Extension call failed' });
      }
      return;
    }

    if (msg.type === 'scrape') {
      const requestId = msg.requestId;
      const reply = (payload) =>
        window.postMessage(
          { source: EXT, type: 'result', requestId, ...payload },
          window.location.origin
        );

      let answered = false;
      const done = (payload) => {
        if (answered) return;
        answered = true;
        reply(payload);
      };

      try {
        chrome.runtime.sendMessage({ action: 'bridgeScrape', url: msg.url }, (resp) => {
          if (chrome.runtime.lastError) {
            done({ ok: false, error: chrome.runtime.lastError.message || 'Extension error' });
            return;
          }
          if (!resp) {
            done({ ok: false, error: 'No response from extension' });
            return;
          }
          done({
            ok: !!resp.ok,
            segments: resp.segments || [],
            text: resp.text || '',
            title: resp.title || '',
            error: resp.error || '',
          });
        });
      } catch (e) {
        done({ ok: false, error: (e && e.message) || 'Extension call failed' });
      }
    }
  });

  // Announce on load, and again shortly after in case the app's listener
  // attaches a beat later than document_idle.
  announce();
  setTimeout(announce, 300);
  setTimeout(announce, 1200);
})();
