// =====================================================================
//  Mode tab switching
// =====================================================================
document.querySelectorAll('.mode-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const mode = tab.dataset.mode;
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', t === tab));
    document.getElementById('singleMode').classList.toggle('active', mode === 'single');
    document.getElementById('batchMode').classList.toggle('active', mode === 'batch');
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
  batchStatusEl.textContent = `Starting batch of ${urls.length} videos...`;
  batchStatusEl.style.color = '#00ff88';
  setBatchUiActive(true);

  chrome.runtime.sendMessage({ action: 'startBatch', urls });
});

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
      items.push(
        `<div class="batch-result-item">` +
        `<span class="batch-result-icon ${cls}">${icon}</span>` +
        `<span class="batch-result-text${ok ? '' : ' failed'}">${escapeHtml(label)}</span>` +
        `</div>`
      );
    } else if (i === results.length && state.active) {
      items.push(
        `<div class="batch-result-item">` +
        `<span class="batch-result-icon active">…</span>` +
        `<span class="batch-result-text">${escapeHtml(shortUrl((state.urls || [])[i] || ''))} — scraping…</span>` +
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

const TELLA_STAGE_LABEL = {
  uploading: 'Uploading to YouTube',
  waiting: 'Waiting for transcript',
  council: 'Asking the Council',
  done: 'Done',
  failed: 'Failed',
};

function renderTellaJobs(jobs) {
  if (!jobs || !jobs.length) { tellaResultsEl.innerHTML = ''; return; }
  tellaResultsEl.innerHTML = jobs.map((j) => {
    const move = j.move || {};
    const pm = move.primary_message || {};
    const heat = (typeof move.heat_score === 'number') ? move.heat_score : null;
    let html = '<div class="batch-result-item" style="display:block;border:1px solid #2a2f3a;border-radius:8px;padding:10px;margin-bottom:8px;">';
    const stageColor = j.stage === 'done' ? '#00ff88' : (j.stage === 'failed' ? '#ff6b6b' : '#f5c451');
    html += `<div style="font-weight:600;color:${stageColor};">${escapeHtml(TELLA_STAGE_LABEL[j.stage] || j.stage)}`;
    if (heat !== null) html += ` &nbsp;🔥 ${heat}/10`;
    html += '</div>';
    html += `<div style="font-size:11px;color:#9aa3b2;margin:3px 0;">${escapeHtml(j.lastMessage || '')}</div>`;
    if (j.youtubeUrl) html += `<div style="font-size:11px;">▶️ <a href="${escapeHtml(j.youtubeUrl)}" target="_blank" rel="noopener" style="color:#00ff88;">${escapeHtml(j.youtubeUrl)}</a></div>`;
    if (j.stage === 'failed' && j.error) html += `<div style="font-size:11px;color:#ff6b6b;margin-top:4px;">${escapeHtml(j.error)}</div>`;
    if (j.stage === 'done' && pm.text) {
      const mid = 'tmsg_' + j.id;
      html += `<div style="margin-top:8px;background:#0f1d15;border:1px solid #244031;border-radius:8px;padding:10px;white-space:pre-wrap;font-size:13px;line-height:1.5;" id="${mid}">${escapeHtml(pm.text)}</div>`;
      html += `<button class="copy-btn tella-copy" data-target="${mid}" style="margin-top:6px;">Copy message</button>`;
      html += ` <a href="https://thecloserscouncil.99dfy.com" target="_blank" rel="noopener" class="copy-btn" style="margin-top:6px;text-decoration:none;display:inline-block;">Open in The Closer's Council</a>`;
      if (j.resultProspectName) html += `<div style="font-size:11px;color:#9aa3b2;margin-top:4px;">🗂️ Saved to Council as: <strong>${escapeHtml(j.resultProspectName)}</strong></div>`;
    }
    html += '</div>';
    return html;
  }).join('');

  tellaResultsEl.querySelectorAll('.tella-copy').forEach((btn) => {
    btn.addEventListener('click', () => {
      const el = document.getElementById(btn.dataset.target);
      if (!el) return;
      navigator.clipboard.writeText(el.textContent).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => (btn.textContent = 'Copy message'), 1500);
      });
    });
  });
}

if (tellaRunBtn) {
  tellaRunBtn.addEventListener('click', () => {
    const links = (tellaUrlsEl.value || '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (!links.length) { tellaStatusEl.textContent = 'Paste at least one Tella link.'; tellaStatusEl.style.color = '#ff8888'; return; }
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
