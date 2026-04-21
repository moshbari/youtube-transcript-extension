# YT Transcript Scraper

A Chrome extension (Manifest V3) that scrapes the full transcript of a YouTube video with one click, saves it as a `.txt` file, and displays it in the popup so you can copy it to the clipboard. Works on both regular YouTube videos and **Shorts**.

## Why this exists

YouTube Shorts don't expose the transcript panel the way regular watch pages do. This extension solves that by opening the same video in the standard `/watch?v=…` player (where the transcript panel does work) and automating the rest: expanding the description, clicking "Show transcript," scrolling the panel until every segment has loaded, and extracting the text.

It also gives you a local `.txt` copy of every transcript you scrape — useful for feeding into LLMs, summarizers, notes, or just keeping a searchable archive.

## Features

- One-click transcript scraping from any YouTube video or Short
- Automatic re-routing of Shorts into the standard watch player
- Downloads transcript as `{videoId}_transcript.txt` with video title and URL included
- In-popup transcript viewer with "Copy All" button
- Caches the last scrape in `chrome.storage.local` — reopen the popup to see it again
- Resilient to YouTube DOM drift (multiple selector strategies + regex fallback)

## Installation (unpacked, for development or personal use)

1. Clone or download this repo to a folder on your machine.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the folder containing this code.
5. The "YT Transcript Scraper" extension should now appear in your toolbar.

To update after a code change, click the circular **reload** icon on the extension's card at `chrome://extensions`.

## Usage

### Regular YouTube video
1. Open any `https://www.youtube.com/watch?v=…` page.
2. Click the extension icon in the Chrome toolbar.
3. Click **Scrape Transcript**.
4. A `.txt` file downloads and the transcript appears in the popup.

### YouTube Short
1. Open any `https://www.youtube.com/shorts/…` page.
2. Click the extension icon → **Scrape Transcript**.
3. The extension opens the same video in a new tab using the standard watch URL, runs the scraper automatically, downloads the transcript, and closes the helper tab.
4. Reopen the popup on any tab to see the saved transcript.

### "Copy All"
When the transcript viewer is visible in the popup, the **Copy All** button copies the full transcript (title + URL + timestamped lines) to your clipboard.

## How it works

### Architecture

```
┌─────────────────┐        message: scrapeUrl        ┌─────────────────┐
│   popup.js      │ ───────────────────────────────▶ │ background.js   │
│   (toolbar UI)  │ ◀───── message: status/done ──── │ (service worker)│
└────────┬────────┘                                  └────────┬────────┘
         │ executeScript(content.js)                          │ opens new tab
         │ (non-Shorts path)                                  │ executeScript(content.js)
         ▼                                                    ▼
     ┌─────────────────────────────────────────────────────────────┐
     │                        content.js                           │
     │   runs in the YouTube page, drives the DOM, extracts text   │
     └─────────────────────────────────────────────────────────────┘
```

### Content-script flow (`content.js`)

1. **Expand description.** Clicks the "…more" button so the "Show transcript" button becomes reachable. Retries up to 20 times with 500 ms polling.
2. **Find and click "Show transcript."** Scans every `<button>` for one whose innerText contains `"show transcript"`. Retries up to 20 times.
3. **Wait for the transcript panel.** Polls for `transcript-segment-view-model` (newer) or `ytd-transcript-segment-renderer` (older) for up to 5 s.
4. **Scroll the panel to force lazy-loading.** YouTube virtualizes the transcript list — segments only render as they scroll into view, and background-tab IntersectionObservers get suspended. The script:
   - Scrolls the last segment into view.
   - Manually dispatches `scroll` and `wheel` events on the segments container.
   - Scrolls the window itself.
   - Continues until 3 consecutive checks find no new segments.
5. **Extract each segment.** Uses a three-strategy approach for maximum resilience to YouTube class-name changes:
   1. Known class names: `.ytwTranscriptSegmentViewModelTimestamp`, `.segment-timestamp`, `.yt-core-attributed-string`, `.segment-text`.
   2. Attribute-contains fallback: `[class*="SegmentTimestamp"]`, `[class*="Timestamp"]`, `[class*="SegmentText"]`.
   3. Raw-text regex fallback on `segment.innerText`: `/^(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)$/`.
6. **Build the output text:**
   ```
   <video title>
   <video URL>

   0:00 - first segment text
   0:04 - next segment text
   ...
   ```
7. **Download** the blob as `{videoId}_transcript.txt` and save the parsed data to `chrome.storage.local` under `lastTranscript`.
8. **Notify the popup** via `chrome.runtime.sendMessage({ action: 'done', … })`.
9. **Close the helper tab** if this was a Shorts-initiated scrape (detected via `window.history.length <= 2`).

### Shorts handling (`popup.js` + `background.js`)

Shorts don't render the transcript button in their native player. The workaround:
1. `popup.js` detects a `youtube.com/shorts/{id}` URL.
2. It sends `{ action: 'scrapeUrl', url: 'https://www.youtube.com/watch?v={id}' }` to the background service worker.
3. `background.js` opens the watch URL in a new **active** tab (active is important — background tabs have IntersectionObservers suspended, which breaks the transcript panel's virtualization).
4. On `chrome.tabs.onUpdated` with `status === 'complete'`, it injects `content.js`.
5. The content script does its thing, then sends `{ action: 'closeSenderTab' }` so the background script can tidy up.

### Permissions and why they're requested

| Permission | Reason |
|---|---|
| `activeTab` | Run in the currently active tab when the user clicks the extension icon. |
| `scripting` | Programmatically inject `content.js` (`chrome.scripting.executeScript`). |
| `downloads` | Save the transcript as a `.txt` file. (Technically the current code uses a blob + `<a download>` which doesn't require this permission, but it's declared for forward compatibility with a future native downloads API call.) |
| `storage` | Persist the last scraped transcript so reopening the popup still shows it. |
| `host_permissions: https://www.youtube.com/*` | Restrict the extension to YouTube — it can't touch any other site. |

## File structure

```
youtube-transcript-extension/
├── manifest.json       Manifest V3 config, permissions, icons, popup/background refs
├── popup.html          Toolbar popup UI
├── popup.css           Popup styles (dark theme, YouTube-red accents)
├── popup.js            Popup logic — click handler, message listener, transcript viewer
├── background.js       Service worker — orchestrates the Shorts → watch detour
├── content.js          Runs in-page, drives the YouTube DOM, extracts transcript
├── icon16.png          Toolbar icon (16×16)
├── icon48.png          Extensions-page icon (48×48)
└── icon128.png         Chrome Web Store icon (128×128)
```

## Maintenance notes

**This extension depends on YouTube's internal DOM, which changes without warning.** Expect to patch selectors every few months.

### Where it's likely to break

1. **Description expand button** — `content.js` currently uses `tp-yt-paper-button#expand`. This is an old Polymer selector. YouTube is gradually migrating away from Polymer. If the popup gets stuck on "Expanding description…", this is the first thing to check.
2. **"Show transcript" button location/text** — currently found by scanning all buttons for `innerText.includes('show transcript')`. If YouTube changes the label, this breaks. Fallback would be attribute matching or a more targeted panel query.
3. **Segment element class names** — the inner `Timestamp` / `SegmentText` classes. These have already drifted once (fixed in v1.3).
4. **Panel container selectors** — currently checks for `transcript-segment-view-model` and `ytd-transcript-segment-renderer`. If YouTube renames the web component, both paths fail.

### Debugging snippet

When something breaks, open the failing watch page, open DevTools (F12), and run this in the Console. It prints the structure of the first segment and tells you exactly what class names YouTube is currently using:

```js
const seg = document.querySelector('transcript-segment-view-model, ytd-transcript-segment-renderer');
console.log('segment tag:', seg?.tagName);
console.log('segment innerHTML:', seg?.innerHTML?.slice(0, 800));
console.log('segment innerText:', JSON.stringify(seg?.innerText));
```

Also check the **last status message** in the extension popup. Each status line in `content.js` maps to a specific stage of the scrape — whichever one is visible when it stalls tells you which stage broke:

| Popup last message | Broken stage |
|---|---|
| "Expanding description…" | Description-expand selector dead |
| "Looking for transcript button…" | "Show transcript" button not found |
| "Could not find 'Show transcript' button…" | Same as above, explicit error |
| "Waiting for transcript panel…" / "Transcript panel did not appear." | Panel container selector changed |
| "Loaded 0 segments…" or stuck at some number | Scroll loop not loading more segments |
| "Failed to extract any text from the panel." | Inner segment class names changed |
| "Success! Saved X segments." but no file | Blob/download permission issue |

### Changelog

- **v1.3** — Hardened transcript extraction. Added attribute-contains selectors and an innerText regex fallback so future class-name renames don't immediately break scraping.
- **v1.2** — Shorts support via background-orchestrated watch-URL detour. In-popup transcript viewer + "Copy All." Persistence via `chrome.storage.local`.

## Related

There is also a server-side sibling project, `moshbari/youtube-scraper-backend`, that does the same thing via FastAPI + Playwright. It's a separate codebase and not required for this extension to work.

## License

No license declared. All rights reserved by the author unless/until a license is added.
