// --- Load any previously saved transcript on popup open ---
chrome.storage.local.get('lastTranscript', (result) => {
  if (result.lastTranscript) {
    displayTranscript(result.lastTranscript);
  }
});

// --- Scrape button ---
document.getElementById('scrapeBtn').addEventListener('click', async () => {
  const statusDiv = document.getElementById('status');
  const btn = document.getElementById('scrapeBtn');

  statusDiv.textContent = 'Injecting script...';
  statusDiv.style.color = '#fff';
  btn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Check if it's a Shorts URL
    if (tab.url.includes("youtube.com/shorts/")) {
      const videoId = tab.url.split("/shorts/")[1].split(/[?#]/)[0];
      const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

      statusDiv.textContent = 'Opening standard player to extract...';

      // Let background.js orchestrate the active tab and injection so the popup closing doesn't interrupt it
      chrome.runtime.sendMessage({ action: 'scrapeUrl', url: watchUrl });

      // Close the popup shortly after so user can watch the new tab do its magic
      setTimeout(() => window.close(), 1500);
      return;
    }

    if (!tab.url.includes("youtube.com/watch")) {
      statusDiv.textContent = 'Please open a YouTube video!';
      statusDiv.style.color = '#ff4444';
      btn.disabled = false;
      return;
    }

    // Inject the content script into the standard watch page
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

// --- Copy button ---
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

// --- Listen for messages from content.js ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const statusDiv = document.getElementById('status');
  const btn = document.getElementById('scrapeBtn');

  if (request.action === 'status' && statusDiv) {
    statusDiv.textContent = request.message;
  }

  if (request.action === 'done' && statusDiv) {
    statusDiv.textContent = `Success! Saved ${request.lines} segments.`;
    statusDiv.style.color = '#00ff88';
    if (btn) btn.disabled = false;

    // Reload transcript from storage into the viewer
    chrome.storage.local.get('lastTranscript', (result) => {
      if (result.lastTranscript) {
        displayTranscript(result.lastTranscript);
      }
    });
  }

  if (request.action === 'error' && statusDiv) {
    statusDiv.textContent = request.message;
    statusDiv.style.color = '#ff4444';
    if (btn) btn.disabled = false;
  }
});

// --- Render transcript in the popup ---
function displayTranscript(data) {
  const viewer = document.getElementById('transcriptViewer');
  const titleEl = document.getElementById('videoTitle');
  const urlEl = document.getElementById('videoUrl');
  const contentEl = document.getElementById('transcriptContent');

  titleEl.textContent = data.title;
  urlEl.textContent = data.url;
  urlEl.href = data.url;

  // Build transcript HTML
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
