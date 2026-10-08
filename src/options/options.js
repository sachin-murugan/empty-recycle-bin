const $ = (id) => document.getElementById(id);
const { buildTemplate, parseCopiedFetch } = FSX.uiRequest;
const { moduleKeyFromPath } = FSX.platform;

const MODE_LABELS = {
  bulk: 'many records per request',
  single: 'one record per request',
  view: 'whole view in one request',
};

function setStatus(text, ok) {
  $('status').textContent = text;
  $('status').className = ok ? 'ok' : 'err';
}

async function load() {
  const { uiTemplates = {} } = await chrome.storage.local.get('uiTemplates');
  const list = $('saved');
  list.textContent = '';
  const rows = [];
  for (const host of Object.keys(uiTemplates).sort()) {
    for (const key of Object.keys(uiTemplates[host]).sort()) rows.push([host, key, uiTemplates[host][key]]);
  }
  if (!rows.length) {
    const li = document.createElement('li');
    li.textContent = 'None yet';
    list.appendChild(li);
  }
  for (const [host, key, t] of rows) {
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = `${t.method} ${t.path}`;
    li.append(`${host} · ${key === '*' ? 'any module' : key} · ${MODE_LABELS[t.mode] || t.mode} · `, code);
    const btn = document.createElement('button');
    btn.textContent = 'Remove';
    btn.addEventListener('click', async () => {
      delete uiTemplates[host][key];
      if (!Object.keys(uiTemplates[host]).length) delete uiTemplates[host];
      await chrome.storage.local.set({ uiTemplates });
      load();
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

$('save').addEventListener('click', async () => {
  let captured;
  try {
    captured = parseCopiedFetch($('paste').value);
  } catch (e) {
    setStatus(e.message, false);
    return;
  }
  const url = new URL(captured.url);
  if (!/\.(freshsales\.io|myfreshworks\.com)$/.test(url.host)) {
    setStatus('That request is not to a *.freshsales.io or *.myfreshworks.com address.', false);
    return;
  }
  const template = buildTemplate(captured);
  if (!template) {
    setStatus("That doesn't look like a delete request. Copy the one sent when you clicked Delete forever.", false);
    return;
  }
  const key = moduleKeyFromPath(url.pathname) || moduleKeyFromPath(new URL(captured.headers.referer || url).pathname) || '*';
  const { uiTemplates = {} } = await chrome.storage.local.get('uiTemplates');
  uiTemplates[url.host] = { ...(uiTemplates[url.host] || {}), [key]: template };
  await chrome.storage.local.set({ uiTemplates });
  $('paste').value = '';
  setStatus(`Saved for ${key === '*' ? 'any module' : key}: ${MODE_LABELS[template.mode]}.`, true);
  load();
});

load();
