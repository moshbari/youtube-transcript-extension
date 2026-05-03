// =====================================================================
//  Service worker — single-video flow + batch queue manager
// =====================================================================
//
//  The batch queue is persisted to chrome.storage.local so the queue
//  survives service-worker termination. Every transition (start, advance,
//  cancel) writes state back; readers (popup, alarm, message handler)
//  always read the canonical state from storage.
//
//  Queue shape (chrome.storage.local.batchQueue):
//    {
//      active: true,
//      urls:   ["https://www.youtube.com/watch?v=...", ...],
//      total:  22,
//      index:  3,                       // index of video currently scraping
//      currentTabId: 1234,              // tab we navigate between videos
//      lastInjectedIndex: 3,            // dedup against onUpdated re-firing
//      lastMessage: "Loaded 47 segments...",
//      results: [
//        { url, videoId, title, status: 'success'|'failed', lines, error },
//        ...
//      ]
//    }
//
const BATCH_KEY            = 'batchQueue';
const PER_VIDEO_TIMEOUT_MIN = 2;   // chrome.alarms minimum granularity is ~30s
const TIMEOUT_ALARM         = 'batchVideoTimeout';

// ----- Download filename plumbing (see download handler for the why) -----
// Map from data URL -> desired filename. Consumed by onDeterminingFilename
// to authoritatively override Chrome's filename inference, which is
// unreliable for data: URLs and especially for filenames with brackets.
//
// We also keep a Map<downloadId, dataUrl> as a fallback lookup path in
// case the listener-based override misses (it shouldn't, but defense in
// depth) and so we can clean up pendingFilenames after each download.
const pendingFilenames = new Map();
const dataUrlByDownloadId = new Map();

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  // item.url is the original requested URL we passed; item.finalUrl is
  // post-redirect (irrelevant for data: URLs but check both).
  const desired = pendingFilenames.get(item.url) || pendingFilenames.get(item.finalUrl);
  if (desired) {
    suggest({ filename: desired, conflictAction: 'uniquify' });
  } else {
    suggest();   // let Chrome decide for downloads we didn't initiate
  }
});

// Clean up pendingFilenames after each download finishes so the Map
// doesn't accumulate large data URL keys across a long-running session.
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state || !delta.state.current) return;
  const state = delta.state.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  const dataUrl = dataUrlByDownloadId.get(delta.id);
  if (dataUrl) {
    pendingFilenames.delete(dataUrl);
    dataUrlByDownloadId.delete(delta.id);
  }
});

// ---------- queue state helpers ----------
async function getQueue() {
  const r = await chrome.storage.local.get(BATCH_KEY);
  return r[BATCH_KEY] || null;
}
async function setQueue(q) {
  await chrome.storage.local.set({ [BATCH_KEY]: q });
}
async function clearQueue() {
  await chrome.storage.local.remove(BATCH_KEY);
}

// ---------- broadcast to popup (fire and forget) ----------
function broadcast(action, payload) {
  chrome.runtime.sendMessage({ action, ...payload }).catch(() => {});
}
async function broadcastState(extra = {}) {
  const q = await getQueue();
  if (!q) return;
  broadcast('batchStatus', { state: q, ...extra });
}

// ---------- start / cancel ----------
async function startBatch(urls) {
  // If a batch is already in progress, refuse — popup should not let this happen,
  // but be defensive.
  const existing = await getQueue();
  if (existing && existing.active) return;

  const queue = {
    active: true,
    urls: urls.slice(),
    total: urls.length,
    index: 0,
    currentTabId: null,
    lastInjectedIndex: -1,
    lastMessage: 'Starting...',
    results: []
  };
  await setQueue(queue);
  await processNext();
}

async function cancelBatch() {
  const q = await getQueue();
  if (!q) return;
  q.active = false;
  await setQueue(q);
  chrome.alarms.clear(TIMEOUT_ALARM);
  if (q.currentTabId) {
    try { await chrome.tabs.remove(q.currentTabId); } catch {}
  }
  broadcast('batchCancelled', { state: q });
  await clearQueue();
}

// ---------- main loop ----------
async function processNext() {
  const q = await getQueue();
  if (!q || !q.active) return;

  // All done?
  if (q.index >= q.total) {
    if (q.currentTabId) {
      try { await chrome.tabs.remove(q.currentTabId); } catch {}
    }
    chrome.alarms.clear(TIMEOUT_ALARM);
    const finalState = { ...q, active: false };
    await clearQueue();
    broadcast('batchComplete', { state: finalState });
    return;
  }

  const url = q.urls[q.index];
  q.lastMessage = `Opening video ${q.index + 1} of ${q.total}...`;
  await setQueue(q);
  await broadcastState();

  // Open or recycle the tab
  let tabId = q.currentTabId;
  if (tabId) {
    try {
      await chrome.tabs.update(tabId, { url, active: true });
    } catch {
      tabId = null;   // tab was closed by user — make a new one
    }
  }
  if (!tabId) {
    const tab = await chrome.tabs.create({ url, active: true });
    tabId = tab.id;
    q.currentTabId = tabId;
    await setQueue(q);
  }

  // Per-video safety timeout. chrome.alarms minimum is 0.5 minutes in newer
  // Chrome — we use 2 minutes which is comfortably above any min.
  chrome.alarms.create(TIMEOUT_ALARM, { delayInMinutes: PER_VIDEO_TIMEOUT_MIN });

  // The chrome.tabs.onUpdated listener (registered below at module scope)
  // takes over from here: it injects content.js once the tab is loaded,
  // and content.js sends 'done' or 'error' back via runtime messaging.
}

// ---------- record this video's outcome and move on ----------
async function recordResultAndAdvance(result) {
  const q = await getQueue();
  if (!q || !q.active) return;
  q.results.push(result);
  q.index++;
  q.lastInjectedIndex = -1;     // allow next index's onUpdated to inject
  q.lastMessage = result.status === 'success'
    ? `✓ ${result.title || result.videoId || 'done'}`
    : `✗ ${result.error || 'failed'}`;
  await setQueue(q);
  chrome.alarms.clear(TIMEOUT_ALARM);
  await broadcastState();
  await processNext();
}

// =====================================================================
//  Tab-update listener: inject content.js once the batch tab finishes loading.
// =====================================================================
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;

  const q = await getQueue();
  if (!q || !q.active) return;
  if (tabId !== q.currentTabId) return;
  if (!tab.url || !tab.url.includes('youtube.com/watch')) return;

  // Dedup: YouTube can fire 'complete' more than once per real navigation.
  if (q.lastInjectedIndex === q.index) return;
  q.lastInjectedIndex = q.index;
  await setQueue(q);

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
  } catch (err) {
    await recordResultAndAdvance({
      url: q.urls[q.index],
      status: 'failed',
      error: 'Injection failed: ' + err.message
    });
  }
});

// =====================================================================
//  Alarm listener: per-video safety timeout.
// =====================================================================
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== TIMEOUT_ALARM) return;
  const q = await getQueue();
  if (!q || !q.active) return;
  await recordResultAndAdvance({
    url: q.urls[q.index],
    status: 'failed',
    error: 'Timed out after 2 min (no transcript or YouTube hung)'
  });
});

// =====================================================================
//  Single-video (legacy) and batch message routing.
// =====================================================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // ----- single-video flow (unchanged from v1.3) -----
  if (request.action === 'scrapeUrl') {
    chrome.tabs.create({ url: request.url, active: true }, (newTab) => {
      chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
        if (tabId === newTab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          chrome.scripting.executeScript({
            target: { tabId: newTab.id },
            files: ['content.js']
          });
        }
      });
    });
    return;
  }

  if (request.action === 'closeSenderTab' && sender.tab) {
    // In batch mode we keep the tab alive so we can navigate it to the
    // next video. The single-video flow still gets to close.
    getQueue().then(q => {
      if (q && q.active && sender.tab.id === q.currentTabId) return;
      chrome.tabs.remove(sender.tab.id);
    });
    return;
  }

  // ----- file download (used by content.js for both single + batch) -----
  // Centralizing downloads here lets us use chrome.downloads.download(),
  // which runs with the extension's permissions and isn't subject to
  // Chrome's per-site "block multiple automatic downloads" gate that
  // breaks page-context batch downloads.
  //
  // The URL is a data: URL built by content.js — reliable across
  // service-worker suspensions (unlike Blob URLs from the SW context,
  // which can become invalid mid-download). The filename is forced via
  // the onDeterminingFilename listener above, so Chrome's unreliable
  // data-URL filename inference doesn't matter.
  if (request.action === 'download') {
    pendingFilenames.set(request.url, request.filename);
    chrome.downloads.download({
      url: request.url,
      filename: request.filename,    // hint; listener overrides authoritatively
      saveAs: false,
      conflictAction: 'uniquify'     // appends "(1)", "(2)" if name collides
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        const errMsg = chrome.runtime.lastError.message || 'download failed';
        pendingFilenames.delete(request.url);
        // Surface failures up to the queue so a download-failed video
        // gets recorded as failed instead of silently advancing as success.
        getQueue().then(async (q) => {
          if (!q || !q.active) return;
          if (!sender.tab || sender.tab.id !== q.currentTabId) return;
          if (q.lastInjectedIndex !== q.index) return;
          await recordResultAndAdvance({
            url: q.urls[q.index],
            status: 'failed',
            error: 'Download failed: ' + errMsg
          });
        });
        return;
      }
      dataUrlByDownloadId.set(downloadId, request.url);
    });
    return;
  }

  // ----- batch control -----
  if (request.action === 'startBatch') {
    startBatch(request.urls || []);
    return;
  }

  if (request.action === 'cancelBatch') {
    cancelBatch();
    return;
  }

  // ----- batch progress (forwarded from content.js) -----
  if (request.action === 'status' && sender.tab) {
    // Update lastMessage if it's the current batch tab, so popup shows it.
    getQueue().then(async (q) => {
      if (!q || !q.active) return;
      if (sender.tab.id !== q.currentTabId) return;
      q.lastMessage = request.message;
      await setQueue(q);
      broadcastState();
    });
    return;
  }

  if (request.action === 'done' && sender.tab) {
    getQueue().then(async (q) => {
      if (!q || !q.active) return;
      if (sender.tab.id !== q.currentTabId) return;
      // Guard: if the index advanced already (e.g. timeout fired and moved on),
      // lastInjectedIndex was reset and won't match — ignore late messages.
      if (q.lastInjectedIndex !== q.index) return;
      await recordResultAndAdvance({
        url: request.url || q.urls[q.index],
        videoId: request.videoId,
        title: request.title,
        status: 'success',
        lines: request.lines
      });
    });
    return;
  }

  if (request.action === 'error' && sender.tab) {
    getQueue().then(async (q) => {
      if (!q || !q.active) return;
      if (sender.tab.id !== q.currentTabId) return;
      if (q.lastInjectedIndex !== q.index) return;
      await recordResultAndAdvance({
        url: q.urls[q.index],
        status: 'failed',
        error: request.message
      });
    });
    return;
  }
});
