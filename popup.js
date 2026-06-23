// =====================================================================
//  Mode tab switching
// =====================================================================
document.querySelectorAll('.mode-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const mode = tab.dataset.mode;
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', t === tab));
    document.getElementById('singleMode').classList.toggle('active', mode === 'single');
    document.getElementById('batchMode').classList.toggle('active', mode === 'batch');
    document.getElementById('namesMode').classList.toggle('active', mode === 'names');
    document.getElementById('tellaMode').classList.toggle('active', mode === 'tella');
  });
});

// =====================================================================
//  Single video flow (preserved from v1.3)
// =====================================================================

// Load any previously saved transcript on popup open
chrome.storage.local.get('lastTranscript', (result) => {
  if (result.lastTranscript) {
    displayTranscript(result.lastTranscript);
  }
});

document.getElementById('scrapeBtn').addEventListener('click', async () => {
  const statusDiv = document.getElementById('status');
  const btn = document.getElementById('scrapeBtn');

  statusDiv.textContent = 'Injecting script...';
  statusDiv.style.color = '#fff';
  btn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (tab.url.includes("youtube.com/shorts/")) {
      const videoId = tab.url.split("/shorts/")[1].split(/[?#]/)[0];
      const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
      statusDiv.textContent = 'Opening standard player to extract...';
      chrome.runtime.sendMessage({ action: 'scrapeUrl', url: watchUrl });
      setTimeout(() => window.close(), 1500);
      return;
    }

    if (!tab.url.includes("youtube.com/watch")) {
      statusDiv.textContent = 'Please open a YouTube video!';
      statusDiv.style.color = '#ff4444';
      btn.disabled = false;
      return;
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
    statusDiv.textContent = 'Starting process...';
  } catch (error) {
    statusDiv.textContent = 'Error: ' + error.message;
    statusDiv.style.color = '#ff4444';
    btn.disabled = false;
  }
});

document.getElementById('copyBtn').addEventListener('click', () => {
  chrome.storage.local.get('lastTranscript', (result) => {
    if (!result.lastTranscript) return;
    const data = result.lastTranscript;
    let copyText = `${data.title}\n${data.url}\n\n`;
    for (const line of data.lines) {
      copyText += `${line.timestamp} - ${line.text}\n`;
    }
    navigator.clipboard.writeText(copyText).then(() => {
      const copyBtn = document.getElementById('copyBtn');
      copyBtn.textContent = 'Copied!';
      copyBtn.classList.add('copied');
      setTimeout(() => {
        copyBtn.textContent = 'Copy All';
        copyBtn.classList.remove('copied');
      }, 2000);
    });
  });
});

function displayTranscript(data) {
  const viewer = document.getElementById('transcriptViewer');
  const titleEl = document.getElementById('videoTitle');
  const urlEl = document.getElementById('videoUrl');
  const contentEl = document.getElementById('transcriptContent');

  titleEl.textContent = data.title;
  urlEl.textContent = data.url;
  urlEl.href = data.url;

  let html = '';
  for (const line of data.lines) {
    html += `<div class="transcript-line"><span class="transcript-timestamp">${escapeHtml(line.timestamp)}</span><span class="transcript-text">${escapeHtml(line.text)}</span></div>`;
  }
  contentEl.innerHTML = html;
  viewer.style.display = 'block';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// =====================================================================
//  Batch mode
// =====================================================================

const batchUrlsEl       = document.getElementById('batchUrls');
const batchUrlCountEl   = document.getElementById('batchUrlCount');
const batchClearBtn     = document.getElementById('batchClearBtn');
const batchScrapeBtn    = document.getElementById('batchScrapeBtn');
const batchCancelBtn    = document.getElementById('batchCancelBtn');
const batchStatusEl     = document.getElementById('batchStatus');
const batchProgressEl   = document.getElementById('batchProgress');
const batchProgressFill = document.getElementById('batchProgressFill');
const batchProgressText = document.getElementById('batchProgressText');
const batchResultsEl    = document.getElementById('batchResults');

// Persist textarea content across popup opens. Chrome closes the popup any
// time it loses focus, so without this, anything pasted is lost the moment
// the user clicks back to a YouTube tab to grab the next URL.
const BATCH_DRAFT_KEY = 'batchUrlsDraft';
let saveDraftTimer = null;
function saveDraftSoon() {
  // Debounce so we're not hammering storage on every keystroke.
  if (saveDraftTimer) clearTimeout(saveDraftTimer);
  saveDraftTimer = setTimeout(() => {
    chrome.storage.local.set({ [BATCH_DRAFT_KEY]: batchUrlsEl.value });
  }, 250);
}

// Pull every YouTube video ID out of an arbitrary blob of text.
// Accepts: youtube.com/watch?v=, youtu.be/, /shorts/, /embed/, bare 11-char IDs.
// Returns deduped array of { id, url } in the order they first appeared.
function extractVideoUrls(text) {
  const seen = new Set();
  const out = [];
  if (!text) return out;

  const tokens = text.split(/[\s,]+/).filter(Boolean);
  const patterns = [
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /\/shorts\/([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/,
    /\/live\/([A-Za-z0-9_-]{11})/,
    /^([A-Za-z0-9_-]{11})$/
  ];

  for (const token of tokens) {
    let id = null;
    for (const p of patterns) {
      const m = token.match(p);
      if (m) { id = m[1]; break; }
    }
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push({ id, url: `https://www.youtube.com/watch?v=${id}` });
    }
  }
  return out;
}

function updateUrlCount() {
  const found = extractVideoUrls(batchUrlsEl.value);
  if (found.length === 0) {
    batchUrlCountEl.textContent = batchUrlsEl.value.trim() ? 'No valid YouTube URLs found' : '';
    batchUrlCountEl.style.color = batchUrlsEl.value.trim() ? '#ff8888' : '#888';
    batchScrapeBtn.disabled = true;
  } else {
    batchUrlCountEl.textContent = `${found.length} video${found.length === 1 ? '' : 's'} detected`;
    batchUrlCountEl.style.color = '#00ff88';
    batchScrapeBtn.disabled = false;
  }
}

batchUrlsEl.addEventListener('input', () => {
  updateUrlCount();
  saveDraftSoon();
});

batchClearBtn.addEventListener('click', () => {
  batchUrlsEl.value = '';
  chrome.storage.local.remove(BATCH_DRAFT_KEY);
  updateUrlCount();
  batchUrlsEl.focus();
});

batchScrapeBtn.addEventListener('click', () => {
  const found = extractVideoUrls(batchUrlsEl.value);
  if (found.length === 0) return;

  const urls = found.map(v => v.url);
  const toCouncil = document.getElementById('batchToCouncil').checked;
  const lang = document.getElementById('batchLang').value;
  batchStatusEl.textContent = toCouncil
    ? `Starting batch of ${urls.length} videos → Council...`
    : `Starting batch of ${urls.length} videos...`;
  batchStatusEl.style.color = '#00ff88';
  setBatchUiActive(true);

  chrome.runtime.sendMessage({ action: 'startBatch', urls, toCouncil, lang });
});

// Council toggle: reveal the language picker + relabel the action button.
(function () {
  const cb = document.getElementById('batchToCouncil');
  const langSel = document.getElementById('batchLang');
  if (cb) cb.addEventListener('change', () => {
    if (langSel) langSel.style.display = cb.checked ? '' : 'none';
    batchScrapeBtn.textContent = cb.checked ? 'Scrape all → Council' : 'Scrape All';
  });
})();

batchCancelBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'cancelBatch' });
  batchStatusEl.textContent = 'Cancelling...';
});

function setBatchUiActive(active) {
  batchScrapeBtn.style.display = active ? 'none' : '';
  batchCancelBtn.style.display = active ? '' : 'none';
  batchUrlsEl.disabled = active;
  batchProgressEl.style.display = active ? 'block' : batchProgressEl.style.display;
}

function renderBatchProgress(state) {
  // state = { active, urls, index, total, results, currentUrl, lastMessage }
  const total = state.total || (state.urls ? state.urls.length : 0);
  const completed = state.results ? state.results.length : 0;
  const pct = total === 0 ? 0 : (completed / total) * 100;
  batchProgressFill.style.width = pct + '%';

  if (state.active) {
    batchProgressText.textContent =
      `Video ${Math.min(completed + 1, total)} of ${total}` +
      (state.lastMessage ? ` — ${state.lastMessage}` : '');
  } else {
    const succeeded = (state.results || []).filter(r => r.status === 'success').length;
    const failed    = (state.results || []).filter(r => r.status !== 'success').length;
    batchProgressText.textContent = `Done — ${succeeded} succeeded, ${failed} failed`;
  }

  // Render the results list. Pad with pending placeholders for upcoming videos.
  const results = state.results || [];
  const items = [];
  for (let i = 0; i < total; i++) {
    if (i < results.length) {
      const r = results[i];
      const ok = r.status === 'success';
      const icon = ok ? '✓' : '✗';
      const cls  = ok ? 'success' : 'failed';
      const label = ok
        ? (r.title || r.url) + (r.lines ? ` (${r.lines} lines)` : '')
        : `${shortUrl(r.url)} — ${r.error || 'failed'}`;
      let extra = '';
      if (ok && r.councilSent) {
        extra = `<div class="batch-council-ok">✓ Sent to The Closer's Council${r.prospectName ? ' — ' + escapeHtml(r.prospectName) : ''}</div>`;
      } else if (ok && r.councilError) {
        extra = `<div class="batch-council-err">Council: ${escapeHtml(r.councilError)}</div>`;
      }
      const blockStyle = (ok && (r.councilSent || r.councilError)) ? ' style="display:block;"' : '';
      items.push(
        `<div class="batch-result-item"${blockStyle}>` +
        `<span class="batch-result-icon ${cls}">${icon}</span>` +
        `<span class="batch-result-text${ok ? '' : ' failed'}">${escapeHtml(label)}</span>` +
        extra +
        `</div>`
      );
    } else if (i === results.length && state.active) {
      items.push(
        `<div class="batch-result-item">` +
        `<span class="batch-result-icon active">…</span>` +
        `<span class="batch-result-text">${escapeHtml(shortUrl((state.urls || [])[i] || ''))} — ${escapeHtml(state.lastMessage || 'scraping…')}</span>` +
        `</div>`
      );
    } else {
      items.push(
        `<div class="batch-result-item">` +
        `<span class="batch-result-icon pending">○</span>` +
        `<span class="batch-result-text">${escapeHtml(shortUrl((state.urls || [])[i] || ''))}</span>` +
        `</div>`
      );
    }
  }
  batchResultsEl.innerHTML = items.join('');
  batchResultsEl.querySelectorAll('.batch-council-copy').forEach((btn) => {
    btn.addEventListener('click', () => {
      const el = document.getElementById(btn.dataset.target);
      if (!el) return;
      navigator.clipboard.writeText(el.textContent).then(() => {
        const t = btn.textContent; btn.textContent = 'Copied!';
        setTimeout(() => (btn.textContent = t), 1500);
      });
    });
  });
}

function shortUrl(url) {
  if (!url) return '';
  const m = url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  return m ? m[1] : url;
}

// On popup open: restore textarea draft, and if a batch is in progress
// restore the UI and switch to the batch tab.
chrome.storage.local.get(['batchQueue', BATCH_DRAFT_KEY], (result) => {
  // Restore the textarea content first — important so the user's pasted
  // URLs survive popup auto-close.
  if (typeof result[BATCH_DRAFT_KEY] === 'string') {
    batchUrlsEl.value = result[BATCH_DRAFT_KEY];
  }
  updateUrlCount();

  const batchQueue = result.batchQueue;
  if (batchQueue && batchQueue.active) {
    setBatchUiActive(true);
    batchProgressEl.style.display = 'block';
    renderBatchProgress(batchQueue);
    batchStatusEl.textContent = 'Batch in progress...';
    document.querySelector('.mode-tab[data-mode="batch"]').click();
  }
});


// Listen for background broadcasts
chrome.runtime.onMessage.addListener((request) => {
  // Single-video flow messages (preserved)
  const statusDiv = document.getElementById('status');
  const btn = document.getElementById('scrapeBtn');

  if (request.action === 'status' && statusDiv) {
    statusDiv.textContent = request.message;
  }
  if (request.action === 'done' && statusDiv) {
    statusDiv.textContent = `Success! Saved ${request.lines} segments.`;
    statusDiv.style.color = '#00ff88';
    if (btn) btn.disabled = false;
    chrome.storage.local.get('lastTranscript', (result) => {
      if (result.lastTranscript) displayTranscript(result.lastTranscript);
    });
  }
  if (request.action === 'error' && statusDiv) {
    statusDiv.textContent = request.message;
    statusDiv.style.color = '#ff4444';
    if (btn) btn.disabled = false;
  }

  // Batch messages
  if (request.action === 'batchStatus') {
    renderBatchProgress(request.state);
    batchProgressEl.style.display = 'block';
    if (request.state && request.state.lastMessage) {
      batchStatusEl.textContent = request.state.lastMessage;
    }
  }
  if (request.action === 'batchComplete') {
    setBatchUiActive(false);
    renderBatchProgress({ ...request.state, active: false });
    batchStatusEl.textContent =
      `Batch finished. ${request.state.results.filter(r => r.status === 'success').length}` +
      ` of ${request.state.total} succeeded.`;
    batchStatusEl.style.color = '#00ff88';
  }
  if (request.action === 'batchCancelled') {
    setBatchUiActive(false);
    renderBatchProgress({ ...request.state, active: false });
    batchStatusEl.textContent = 'Batch cancelled.';
    batchStatusEl.style.color = '#ffaa00';
  }
});

// =====================================================================
//  Names → Links mode
// =====================================================================
//
//  Reads the user's full video library off YouTube Studio (all videos:
//  public, unlisted, private, drafts — because they're logged in), caches
//  it, then matches a pasted list of names to YouTube watch links.
//
const loadLibBtn   = document.getElementById('loadLibBtn');
const stopLibBtn   = document.getElementById('stopLibBtn');
const libStatusEl  = document.getElementById('libStatus');
const namesInput   = document.getElementById('namesInput');
const namesCountEl  = document.getElementById('namesCount');
const namesClearBtn = document.getElementById('namesClearBtn');
const matchBtn      = document.getElementById('matchBtn');
const namesResultsWrap = document.getElementById('namesResultsWrap');
const namesResultsEl   = document.getElementById('namesResults');
const copyLinksBtn     = document.getElementById('copyLinksBtn');
const copyTitlesLinksBtn = document.getElementById('copyTitlesLinksBtn');

const NAMES_DRAFT_KEY = 'namesDraft';

// ---- persist names textarea across popup auto-close ----
let namesDraftTimer = null;
function saveNamesDraftSoon() {
  if (namesDraftTimer) clearTimeout(namesDraftTimer);
  namesDraftTimer = setTimeout(() => {
    chrome.storage.local.set({ [NAMES_DRAFT_KEY]: namesInput.value });
  }, 250);
}

function parseNames(text) {
  return (text || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
}

function updateNamesCount() {
  const n = parseNames(namesInput.value).length;
  namesCountEl.textContent = n ? `${n} name${n === 1 ? '' : 's'}` : '';
}

namesInput.addEventListener('input', () => {
  updateNamesCount();
  saveNamesDraftSoon();
});

namesClearBtn.addEventListener('click', () => {
  namesInput.value = '';
  chrome.storage.local.remove(NAMES_DRAFT_KEY);
  updateNamesCount();
  namesInput.focus();
});

// ---- library status line ----
function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} day(s) ago`;
}

function refreshLibStatus() {
  chrome.storage.local.get('videoLibrary', (r) => {
    const lib = r.videoLibrary;
    if (lib && Array.isArray(lib.videos) && lib.videos.length) {
      libStatusEl.textContent =
        `${lib.videos.length} videos loaded (${timeAgo(lib.scrapedAt)})`;
      libStatusEl.style.color = '#00ff88';
    } else {
      libStatusEl.textContent = 'No video list loaded yet.';
      libStatusEl.style.color = '#888';
    }
  });
}

// ---- load library by harvesting the active Studio tab ----
loadLibBtn.addEventListener('click', async () => {
  loadLibBtn.disabled = true;
  libStatusEl.style.color = '#fff';
  libStatusEl.textContent = 'Checking active tab…';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url || !tab.url.includes('studio.youtube.com')) {
      libStatusEl.style.color = '#ffaa00';
      libStatusEl.innerHTML =
        'Open <b>studio.youtube.com</b>, click <b>Content</b> (your Videos list), ' +
        'then come back and press this button.';
      loadLibBtn.disabled = false;
      return;
    }

    // Hand the pasted names to the harvester so it can stop as soon as it
    // finds them, and clear any stale stop flag from a previous run.
    const targets = parseNames(namesInput.value);
    await chrome.storage.local.set({ harvestTargets: targets, harvestStop: false });

    libStatusEl.textContent = targets.length
      ? `Scanning Studio for your ${targets.length} name${targets.length === 1 ? '' : 's'}…`
      : 'Reading your videos from Studio…';
    stopLibBtn.style.display = '';
    stopLibBtn.disabled = false;
    stopLibBtn.textContent = 'Stop';

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['studio.js']
    });
    // studio.js writes live state to storage; poll it so closing/reopening the
    // popup re-attaches to the scan instead of losing it.
    ensurePolling();
  } catch (err) {
    libStatusEl.style.color = '#ff4444';
    libStatusEl.textContent = 'Error: ' + (err && err.message || err);
    loadLibBtn.disabled = false;
    stopLibBtn.style.display = 'none';
  }
});

// ---- stop an in-progress scan ----
stopLibBtn.addEventListener('click', async () => {
  stopLibBtn.disabled = true;
  stopLibBtn.textContent = 'Stopping…';
  await chrome.storage.local.set({ harvestStop: true });
});

// ---- reconnecting to the scan ------------------------------------------
// The scan runs inside the Studio tab and keeps going even if this popup is
// closed (Chrome always closes a popup when you click away). studio.js writes
// its live state to chrome.storage.local under 'harvestStatus'; we poll it so
// reopening the popup re-attaches to an in-progress scan and shows results.
let harvestPoll = null;
let lastDoneStamp = null;

function stopPolling() { if (harvestPoll) { clearInterval(harvestPoll); harvestPoll = null; } }
function ensurePolling() {
  if (harvestPoll) return;
  harvestPoll = setInterval(() => {
    chrome.storage.local.get('harvestStatus', (r) => applyHarvestStatus(r.harvestStatus));
  }, 1000);
}

function applyHarvestStatus(s) {
  if (!s) return;
  if (s.running) {
    loadLibBtn.disabled = true;
    stopLibBtn.style.display = '';
    stopLibBtn.disabled = false;
    stopLibBtn.textContent = 'Stop';
    libStatusEl.style.color = '#fff';
    libStatusEl.textContent = s.message || 'Scanning… (keeps running if you close this)';
    ensurePolling();
    return;
  }
  // Not running any more.
  loadLibBtn.disabled = false;
  stopLibBtn.style.display = 'none';
  stopPolling();

  if (s.error) {
    libStatusEl.style.color = '#ff4444';
    libStatusEl.textContent = s.error;
    return;
  }
  if (s.done && s.stamp && s.stamp !== lastDoneStamp) {
    lastDoneStamp = s.stamp; // process each completed run once per popup session
    if (s.totalTargets && s.foundTargets === 0 && s.diag) {
      libStatusEl.style.color = '#ffaa00';
      libStatusEl.textContent = 'Nothing matched — see the diagnostic below.';
      showDiag(s.diag);
    } else if (s.totalTargets) {
      matchBtn.click(); // show the found links
    } else {
      refreshLibStatus();
    }
  }
}

// Instant nudge when a message arrives while the popup is open; the real state
// always comes from storage so live + reconnect paths agree.
chrome.runtime.onMessage.addListener((request) => {
  if (request && typeof request.action === 'string' && request.action.startsWith('studio')) {
    chrome.storage.local.get('harvestStatus', (r) => applyHarvestStatus(r.harvestStatus));
  }
});

// ---- matching ----
// YouTube turns underscores into spaces on upload, and people often paste the
// raw filename (with .mp4). Strip the extension and flatten underscores so
// "Ad_0001_H01...C01.mp4" matches the uploaded title "Ad 0001 H01 ... C01".
function stripExt(s) { return (s || '').replace(/\.(mp4|mov|m4v|webm|mkv|avi|wmv|flv)$/i, ''); }
function norm(s) { return stripExt(s).toLowerCase().replace(/_+/g, ' ').replace(/\s+/g, ' ').trim(); }
function loose(s) { return stripExt(s).toLowerCase().replace(/[^a-z0-9]+/g, ''); }

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (!seen.has(v.id)) { seen.add(v.id); out.push(v); }
  }
  return out;
}

function matchName(name, lib) {
  const n = norm(name);
  const nl = loose(name);
  if (!n) return { name, status: 'none', matches: [] };

  const tiers = [
    lib.filter(v => norm(v.title) === n),          // exact
    lib.filter(v => nl && loose(v.title) === nl),  // exact ignoring punctuation/spaces
    lib.filter(v => norm(v.title).includes(n))     // title contains the full typed name
  ];
  for (const t of tiers) {
    const uniq = dedupe(t);
    if (uniq.length) return { name, status: uniq.length === 1 ? 'found' : 'multiple', matches: uniq };
  }

  // Strict fallback: a title that contains EVERY distinguishing token of the
  // name. (Loose token overlap is deliberately NOT used — for structured names
  // like "Ad 0001 H01 A01 V01 M01 C01" it cross-matches near-identical names
  // such as "Ad 0037 ..." that share most words.)
  const tokens = n.split(' ').filter(t => t.length > 2);
  if (tokens.length) {
    const all = dedupe(lib.filter(v => {
      const t = norm(v.title);
      return tokens.every(tok => t.includes(tok));
    }));
    if (all.length) return { name, status: all.length === 1 ? 'found' : 'multiple', matches: all };
  }

  return { name, status: 'none', matches: [] };
}

let lastFoundLinks = [];

function renderNameResults(results) {
  const items = [];
  lastFoundLinks = [];

  for (const r of results) {
    let body = '';
    if (r.status === 'none') {
      body = `<div class="none-msg">No matching video found</div>`;
    } else if (r.status === 'found') {
      const v = r.matches[0];
      lastFoundLinks.push({ title: v.title, url: v.url });
      const vis = v.visibility ? ` · ${escapeHtml(v.visibility)}` : '';
      body =
        `<a href="${v.url}" target="_blank" rel="noopener">${v.url}</a>` +
        `<div class="matched-title">${escapeHtml(v.title)}${vis}</div>`;
    } else {
      // multiple candidates — list them all so the user picks
      body = r.matches.map(v => {
        const vis = v.visibility ? ` · ${escapeHtml(v.visibility)}` : '';
        return `<a href="${v.url}" target="_blank" rel="noopener">${v.url}</a>` +
               `<div class="matched-title">${escapeHtml(v.title)}${vis}</div>`;
      }).join('');
    }

    const label = r.status === 'found' ? '✓ found'
      : r.status === 'multiple' ? `⚠ ${r.matches.length} matches — pick one`
      : '✗ not found';

    items.push(
      `<div class="name-result">` +
      `<div class="name-result-name">${escapeHtml(r.name)}` +
      `<span class="tag ${r.status}">${label}</span></div>` +
      body +
      `</div>`
    );
  }

  namesResultsEl.innerHTML = items.join('');
  namesResultsWrap.style.display = 'block';
  copyLinksBtn.style.display = lastFoundLinks.length ? '' : 'none';
  copyTitlesLinksBtn.style.display = lastFoundLinks.length ? '' : 'none';
}

function showDiag(d) {
  const p = d.probe;
  const probeBlock = p
    ? `target: "${escapeHtml(p.target)}"<br>` +
      `exactInLib: <b style="color:${p.exactInLib ? '#00ff88' : '#ff6666'}">${p.exactInLib}</b>&nbsp;&nbsp;` +
      `looseInLib: <b style="color:${p.looseInLib ? '#00ff88' : '#ff6666'}">${p.looseInLib}</b><br>` +
      `closest captured titles:<br>` +
      ((p.close && p.close.length)
        ? p.close.map(c => `&nbsp;&nbsp;(${c.score}) "${escapeHtml(c.title)}"`).join('<br>')
        : '&nbsp;&nbsp;(none share words — NOT captured)')
    : '(no probe)';

  const titles = (d.sampleTitles || []).map(t => `&nbsp;&nbsp;"${escapeHtml(t)}"`).join('<br>') || '&nbsp;&nbsp;(none)';
  const rowCounts = Object.entries(d.rowCounts || {})
    .map(([k, v]) => `&nbsp;&nbsp;${escapeHtml(k)} → ${v}`).join('<br>');
  const hrefs = (d.sampleHrefs || []).map(h => `&nbsp;&nbsp;${escapeHtml(h)}`).join('<br>') || '&nbsp;&nbsp;(none)';

  namesResultsEl.innerHTML =
    `<div class="name-result" style="font-family:monospace;font-size:11px;line-height:1.5;white-space:normal;">` +
    `<b style="color:#ffaa00;">DIAGNOSTIC — screenshot this and send it</b><br><br>` +
    `<b style="color:#ffaa00;">PROBE (most important):</b><br>${probeBlock}<br><br>` +
    `sample captured titles:<br>${titles}<br><br>` +
    `harvested into library: <b>${d.harvested}</b> · ids on page: <b>${d.idAnchors}</b> · search box: <b>${d.searchInputFound ? 'yes' : 'no'}</b><br><br>` +
    `row counts:<br>${rowCounts}<br><br>` +
    `sample id links:<br>${hrefs}` +
    `</div>`;
  namesResultsWrap.style.display = 'block';
}

matchBtn.addEventListener('click', () => {
  const names = parseNames(namesInput.value);
  if (!names.length) {
    libStatusEl.style.color = '#ffaa00';
    libStatusEl.textContent = 'Paste at least one video name first.';
    return;
  }
  chrome.storage.local.get('videoLibrary', (r) => {
    const lib = r.videoLibrary && r.videoLibrary.videos;
    if (!lib || !lib.length) {
      libStatusEl.style.color = '#ffaa00';
      libStatusEl.innerHTML =
        'No video list yet — open <b>Studio → Content</b> and press ' +
        '<b>Load my video list</b> first.';
      return;
    }
    const results = names.map(name => matchName(name, lib));
    renderNameResults(results);
    const found = results.filter(x => x.status === 'found').length;
    const multi = results.filter(x => x.status === 'multiple').length;
    const none  = results.filter(x => x.status === 'none').length;
    libStatusEl.style.color = '#00ff88';
    libStatusEl.textContent =
      `${found} found` + (multi ? `, ${multi} need a pick` : '') + (none ? `, ${none} not found` : '');
  });
});

copyLinksBtn.addEventListener('click', () => {
  if (!lastFoundLinks.length) return;
  const text = lastFoundLinks.map(v => v.url).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    copyLinksBtn.textContent = 'Copied!';
    copyLinksBtn.classList.add('copied');
    setTimeout(() => {
      copyLinksBtn.textContent = 'Copy all found links';
      copyLinksBtn.classList.remove('copied');
    }, 2000);
  });
});

copyTitlesLinksBtn.addEventListener('click', () => {
  if (!lastFoundLinks.length) return;
  const text = lastFoundLinks.map(v => `${v.title}\n${v.url}`).join('\n\n');
  navigator.clipboard.writeText(text).then(() => {
    copyTitlesLinksBtn.textContent = 'Copied!';
    copyTitlesLinksBtn.classList.add('copied');
    setTimeout(() => {
      copyTitlesLinksBtn.textContent = 'Copy titles + links';
      copyTitlesLinksBtn.classList.remove('copied');
    }, 2000);
  });
});

// ---- restore on open ----
chrome.storage.local.get(NAMES_DRAFT_KEY, (r) => {
  if (typeof r[NAMES_DRAFT_KEY] === 'string') namesInput.value = r[NAMES_DRAFT_KEY];
  updateNamesCount();
});
refreshLibStatus();

// Re-attach to a scan that may have been running while the popup was closed.
chrome.storage.local.get('harvestStatus', (r) => applyHarvestStatus(r.harvestStatus));

// =====================================================================
//  Tella -> Council mode
// =====================================================================
const tellaUrlsEl      = document.getElementById('tellaUrls');
const tellaProspectEl  = document.getElementById('tellaProspect');
const tellaNotesEl     = document.getElementById('tellaNotes');
const tellaSituationEl = document.getElementById('tellaSituation');
const tellaLangEl      = document.getElementById('tellaLang');
const tellaRunBtn     = document.getElementById('tellaRunBtn');
const tellaClearBtn   = document.getElementById('tellaClearBtn');
const tellaStatusEl   = document.getElementById('tellaStatus');
const tellaResultsEl  = document.getElementById('tellaResults');

// --- Connect your own YouTube channel ---
const ytConnStatusEl = document.getElementById('ytConnStatus');
const ytConnBtn      = document.getElementById('ytConnBtn');
let ytConnected = false;

function renderYtConn(connected, email) {
  ytConnected = !!connected;
  if (!ytConnStatusEl) return;
  if (connected) {
    ytConnStatusEl.innerHTML = '✅ Connected' + (email ? ' as <strong>' + escapeHtml(email) + '</strong>' : '');
    if (ytConnBtn) ytConnBtn.textContent = 'Switch';
  } else {
    ytConnStatusEl.textContent = 'Connect your YouTube so uploads go to your channel.';
    if (ytConnBtn) ytConnBtn.textContent = 'Connect your YouTube';
  }
}
if (ytConnBtn) {
  ytConnBtn.addEventListener('click', () => {
    if (ytConnStatusEl) ytConnStatusEl.textContent = 'Opening Google sign-in…';
    chrome.runtime.sendMessage({ action: 'ytConnect' }, (r) => {
      if (r && r.ok) renderYtConn(true, r.email);
      else if (ytConnStatusEl) ytConnStatusEl.textContent = 'Connection failed: ' + ((r && r.error) || 'cancelled');
    });
  });
}
chrome.runtime.sendMessage({ action: 'ytStatus' }, (r) => {
  if (r && r.ok) renderYtConn(r.connected, r.email);
});

const TELLA_STAGE_LABEL = {
  uploading: 'Uploading to YouTube',
  waiting: 'Waiting for transcript',
  done: 'Sent to The Closer\u2019s Council ✓',
  failed: 'Failed',
};

function renderTellaJobs(jobs) {
  if (!jobs || !jobs.length) { tellaResultsEl.innerHTML = ''; return; }
  tellaResultsEl.innerHTML = jobs.map((j) => {
    let html = '<div class="batch-result-item" style="display:block;border:1px solid #2a2f3a;border-radius:8px;padding:10px;margin-bottom:8px;">';
    const stageColor = j.stage === 'done' ? '#00ff88' : (j.stage === 'failed' ? '#ff6b6b' : '#f5c451');
    html += `<div style="font-weight:600;color:${stageColor};">${escapeHtml(TELLA_STAGE_LABEL[j.stage] || j.stage)}</div>`;
    html += `<div style="font-size:11px;color:#9aa3b2;margin:3px 0;">${escapeHtml(j.lastMessage || '')}</div>`;
    if (j.youtubeUrl) html += `<div style="font-size:11px;">▶️ <a href="${escapeHtml(j.youtubeUrl)}" target="_blank" rel="noopener" style="color:#00ff88;">${escapeHtml(j.youtubeUrl)}</a></div>`;
    if (j.stage === 'failed' && j.error) html += `<div style="font-size:11px;color:#ff6b6b;margin-top:4px;">${escapeHtml(j.error)}</div>`;
    if (j.stage === 'done') {
      if (j.resultProspectName) html += `<div style="font-size:11px;color:#9aa3b2;margin-top:4px;">🗂️ Saved to the Council as: <strong>${escapeHtml(j.resultProspectName)}</strong></div>`;
      html += `<a href="https://thecloserscouncil.99dfy.com" target="_blank" rel="noopener" class="copy-btn" style="margin-top:8px;text-decoration:none;display:inline-block;">Open The Closer\u2019s Council</a>`;
    }
    html += '</div>';
    return html;
  }).join('');
}

if (tellaRunBtn) {
  tellaRunBtn.addEventListener('click', () => {
    const links = (tellaUrlsEl.value || '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (!links.length) { tellaStatusEl.textContent = 'Paste at least one Tella link.'; tellaStatusEl.style.color = '#ff8888'; return; }
    if (!ytConnected) { tellaStatusEl.textContent = 'First connect your YouTube channel (button at the top).'; tellaStatusEl.style.color = '#ff8888'; return; }
    const prospectName = (tellaProspectEl.value || '').trim();
    const notes = (tellaNotesEl.value || '').trim();
    const situation = (tellaSituationEl.value || '').trim();
    const lang = tellaLangEl.value;
    const items = links.map((url) => ({ tellaUrl: url, prospectName, notes, situation, lang }));
    chrome.runtime.sendMessage({ action: 'startTella', items });
    tellaStatusEl.textContent = `Started ${items.length} job${items.length === 1 ? '' : 's'}. You can close this popup — it keeps running.`;
    tellaStatusEl.style.color = '#00ff88';
    tellaUrlsEl.value = '';
  });
}
if (tellaClearBtn) {
  tellaClearBtn.addEventListener('click', () => chrome.runtime.sendMessage({ action: 'clearTellaDone' }));
}

// Load current Tella jobs on open + live updates.
chrome.runtime.sendMessage({ action: 'getTellaState' }, (resp) => {
  if (resp && resp.jobs) renderTellaJobs(resp.jobs);
});
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'tellaState') renderTellaJobs(request.jobs);
});
// Keep the panel live even between broadcasts: read stored jobs every few seconds.
setInterval(() => {
  chrome.storage.local.get('tellaJobs', (r) => {
    const jobs = r.tellaJobs ? Object.values(r.tellaJobs).sort((a, b) => b.created - a.created) : [];
    if (jobs.length) renderTellaJobs(jobs);
  });
}, 4000);
