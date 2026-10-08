const $ = (id) => document.getElementById(id);

let tabId = null;

function show(el, visible) {
  el.hidden = !visible;
}

function renderState(state) {
  if (!state) return;
  const running = state.status === 'running';
  show($('progress'), running || state.status === 'done');
  show($('cancel'), running);
  show($('note'), !running);
  $('run').disabled = running;
  $('progress-text').textContent = state.message || '';

  const fill = $('bar-fill');
  if (running && state.total) {
    fill.classList.remove('indeterminate');
    fill.style.width = `${Math.min(100, Math.round((state.done / state.total) * 100))}%`;
  } else if (running) {
    fill.classList.add('indeterminate');
    fill.style.width = '';
  } else {
    fill.classList.remove('indeterminate');
    fill.style.width = state.status === 'done' ? '100%' : '0';
  }

  show($('error'), state.status === 'error');
  if (state.status === 'error') $('error').textContent = state.message;
}

async function init() {
  $('options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;
  const host = tab && tab.url ? new URL(tab.url).host : '';
  if (!/\.(freshsales\.io|myfreshworks\.com)$/.test(host)) {
    $('hint').textContent = 'Open the recycle bin in Freshsales to empty it.';
    return;
  }

  let detected;
  try {
    detected = await chrome.tabs.sendMessage(tabId, { type: 'ERB_DETECT' });
  } catch (_e) {
    $('hint').textContent = 'Reload this Freshsales tab so the extension can attach to it.';
    return;
  }
  if (!detected || !detected.ok) {
    $('hint').textContent = (detected && detected.error) || 'Could not read this page.';
    return;
  }
  if (!detected.view) {
    $('hint').textContent = 'Open the Recycle Bin view of a module (for example Contacts > Recycle Bin), then try again.';
    return;
  }

  const { view } = detected;
  show($('view'), true);
  $('view-name').textContent = view.viewName || (view.viewId ? `View ${view.viewId}` : 'Recycle Bin');
  $('view-module').textContent = view.moduleLabel;
  if (!view.isRecycleBin) {
    $('hint').textContent = "This view isn't the recycle bin, so the extension won't delete from it.";
    return;
  }
  show($('hint'), false);
  show($('note'), true);
  $('run').disabled = false;

  const { state } = await chrome.runtime.sendMessage({ type: 'ERB_GET_STATE', tabId });
  // The content script is the source of truth for whether a run is still alive.
  if (state && (state.status !== 'running' || detected.running)) renderState(state);
}

$('run').addEventListener('click', async () => {
  $('run').disabled = true;
  show($('error'), false);
  renderState({ status: 'running', message: 'Starting…', done: 0 });
  const res = await chrome.tabs.sendMessage(tabId, { type: 'ERB_RUN' });
  if (!res || !res.ok) renderState({ status: 'error', message: (res && res.error) || 'Failed to start.' });
});

$('cancel').addEventListener('click', () => {
  chrome.tabs.sendMessage(tabId, { type: 'ERB_CANCEL' });
});

// Content-script progress messages reach the popup directly as well as the service worker.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'ERB_STATE' && sender.tab && sender.tab.id === tabId) renderState(msg.state);
});

init();
