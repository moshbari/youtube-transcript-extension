// =====================================================================
//  Studio harvester — finds your videos' links from YouTube Studio.
// =====================================================================
//
//  Injected into a studio.youtube.com tab. Two modes:
//
//  1) SEARCH mode (default when you've pasted names): types each name
//     into Studio's search box and reads the matching video's link from
//     the results. One quick search per name — no crawling the whole
//     channel. This is how a human would do it, and it handles YouTube
//     turning "Ad_0001_..." into "Ad 0001 ..." for free.
//
//  2) SCROLL mode (fallback / no names): scrolls the Content list and
//     collects every { id, title, url, visibility } the user owns —
//     including unlisted/private, since they're signed in.
//
//  Results merge into chrome.storage.local 'videoLibrary' and are
//  broadcast back to the popup. A window flag guards double-injection.
// =====================================================================
(async function () {
  if (window.__ytStudioHarvestRunning) return;
  window.__ytStudioHarvestRunning = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function progress(count, message) {
    // Live message for an open popup AND a durable copy in storage so a popup
    // that was closed (Chrome closes it on click-away) can re-attach on reopen.
    try { chrome.runtime.sendMessage({ action: 'studioProgress', count, message }); } catch {}
    try {
      chrome.storage.local.set({
        harvestStatus: { running: true, message, count, foundTargets: foundCount(), totalTargets: targetsN.length }
      });
    } catch {}
  }

  // ---- map keyed by videoId so re-seeing a row never double-counts ----
  const videos = new Map();

  // ---- normalization (must mirror popup.js): YouTube turns underscores
  //      into spaces on upload, and users often paste the raw .mp4 name. ----
  const stripExt = (s) => (s || '').replace(/\.(mp4|mov|m4v|webm|mkv|avi|wmv|flv)$/i, '');
  const normT = (s) => stripExt(s).toLowerCase().replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  const looseT = (s) => stripExt(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

  const store = await chrome.storage.local.get(['harvestTargets']);
  const targets = (Array.isArray(store.harvestTargets) ? store.harvestTargets : [])
    .map((s) => (s || '').trim())
    .filter(Boolean);
  const targetsN = targets.map((t) => ({ n: normT(t), l: looseT(t) })).filter((t) => t.n);

  function titleMatches(vTitle, t) {
    const vn = normT(vTitle);
    if (vn === t.n) return true;                 // exact
    if (t.l && looseT(vTitle) === t.l) return true; // exact ignoring punctuation
    if (t.n && vn.includes(t.n)) return true;    // title contains the full name
    // NB: deliberately no reverse-contains / token overlap — for structured
    // names ("Ad 0001 H01 ...") that cross-matches near-identical siblings.
    return false;
  }
  function targetMatched(t) {
    for (const v of videos.values()) if (titleMatches(v.title, t)) return true;
    return false;
  }
  const nameMatched = (name) => { const t = { n: normT(name), l: looseT(name) }; return t.n ? targetMatched(t) : false; };
  const foundCount = () => targetsN.filter(targetMatched).length;
  const allTargetsFound = () => targetsN.length > 0 && targetsN.every(targetMatched);
  async function stopRequested() {
    const s = await chrome.storage.local.get(['harvestStop']);
    return !!s.harvestStop;
  }

  // -------------------------------------------------------------------
  //  Universal harvest: scan every "/video/<id>" anchor on the page and
  //  pull a title for it. Works for both the Content list rows AND the
  //  search-results dropdown, which don't share the same markup.
  // -------------------------------------------------------------------
  const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

  // A video id hides in several shapes: links (watch?v=, /video/<id>/edit,
  // youtu.be, shorts/embed) AND — crucially for search results — the
  // thumbnail image src, i.ytimg.com/vi/<id>/...  Read them all.
  function extractId(s) {
    if (!s) return null;
    let m = s.match(/[?&]v=([A-Za-z0-9_-]{11})(?:&|$)/); if (m) return m[1];
    m = s.match(/\/vi\/([A-Za-z0-9_-]{11})\//); if (m) return m[1];          // thumbnail
    m = s.match(/\/vi_webp\/([A-Za-z0-9_-]{11})\//); if (m) return m[1];     // webp thumbnail
    m = s.match(/\/video\/([A-Za-z0-9_-]{11})(?:\/|$|\?)/); if (m) return m[1];
    m = s.match(/youtu\.be\/([A-Za-z0-9_-]{11})/); if (m) return m[1];
    m = s.match(/\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/); if (m) return m[1];
    return null;
  }

  // A thumbnail link's own text is the DURATION badge ("4:14"), not the title.
  // Reject duration-like / too-short strings so we never store those as titles.
  const DUR_RE = /^(\d{1,2}:)?\d{1,2}:\d{2}$/;
  const isJunkTitle = (t) => { t = (t || '').trim(); return !t || t.length < 3 || DUR_RE.test(t); };

  function titleFromContainer(c) {
    if (!c) return '';
    // The dedicated title element is the reliable source.
    const te = c.querySelector(
      'a#video-title, #video-title, #video-title-container #video-title, [id*="video-title" i], .video-title'
    );
    if (te) {
      const tx = (te.getAttribute('title') || te.textContent || '').trim().split('\n')[0].trim();
      if (!isJunkTitle(tx)) return tx;
    }
    // Fallback: first non-duration, reasonably long text line in this item.
    const lines = (c.textContent || '').split('\n').map((s) => s.trim()).filter(Boolean);
    for (const ln of lines) if (!isJunkTitle(ln) && ln.length >= 4) return ln.slice(0, 140);
    return '';
  }

  // Best-effort title for an element (anchor or img): read it from the NEAREST
  // row/result container (not by climbing into the whole list, which would
  // grab the first row's title for everything).
  function findTitleNear(el) {
    const c = el.closest && el.closest(
      'ytcp-video-row, ytcp-video-list-cell-video, ytcp-text-search-suggestions-list-item, tp-yt-paper-item, ytcp-entity-card, ytcp-grid-renderer-item, li, tr'
    );
    let t = titleFromContainer(c);
    if (t) return t;
    // Element attributes (aria-label/title) — but not its text (that's the badge).
    t = ((el.getAttribute && (el.getAttribute('title') || el.getAttribute('aria-label'))) || '').trim();
    if (!isJunkTitle(t)) return t.split('\n')[0].trim();
    // Last resort: element text, only if it isn't a duration.
    t = (el.textContent || '').trim().split('\n')[0].trim();
    if (!isJunkTitle(t)) return t;
    return '';
  }

  // Collect id -> title from a DOM root (whole page, or just a dropdown).
  function collectFrom(root) {
    const out = new Map();
    const consider = (el, id) => { if (id && !out.has(id)) out.set(id, findTitleNear(el)); };
    root.querySelectorAll('a[href]').forEach((a) => consider(a, extractId(a.getAttribute('href') || '')));
    root.querySelectorAll('img[src]').forEach((img) => consider(img, extractId(img.getAttribute('src') || '')));
    return out;
  }

  // Merge everything currently on the page into the library.
  function harvest() {
    let added = 0;
    for (const [id, title] of collectFrom(document)) {
      if (title && !videos.has(id)) {
        videos.set(id, { id, title, url: watchUrl(id), visibility: '' });
        added++;
      }
    }
    return added;
  }

  // The search-results dropdown container, if present.
  function getSuggestionRoot() {
    return (
      document.querySelector('ytcp-text-search-suggestions') ||
      document.querySelector('ytcp-text-search-box tp-yt-iron-dropdown') ||
      document.querySelector('tp-yt-iron-dropdown[aria-hidden="false"]') ||
      document.querySelector('[role="listbox"]') ||
      document.querySelector('#suggestions')
    );
  }

  // -------------------------------------------------------------------
  //  SEARCH mode helpers
  // -------------------------------------------------------------------
  function setNativeValue(el, value) {
    try {
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
    } catch { el.value = value; }
  }

  async function getSearchInput() {
    const findInput = () => {
      const sels = [
        'ytcp-text-search-box input',
        'ytcp-search-box input',
        '#search-input input',
        'input#search-input',
        'input[aria-label*="Search" i]',
        'input[placeholder*="Search" i]',
        'tp-yt-paper-input input[type="text"]'
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && el.offsetParent !== null) return el;
      }
      return null;
    };
    let input = findInput();
    if (input) return input;
    // Search may be collapsed behind a magnifier icon — click to reveal.
    const opener = document.querySelector(
      'ytcp-icon-button#search-button, #search-button, ytcp-icon-button[aria-label*="Search" i], button[aria-label*="Search" i]'
    );
    if (opener) { opener.click(); await sleep(700); input = findInput(); }
    return input;
  }

  function typeSearch(input, text) {
    input.focus();
    setNativeValue(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setNativeValue(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));
  }

  function clearSearch(input) {
    try {
      input.focus();
      setNativeValue(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch {}
  }

  // -------------------------------------------------------------------
  //  SCROLL mode helpers (fallback)
  // -------------------------------------------------------------------
  function getScroller() {
    const c = [
      document.querySelector('ytcp-video-section-content #video-list'),
      document.querySelector('#video-list'),
      document.querySelector('ytcp-video-section-content'),
      document.scrollingElement,
      document.documentElement
    ];
    return c.find(Boolean) || document.documentElement;
  }
  function scrollDown() {
    const s = getScroller();
    try { s.scrollTop = s.scrollHeight; s.dispatchEvent(new Event('scroll', { bubbles: true })); } catch {}
    window.scrollTo(0, document.body.scrollHeight);
    window.dispatchEvent(new Event('scroll'));
  }
  // Row action buttons (incl. "View on YouTube", which carries a draft's
  // watch link) often only render on hover. Nudge each visible row so those
  // links exist in the DOM before we harvest.
  function hoverRows() {
    document.querySelectorAll('ytcp-video-row').forEach((r) => {
      ['pointerover', 'mouseover', 'mouseenter', 'pointerenter', 'focusin'].forEach((type) => {
        try { r.dispatchEvent(new MouseEvent(type, { bubbles: true })); } catch {}
      });
    });
  }
  function findNextPageBtn() {
    const btn =
      document.querySelector('#navigate-after') ||
      document.querySelector('ytcp-icon-button[aria-label*="next" i]') ||
      document.querySelector('ytcp-table-footer #navigate-after');
    if (!btn) return null;
    const disabled = btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true' || btn.disabled === true;
    return disabled ? null : btn;
  }

  // -------------------------------------------------------------------
  //  Diagnostic snapshot — shows what the harvester actually sees on the
  //  page, so selectors can be fixed against reality instead of guesswork.
  // -------------------------------------------------------------------
  function buildDiag() {
    const rowSelectors = [
      'ytcp-video-row',
      'ytcp-video-list-cell-video',
      '#video-list ytcp-video-row',
      'tbody tr',
      '[id="row-container"]'
    ];
    const rowCounts = {};
    rowSelectors.forEach((s) => { try { rowCounts[s] = document.querySelectorAll(s).length; } catch { rowCounts[s] = 'err'; } });

    let idAnchors = 0;
    const sampleHrefs = [];
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (extractId(href)) {
        idAnchors++;
        if (sampleHrefs.length < 6) sampleHrefs.push(href.slice(0, 70));
      }
    });

    const rows = document.querySelectorAll('ytcp-video-row');
    const sampleRows = [];
    rows.forEach((r, i) => {
      if (i >= 4) return;
      const titleEl = r.querySelector('#video-title, [id*="video-title" i], a#video-title, yt-formatted-string');
      const title = titleEl ? (titleEl.getAttribute('title') || titleEl.textContent || '').trim().split('\n')[0].slice(0, 50) : '(no title el)';
      const hrefs = Array.from(r.querySelectorAll('a[href]')).map((a) => a.getAttribute('href')).filter(Boolean).slice(0, 3).map((h) => h.slice(0, 55));
      sampleRows.push({ title, hrefs });
    });

    const searchInputFound = !!document.querySelector(
      'ytcp-text-search-box input, ytcp-search-box input, #search-input input, input[aria-label*="Search" i], input[placeholder*="Search" i]'
    );

    // First few RAW titles actually captured, so we can see what they look like.
    const sampleTitles = Array.from(videos.values()).slice(0, 8).map((v) => v.title.slice(0, 50));

    // Probe the library for the first pasted name: is it captured at all, and
    // under exactly what title? Surfaces capture vs. normalization problems.
    let probe = null;
    if (targetsN[0]) {
      const t = targetsN[0];
      const tokens = t.n.split(' ').filter((x) => x.length > 1);
      const close = [];
      for (const v of videos.values()) {
        const vn = normT(v.title);
        const score = tokens.filter((tok) => vn.includes(tok)).length;
        if (score >= 2) close.push({ title: v.title.slice(0, 50), score });
      }
      close.sort((a, b) => b.score - a.score);
      probe = {
        target: t.n,
        exactInLib: Array.from(videos.values()).some((v) => normT(v.title) === t.n),
        looseInLib: !!t.l && Array.from(videos.values()).some((v) => looseT(v.title) === t.l),
        tokenCount: tokens.length,
        close: close.slice(0, 5)
      };
    }

    return { rowCounts, idAnchors, harvested: videos.size, searchInputFound, sampleHrefs, sampleRows, sampleTitles, probe };
  }

  // -------------------------------------------------------------------
  //  Save + report
  // -------------------------------------------------------------------
  async function finish() {
    harvest();
    const prev = (await chrome.storage.local.get(['videoLibrary'])).videoLibrary;
    const merged = new Map();
    if (prev && Array.isArray(prev.videos)) for (const v of prev.videos) merged.set(v.id, v);
    for (const v of videos.values()) merged.set(v.id, v);

    const library = { videos: Array.from(merged.values()), scrapedAt: new Date().toISOString() };
    const done = {
      running: false,
      done: true,
      stamp: Date.now(),
      count: library.videos.length,
      foundTargets: foundCount(),
      totalTargets: targetsN.length,
      diag: buildDiag()
    };
    await chrome.storage.local.set({ videoLibrary: library, harvestStop: false, harvestStatus: done });
    try { chrome.runtime.sendMessage({ action: 'studioDone', ...done }); } catch {}
  }

  // =================================================================
  //  Run
  // =================================================================
  try {
    await chrome.storage.local.set({
      harvestStatus: { running: true, message: 'Starting…', count: 0, foundTargets: 0, totalTargets: targetsN.length }
    });

    // ---- SEARCH mode: only when the user pasted names ----
    if (targetsN.length) {
      const input = await getSearchInput();
      if (input) {
        for (let i = 0; i < targets.length; i++) {
          if (await stopRequested()) break;
          const name = targets[i];
          if (nameMatched(name)) continue; // already found from a prior search
          progress(videos.size, `Searching Studio for "${name}" — ${i + 1}/${targets.length}…`);

          // Snapshot ids already on the page so we can tell which ones the
          // search dropdown adds.
          const beforeIds = new Set(collectFrom(document).keys());
          typeSearch(input, name);

          // Poll up to ~6s for the dropdown results to show up.
          let resultIds = [];
          let resultMap = new Map();
          for (let w = 0; w < 12; w++) {
            await sleep(500);
            const root = getSuggestionRoot();
            const found = root ? collectFrom(root) : null;
            if (found && found.size) {
              resultMap = found;
              resultIds = Array.from(found.keys());
              break;
            }
            // Fallback: whatever ids appeared that weren't there before.
            const fresh = Array.from(collectFrom(document).keys()).filter((id) => !beforeIds.has(id));
            if (fresh.length) {
              resultIds = fresh;
              break;
            }
            if (await stopRequested()) break;
          }

          // Record results. If the search returned exactly one video, we KNOW
          // it's this name — force its title to the typed name so the match is
          // guaranteed regardless of any title quirk.
          if (resultIds.length === 1) {
            const id = resultIds[0];
            videos.set(id, { id, title: name, url: watchUrl(id), visibility: '' });
          } else {
            for (const id of resultIds) {
              if (!videos.has(id)) {
                videos.set(id, { id, title: (resultMap.get(id) || name), url: watchUrl(id), visibility: '' });
              }
            }
          }
          progress(videos.size, `${foundCount()}/${targetsN.length} of your names found…`);
        }
        clearSearch(input);
        await sleep(800); // let the list repopulate after clearing the search
        // Drafts usually don't appear in global search — if anything is still
        // missing, fall through to scanning the Content list below.
        if (allTargetsFound()) {
          await finish();
          window.__ytStudioHarvestRunning = false;
          return;
        }
        progress(videos.size, `${foundCount()}/${targetsN.length} found in search — checking your list for the rest…`);
      } else {
        // No search box found — fall through to scroll mode below.
        progress(videos.size, 'Search box not found — reading the list instead…');
      }
    }

    // ---- SCROLL mode: read the Content list ----
    let waited = 0;
    while (!document.querySelector('ytcp-video-row') && waited < 16) { await sleep(500); waited++; }
    if (!document.querySelector('ytcp-video-row')) {
      const message = 'No video list found. Open YouTube Studio and click "Content" (the Videos list) first, then try again.';
      try { await chrome.storage.local.set({ harvestStatus: { running: false, error: message, stamp: Date.now() } }); } catch {}
      try { chrome.runtime.sendMessage({ action: 'studioError', message }); } catch {}
      window.__ytStudioHarvestRunning = false;
      return;
    }

    let safety = 0;
    const MAX_ITERS = 4000;
    let finished = false;

    while (!finished && safety++ < MAX_ITERS) {
      let stable = 0;
      while (stable < 3 && safety++ < MAX_ITERS) {
        const before = videos.size;
        hoverRows();
        harvest();
        const grew = videos.size > before;
        progress(videos.size, targetsN.length
          ? `Scanning… ${videos.size} videos read, ${foundCount()}/${targetsN.length} of your names found`
          : `Reading your videos… ${videos.size} found`);
        if (allTargetsFound()) { finished = true; break; }
        if (await stopRequested()) { finished = true; break; }
        scrollDown();
        await sleep(grew ? 600 : 900);
        const after = (harvest(), videos.size);
        if (after > before) stable = 0; else stable++;
      }
      if (finished) break;

      const next = findNextPageBtn();
      if (!next) break;
      next.click();
      progress(videos.size, `Loading next page… ${videos.size} so far`);
      await sleep(1500);
      if (await stopRequested()) { finished = true; break; }
    }

    await finish();
  } catch (err) {
    const message = String(err && err.message || err);
    try { await chrome.storage.local.set({ harvestStatus: { running: false, error: message, stamp: Date.now() } }); } catch {}
    try { chrome.runtime.sendMessage({ action: 'studioError', message }); } catch {}
  } finally {
    window.__ytStudioHarvestRunning = false;
  }
})();
