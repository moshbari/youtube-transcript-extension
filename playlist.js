// =====================================================================
//  Playlist harvester — turns one playlist URL into every video in it.
// =====================================================================
//
//  Injected (via chrome.scripting) into a youtube.com/playlist?list=...
//  tab that background.js opened.
//
//  MEASURED 2026-09-20, and the reason this does NOT simply scroll:
//  YouTube's playlist page renders only the first 100 rows and, on the
//  new `yt-lockup-view-model` layout, plants NO continuation sentinel in
//  the DOM. Scrolling to the bottom — waiting there, jiggling, firing
//  wheel events — loads nothing. A 534-video playlist stopped dead at
//  100 every time.
//
//  What the page itself does is POST its continuation token to
//  /youtubei/v1/browse, so that is what we do: read the token out of the
//  page's own `ytInitialData`, then follow the chain. Same endpoint, same
//  origin, same signed-in session as the tab — so private and unlisted
//  playlists the user owns work, and no YouTube Data API, key or quota is
//  involved. The full 534 came back in ~2 seconds.
//
//  The old scroll-and-read-the-DOM route is kept as a fallback for any
//  layout this parser doesn't recognise.
// =====================================================================
(async function () {
  if (window.__ytPlaylistHarvestRunning) return;
  window.__ytPlaylistHarvestRunning = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send  = (msg) => { try { chrome.runtime.sendMessage(msg); } catch {} };

  const MAX_PAGES = 200;            // 200 * 100 = 20,000 videos
  const listId = (location.search.match(/[?&]list=([A-Za-z0-9_-]+)/) || [])[1] || '';

  // ---------- inline-script helpers (content scripts can't touch window.*) ----------
  function inlineScript(needle) {
    for (const s of document.querySelectorAll('script')) {
      const t = s.textContent || '';
      if (t.includes(needle)) return t;
    }
    return null;
  }

  // MEASURED: a playlist page carries TWO scripts mentioning ytInitialData —
  // the ~1MB data blob and a ~1KB bystander. Taking the first match is a coin
  // flip, so return every candidate, biggest and `var`-declared first, and let
  // the caller keep trying until one actually parses into videos.
  function initialDataCandidates() {
    const out = [];
    for (const s of document.querySelectorAll('script')) {
      const t = s.textContent || '';
      if (t.includes('ytInitialData')) out.push(t);
    }
    return out.sort((a, b) => {
      const av = /^\s*var\s+ytInitialData/.test(a) ? 1 : 0;
      const bv = /^\s*var\s+ytInitialData/.test(b) ? 1 : 0;
      if (av !== bv) return bv - av;
      return b.length - a.length;
    });
  }

  // Brace-balanced extract, string-aware so a '}' inside a title can't end it.
  function braceJson(text, startKey) {
    const i = text.indexOf(startKey); if (i < 0) return null;
    const s = text.indexOf('{', i);   if (s < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let p = s; p < text.length; p++) {
      const c = text[p];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { try { return JSON.parse(text.slice(s, p + 1)); } catch { return null; } }
      }
    }
    return null;
  }

  // Walk any innertube response for video entries + continuation tokens.
  // Handles the new lockup layout and the older playlistVideoRenderer one.
  function collect(node, out, tokens) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) collect(n, out, tokens); return; }

    const lv = node.lockupViewModel;
    if (lv && lv.contentId && (!lv.contentType || lv.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO')) {
      const t = lv.metadata && lv.metadata.lockupMetadataViewModel && lv.metadata.lockupMetadataViewModel.title;
      out.push({ id: lv.contentId, title: (t && (t.content || (t.runs && t.runs[0] && t.runs[0].text))) || '' });
    }
    const pv = node.playlistVideoRenderer;
    if (pv && pv.videoId) {
      const t = pv.title;
      out.push({ id: pv.videoId, title: (t && ((t.runs && t.runs[0] && t.runs[0].text) || t.simpleText)) || '' });
    }
    const cc = node.continuationCommand;
    if (cc && cc.token) tokens.push(cc.token);

    for (const k in node) collect(node[k], out, tokens);
  }

  // ---------- DOM fallback (older layouts) ----------
  const ROW_SELECTORS = [
    'yt-lockup-view-model',
    'ytd-playlist-video-renderer',
    'ytd-playlist-panel-video-renderer',
    'ytd-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-rich-item-renderer'
  ].join(',');

  function readRow(row) {
    const a = row.querySelector(
      'a#video-title, a.ytLockupMetadataViewModelTitle, h3 a[href*="/watch"], ' +
      'a#thumbnail[href*="/watch"], a[href*="/watch?v="]'
    );
    if (!a) return null;
    const m = (a.getAttribute('href') || '').match(/[?&]v=([A-Za-z0-9_-]{11})/);
    if (!m) return null;
    const t = row.querySelector(
      '#video-title, #video-title-link, h3 a, a.ytLockupMetadataViewModelTitle, yt-formatted-string#video-title'
    );
    return { id: m[1], title: ((t && (t.getAttribute('title') || t.textContent)) || '').trim() };
  }

  function harvestDom() {
    const seen = new Map();
    for (const row of document.querySelectorAll(ROW_SELECTORS)) {
      const v = readRow(row);
      if (v && !seen.has(v.id)) seen.set(v.id, v);
    }
    return Array.from(seen.values());
  }

  async function scrollAndHarvest() {
    for (let i = 0; i < 40 && document.querySelectorAll(ROW_SELECTORS).length === 0; i++) await sleep(250);
    let last = -1, quiet = 0, passes = 0;
    while (quiet < 4 && passes < 200) {
      passes++;
      const count = harvestDom().length;
      if (count === last) quiet++;
      else { quiet = 0; last = count; send({ action: 'playlistProgress', count }); }
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(700);
    }
    return harvestDom();
  }

  function playlistTitle() {
    const el = document.querySelector(
      'yt-dynamic-sizing-formatted-string #text, ' +
      'ytd-playlist-header-renderer yt-formatted-string#text, ' +
      'ytd-playlist-sidebar-primary-info-renderer h1 yt-formatted-string, ' +
      'h1.ytd-playlist-header-renderer'
    );
    const t = ((el && el.textContent) || '').trim();
    return t || (document.title || '').replace(/\s*-\s*YouTube\s*$/i, '').trim();
  }

  try {
    // Wait for the page's data to be present at all.
    let candidates = [];
    for (let i = 0; i < 40 && !candidates.length; i++) {
      candidates = initialDataCandidates();
      if (!candidates.length) await sleep(250);
    }

    const seen = new Set();
    const videos = [];
    const push = (v) => { if (v && v.id && !seen.has(v.id)) { seen.add(v.id); videos.push(v); } };

    let tokens = [];
    let fastPath = false;

    for (const raw of candidates) {
      // The inline <script> of the FIRST page load survives SPA navigation, so
      // data that isn't for THIS list must never be trusted (the v3.4 lesson).
      if (listId && !raw.includes(listId)) continue;
      const init = braceJson(raw, 'ytInitialData');
      if (!init) continue;
      const out = [];
      const tk = [];
      collect(init, out, tk);
      if (out.length) { fastPath = true; tokens = tk; out.forEach(push); break; }
    }

    if (fastPath) {
      send({ action: 'playlistProgress', count: videos.length });

      const cfg = inlineScript('INNERTUBE_API_KEY') || '';
      const key = (cfg.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
      const cv  = (cfg.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1];

      // Follow the continuation chain. A playlist page can carry more than one
      // token (other shelves have their own), so untried tokens are attempted
      // until one actually yields new videos.
      if (key && cv) {
        const tried = new Set();
        let pages = 0;
        while (pages < MAX_PAGES) {
          const candidates = tokens.filter((t) => !tried.has(t));
          if (!candidates.length) break;
          let added = 0;
          let next = [];
          for (const tok of candidates.reverse()) {
            tried.add(tok);
            let data = null;
            try {
              const r = await fetch(`/youtubei/v1/browse?key=${key}&prettyPrint=false`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  context: { client: { clientName: 'WEB', clientVersion: cv, hl: 'en' } },
                  continuation: tok
                })
              });
              if (!r.ok) continue;
              data = await r.json();
            } catch { continue; }

            const out = [], tk = [];
            collect(data, out, tk);
            const before = videos.length;
            out.forEach(push);
            added = videos.length - before;
            next = tk;
            if (added) break;       // this was the playlist's own token
          }
          pages++;
          if (!added) break;        // chain exhausted
          tokens = next;
          send({ action: 'playlistProgress', count: videos.length });
        }
      }
    } else {
      // Unrecognised layout — fall back to reading rows off the page.
      (await scrollAndHarvest()).forEach(push);
    }

    if (!videos.length) {
      send({ action: 'playlistError', message: 'No videos found on this playlist page. Is it private, empty, or still loading?' });
      return;
    }
    send({ action: 'playlistDone', videos, title: playlistTitle() });
  } catch (e) {
    send({ action: 'playlistError', message: (e && e.message) || String(e) });
  } finally {
    window.__ytPlaylistHarvestRunning = false;
  }
})();
