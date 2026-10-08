// Tracks progress per tab so the popup can be closed and reopened mid-run,
// and mirrors progress on the toolbar badge.

const states = new Map(); // tabId -> latest state from the content script

function setBadge(tabId, state) {
  let text = '';
  let color = '#dc2626';
  if (state.status === 'running') {
    text = state.done >= 1000 ? `${Math.floor(state.done / 1000)}k` : String(state.done || '…');
  } else if (state.status === 'done') {
    text = '✓';
    color = '#16a34a';
  } else if (state.status === 'error') {
    text = '!';
  }
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  if (msg.type === 'ERB_STATE' && sender.tab) {
    const tabId = sender.tab.id;
    states.set(tabId, { ...msg.state, at: Date.now() });
    setBadge(tabId, msg.state);
    return false;
  }

  if (msg.type === 'ERB_GET_STATE') {
    sendResponse({ state: states.get(msg.tabId) || null });
    return false;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => states.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  // A full page load drops any in-flight run in that tab.
  if (info.status === 'loading' && states.get(tabId)?.status !== 'running') {
    states.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }
});
