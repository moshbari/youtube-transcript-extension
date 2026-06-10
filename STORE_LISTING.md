# Chrome Web Store — Submission Pack

Everything below is copy-paste ready for the Chrome Web Store dashboard.
Upload file: **yt-transcript-scraper-v1.4.zip** (in this folder).

---

## Store listing

**Name** (max 45 chars)
```
YT Transcript Scraper
```

**Summary / short description** (max 132 chars)
```
Scrape the full transcript of any YouTube video or Short with one click. Save as .txt and copy to clipboard.
```

**Detailed description**
```
YT Transcript Scraper grabs the complete transcript of any YouTube video — including Shorts — with a single click.

WHAT IT DOES
• Click the toolbar icon on any YouTube video, then "Scrape Transcript"
• The full timestamped transcript appears right in the popup
• A .txt copy (with the video title and URL) downloads automatically
• One "Copy All" button puts the whole transcript on your clipboard

WORKS ON SHORTS
YouTube Shorts don't show a transcript panel. This extension automatically re-opens the same video in the standard player, scrapes it, and saves the result — no manual steps.

GREAT FOR
• Feeding transcripts into ChatGPT, Claude, or other AI tools for summaries
• Research, note-taking, and building a searchable archive
• Translating, quoting, or repurposing video content

PRIVACY
Everything happens locally in your browser. The extension only runs on youtube.com, never collects or transmits your data, and saves transcripts only to your own computer.
```

**Category:** Productivity
**Language:** English

---

## Permission justifications
(Paste each into its box under "Privacy practices" → "Permission justification")

| Permission | Justification |
|---|---|
| **activeTab** | Used to read the YouTube page the user is currently viewing when they click the extension icon, so the transcript can be scraped. |
| **scripting** | Required to inject the transcript-extraction script into the YouTube watch page. |
| **storage** | Saves the most recently scraped transcript locally so the user can reopen the popup and see it again. No data leaves the device. |
| **tabs** | Needed to open the standard YouTube watch page for Shorts (which lack a transcript panel) and to close that helper tab when done. |
| **alarms** | Used internally to schedule short retries while the YouTube transcript panel finishes loading. |
| **offscreen** | Used to reliably trigger the .txt file download from a stable page context (via a generated link, not the downloads API). |
| **Host permission: youtube.com** | The extension only operates on YouTube. This restricts it so it cannot access any other website. |

**Single purpose** (paste into the "Single purpose" box)
```
This extension has one purpose: to extract the transcript of a YouTube video and let the user save or copy it.
```

**Are you using remote code?** → **No, I am not using remote code.**

---

## Data usage disclosures
(Under "Privacy practices" — check the boxes as described)

- Does NOT collect or use any of the listed data types (personally identifiable info, health, financial, authentication, personal communications, location, web history, user activity, website content).
- The transcript text the extension reads is processed locally only and is never sent anywhere.

Check **all three** certification boxes:
- ☑ I do not sell or transfer user data to third parties, outside of the approved use cases
- ☑ I do not use or transfer user data for purposes unrelated to my item's single purpose
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** see PRIVACY_POLICY.md — it must be hosted at a public URL (see submission steps).
