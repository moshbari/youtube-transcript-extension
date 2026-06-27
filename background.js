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

// ---------- start / cancel ----------
async function startBatch(urls, opts = {}) {
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
    // When toCouncil is on, each scraped transcript is sent to The Closer's
    // Council and the follow-up is stored on that video's result.
    toCouncil: !!opts.toCouncil,
    lang: opts.lang || 'bn',
    results: []
  };
  await setQueue(queue);
  await processNext();
}

// ---- Send a transcript to The Closer's Council (fire-and-forget) ----
// The extension's only job is to hand off the transcript. The Council runs the
// analysis on its own server and saves it to the prospect's diary; the user
// reads the result by logging into the Council, not here.
const COUNCIL_BACKEND = 'https://tellatotube.up.railway.app';

async function sendToCouncil({ transcript, prospectName = '', notes = '', situation = '', lang }) {
  const res = await fetch(`${COUNCIL_BACKEND}/followup/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, prospectName, notes, situation, lang }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Could not send to the Council.');
  return { prospectName: data.prospectName || '' };
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
