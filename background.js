chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'scrapeUrl') {
    // Open the requested URL in a new ACTIVE tab to prevent suspended UI rendering
    chrome.tabs.create({ url: request.url, active: true }, (newTab) => {
      // Listen for the tab to finish loading
      chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
        if (tabId === newTab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener); // Stop listening once we catch it
          
          // Inject the scraper content script into the fully loaded foreground tab
          chrome.scripting.executeScript({
            target: { tabId: newTab.id },
            files: ['content.js']
          });
        }
      });
    });
  }

  if (request.action === 'closeSenderTab' && sender.tab) {
    chrome.tabs.remove(sender.tab.id);
  }
});
