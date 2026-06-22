// =====================================================================
//  Offscreen download helper
// =====================================================================
//
//  This page lives at chrome-extension://<our-id>/offscreen.html and is
//  spun up by the service worker on demand. Its only job is to receive
//  {text, filename} pairs and trigger downloads via the classic
//  <a download="...">.click() trick from a page context.
//
//  Why not let the service worker do this directly with
//  chrome.downloads.download?  Two reasons:
//
//    1. chrome.downloads.download has an unreliable `filename` hint
//       for data: URLs across Chrome versions, and the
//       onDeterminingFilename listener override doesn't always win
//       (other extensions can claim the slot, or it can simply not
//       fire). We've burned several iterations on that path.
//
//    2. Blob URLs created in a service worker have worker-scoped
//       lifetimes — the worker can suspend before Chrome fetches the
//       blob, dropping the download. An offscreen document is a
//       persistent page; its blob URLs are valid for as long as the
//       page is alive.
//
//  The <a download> approach in a page context honors the filename
//  attribute deterministically and isn't subject to YouTube's
//  per-origin "block multiple automatic downloads" gate (this page's
//  origin is chrome-extension://, not youtube.com).
//
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return false;

  if (message.action === 'download') {
    try {
      const blob = new Blob([message.text], { type: 'text/plain;charset=utf-8' });
      const blobUrl = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = message.filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      // Give Chrome a beat to start the download before revoking the
      // object URL — the download read happens immediately on click,
      // so 5 seconds is far more than enough.
      setTimeout(() => {
        try { URL.revokeObjectURL(blobUrl); } catch {}
      }, 5000);

      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
    return true;   // keep channel open until sendResponse fires
  }
});
