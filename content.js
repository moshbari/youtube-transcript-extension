(async function() {
  function sendStatus(message) {
    chrome.runtime.sendMessage({ action: 'status', message });
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  try {
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

    // Wait for the panel to appear
    let retries = 0;
    while (!document.querySelector('transcript-segment-view-model, ytd-transcript-segment-renderer') && retries < 10) {
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

        // Force scroll events specifically because background tabs suspend IntersectionObservers
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

        // Trigger global window scroll to catch page-level IntersectionObservers
        window.scrollBy(0, 500);
        window.dispatchEvent(new Event('scroll'));

        sendStatus(`Loaded ${lastCount} segments...`);
        await sleep(1000);
      }
    }

    // Extract video title and URL
    const videoTitle = document.querySelector('yt-formatted-string.ytd-watch-metadata, h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string')?.innerText?.trim() || document.title.replace(' - YouTube', '').trim();
    const videoUrl = window.location.href;

    const segments = document.querySelectorAll('transcript-segment-view-model, ytd-transcript-segment-renderer');
    let transcriptLines = [];

    for (const segment of segments) {
      // YouTube changes class names frequently — try specific selectors first,
      // then fall back to attribute-contains matches, then raw-text parsing.
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
        // Fallback: parse the segment's own innerText.
        // Format is reliably "M:SS text..." or "H:MM:SS text...".
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
      let videoId = 'youtube';
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.has('v')) videoId = urlParams.get('v');

      // Build the full text with title and URL at the top
      let fullText = `${videoTitle}\n${videoUrl}\n\n`;
      for (const line of transcriptLines) {
        fullText += `${line.timestamp} - ${line.text}\n`;
      }

      // Download the .txt file
      const blob = new Blob([fullText], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${videoId}_transcript.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      // Save transcript data to chrome.storage.local for the popup to display
      chrome.storage.local.set({
        lastTranscript: {
          title: videoTitle,
          url: videoUrl,
          lines: transcriptLines,
          videoId: videoId,
          scrapedAt: new Date().toISOString()
        }
      });

      chrome.runtime.sendMessage({
        action: 'done',
        text: fullText,
        lines: transcriptLines.length,
        videoId: videoId,
        title: videoTitle,
        url: videoUrl
      });

      // If opening in a freshly created background tab, the history length is very small
      if (window.history.length <= 2) {
          setTimeout(() => {
             chrome.runtime.sendMessage({ action: 'closeSenderTab' });
          }, 1000);
      }
    } else {
      chrome.runtime.sendMessage({ action: 'error', message: 'Failed to extract any text from the panel.' });
    }

  } catch (err) {
    chrome.runtime.sendMessage({ action: 'error', message: err.toString() });
  }
})();
