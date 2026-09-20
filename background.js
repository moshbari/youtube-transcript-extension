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

// ---- Retry-until-ready + dedup (batch) ----
// A batch makes repeated PASSES over its videos. The first pass starts AT ONCE.
// Any video whose transcript isn't ready yet fails its pass and is retried 3
// minutes later, again and again, until every video has downloaded or we hit
// the pass cap. Modelled on the Tella poll loop further down.
//
// The first pass used to be delayed 3 minutes as well, on the theory that
// YouTube needs time to make captions after an upload. That's only true for the
// one caller that hands us a video seconds old (a fresh TubeDrop upload). For a
// playlist, or any link pasted by hand, the captions have existed for months and
// the delay bought nothing but three minutes of staring at a spinner. A fresh
// upload simply fails its instant first pass and picks up the 3-minute retry
// loop exactly as before — one cheap extra attempt, no behaviour lost.
const BATCH_RETRY_ALARM = 'batchRetry';
const BATCH_RETRY_MIN   = 3;     // minutes between passes (and before the first)
const BATCH_MAX_PASSES  = 60;    // 60 * 3 min ≈ 3 hours of retrying
// Persistent set of video IDs we've already downloaded — never download twice.
const DOWNLOADED_KEY    = 'downloadedVideoIds';

async function getDownloadedIds() {
  const r = await chrome.storage.local.get(DOWNLOADED_KEY);
  return r[DOWNLOADED_KEY] || {};
}
async function addDownloadedId(videoId, title) {
  if (!videoId) return;
  const ids = await getDownloadedIds();
  ids[videoId] = { at: Date.now(), title: title || '' };
  await chrome.storage.local.set({ [DOWNLOADED_KEY]: ids });
}

// A single PERIODIC alarm drives all retries (not a chain of one-shots, which
// breaks if the service worker is killed between passes). It ticks every 3 min
// for the whole life of a batch; each tick re-runs the still-pending videos.
// Ticks that land while a pass is already running are ignored (see the handler),
// so it costs nothing to start this at the same moment as the first pass.
function ensureBatchRetryAlarm() {
  chrome.alarms.create(BATCH_RETRY_ALARM, { periodInMinutes: BATCH_RETRY_MIN });
}

// =====================================================================
//  Offscreen document for downloads
// =====================================================================
//
//  We route all transcript file writes through an offscreen document
//  rather than calling chrome.downloads.download from the service
//  worker. The offscreen doc uses <a download>.click() in a page
//  context, which honors the filename attribute deterministically.
//  See offscreen.js for the full reasoning.
//
const OFFSCREEN_PATH = 'offscreen.html';
let offscreenCreating = null;

async function ensureOffscreenDocument() {
  // Check whether the doc already exists. chrome.runtime.getContexts is
  // the supported way to query this in MV3 (Chrome 116+).
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });
  if (existing && existing.length > 0) return;

  // Avoid races where multiple parallel callers all try to create.
  if (offscreenCreating) return offscreenCreating;
  offscreenCreating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['BLOBS'],
    justification: 'Trigger transcript file downloads from a page context so filenames are honored and Chrome\'s per-origin multi-download gate (which blocks YouTube-tab downloads in batch mode) does not apply.'
  });
  try {
    await offscreenCreating;
  } finally {
    offscreenCreating = null;
  }
}

async function downloadViaOffscreen(text, filename) {
  await ensureOffscreenDocument();
  const reply = await chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'download',
    text,
    filename
  }).catch(err => ({ ok: false, error: err && err.message }));
  return reply || { ok: false, error: 'no reply from offscreen doc' };
}

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

// ---------- 🎙️ podcast projects are matched by VIDEO ID, never by URL ----------
//
// The upload page hands over links in the short form (https://youtu.be/abc123),
// but the transcript is scraped on the canonical watch page, so content.js
// reports back https://www.youtube.com/watch?v=abc123. Matching the two as
// strings missed EVERY time: the transcript downloaded fine, the Podcast Brain
// was never called, and nothing anywhere said so — the episode just sat in the
// editor with no hooks, no cuts and no post.
//
// The video id is the only stable name a video has, so the map is keyed on it
// the moment the batch is queued.
function normalizePodcastJobs(raw) {
  const out = {};
  for (const [url, jobId] of Object.entries(raw || {})) {
    if (!jobId) continue;
    const id = extractYtId(url);
    if (id) out[id] = jobId;      // keyed by id from here on
    else out[url] = jobId;        // unrecognisable link — keep it rather than lose it
  }
  return out;
}

// Find the podcast project a finished video belongs to. Tries the id first,
// then the raw URLs, so a batch queued by an older version still resolves.
function podcastJobFor(q, { videoId, url, altUrl }) {
  const map = q && q.podcastJobs;
  if (!map) return null;
  const id = videoId || extractYtId(url || '') || extractYtId(altUrl || '');
  return (id && map[id]) || (url && map[url]) || (altUrl && map[altUrl]) || null;
}

// ---------- start / cancel ----------
async function startBatch(urls, opts = {}) {
  // If a batch is already in progress, refuse — popup should not let this happen,
  // but be defensive.
  const existing = await getQueue();
  if (existing && existing.active) return;

  // De-dupe the incoming list by video ID, then drop anything we've already
  // downloaded in a previous run (unless the caller forces a re-scrape).
  const downloaded = opts.force ? {} : await getDownloadedIds();
  const podcastJobs = normalizePodcastJobs(opts.podcastJobs);
  const seen = new Set();
  const fresh = [];
  let skipped = 0;
  for (const u of urls) {
    const id = extractYtId(u);
    const key = id || u;
    if (seen.has(key)) continue;
    seen.add(key);
    // 🎙️ Never dedupe an episode that is bound to a podcast project. The
    // "already downloaded" memory exists to avoid re-fetching a transcript we
    // have on disk — but a podcast episode's whole point is the hand-off to the
    // Brain, not the file. Skipping it here meant an episode whose transcript
    // once downloaded could never be sent to the editor again: the page said
    // "Nothing new" and the project stayed empty forever.
    if (id && podcastJobs[id]) { fresh.push(u); continue; }
    if (id && downloaded[id]) { skipped++; continue; }
    fresh.push(u);
  }

  // Remember where the user was so we can snap focus back between passes.
  let returnToTabId = null, returnToWindowId = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs[0]) { returnToTabId = tabs[0].id; returnToWindowId = tabs[0].windowId; }
  } catch {}

  // Nothing new to do — everything was already downloaded.
  if (!fresh.length) {
    broadcast('batchComplete', {
      state: { active: false, allTotal: urls.length, doneIds: [], skipped, results: [],
               lastMessage: `Nothing new — all ${skipped} already downloaded.` }
    });
    return;
  }

  const queue = {
    active: true,
    urls: fresh.slice(),       // the working list for THIS pass
    total: fresh.length,
    index: 0,
    currentTabId: null,
    lastInjectedIndex: -1,
    lastMessage: skipped
      ? `Starting — ${fresh.length} to scrape (${skipped} already downloaded, skipped)…`
      : `Starting — ${fresh.length} video${fresh.length === 1 ? '' : 's'} to scrape…`,
    // --- retry-until-ready bookkeeping ---
    allTotal: fresh.length,    // total videos this batch is responsible for
    doneIds: [],               // video IDs successfully downloaded this batch
    pass: 1,
    maxPasses: BATCH_MAX_PASSES,
    skipped,
    // 🎙️ { videoId: podcastProjectId } for links uploaded with "Also send to
    // the Podcast Editor". Lives on the queue (which is chrome.storage-backed),
    // so it survives the service worker being shut down during the hours
    // YouTube can take to produce captions. Keyed by id, not URL — see
    // normalizePodcastJobs above for why that mattered.
    podcastJobs,
    returnToTabId, returnToWindowId,
    // Go now. Only videos that actually come back without a transcript wait
    // for the 3-minute retry loop.
    waiting: false,
    nextRetryAt: null,
    // When toCouncil is on, each scraped transcript is sent to The Closer's
    // Council and the follow-up is stored on that video's result.
    toCouncil: !!opts.toCouncil,
    lang: opts.lang || 'bn',
    results: []
  };
  await setQueue(queue);
  // Arm the retry heartbeat for any video that turns out not to be ready, then
  // start scraping straight away. A tick arriving mid-pass is a no-op.
  ensureBatchRetryAlarm();
  await broadcastState();
  await processNext();
}

// Snap focus back to wherever the user was before the batch stole it.
function restoreFocus(q) {
  if (!q) return;
  if (q.returnToTabId != null) {
    chrome.tabs.update(q.returnToTabId, { active: true }).catch(() => {});
    if (q.returnToWindowId != null) chrome.windows.update(q.returnToWindowId, { focused: true }).catch(() => {});
  }
}

// ---- Send a transcript to The Closer's Council (fire-and-forget) ----
// The extension's only job is to hand off the transcript. The Council runs the
// analysis on its own server and saves it to the prospect's diary; the user
// reads the result by logging into the Council, not here.
const COUNCIL_BACKEND = 'https://tellatotube.up.railway.app';

async function sendToCouncil({ transcript, prospectName = '', notes = '', situation = '', lang }) {
  // The server on Railway can briefly serve an HTML platform page (502/503/504)
  // during a cold start or restart. Blindly calling res.json() on that used to
  // kill the whole run with "Unexpected token '<'". Read the body as text, and
  // retry a few times on any transient non-JSON / 5xx blip before giving up.
  const attempts = 3;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${COUNCIL_BACKEND}/followup/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, prospectName, notes, situation, lang }),
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        // Not JSON — almost always a temporary Railway error page. Retry.
        throw new Error(`The Council server was briefly unavailable (HTTP ${res.status}).`);
      }
      if (!res.ok || !data.ok) throw new Error(data.error || `Could not send to the Council (HTTP ${res.status}).`);
      return { prospectName: data.prospectName || '' };
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastErr || new Error('Could not send to the Council.');
}

// ---- 🎙️ Send a transcript to the Podcast Brain (fire-and-forget) ----
// Same shape and the same retry reasoning as sendToCouncil above: Railway can
// briefly serve an HTML error page on a cold start, and calling res.json() on
// that used to kill a whole run.
//
// The transcript sent here is the TIMESTAMPED one. The Council wants flowing
// text, but hooks and cuts are time ranges — without the cue times there is
// nothing to cut.
async function sendToPodcastEditor({ devrantJobId, transcript, youtubeUrl }) {
  const attempts = 3;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${COUNCIL_BACKEND}/podcast/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devrantJobId, transcript, youtubeUrl }),
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`The podcast server was briefly unavailable (HTTP ${res.status}).`);
      }
      if (!res.ok || !data.ok) throw new Error(data.error || `Could not send to the Podcast Editor (HTTP ${res.status}).`);
      return { projectUrl: data.projectUrl || '' };
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastErr || new Error('Could not send to the Podcast Editor.');
}

async function cancelBatch() {
  const q = await getQueue();
  if (!q) return;
  q.active = false;
  await setQueue(q);
  chrome.alarms.clear(TIMEOUT_ALARM);
  chrome.alarms.clear(BATCH_RETRY_ALARM);
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

  // Reached the end of this pass?
  if (q.index >= q.total) {
    await finishPass(q);
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
  if (result.status === 'success') {
    const vid = result.videoId || extractYtId(result.url || '');
    if (vid) {
      await addDownloadedId(vid, result.title);        // never download this one again
      if (!q.doneIds) q.doneIds = [];
      if (!q.doneIds.includes(vid)) q.doneIds.push(vid);
    }
  }
  q.index++;
  q.lastInjectedIndex = -1;     // allow next index's onUpdated to inject
  const name = result.title || result.videoId || 'done';
  q.lastMessage = result.status === 'success'
    ? (result.podcastSent ? `✓ ${name} → 🎙️ Podcast Editor`
      : result.podcastError ? `✓ ${name} — but the Podcast Editor hand-off failed: ${result.podcastError}`
      : `✓ ${name}`)
    : `✗ ${result.error || 'failed'}`;
  await setQueue(q);
  chrome.alarms.clear(TIMEOUT_ALARM);
  await broadcastState();
  await processNext();
}

// ---------- end of a pass: download done, or schedule a 3-min retry ----------
async function finishPass(q) {
  if (q.currentTabId) { try { await chrome.tabs.remove(q.currentTabId); } catch {} }
  q.currentTabId = null;
  chrome.alarms.clear(TIMEOUT_ALARM);
  restoreFocus(q);

  // Videos that still don't have a transcript this pass — retry them next time.
  const failedUrls = q.results.filter(r => r.status !== 'success').map(r => r.url);
  const doneCount = (q.doneIds || []).length;

  // Everything downloaded — we're finished.
  if (!failedUrls.length) {
    chrome.alarms.clear(BATCH_RETRY_ALARM);
    const finalState = { ...q, active: false,
      lastMessage: `All done ✓ — ${doneCount} transcript${doneCount === 1 ? '' : 's'} downloaded.` };
    await clearQueue();
    broadcast('batchComplete', { state: finalState });
    return;
  }

  // Hit the pass cap — give up on the stragglers (YouTube never made captions).
  if (q.pass >= (q.maxPasses || BATCH_MAX_PASSES)) {
    chrome.alarms.clear(BATCH_RETRY_ALARM);
    const finalState = { ...q, active: false,
      lastMessage: `Stopped after ${q.pass} tries — ${doneCount} downloaded, ${failedUrls.length} still had no transcript on YouTube.` };
    await clearQueue();
    broadcast('batchComplete', { state: finalState });
    return;
  }

  // Some still pending — go into "waiting" until the next heartbeat tick (≤3 min)
  // re-runs just those. The periodic alarm created at startBatch keeps ticking,
  // so this survives the worker being killed in between.
  q.urls = failedUrls;
  q.total = failedUrls.length;
  q.index = 0;
  q.lastInjectedIndex = -1;
  q.results = [];
  q.pass = (q.pass || 1) + 1;
  q.waiting = true;
  q.nextRetryAt = Date.now() + BATCH_RETRY_MIN * 60 * 1000;
  q.lastMessage = `${doneCount}/${q.allTotal} done — ${failedUrls.length} not ready yet. Retrying within ${BATCH_RETRY_MIN} min (try ${q.pass}).`;
  await setQueue(q);
  ensureBatchRetryAlarm();   // idempotent — make sure the heartbeat is alive
  await broadcastState();
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

// Heartbeat tick (every 3 min): if the batch is waiting between passes, kick off
// the next pass over the still-pending videos. If a pass is already in flight,
// do nothing this tick. If there's no batch, stop the heartbeat.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== BATCH_RETRY_ALARM) return;
  const q = await getQueue();
  if (!q || !q.active) { chrome.alarms.clear(BATCH_RETRY_ALARM); return; }
  if (!q.waiting) return;            // a pass is currently running — don't double-start
  q.waiting = false;
  q.nextRetryAt = null;
  await setQueue(q);
  await processNext();
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
  // Routes through the offscreen document rather than calling
  // chrome.downloads.download here. See ensureOffscreenDocument /
  // offscreen.js for why — it's the only path we've found that
  // reliably honors the filename across Chrome versions and
  // simultaneously bypasses the YouTube-page multi-download throttle.
  if (request.action === 'download') {
    const senderTabId = sender.tab && sender.tab.id;
    downloadViaOffscreen(request.text, request.filename).then(reply => {
      if (reply.ok) return;
      // Surface failures up to the queue so a download-failed video
      // gets recorded as failed instead of silently advancing as success.
      getQueue().then(async (q) => {
        if (!q || !q.active) return;
        if (!senderTabId || senderTabId !== q.currentTabId) return;
        if (q.lastInjectedIndex !== q.index) return;
        await recordResultAndAdvance({
          url: q.urls[q.index],
          status: 'failed',
          error: 'Download failed: ' + (reply.error || 'unknown')
        });
      });
    });
    return;
  }

  // ----- batch control -----
  if (request.action === 'startBatch') {
    startBatch(request.urls || [], { toCouncil: !!request.toCouncil, lang: request.lang });
    return;
  }

  if (request.action === 'cancelBatch') {
    cancelBatch();
    return;
  }

  // How many videos has the extension ever downloaded (the dedup memory)?
  if (request.action === 'getDownloadedCount') {
    getDownloadedIds().then((ids) => sendResponse({ ok: true, count: Object.keys(ids).length }));
    return true; // async
  }

  // Forget the dedup memory so previously-downloaded videos can be scraped again.
  if (request.action === 'clearDownloaded') {
    chrome.storage.local.remove(DOWNLOADED_KEY).then(() => sendResponse({ ok: true }));
    return true; // async
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

      const base = {
        url: request.url || q.urls[q.index],
        videoId: request.videoId,
        title: request.title,
        status: 'success',
        lines: request.lines,
      };

      // 🎙️ Is this video bound to a podcast project? If so the transcript goes
      // to the Podcast Brain, which writes the hooks, the cuts and the Facebook
      // post into the editor. Fire-and-forget — the analysis takes up to twenty
      // minutes on the server and reports itself there.
      const podcastJobId = podcastJobFor(q, {
        videoId: request.videoId || base.videoId,
        url: base.url,
        altUrl: request.url,
      });
      if (podcastJobId) {
        chrome.alarms.clear(TIMEOUT_ALARM);
        try {
          await sendToPodcastEditor({
            devrantJobId: podcastJobId,
            transcript: request.text || '',   // timestamped, not plainText
            youtubeUrl: base.url,
          });
          await recordResultAndAdvance({ ...base, podcastSent: true });
        } catch (e) {
          // The transcript still downloaded — only the hand-off failed. Say so
          // rather than letting the episode look finished.
          await recordResultAndAdvance({ ...base, podcastError: e.message });
        }
        return;
      }

      // Plain "scrape only" batch — record and move on, as before.
      if (!q.toCouncil) { await recordResultAndAdvance(base); return; }

      // Council batch — fire-and-forget: send the transcript, mark it sent, advance.
      chrome.alarms.clear(TIMEOUT_ALARM);
      try {
        const { prospectName } = await sendToCouncil({
          transcript: request.plainText || request.text || '',
          notes: request.title,
          lang: q.lang || 'bn',
        });
        await recordResultAndAdvance({ ...base, councilSent: true, prospectName });
      } catch (e) {
        await recordResultAndAdvance({ ...base, councilError: e.message });
      }
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

// =====================================================================
//  Tella → Follow-up pipeline (fallback flow)
// =====================================================================
//
//  Flow per job:
//    1. POST the Tella link to the backend /upload  -> YouTube (unlisted)
//    2. Every 5 min, open the YouTube watch page in a background tab and
//       run content.js to scrape the transcript (retry until YouTube has
//       generated it).
//    3. POST the scraped transcript to the backend /followup, which forwards
//       it to The Closer's Council (key stays server-side) -> next-move plan.
//
//  Jobs persist in chrome.storage.local.tellaJobs so they survive
//  service-worker termination; a periodic chrome.alarm drives the polling.

const TELLA_BACKEND = 'https://tellatotube.up.railway.app';
const TELLA_JOBS_KEY = 'tellaJobs';
const TELLA_ALARM = 'tellaPoll';
const TELLA_MAX_ATTEMPTS = 36;        // 36 * 5 min = 3 hours of polling
const TELLA_SCRAPE_TIMEOUT_MS = 150000;

async function getTellaJobs() {
  const r = await chrome.storage.local.get(TELLA_JOBS_KEY);
  return r[TELLA_JOBS_KEY] || {};
}
async function setTellaJobs(jobs) {
  await chrome.storage.local.set({ [TELLA_JOBS_KEY]: jobs });
}
async function patchTellaJob(id, patch) {
  const jobs = await getTellaJobs();
  if (!jobs[id]) return;
  Object.assign(jobs[id], patch, { updated: Date.now() });
  await setTellaJobs(jobs);
}
async function broadcastTella() {
  const jobs = await getTellaJobs();
  broadcast('tellaState', { jobs: Object.values(jobs).sort((a, b) => b.created - a.created) });
}
function ensureTellaAlarm() {
  // Poll roughly every minute (first tick ~30s) so uploads are detected quickly.
  // Transcript scraping is throttled separately to ~5 min (see pollTellaJobs).
  chrome.alarms.create(TELLA_ALARM, { delayInMinutes: 0.5, periodInMinutes: 1 });
}
function extractYtId(url) {
  if (!url) return null;
  let m = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = url.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = url.match(/\/embed\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = url.match(/\/live\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  return null;
}

// ----- PullTranscript web-app bridge -----
// bridge.js (content script on pulltranscript.com) forwards scrape requests
// here. We reuse the same background-tab scrape engine as the Tella flow and
// hand back the timestamped segments. Kept as its own listener so the async
// sendResponse (return true) doesn't interfere with the other listeners.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || request.action !== 'bridgeScrape') return;
  const videoId = extractYtId(request.url || '');
  if (!videoId) {
    sendResponse({ ok: false, error: 'Could not find a YouTube video ID in that URL.' });
    return;
  }
  scrapeYoutube(videoId)
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ ok: false, error: (e && e.message) || 'Scrape failed' }));
  return true; // keep the message channel open for the async response
});

// ----- Batch handoff from a web page (e.g. tella-to-youtube) -----
// bridge.js forwards a LIST of YouTube URLs here. We feed them straight into
// the same batch engine the popup uses, so the user never copy-pastes links:
// upload page → "Send to Scraper" → transcripts download themselves (with the
// 5-min retry + dedup above). Returns immediately; progress shows in the popup.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || request.action !== 'bridgeBatch') return;
  const urls = Array.isArray(request.urls) ? request.urls.filter(Boolean) : [];
  if (!urls.length) {
    sendResponse({ ok: false, error: 'No YouTube links received.' });
    return true;
  }
  getQueue().then(async (existing) => {
    if (existing && existing.active) {
      sendResponse({ ok: false, error: 'A batch is already running — wait for it to finish.' });
      return;
    }
    // A page may hand us a playlist link instead of (or alongside) video
    // links — expand it here so every consumer gets the same behaviour.
    let final = urls;
    if (urls.some((u) => extractPlaylistId(u))) {
      const ex = await expandPlaylistsInUrls(urls, (p) => broadcast('playlistProgress', p));
      final = ex.urls;
      if (!final.length) {
        sendResponse({ ok: false, error: ex.errors[0] || 'That playlist had no readable videos.' });
        return;
      }
    }
    startBatch(final, { toCouncil: false, podcastJobs: request.podcastJobs || {} });
    sendResponse({ ok: true, accepted: final.length });
  });
  return true; // async sendResponse
});

// =====================================================================
//  Playlist expansion — one playlist URL -> every video URL in it.
// =====================================================================
//  Opens the playlist page in a real tab and lets playlist.js read it to
//  the end — the page itself only ever renders 100 rows, so playlist.js
//  follows YouTube's own continuation chain for the rest (see that file).
//  Same trade as scrapeYoutube: we steal focus briefly, then hand it back.
//
//  No YouTube Data API: the rows are read from the user's own signed-in
//  page, so their unlisted and private playlists work too.

const PLAYLIST_TIMEOUT_MS = 300000;   // 10k-video playlists exist; be patient
const playlistResolvers = new Map();  // tabId -> { finish, onProgress }

// Anything after list= that is a real, finite playlist. Mixes/radio (RD...)
// are auto-generated and effectively endless, so they are refused up front.
function extractPlaylistId(url) {
  if (!url) return null;
  const m = String(url).match(/[?&]list=([A-Za-z0-9_-]{2,})/);
  if (!m) return null;
  return m[1];
}

function isMixPlaylist(listId) {
  return /^(RD|UL|TL)/.test(listId || '');
}

function expandPlaylist(listId, onProgress) {
  return new Promise((resolve) => {
    const url = `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`;
    let settled = false;
    let createdTabId = null;

    const finish = (result) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      if (createdTabId != null) {
        playlistResolvers.delete(createdTabId);
        chrome.tabs.remove(createdTabId).catch(() => {});
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'Timed out loading the playlist.' }), PLAYLIST_TIMEOUT_MS);

    // active:false, unlike scrapeYoutube. A watch page must be VISIBLE for
    // YouTube to mount the transcript panel, but a playlist needs no rendering
    // at all — playlist.js reads the server-sent data out of the page and
    // fetches the rest. Opening it active would also steal focus, and focus
    // leaving the toolbar CLOSES THE POPUP mid-await, which is exactly how the
    // first cut of this feature did nothing at all.
    Promise.resolve(chrome.tabs.create({ url, active: false })).then((tab) => {
      createdTabId = tab.id;
      playlistResolvers.set(createdTabId, { finish, onProgress });
      const onUpd = (tabId, info) => {
        if (tabId === createdTabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(onUpd);
          chrome.scripting.executeScript({ target: { tabId }, files: ['playlist.js'] })
            .catch((e) => finish({ ok: false, error: 'inject failed: ' + e.message }));
        }
      };
      chrome.tabs.onUpdated.addListener(onUpd);
    }).catch((e) => finish({ ok: false, error: 'tab create failed: ' + e.message }));
  });
}

// playlist.js reports from inside the playlist tab.
chrome.runtime.onMessage.addListener((request, sender) => {
  if (!sender.tab) return;
  const entry = playlistResolvers.get(sender.tab.id);
  if (!entry) return;
  if (request.action === 'playlistProgress') {
    if (entry.onProgress) entry.onProgress(request.count || 0);
  } else if (request.action === 'playlistDone') {
    entry.finish({ ok: true, videos: request.videos || [], title: request.title || '' });
  } else if (request.action === 'playlistError') {
    entry.finish({ ok: false, error: request.message || 'Could not read the playlist.' });
  }
});

// Turn a mixed paste (video links AND playlist links) into a flat, deduped
// list of video URLs, expanding every playlist it finds. Shared by the popup
// and the web-page bridge so both behave identically.
async function expandPlaylistsInUrls(urls, onProgress) {
  const seen = new Set();
  const out = [];
  const errors = [];
  const pushId = (id) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(`https://www.youtube.com/watch?v=${id}`);
  };

  for (const raw of urls) {
    const listId = extractPlaylistId(raw);
    const bare = String(raw).match(/^([A-Za-z0-9_-]{11})$/);
    const videoId = extractYtId(raw) || (bare ? bare[1] : null);
    // A bare /watch link with no list= is just a video. A link carrying a
    // list= is treated as the playlist the user meant to hand us.
    if (listId && !isMixPlaylist(listId)) {
      const r = await expandPlaylist(listId, (count) => {
        if (onProgress) onProgress({ listId, count });
      });
      if (r.ok) {
        if (onProgress) onProgress({ listId, count: r.videos.length, done: true, title: r.title });
        for (const v of r.videos) pushId(v.id);
      } else {
        errors.push(`Playlist ${listId}: ${r.error}`);
        if (videoId) pushId(videoId);   // salvage the one video we do have
      }
    } else if (listId && isMixPlaylist(listId)) {
      errors.push('YouTube Mixes / auto-playlists have no fixed end, so they cannot be expanded.');
      if (videoId) pushId(videoId);
    } else if (videoId) {
      pushId(videoId);
    }
  }
  return { urls: out, errors };
}

// ----- playlist -> batch, owned end to end by the background -----
// The popup must NOT drive this. Chrome closes the popup whenever focus moves,
// and the popup being closed is the normal case, not the edge case: an awaited
// sendMessage dies with it and the batch silently never starts. So the popup
// fires this and forgets, and every scrap of progress goes to storage (for a
// popup that reopens later) as well as over the wire (for one that's watching).
const PLAYLIST_STATE_KEY = 'playlistExpandState';

async function setPlaylistState(patch) {
  const state = { at: Date.now(), ...patch };
  await chrome.storage.local.set({ [PLAYLIST_STATE_KEY]: state });
  broadcast('playlistProgress', state);
}

async function runPlaylistBatch({ urls, toCouncil, lang }) {
  try {
    await setPlaylistState({ active: true, count: 0, message: 'Opening the playlist...' });

    const r = await expandPlaylistsInUrls(urls, (p) => {
      setPlaylistState({
        active: true,
        count: p.count || 0,
        title: p.title || '',
        message: p.done
          ? `Playlist loaded — ${p.count} videos.`
          : `Loading playlist... ${p.count} videos found so far`
      });
    });

    if (!r.urls.length) {
      await setPlaylistState({ active: false, error: r.errors[0] || 'That playlist had no readable videos.' });
      return;
    }

    // Put the expanded list where the popup's textarea reads from, so reopening
    // it shows exactly what got queued instead of the playlist link.
    await chrome.storage.local.set({ batchUrlsDraft: r.urls.join('\n') });
    await setPlaylistState({
      active: false,
      count: r.urls.length,
      done: true,
      message: r.errors.length ? r.errors[0] : `Playlist loaded — ${r.urls.length} videos. Starting...`
    });

    await startBatch(r.urls, { toCouncil: !!toCouncil, lang });
  } catch (e) {
    await setPlaylistState({ active: false, error: (e && e.message) || 'Playlist expansion failed' });
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || request.action !== 'startPlaylistBatch') return;
  const urls = Array.isArray(request.urls) ? request.urls.filter(Boolean) : [];
  if (!urls.length) {
    sendResponse({ ok: false, error: 'Nothing to expand.' });
    return true;
  }
  getQueue().then((existing) => {
    if (existing && existing.active) {
      sendResponse({ ok: false, error: 'A batch is already running — wait for it to finish.' });
      return;
    }
    // Answer at once; the work outlives the popup.
    sendResponse({ ok: true, started: true });
    runPlaylistBatch({ urls, toCouncil: request.toCouncil, lang: request.lang });
  });
  return true; // async sendResponse
});

// ----- open a YT watch page in the background and scrape via content.js -----
const tellaScrapeResolvers = new Map(); // tabId -> resolve()

function scrapeYoutube(videoId) {
  return new Promise((resolve) => {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    let settled = false;
    let createdTabId = null;
    let returnToTabId = null;     // the tab the user was on — refocus it when done
    let returnToWindowId = null;
    const finish = (result) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      if (createdTabId != null) {
        tellaScrapeResolvers.delete(createdTabId);
        chrome.tabs.remove(createdTabId).catch(() => {});
      }
      // Restore focus to wherever the user was before we stole it.
      if (returnToTabId != null) {
        chrome.tabs.update(returnToTabId, { active: true }).catch(() => {});
        if (returnToWindowId != null) {
          chrome.windows.update(returnToWindowId, { focused: true }).catch(() => {});
        }
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), TELLA_SCRAPE_TIMEOUT_MS);

    // Remember the user's current tab, then open the watch page in the
    // FOREGROUND. YouTube only mounts the transcript panel for a VISIBLE tab —
    // a background tab (active:false) leaves the panel un-rendered, so the
    // scrape used to fail with "Transcript panel did not appear." We open it
    // active so the panel renders, scrape, then snap focus back to the user.
    chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      if (tabs && tabs[0]) {
        returnToTabId = tabs[0].id;
        returnToWindowId = tabs[0].windowId;
      }
      return chrome.tabs.create({ url, active: true });
    }).then((tab) => {
      createdTabId = tab.id;
      tellaScrapeResolvers.set(createdTabId, finish);
      const onUpd = (tabId, info) => {
        if (tabId === createdTabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(onUpd);
          // Mark this tab as a Tella scrape first, so content.js skips the
          // .txt download (we only want the text forwarded to the Council).
          chrome.scripting.executeScript({ target: { tabId }, func: () => { window.__tellaScrape = true; } })
            .then(() => chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }))
            .catch((e) => finish({ ok: false, error: 'inject failed: ' + e.message }));
        }
      };
      chrome.tabs.onUpdated.addListener(onUpd);
    }).catch((e) => finish({ ok: false, error: 'tab create failed: ' + e.message }));
  });
}

// content.js posts 'done'/'error' from the scrape tab — resolve the matching job.
chrome.runtime.onMessage.addListener((request, sender) => {
  if (!sender.tab) return;
  const resolve = tellaScrapeResolvers.get(sender.tab.id);
  if (!resolve) return; // not one of our scrape tabs (batch flow handles its own)
  if (request.action === 'done') {
    resolve({
      ok: true,
      plainText: request.plainText || request.text || '',
      text: request.text || '',
      segments: request.segments || [],
      title: request.title || '',
    });
  } else if (request.action === 'error') {
    resolve({ ok: false, error: request.message || 'no transcript yet' });
  }
});

// ----- step 1: upload the Tella video to YouTube via the backend -----
// --- Connect the user's own YouTube channel (so Tella uploads go to THEM) ---
// Runs Google OAuth via launchWebAuthFlow against the tella-to-youtube backend,
// which hands the refresh token back on the chromiumapp.org redirect fragment.
// Token is stored locally and sent with each upload; the server never keeps it.
function connectYouTube() {
  return new Promise((resolve, reject) => {
    const extRedirect = chrome.identity.getRedirectURL("yt");
    const authUrl =
      `${TELLA_BACKEND}/auth/youtube?mode=ext&ext_redirect=` + encodeURIComponent(extRedirect);
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (redirectUrl) => {
      if (chrome.runtime.lastError || !redirectUrl) {
        reject(new Error(chrome.runtime.lastError?.message || "Connection cancelled."));
        return;
      }
      const frag = redirectUrl.split("#")[1] || "";
      const params = new URLSearchParams(frag);
      const error = params.get("error");
      if (error) { reject(new Error(error)); return; }
      const refreshToken = params.get("refreshToken");
      const email = params.get("email") || "";
      if (!refreshToken) { reject(new Error("No token returned from Google.")); return; }
      await chrome.storage.local.set({ ytChannel: { refreshToken, email, at: Date.now() } });
      resolve({ email });
    });
  });
}

async function getYtChannel() {
  const { ytChannel } = await chrome.storage.local.get("ytChannel");
  return ytChannel || null;
}

// Popup <-> background messages for the YouTube connection.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request) return;
  if (request.action === "ytConnect") {
    connectYouTube()
      .then((r) => sendResponse({ ok: true, email: r.email }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async
  }
  if (request.action === "ytStatus") {
    getYtChannel().then((c) => sendResponse({ ok: true, connected: !!c?.refreshToken, email: c?.email || "" }));
    return true; // async
  }
  if (request.action === "ytDisconnect") {
    chrome.storage.local.remove("ytChannel").then(() => sendResponse({ ok: true }));
    return true; // async
  }
});

async function runTellaUpload(jobId) {
  const jobs = await getTellaJobs();
  const job = jobs[jobId];
  if (!job) return;
  try {
    const channel = await getYtChannel();
    if (!channel?.refreshToken) {
      throw new Error('Connect your YouTube channel first (button at the top of the Tella tab).');
    }
    await patchTellaJob(jobId, { lastMessage: 'Uploading to YouTube…' });
    await broadcastTella();
    // Start the upload in the background on the server; we poll for it on the
    // alarm so the service worker sleeping mid-upload can't lose the result.
    const res = await fetch(`${TELLA_BACKEND}/upload/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // Pass the prospect name so the server can label the diarized transcript
      // ("Host: … / Farooq: …") instead of leaving it to the Council to guess.
      // youtubeRefreshToken routes the upload to the USER's own channel.
      body: JSON.stringify({ tellaUrl: job.tellaUrl, prospectName: job.prospectName || '', youtubeRefreshToken: channel.refreshToken }),
    });
    const data = await res.json();
    if (!data.ok || !data.uploadId) throw new Error(data.error || 'Could not start the upload.');
    await patchTellaJob(jobId, {
      uploadId: data.uploadId,
      lastMessage: 'Uploading to YouTube… (this can take a few minutes)',
    });
    await broadcastTella();
    ensureTellaAlarm();
  } catch (e) {
    await patchTellaJob(jobId, { stage: 'failed', error: e.message });
    await broadcastTella();
  }
}

// Poll an in-progress upload (alarm-driven). On success -> move to scrape stage.
async function pollTellaUpload(job) {
  if (!job.uploadId) {
    // Legacy/interrupted job from an older version — can't recover it.
    await patchTellaJob(job.id, { stage: 'failed', error: 'This upload was interrupted by an old version. The video may already be on YouTube — run it again, or use the Batch tab with its YouTube link.' });
    await broadcastTella();
    return;
  }
  try {
    const data = await (await fetch(`${TELLA_BACKEND}/upload/status/${job.uploadId}`)).json();
    if (data.done) {
      if (data.succeeded && data.youtubeUrl) {
        const videoId = extractYtId(data.youtubeUrl);
        const base = { youtubeUrl: data.youtubeUrl, videoId, title: data.title || job.title || '' };
        if (data.diarizedTranscript && data.diarizedTranscript.trim().length > 20) {
          // The server already produced a speaker-labelled transcript from the
          // audio. Use it directly and skip the slow, unreliable wait for
          // YouTube to generate (unlabelled) captions.
          await patchTellaJob(job.id, {
            ...base, stage: 'waiting', transcript: data.diarizedTranscript,
            lastMessage: 'Speakers detected ✓ — sending to The Closer’s Council…',
          });
          await broadcastTella();
          await sendTellaToCouncil(job.id);
        } else {
          // No diarized transcript (keys missing / one voice / failure) — fall
          // back to scraping YouTube's captions on the alarm tick.
          await patchTellaJob(job.id, {
            ...base, stage: 'waiting', attempts: 0,
            lastMessage: 'Uploaded ✓ — waiting for YouTube to generate the transcript…',
          });
          await broadcastTella();
        }
      } else {
        await patchTellaJob(job.id, { stage: 'failed', error: data.error || 'Upload failed.' });
        await broadcastTella();
      }
    }
    // not done yet → leave as-is, check again next tick
  } catch (e) {
    // transient — retry next tick
  }
}

// ----- step 3: send the transcript to the Council (fire-and-forget) -----
async function sendTellaToCouncil(jobId) {
  const jobs = await getTellaJobs();
  const job = jobs[jobId];
  if (!job) return;
  try {
    const { prospectName } = await sendToCouncil({
      transcript: job.transcript,
      prospectName: job.prospectName,
      notes: job.notes || job.title || '', // empty "what you know" defaults to video title
      situation: job.situation || '',
      lang: job.lang,
    });
    await patchTellaJob(jobId, {
      stage: 'done', councilSent: true,
      resultProspectName: prospectName || job.prospectName,
      lastMessage: 'Sent to The Closer’s Council ✓',
    });
  } catch (e) {
    await patchTellaJob(jobId, { stage: 'failed', error: 'Council error: ' + e.message });
  }
  await broadcastTella();
}

// ----- step 2: alarm tick — scrape waiting jobs, then send each to the Council -----
async function pollTellaJobs() {
  const jobs = await getTellaJobs();
  const active = Object.values(jobs).filter((j) => j.stage === 'uploading' || j.stage === 'waiting');
  if (!active.length) { chrome.alarms.clear(TELLA_ALARM); return; }

  for (const job of active) {
    if (job.stage === 'uploading') { await pollTellaUpload(job); continue; }
    // 'waiting' stage. If we already have a transcript (a diarized one from the
    // server, or one whose Council send got interrupted), don't scrape YouTube —
    // just send it. Keeps the diarized path idempotent across worker restarts.
    if (job.transcript && job.transcript.trim().length > 20) {
      await sendTellaToCouncil(job.id);
      continue;
    }
    // Otherwise only attempt a scrape ~every 5 min (the alarm itself ticks faster).
    if (job.lastScrapeAt && (Date.now() - job.lastScrapeAt) < 4.5 * 60 * 1000) continue;
    const attempts = (job.attempts || 0) + 1;
    await patchTellaJob(job.id, { attempts, lastScrapeAt: Date.now(), lastMessage: `Checking for transcript (try ${attempts})…` });
    await broadcastTella();

    const r = await scrapeYoutube(job.videoId);
    if (r.ok && r.plainText && r.plainText.length > 20) {
      await patchTellaJob(job.id, { transcript: r.plainText, lastMessage: 'Transcript ready — sending to the Council…' });
      await broadcastTella();
      await sendTellaToCouncil(job.id);
    } else if (attempts >= (job.maxAttempts || TELLA_MAX_ATTEMPTS)) {
      await patchTellaJob(job.id, { stage: 'failed', error: 'Transcript still not available after many tries — YouTube may not have generated captions for this video.' });
      await broadcastTella();
    } else {
      await patchTellaJob(job.id, { lastMessage: `No transcript yet — retrying in 5 min (try ${attempts}).` });
      await broadcastTella();
    }
  }

  const after = await getTellaJobs();
  if (Object.values(after).some((j) => j.stage === 'uploading' || j.stage === 'waiting')) ensureTellaAlarm();
  else chrome.alarms.clear(TELLA_ALARM);
}

// ----- start jobs from the popup -----
async function startTellaJobs(items) {
  const jobs = await getTellaJobs();
  const newIds = [];
  for (const it of items) {
    const id = 'tj_' + Date.now() + '_' + Math.random().toString(16).slice(2, 8);
    jobs[id] = {
      id, tellaUrl: it.tellaUrl, prospectName: it.prospectName || '',
      notes: it.notes || '', situation: it.situation || '', lang: it.lang || 'bn',
      stage: 'uploading', attempts: 0, maxAttempts: TELLA_MAX_ATTEMPTS,
      created: Date.now(), updated: Date.now(), lastMessage: 'Queued…',
    };
    newIds.push(id);
  }
  await setTellaJobs(jobs);
  await broadcastTella();
  // Uploads run one at a time (YouTube quota + avoid hammering the backend).
  for (const id of newIds) await runTellaUpload(id);
}

// ----- alarm + popup message routing -----
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TELLA_ALARM) pollTellaJobs();
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startTella') {
    startTellaJobs(request.items || []);
    return;
  }
  if (request.action === 'getTellaState') {
    getTellaJobs().then((jobs) => sendResponse({ jobs: Object.values(jobs).sort((a, b) => b.created - a.created) }));
    return true; // async response
  }
  if (request.action === 'clearTellaDone') {
    getTellaJobs().then(async (jobs) => {
      for (const id of Object.keys(jobs)) {
        if (jobs[id].stage === 'done' || jobs[id].stage === 'failed') delete jobs[id];
      }
      await setTellaJobs(jobs);
      await broadcastTella();
    });
    return;
  }
  // Delete a single history card (any stage — user explicitly chose it).
  if (request.action === 'deleteTellaJob') {
    getTellaJobs().then(async (jobs) => {
      if (request.id && jobs[request.id]) delete jobs[request.id];
      await setTellaJobs(jobs);
      await broadcastTella();
    });
    return;
  }
  // Wipe the entire Tella history.
  if (request.action === 'clearTellaAll') {
    setTellaJobs({}).then(() => broadcastTella());
    return;
  }
});

// On service-worker startup, resume polling if any jobs are still in flight.
getTellaJobs().then((jobs) => {
  if (Object.values(jobs).some((j) => j.stage === 'uploading' || j.stage === 'waiting')) ensureTellaAlarm();
});

// Resume an interrupted batch: always make sure the heartbeat alarm is alive,
// then if it was mid-pass when the worker died, pick that pass back up.
getQueue().then((q) => {
  if (!q || !q.active) return;
  ensureBatchRetryAlarm();
  if (!q.waiting) processNext();
});

// ---------- Re-attach the bridge after an update ----------
// Reloading or updating the extension orphans every content script already
// sitting in an open tab: the code stays, its `chrome.runtime` does not. The
// user's page then looks connected but fails on the first click, and the only
// cure was for them to know to press Cmd+R. Instead, re-inject bridge.js into
// the app tabs that are already open, so the connection heals itself. The
// fresh copy announces 'ready' on load, so the page's status flips too.
//
// Needs no new permissions: `scripting` + `tabs` are already granted, and every
// URL below is already a host_permission (they mirror manifest content_scripts).
const BRIDGE_URLS = [
  'https://pulltranscript.com/*',
  'https://www.pulltranscript.com/*',
  'https://devrant.99dfy.com/*',
  'https://tellatotube.up.railway.app/*',
  'https://tubedrop.99dfy.com/*',
  'https://wisekid.99dfy.com/*',
  'https://painfinder.99dfy.com/*',
];

async function reattachBridge(reason) {
  try {
    const tabs = await chrome.tabs.query({ url: BRIDGE_URLS });
    for (const tab of tabs) {
      if (!tab.id) continue;
      try {
        // bridge.js guards against a second copy, so injecting into a tab that
        // already has a healthy bridge is a no-op rather than a double listener.
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['bridge.js'] });
      } catch (e) {
        // A tab can be mid-navigation or discarded; nothing to do but skip it.
        console.warn('bridge re-attach skipped for tab', tab.id, e?.message || e);
      }
    }
    if (tabs.length) console.log(`[bridge] re-attached to ${tabs.length} tab(s) after ${reason}`);
  } catch (e) {
    console.warn('bridge re-attach failed:', e?.message || e);
  }
}

chrome.runtime.onInstalled.addListener((details) => reattachBridge(details?.reason || 'install'));
chrome.runtime.onStartup.addListener(() => reattachBridge('browser startup'));

// =====================================================================
//  📱 PocketTranscript — this browser as the phone's transcript worker
// =====================================================================
//  A phone can't run an extension, and nothing outside this Mac can reach
//  into its Chrome. So the phone never calls us and we never call the phone.
//  We both talk to a queue instead:
//
//    phone --> [ pockettranscript.up.railway.app ] <-- we long-poll here
//
//  The poll hangs open for ~25s, so a link sent from the phone lands here in
//  well under a second instead of waiting for the next alarm tick. The alarm
//  is only there to restart the poll after Chrome kills the service worker.
//  Same shape as the Tella loop above, which has been reliable for months.

const POCKET_BACKEND   = 'https://pockettranscript.up.railway.app';
const POCKET_DEVICE_KEY = 'pocketDeviceId';
const POCKET_ON_KEY     = 'pocketEnabled';
const POCKET_STATS_KEY  = 'pocketStats';
const POCKET_ALARM      = 'pocketPoll';
const POCKET_POLL_MS    = 30000;   // must outlast the server's 25s long-poll

let pocketPolling = false;         // guards against two overlapping polls

async function getPocketDeviceId() {
  const r = await chrome.storage.local.get(POCKET_DEVICE_KEY);
  if (r[POCKET_DEVICE_KEY]) return r[POCKET_DEVICE_KEY];
  // 32 hex chars. This id IS the shared secret between this Chrome and the
  // phone, so it comes from crypto, never from Math.random.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  await chrome.storage.local.set({ [POCKET_DEVICE_KEY]: id });
  return id;
}

async function isPocketEnabled() {
  const r = await chrome.storage.local.get(POCKET_ON_KEY);
  return r[POCKET_ON_KEY] !== false;   // ON unless the user turned it off
}

async function bumpPocketStats(patch) {
  const r = await chrome.storage.local.get(POCKET_STATS_KEY);
  const stats = r[POCKET_STATS_KEY] || { done: 0, failed: 0, lastAt: 0, lastTitle: '' };
  Object.assign(stats, patch);
  await chrome.storage.local.set({ [POCKET_STATS_KEY]: stats });
  broadcast('pocketStats', { stats });
}

function ensurePocketAlarm() {
  // 0.5 min is Chrome's floor. The alarm's only job is to revive the loop
  // after the service worker is torn down — the long-poll does the real work.
  chrome.alarms.create(POCKET_ALARM, { periodInMinutes: 0.5 });
}

async function stopPocket() {
  chrome.alarms.clear(POCKET_ALARM);
}

// One trip round the loop: ask for work, do it, post it back, go again.
async function pocketPollOnce() {
  if (pocketPolling) return;
  if (!(await isPocketEnabled())) { await stopPocket(); return; }
  pocketPolling = true;
  let keepListening = false;   // only re-enter if we actually reached the server

  try {
    const deviceId = await getPocketDeviceId();
    let res;
    try {
      res = await fetch(`${POCKET_BACKEND}/api/desktop/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, name: 'This computer' }),
      });
    } catch (e) {
      // No network, or the queue is down. Back off to the alarm rather than
      // spinning on a dead socket; the phone shows "computer asleep" meanwhile.
      return;
    }
    if (!res.ok) return;

    const data = await res.json().catch(() => null);
    const job = data && data.job;

    // The server answered, so go straight back in once we're done here.
    // Without this we'd stop listening for up to 30s after every idle timeout,
    // and a link sent from the phone inside that gap would just sit there.
    keepListening = true;
    if (!job) return;                       // idle timeout — nothing waiting

    await bumpPocketStats({ lastAt: Date.now(), lastTitle: `Working on ${job.videoId}…` });

    // Reuse the exact scraper the popup and the Tella loop use. It opens the
    // watch page in a background tab, scrapes, and restores the user's focus.
    let result;
    try {
      result = await scrapeYoutube(job.videoId);
    } catch (e) {
      result = { ok: false, error: (e && e.message) || 'Scrape failed' };
    }

    const ok = !!(result && result.ok && (result.plainText || '').trim().length > 0);
    try {
      await fetch(`${POCKET_BACKEND}/api/desktop/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId,
          jobId: job.id,
          ok,
          // `text` is content.js's fullText — title, video URL, blank line, then
          // "0:00 - line" per row. That is exactly what the .txt download holds,
          // so the phone hands back the same thing the computer does.
          text: (result && result.text) || '',
          plain: (result && result.plainText) || '',
          segments: (result && result.segments) || [],
          title: (result && result.title) || '',
          error: ok ? '' : ((result && result.error) ||
            'No transcript came back — this video may not have captions yet.'),
        }),
      });
    } catch (e) {
      // The transcript is lost, but the phone's Retry button re-queues it.
      return;
    }

    const stats = (await chrome.storage.local.get(POCKET_STATS_KEY))[POCKET_STATS_KEY] || {};
    await bumpPocketStats(
      ok ? { done: (stats.done || 0) + 1, lastAt: Date.now(), lastTitle: result.title || job.videoId }
         : { failed: (stats.failed || 0) + 1, lastAt: Date.now(), lastTitle: `Failed: ${job.videoId}` }
    );
  } finally {
    pocketPolling = false;
    // Covers every exit path: finished a job, or idled out with nothing waiting.
    if (keepListening) {
      isPocketEnabled().then((on) => { if (on) pocketPollOnce(); });
    }
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POCKET_ALARM) pocketPollOnce();
});

// --- popup <-> background messages for the 📱 Phone tab ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || !request.action || !request.action.startsWith('pocket')) return;

  if (request.action === 'pocketGetState') {
    (async () => {
      const deviceId = await getPocketDeviceId();
      const enabled = await isPocketEnabled();
      const r = await chrome.storage.local.get(POCKET_STATS_KEY);
      sendResponse({ ok: true, deviceId, enabled, stats: r[POCKET_STATS_KEY] || {} });
    })();
    return true;
  }

  if (request.action === 'pocketSetEnabled') {
    (async () => {
      await chrome.storage.local.set({ [POCKET_ON_KEY]: !!request.enabled });
      if (request.enabled) { ensurePocketAlarm(); pocketPollOnce(); }
      else await stopPocket();
      sendResponse({ ok: true, enabled: !!request.enabled });
    })();
    return true;
  }

  if (request.action === 'pocketPairCode') {
    (async () => {
      try {
        const deviceId = await getPocketDeviceId();
        const res = await fetch(`${POCKET_BACKEND}/api/desktop/paircode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId, name: 'This computer' }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Could not get a code.');
        // Getting a code means a phone is about to connect — make sure we're listening.
        await chrome.storage.local.set({ [POCKET_ON_KEY]: true });
        ensurePocketAlarm();
        pocketPollOnce();
        sendResponse({ ok: true, code: data.code, expiresInMs: data.expiresInMs, url: POCKET_BACKEND });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || 'Could not reach PocketTranscript.' });
      }
    })();
    return true;
  }
});

// Start listening on install and on every browser start, so the phone works
// the moment the Mac wakes up without anyone opening the popup.
function bootPocket() {
  isPocketEnabled().then((on) => {
    if (!on) return;
    ensurePocketAlarm();
    pocketPollOnce();
  });
}
chrome.runtime.onInstalled.addListener(bootPocket);
chrome.runtime.onStartup.addListener(bootPocket);
bootPocket();
