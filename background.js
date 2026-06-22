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

// ----- Download filename plumbing -----
// Chrome ignores the chrome.downloads.download `filename` hint for
// data: URLs and assigns "download.txt", so we override authoritatively
// in chrome.downloads.onDeterminingFilename. We track pending names
// two ways:
//
//   * A FIFO queue of filenames in download() order. onDeterminingFilename
//     fires for each download in the same order, so popping the front of
//     the queue yields the correct name. This is the primary path.
//   * A Map<dataUrl, filename> backup, in case listener invocation order
//     ever races with our queue (e.g. if some other code path also
//     triggers a download before ours fires). URL match wins when present.
const filenameFifo = [];
const filenameByUrl = new Map();

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  // Try URL match first (most precise), then fall back to FIFO order.
  let desired = filenameByUrl.get(item.url) || filenameByUrl.get(item.finalUrl);
  let matchedByUrl = !!desired;
  if (!desired && filenameFifo.length > 0) {
    desired = filenameFifo.shift();
  }

  if (desired) {
    if (matchedByUrl) {
      // Drop URL key so it can't be reused.
      filenameByUrl.delete(item.url);
      if (item.finalUrl) filenameByUrl.delete(item.finalUrl);
      // Also remove the corresponding FIFO entry so the queue stays
      // in sync with what's left.
      const idx = filenameFifo.indexOf(desired);
      if (idx !== -1) filenameFifo.splice(idx, 1);
    }
    suggest({ filename: desired, conflictAction: 'uniquify' });
  } else {
    suggest();   // let Chrome decide for downloads we didn't initiate
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
  // We deliberately do NOT pass `filename` to chrome.downloads.download.
  // Chrome ignores that hint for data: URLs anyway, and passing it has
  // been observed to make the listener path less reliable. Instead, the
  // onDeterminingFilename listener above is the sole source of truth
  // for the saved filename — it pops from filenameFifo / filenameByUrl
  // when Chrome asks for a name.
  if (request.action === 'download') {
    filenameFifo.push(request.filename);
    filenameByUrl.set(request.url, request.filename);

    chrome.downloads.download({
      url: request.url,
      saveAs: false,
      conflictAction: 'uniquify'
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        const errMsg = chrome.runtime.lastError.message || 'download failed';
        // Roll back our filename bookkeeping so this entry doesn't get
        // applied to the next download.
        filenameByUrl.delete(request.url);
        const idx = filenameFifo.indexOf(request.filename);
        if (idx !== -1) filenameFifo.splice(idx, 1);
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
      }
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
  chrome.alarms.create(TELLA_ALARM, { periodInMinutes: 5, delayInMinutes: 5 });
}
function extractYtId(url) {
  if (!url) return null;
  let m = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  return null;
}

// ----- open a YT watch page in the background and scrape via content.js -----
const tellaScrapeResolvers = new Map(); // tabId -> resolve()

function scrapeYoutube(videoId) {
  return new Promise((resolve) => {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    let settled = false;
    let createdTabId = null;
    const finish = (result) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      if (createdTabId != null) {
        tellaScrapeResolvers.delete(createdTabId);
        chrome.tabs.remove(createdTabId).catch(() => {});
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), TELLA_SCRAPE_TIMEOUT_MS);
    chrome.tabs.create({ url, active: false }).then((tab) => {
      createdTabId = tab.id;
      tellaScrapeResolvers.set(createdTabId, finish);
      const onUpd = (tabId, info) => {
        if (tabId === createdTabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(onUpd);
          chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
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
    resolve({ ok: true, plainText: request.plainText || request.text || '', title: request.title || '' });
  } else if (request.action === 'error') {
    resolve({ ok: false, error: request.message || 'no transcript yet' });
  }
});

// ----- step 1: upload the Tella video to YouTube via the backend -----
async function runTellaUpload(jobId) {
  const jobs = await getTellaJobs();
  const job = jobs[jobId];
  if (!job) return;
  try {
    await patchTellaJob(jobId, { lastMessage: 'Uploading to YouTube…' });
    await broadcastTella();
    const res = await fetch(`${TELLA_BACKEND}/upload`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tellaUrl: job.tellaUrl }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Upload failed');
    const videoId = extractYtId(data.youtubeUrl);
    if (!videoId) throw new Error('Could not read the YouTube video id from the upload.');
    await patchTellaJob(jobId, {
      stage: 'waiting', youtubeUrl: data.youtubeUrl, videoId, title: data.title || '',
      attempts: 0, lastMessage: 'Uploaded. Waiting for YouTube to generate the transcript…',
    });
    await broadcastTella();
    ensureTellaAlarm();
  } catch (e) {
    await patchTellaJob(jobId, { stage: 'failed', error: e.message });
    await broadcastTella();
  }
}

// ----- step 3: forward transcript to the Council via the backend -----
async function runTellaCouncil(jobId) {
  const jobs = await getTellaJobs();
  const job = jobs[jobId];
  if (!job) return;
  try {
    const res = await fetch(`${TELLA_BACKEND}/followup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: job.transcript, prospectName: job.prospectName, lang: job.lang }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Council failed');
    await patchTellaJob(jobId, {
      stage: 'done', move: data.move, resultProspectName: data.prospectName || job.prospectName,
      lastMessage: 'Done — follow-up ready.',
    });
  } catch (e) {
    await patchTellaJob(jobId, { stage: 'failed', error: 'Council error: ' + e.message });
  }
  await broadcastTella();
}

// ----- step 2: poll waiting jobs for their transcript (alarm-driven) -----
async function pollTellaJobs() {
  const jobs = await getTellaJobs();
  const waiting = Object.values(jobs).filter((j) => j.stage === 'waiting');
  if (!waiting.length) { chrome.alarms.clear(TELLA_ALARM); return; }

  for (const job of waiting) {
    const attempts = (job.attempts || 0) + 1;
    await patchTellaJob(job.id, { attempts, lastMessage: `Checking for transcript (try ${attempts})…` });
    await broadcastTella();

    const r = await scrapeYoutube(job.videoId);
    if (r.ok && r.plainText && r.plainText.length > 20) {
      await patchTellaJob(job.id, { stage: 'council', transcript: r.plainText, lastMessage: 'Transcript ready — asking the Council…' });
      await broadcastTella();
      await runTellaCouncil(job.id);
    } else if (attempts >= (job.maxAttempts || TELLA_MAX_ATTEMPTS)) {
      await patchTellaJob(job.id, { stage: 'failed', error: 'Transcript still not available after many tries — YouTube may not have generated captions for this video.' });
      await broadcastTella();
    } else {
      await patchTellaJob(job.id, { lastMessage: `No transcript yet — retrying in 5 min (try ${attempts}).` });
      await broadcastTella();
    }
  }

  const after = await getTellaJobs();
  if (Object.values(after).some((j) => j.stage === 'waiting')) ensureTellaAlarm();
  else chrome.alarms.clear(TELLA_ALARM);
}

// ----- start jobs from the popup -----
async function startTellaJobs(items) {
  const jobs = await getTellaJobs();
  const newIds = [];
  for (const it of items) {
    const id = 'tj_' + Date.now() + '_' + Math.random().toString(16).slice(2, 8);
    jobs[id] = {
      id, tellaUrl: it.tellaUrl, prospectName: it.prospectName || '', lang: it.lang || 'bn',
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
});

// On service-worker startup, resume polling if any jobs are still waiting.
getTellaJobs().then((jobs) => {
  if (Object.values(jobs).some((j) => j.stage === 'waiting')) ensureTellaAlarm();
});
