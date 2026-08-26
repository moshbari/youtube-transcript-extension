// bridge.js — injected on our own web apps (pulltranscript, devrant, tella, wisekid, painfinder).
//
// Lets a web app pull YouTube transcripts THROUGH this
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
  // Injected twice? Content scripts are auto-injected on page load AND
  // re-injected by background.js when the extension updates, so a page can get
  // two copies. Two live listeners means two replies to every request, and the
  // app resolves on whichever lands first. One bridge per frame.
  if (window.__ytScraperBridge) return;
  window.__ytScraperBridge = true;

  const EXT = 'yt-scraper-ext';
  // Accept handshakes from any of our own web apps. tella-to-youtube uses this
  // to push a whole batch of freshly-uploaded YouTube links straight into the
  // extension's batch scraper (no copy-paste).
  const APPS = ['pulltranscript-app', 'tella-app', 'wisekid-app', 'painfinder-app'];
  // Is this bridge still attached to a living extension? When the extension is
  // reloaded or updated, every content script already sitting in an open page is
  // ORPHANED: the code keeps running but `chrome.runtime` is torn out from under
  // it. Touching it then throws "Cannot read properties of undefined (reading
  // 'sendMessage')" — which is what the apps were showing their users.
  const alive = () => {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  };
  const STALE_MSG = 'The extension was just updated. Reload this page (Cmd/Ctrl+R) and try again.';

  let version = '';
  try {
    version = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
  } catch (e) { /* orphaned before we even started — stay quiet */ }

  const announce = () => {
    // Never announce from an orphaned bridge — the app would show itself as
    // connected to an extension that cannot answer a single request.
    if (!alive()) return;
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
      // 🎙️ Optional { youtubeUrl: podcastProjectId }. Present when the video was
      // uploaded with "Also send to the Podcast Editor" ticked, so once the
      // captions exist we know which project the transcript belongs to.
      const podcastJobs = (msg.podcastJobs && typeof msg.podcastJobs === 'object') ? msg.podcastJobs : {};
      const reply = (payload) =>
        window.postMessage({ source: EXT, type: 'batchAccepted', requestId, ...payload }, window.location.origin);
      if (!alive()) { reply({ ok: false, stale: true, error: STALE_MSG }); return; }
      try {
        chrome.runtime.sendMessage({ action: 'bridgeBatch', urls, podcastJobs }, (resp) => {
          if (chrome.runtime.lastError) {
            reply({ ok: false, error: chrome.runtime.lastError.message || 'Extension error' });
            return;
          }
          reply(resp || { ok: false, error: 'No response from extension' });
        });
      } catch (e) {
        reply({ ok: false, stale: !alive(), error: alive() ? ((e && e.message) || 'Extension call failed') : STALE_MSG });
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

      if (!alive()) { done({ ok: false, stale: true, error: STALE_MSG }); return; }
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
        done({ ok: false, stale: !alive(), error: alive() ? ((e && e.message) || 'Extension call failed') : STALE_MSG });
      }
    }
  });

  // Announce on load, and again shortly after in case the app's listener
  // attaches a beat later than document_idle.
  announce();
  setTimeout(announce, 300);
  setTimeout(announce, 1200);
})();
