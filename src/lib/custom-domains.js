// Custom domains, for Freshworks CRM accounts served from your own address such as
// https://crm.example.com/crm/sales/contacts/view/123.
//
// The Freshworks domains in the manifest's host_permissions work out of the box. Any
// other host has to be allowed once: the popup offers an "Enable on <host>" button,
// which asks Chrome for that one origin (an optional host permission). Once it is
// granted, the service worker registers the manifest's first content script for it, so
// the extension attaches there exactly as it does on the built-in domains.
(function (root) {
  const FSX = (root.FSX = root.FSX || {});

  const SCRIPT_ID = 'fsx-custom-domains';
  const DEFAULT_SUFFIXES = ['freshsales.io', 'myfreshworks.com', 'freshworks.com'];

  /** Domain suffixes covered by the manifest, e.g. ['freshsales.io', 'myfreshworks.com']. */
  function builtInSuffixes() {
    try {
      const perms = chrome.runtime.getManifest().host_permissions || [];
      const out = perms.map((p) => (/^https:\/\/\*\.([^/]+)\/\*$/.exec(p) || [])[1]).filter(Boolean);
      return out.length ? out : DEFAULT_SUFFIXES;
    } catch (_e) {
      return DEFAULT_SUFFIXES;
    }
  }

  function isBuiltInHost(host, suffixes = builtInSuffixes()) {
    const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
    return suffixes.some((s) => h === s || h.endsWith(`.${s}`));
  }

  /** A Freshworks CRM page on a custom domain lives under /crm/sales. */
  function looksLikeCrmUrl(href) {
    try {
      const u = new URL(href);
      return u.protocol === 'https:' && /^\/crm\/sales(\/|$)/.test(u.pathname);
    } catch (_e) {
      return false;
    }
  }

  function isValidHost(host) {
    return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?(:\d{1,5})?$/i.test(
      String(host || '')
    );
  }

  function originPattern(hostname) {
    return `https://${hostname}/*`;
  }

  /** 'https://crm.example.com/*' -> 'crm.example.com'; wildcards and other shapes -> null. */
  function hostFromPattern(pattern) {
    const m = /^https:\/\/([^/*:]+)\/\*$/.exec(String(pattern || ''));
    return m ? m[1].toLowerCase() : null;
  }

  async function grantedHosts() {
    const { origins = [] } = await chrome.permissions.getAll();
    return [...new Set(origins.map(hostFromPattern).filter((h) => h && !isBuiltInHost(h)))];
  }

  function mainContentScript() {
    const cs = chrome.runtime.getManifest().content_scripts[0];
    return { js: cs.js || [], css: cs.css || [], runAt: cs.run_at || 'document_idle' };
  }

  // Install, startup and permission events can fire together; run syncs one at a time.
  let syncQueue = Promise.resolve();

  /** Make the registered content script cover exactly the custom hosts the user has allowed. */
  function syncContentScripts() {
    const run = syncQueue.then(syncNow, syncNow);
    syncQueue = run.catch(() => {});
    return run;
  }

  async function syncNow() {
    const hosts = await grantedHosts();
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    if (!hosts.length) return hosts;
    const cs = mainContentScript();
    const script = {
      id: SCRIPT_ID,
      matches: hosts.map(originPattern),
      js: cs.js,
      runAt: cs.runAt,
      persistAcrossSessions: true,
    };
    if (cs.css.length) script.css = cs.css;
    await chrome.scripting.registerContentScripts([script]);
    return hosts;
  }

  /** Attach the content script to an already-open tab, once. */
  async function injectInto(tabId) {
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (globalThis.__fsxCustomDomainInjected) return true;
        globalThis.__fsxCustomDomainInjected = true;
        return false;
      },
    });
    if (probe && probe.result) return;
    const cs = mainContentScript();
    try {
      if (cs.css.length) await chrome.scripting.insertCSS({ target: { tabId }, files: cs.css });
      await chrome.scripting.executeScript({ target: { tabId }, files: cs.js });
    } catch (e) {
      await chrome.scripting
        .executeScript({ target: { tabId }, func: () => delete globalThis.__fsxCustomDomainInjected })
        .catch(() => {});
      throw e;
    }
  }

  /** Attach to open tabs on newly allowed hosts (service worker, permissions.onAdded). */
  async function injectIntoOpenTabs(origins) {
    const hosts = (origins || []).map(hostFromPattern).filter((h) => h && !isBuiltInHost(h));
    if (!hosts.length) return;
    const tabs = await chrome.tabs.query({ url: hosts.map(originPattern) });
    await Promise.all(tabs.map((t) => injectInto(t.id).catch(() => {})));
  }

  /**
   * What the popup can do with this tab:
   *   builtin           a manifest domain, the content script is already there
   *   custom            a custom domain the user has allowed
   *   needs-permission  looks like Freshworks CRM (/crm/sales) on a host not allowed yet
   *   unsupported       anything else
   */
  async function tabAccess(tab) {
    const url = (tab && tab.url) || '';
    let hostname = '';
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch (_e) {}
    if (!hostname || !url.startsWith('https://')) return { kind: 'unsupported', host: hostname };
    if (isBuiltInHost(hostname)) return { kind: 'builtin', host: hostname };
    if (await chrome.permissions.contains({ origins: [originPattern(hostname)] })) {
      return { kind: 'custom', host: hostname };
    }
    return { kind: looksLikeCrmUrl(url) ? 'needs-permission' : 'unsupported', host: hostname };
  }

  /** tabs.sendMessage that attaches the content script first if a custom-domain tab lacks it. */
  async function sendToTab(tabId, message, access) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
      if (!access || access.kind !== 'custom') throw e;
      await injectInto(tabId);
      return chrome.tabs.sendMessage(tabId, message);
    }
  }

  // Popup helpers. permissions.request must run straight from the click (user gesture).
  function offerEnable(hintEl, host) {
    hintEl.textContent = `Is ${host} your Freshsales account? Allow the extension on this domain to use it here.`;
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = `Enable on ${host}`;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      let granted = false;
      try {
        granted = await chrome.permissions.request({ origins: [originPattern(host)] });
      } catch (_e) {}
      if (granted) {
        location.reload();
      } else {
        btn.disabled = false;
        hintEl.textContent = `Access to ${host} wasn't granted, so the extension can't run there.`;
      }
    });
    hintEl.after(btn);
  }

  function addForgetLink(parentEl, host) {
    const p = document.createElement('p');
    p.className = 'muted';
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = `Stop using on ${host}`;
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        await chrome.permissions.remove({ origins: [originPattern(host)] });
      } catch (_e) {}
      window.close();
    });
    p.append('Custom domain. ', a);
    parentEl.appendChild(p);
  }

  /** Service-worker wiring: keep registrations in step with granted hosts. */
  function installBackgroundHandlers() {
    const sync = () => syncContentScripts().catch(() => {});
    chrome.runtime.onInstalled.addListener(sync);
    chrome.runtime.onStartup.addListener(sync);
    chrome.permissions.onAdded.addListener(async (perms) => {
      await sync();
      injectIntoOpenTabs(perms.origins).catch(() => {});
    });
    chrome.permissions.onRemoved.addListener(sync);
  }

  FSX.customDomains = {
    builtInSuffixes,
    isBuiltInHost,
    looksLikeCrmUrl,
    isValidHost,
    originPattern,
    hostFromPattern,
    grantedHosts,
    syncContentScripts,
    injectInto,
    injectIntoOpenTabs,
    tabAccess,
    sendToTab,
    offerEnable,
    addForgetLink,
    installBackgroundHandlers,
  };
})(globalThis);
