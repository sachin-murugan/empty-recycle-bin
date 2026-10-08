const $ = (id) => document.getElementById(id);

function normalizeHost(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .toLowerCase();
}

async function load() {
  const { apiKeys = {} } = await chrome.storage.local.get('apiKeys');
  const list = $('saved');
  list.textContent = '';
  const hosts = Object.keys(apiKeys).sort();
  if (!hosts.length) {
    const li = document.createElement('li');
    li.textContent = 'None';
    list.appendChild(li);
  }
  for (const host of hosts) {
    const li = document.createElement('li');
    li.textContent = host;
    const btn = document.createElement('button');
    btn.textContent = 'Remove';
    btn.addEventListener('click', async () => {
      delete apiKeys[host];
      await chrome.storage.local.set({ apiKeys });
      load();
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

$('save').addEventListener('click', async () => {
  const host = normalizeHost($('host').value);
  const key = $('key').value.trim();
  if (!/\.(freshsales\.io|myfreshworks\.com)$/.test(host) || !key) {
    $('status').textContent = 'Enter a *.freshsales.io or *.myfreshworks.com domain and a key.';
    return;
  }
  const { apiKeys = {} } = await chrome.storage.local.get('apiKeys');
  apiKeys[host] = key;
  await chrome.storage.local.set({ apiKeys });
  $('key').value = '';
  $('status').textContent = 'Saved';
  setTimeout(() => ($('status').textContent = ''), 1500);
  load();
});

load();
