(async function() {
  function sendStatus(message) {
    chrome.runtime.sendMessage({ action: 'status', message });
  }
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  function msToTimestamp(ms) {
    const t = Math.floor((ms || 0) / 1000);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  }

  // Pull a JSON array that follows "key": out of a big string, brace-balanced
  // (handles nested arrays/objects, unlike a naive non-greedy regex).
  function jsonArrayAfter(text, key) {
    const i = text.indexOf(key);
    if (i === -1) return null;
    const start = text.indexOf('[', i);
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let k = start; k < text.length; k++) {
      const c = text[k];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, k + 1)); } catch { return null; } } }
    }
    return null;
  }

  // Find the captionTracks array (if any) from the page's inline data.
  function getCaptionTracks() {
    const sources = [];
    for (const s of document.querySelectorAll('script')) {
      const t = s.textContent || '';
      if (t.includes('captionTracks')) sources.push(t);
    }
    sources.push(document.documentElement.innerHTML);
    for (const src of sources) {
      const tracks = jsonArrayAfter(src, '"captionTracks"');
      if (tracks && tracks.length) return tracks;
    }
    return null;
  }

  // FAST PATH: fetch the caption track straight from YouTube's timedtext endpoint.
  // Runs in the page's own origin/session (cookies + visitor data), so it works
  // for the user's unlisted videos — no clicking the flaky "Show transcript" UI.
  async function tryDirectCaptions() {
    const tracks = getCaptionTracks();
    if (!tracks) return { lines: null, captionsExist: false };
    // Prefer Bengali, then any non-translated track, else the first.
    const track =
      tracks.find(t => (t.languageCode || '').toLowerCase().startsWith('bn')) ||
      tracks.find(t => t.kind === 'asr') ||
      tracks[0];
    if (!track || !track.baseUrl) return { lines: null, captionsExist: true };

    // Try JSON3 first, then the default XML format.
    const base = track.baseUrl;
    const urls = [base + (base.includes('fmt=') ? '' : '&fmt=json3'), base];
    for (const url of urls) {
      try {
        const res = await fetch(url, { credentials: 'include' });
        const body = await res.text();
        if (!body) continue;
        const lines = [];
        if (body.trim().startsWith('{')) {
          const data = JSON.parse(body);
          for (const ev of (data.events || [])) {
            if (!ev.segs) continue;
            const text = ev.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
            if (text) lines.push({ timestamp: msToTimestamp(ev.tStartMs), text });
          }
        } else if (body.includes('<text')) {
          const doc = new DOMParser().parseFromString(body, 'text/xml');
          for (const node of doc.querySelectorAll('text')) {
            const text = (node.textContent || '')
              .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
              .replace(/\s+/g, ' ').trim();
            if (text) lines.push({ timestamp: msToTimestamp(parseFloat(node.getAttribute('start') || '0') * 1000), text });
          }
        }
        if (lines.length) return { lines, captionsExist: true };
      } catch (_) { /* try next */ }
    }
    return { lines: null, captionsExist: true };
  }

  // Build the .txt + notify the background. Shared by both scrape paths.
  function emitTranscript(transcriptLines) {
    const videoTitle = document.querySelector('yt-formatted-string.ytd-watch-metadata, h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string')?.innerText?.trim()
      || document.title.replace(' - YouTube', '').trim();
    const videoUrl = window.location.href;
    let videoId = 'youtube';
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('v')) videoId = urlParams.get('v');

    let fullText = `${videoTitle}\n${videoUrl}\n\n`;
    for (const line of transcriptLines) fullText += `${line.timestamp} - ${line.text}\n`;

    const safeTitle = (videoTitle || '')
      .replace(/[<>:"/\\|?*\x00-\x1F\[\]\{\}]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 150) || 'youtube';
    const filename = `${safeTitle} - ${videoId}.txt`;

    if (!window.__tellaScrape) {
      chrome.runtime.sendMessage({ action: 'download', text: fullText, filename });
    }
    chrome.storage.local.set({
      lastTranscript: { title: videoTitle, url: videoUrl, lines: transcriptLines, videoId, scrapedAt: new Date().toISOString() }
    });
    const plainText = transcriptLines.map(l => l.text).join(' ').replace(/\s+/g, ' ').trim();
    chrome.runtime.sendMessage({
      action: 'done', text: fullText, plainText, lines: transcriptLines.length,
      segments: transcriptLines, videoId, title: videoTitle, url: videoUrl
    });
    if (window.history.length <= 2) {
      setTimeout(() => chrome.runtime.sendMessage({ action: 'closeSenderTab' }), 1000);
    }
  }

  try {
    // ---- FAST PATH: direct caption fetch ----
    sendStatus('Checking for captions…');
    const direct = await tryDirectCaptions();
    if (direct.lines && direct.lines.length) {
      sendStatus(`Got ${direct.lines.length} caption lines.`);
      emitTranscript(direct.lines);
      return;
    }
    // If we can see the page data and it has NO caption track yet, fail fast so
    // the batch retries in 5 min (instead of a slow 20s UI dance for nothing).
    if (direct.captionsExist === false) {
      chrome.runtime.sendMessage({ action: 'error', message: 'No captions on YouTube yet — will retry.' });
      return;
    }

    // ---- FALLBACK: the UI scrape (click "Show transcript", read the panel) ----
    sendStatus('Expanding description...');
    let expandRetries = 0;
    let expandBtn = null;
    while (!expandBtn && expandRetries < 20) {
      expandBtn = document.querySelector('tp-yt-paper-button#expand');
      if (expandBtn && expandBtn.offsetParent !== null) {
          expandBtn.click();
          break;
      }
      expandBtn = null;
      await sleep(500);
      expandRetries++;
    }

    await sleep(1000);

    sendStatus('Looking for transcript button...');
    let transcriptRetries = 0;
    let transcriptBtn = null;
    while (!transcriptBtn && transcriptRetries < 20) {
      const buttons = Array.from(document.querySelectorAll('button'));
      transcriptBtn = buttons.find(b => b.innerText && b.innerText.toLowerCase().includes('show transcript'));
      if (transcriptBtn) {
        transcriptBtn.click();
        break;
      }
      await sleep(500);
      transcriptRetries++;
    }

    if (!transcriptBtn) {
      chrome.runtime.sendMessage({ action: 'error', message: 'Could not find "Show transcript" button. It might not be available for this video.' });
      return;
    }

    sendStatus('Waiting for transcript panel...');

    let retries = 0;
    while (!document.querySelector('transcript-segment-view-model, ytd-transcript-segment-renderer') && retries < 20) {
      await sleep(500);
      retries++;
    }

    if (!document.querySelector('transcript-segment-view-model, ytd-transcript-segment-renderer')) {
        chrome.runtime.sendMessage({ action: 'error', message: 'Transcript panel did not appear.' });
        return;
    }

    sendStatus('Scrolling transcript panel...');
    let lastCount = 0;
    let consecutiveNoNewSegments = 0;

    while (consecutiveNoNewSegments < 3) {
      const segments = document.querySelectorAll('transcript-segment-view-model, ytd-transcript-segment-renderer');
      if (segments.length === 0) break;

      if (segments.length === lastCount) {
        consecutiveNoNewSegments++;
        await sleep(1500);
      } else {
        consecutiveNoNewSegments = 0;
        lastCount = segments.length;
        const lastElement = segments[segments.length - 1];
        lastElement.scrollIntoView({ behavior: 'smooth', block: 'end' });

        const container = lastElement.closest('#segments-container, ytd-engagement-panel-section-list-renderer #content, ytd-transcript-segment-list-renderer, yt-formatted-string');
        if (container) {
          container.scrollTop = container.scrollHeight;
          container.dispatchEvent(new Event('scroll', { bubbles: true }));
          container.dispatchEvent(new WheelEvent('wheel', { deltaY: 1000, bubbles: true }));
        }

        [...document.querySelectorAll('#segments-container, ytd-engagement-panel-section-list-renderer #content')].forEach(c => {
            c.scrollTop = c.scrollHeight;
            c.dispatchEvent(new Event('scroll', { bubbles: true }));
            c.dispatchEvent(new WheelEvent('wheel', { deltaY: 1000, bubbles: true }));
        });

        window.scrollBy(0, 500);
        window.dispatchEvent(new Event('scroll'));

        sendStatus(`Loaded ${lastCount} segments...`);
        await sleep(1000);
      }
    }

    const segments = document.querySelectorAll('transcript-segment-view-model, ytd-transcript-segment-renderer');
    let transcriptLines = [];

    for (const segment of segments) {
      let timestamp = null;
      let text = null;

      const timestampEl = segment.querySelector(
        '.ytwTranscriptSegmentViewModelTimestamp, .segment-timestamp, ' +
        '[class*="SegmentTimestamp"], [class*="Timestamp"]'
      );
      const textEl = segment.querySelector(
        '.yt-core-attributed-string, .segment-text, [class*="SegmentText"]'
      );

      if (timestampEl && textEl) {
        timestamp = timestampEl.innerText.trim();
        text = textEl.innerText.trim();
      } else {
        const raw = (segment.innerText || '').trim();
        const match = raw.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s+([\s\S]+)$/);
        if (match) {
          timestamp = match[1];
          text = match[2].replace(/\s+/g, ' ').trim();
        }
      }

      if (timestamp && text) {
        transcriptLines.push({ timestamp, text });
      }
    }

    if (transcriptLines.length > 0) {
      emitTranscript(transcriptLines);
    } else {
      chrome.runtime.sendMessage({ action: 'error', message: 'Failed to extract any text from the panel.' });
    }

  } catch (err) {
    chrome.runtime.sendMessage({ action: 'error', message: err.toString() });
  }
})();
