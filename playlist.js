// =====================================================================
//  Playlist harvester — turns one playlist URL into every video in it.
// =====================================================================
//
//  Injected (via chrome.scripting) into a youtube.com/playlist?list=...
//  tab that background.js opened. YouTube only renders ~100 rows up
//  front and lazy-loads the rest as you scroll, so this scrolls to the
//  bottom over and over until the row count stops growing, then reads
//  every { id, title } in playlist order and posts them back.
//
//  Scraped from the page's own DOM in the user's own session — so
//  unlisted and private playlists they own work too, and no API key,
//  quota or server ever enters the picture (same rule as content.js).
// =====================================================================
(async function () {
  if (window.__ytPlaylistHarvestRunning) return;
  window.__ytPlaylistHarvestRunning = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send  = (msg) => { try { chrome.runtime.sendMessage(msg); } catch {} };

  const ROW_SELECTORS = [
    'ytd-playlist-video-renderer',
    'ytd-playlist-panel-video-renderer',
    'ytd-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-rich-item-renderer'
  ].join(',');

  function rows() {
    return Array.from(document.querySelectorAll(ROW_SELECTORS));
  }

  // Pull { id, title } out of one row. Rows differ between the classic
  // playlist page and the newer grid, so try the title link, then any
  // /watch link inside the row.
  function readRow(row) {
    const a = row.querySelector('a#video-title, a#thumbnail[href*="/watch"], a[href*="/watch?v="]');
    if (!a) return null;
    const href = a.getAttribute('href') || '';
    const m = href.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    if (!m) return null;
    const titleEl = row.querySelector('#video-title, #video-title-link, h3 a, yt-formatted-string#video-title');
    const title = ((titleEl && (titleEl.getAttribute('title') || titleEl.textContent)) || a.getAttribute('title') || '').trim();
    return { id: m[1], title };
  }

  // Deleted/private rows still render but carry no watch link — they're
  // simply skipped, which is why we count rows AND ids separately.
  function harvest() {
    const seen = new Map();
    for (const row of rows()) {
      const v = readRow(row);
      if (v && !seen.has(v.id)) seen.set(v.id, v);
    }
    return Array.from(seen.values());
  }

  function playlistTitle() {
    const el = document.querySelector(
      'ytd-playlist-header-renderer yt-formatted-string#text, ' +
      'yt-dynamic-sizing-formatted-string #text, ' +
      'ytd-playlist-sidebar-primary-info-renderer h1 yt-formatted-string, ' +
      'h1.ytd-playlist-header-renderer'
    );
    const t = (el && el.textContent || '').trim();
    if (t) return t;
    return (document.title || '').replace(/\s*-\s*YouTube\s*$/i, '').trim();
  }

  try {
    // Wait for the first rows to mount (a cold playlist page can take a
    // couple of seconds before anything is in the DOM at all).
    for (let i = 0; i < 40 && rows().length === 0; i++) await sleep(250);

    if (rows().length === 0) {
      send({ action: 'playlistError', message: 'No videos found on this playlist page. Is the playlist private or empty?' });
      return;
    }

    // Scroll to the bottom until the count stops growing. Each pass gives
    // YouTube time to fetch the next continuation; we allow several quiet
    // passes before deciding we've hit the end, because a slow network can
    // make one pass look like the end when it isn't.
    let last = -1;
    let quiet = 0;
    let passes = 0;
    while (quiet < 4 && passes < 400) {
      passes++;
      const count = harvest().length;
      if (count === last) {
        quiet++;
      } else {
        quiet = 0;
        last = count;
        send({ action: 'playlistProgress', count });
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
      // Nudge the inner scroller too — some layouts scroll a container
      // rather than the document.
      const cont = document.querySelector('ytd-section-list-renderer #contents, #contents.ytd-playlist-video-list-renderer');
      if (cont) cont.scrollIntoView({ block: 'end' });
      await sleep(700);
    }

    const videos = harvest();
    if (videos.length === 0) {
      send({ action: 'playlistError', message: 'Playlist page loaded but no video links were readable.' });
      return;
    }
    send({ action: 'playlistDone', videos, title: playlistTitle() });
  } catch (e) {
    send({ action: 'playlistError', message: (e && e.message) || String(e) });
  } finally {
    window.__ytPlaylistHarvestRunning = false;
  }
})();
