// Runs on Freshsales / Freshworks CRM pages. Detects the open recycle bin view, and on request
// reads every record in it with the user's session, asks for confirmation in the page and
// then permanently deletes ("forgets") each record.
(function () {
  const { parseRecycleBinUrl } = FSX.platform;
  const { CRMClient, RateLimitError } = FSX.client;
  const { RecycleBin } = FSX.recycleBin;
  const { confirmForget } = FSX.confirmDialog;

  const MODULE_LABELS = {
    contact: 'Contacts',
    deal: 'Deals',
    sales_account: 'Accounts',
    lead: 'Leads',
  };

  let running = null; // { aborted } while a run is in flight

  function report(state) {
    chrome.runtime.sendMessage({ type: 'ERB_STATE', state }).catch(() => {});
  }

  async function apiKeyFor(host) {
    try {
      const { apiKeys = {} } = await chrome.storage.local.get('apiKeys');
      return apiKeys[host] || '';
    } catch (_e) {
      return '';
    }
  }

  function csrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return (meta && meta.getAttribute('content')) || '';
  }

  async function makeBin(host, clientOptions = {}) {
    return new RecycleBin(
      new CRMClient({
        host,
        apiKey: await apiKeyFor(host),
        csrfToken: csrfToken(),
        origin: location.origin,
        ...clientOptions,
      })
    );
  }

  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  function rateLimitMessage(err) {
    const when = err.retryAfterMs ? ` Try again after ${clock(Date.now() + err.retryAfterMs)}.` : ' Try again in a few minutes.';
    return `Freshsales' hourly API limit is used up for this account.${when}`;
  }

  const moduleLabel = (view) => MODULE_LABELS[view.entity] || view.entity;

  async function detect() {
    const view = parseRecycleBinUrl(location.href);
    if (!view) return { ok: true, view: null };
    // The popup waits on this, so never sit out a rate limit here: fail fast and say why.
    const bin = await makeBin(view.host, { maxRetries: 2, maxWaitMs: 0, timeoutMs: 15_000 });
    try {
      Object.assign(view, await bin.resolveView(view), { moduleLabel: moduleLabel(view) });
    } catch (err) {
      if (err instanceof RateLimitError) return { ok: false, error: rateLimitMessage(err), running: !!running };
      throw err;
    }
    return { ok: true, view, running: !!running };
  }

  async function run() {
    if (running) return { ok: false, error: 'Already running in this tab.' };
    const view = parseRecycleBinUrl(location.href);
    if (!view) return { ok: false, error: 'Open the recycle bin of a module (e.g. Contacts) first.' };

    running = { aborted: false };
    const signal = running;
    const log = (msg) => console.debug('[Empty Recycle Bin]', msg);
    let lastProgress = '';
    const onPause = (resumeAt) => {
      const msg = `Freshsales API limit reached. Waiting until ${clock(resumeAt)}, then carrying on. Keep this tab open.`;
      log(msg);
      report({ status: 'running', message: lastProgress ? `${lastProgress}. ${msg}` : msg, paused: true });
    };
    try {
      report({ status: 'running', message: 'Checking the view…', done: 0 });
      const bin = await makeBin(view.host);
      const resolved = await bin.withPause(() => bin.resolveView(view), { signal, onPause });
      // Safety gate: never forget records from a view that isn't the recycle bin.
      if (!resolved.isRecycleBin) {
        const msg = 'This view is not the recycle bin, so nothing was deleted.';
        report({ status: 'error', message: msg });
        return { ok: false, error: msg };
      }

      const records = await bin.fetchRecords(view, resolved.viewId, {
        log,
        signal,
        onPause,
        onProgress: (p) =>
          report({
            status: 'running',
            message: `Reading the recycle bin: ${p.fetched} records (page ${p.page}${p.totalPages ? ` of ${p.totalPages}` : ''})`,
            done: p.page,
            total: p.totalPages,
          }),
      });

      if (!records.length) {
        report({ status: 'done', message: 'The recycle bin is already empty.' });
        return { ok: true, count: 0 };
      }

      report({ status: 'running', message: 'Confirm in the Freshsales tab…', done: 0 });
      const confirmed = await confirmForget({ records, viewName: resolved.viewName, moduleLabel: moduleLabel(view) });
      if (!confirmed || signal.aborted) {
        report({ status: 'done', message: 'Cancelled. Nothing was deleted.' });
        return { ok: true, count: 0, cancelled: true };
      }

      const result = await bin.forgetRecords(view, records, {
        log,
        signal,
        onPause,
        onProgress: (p) => {
          lastProgress = `Deleted ${p.done} of ${p.total}${p.failed ? ` (${p.failed} failed)` : ''}`;
          report({ status: 'running', message: lastProgress, done: p.done, total: p.total });
        },
      });

      const deleted = result.forgotten.length + result.gone.length;
      log(`Forgotten: ${result.forgotten.join(', ') || 'none'}`);
      if (result.gone.length) log(`Already gone: ${result.gone.join(', ')}`);
      if (result.failed.length) console.warn('[Empty Recycle Bin] Failed:', result.failed);
      const parts = [`Permanently deleted ${deleted} of ${records.length} records.`];
      if (result.failed.length) parts.push(`${result.failed.length} failed; ids are in the page console.`);
      if (result.cancelled) parts.push('Stopped early.');
      report({ status: result.failed.length ? 'error' : 'done', message: parts.join(' ') });
      return { ok: true, count: deleted };
    } catch (err) {
      if (signal.aborted && /Cancelled/.test(String(err && err.message))) {
        report({ status: 'done', message: 'Stopped.' });
        return { ok: true, cancelled: true };
      }
      const message = err && err.message ? err.message : String(err);
      log(message);
      report({ status: 'error', message: friendlyError(message) });
      return { ok: false, error: friendlyError(message) };
    } finally {
      running = null;
    }
  }

  function friendlyError(message) {
    if (/HTTP 401|HTTP 403/.test(message)) {
      return 'Freshsales refused the request. Make sure you are logged in with permission to delete records, or add an API key in the extension options.';
    }
    if (/HTTP 422.*(csrf|authenticity)/i.test(message)) {
      return 'Freshsales rejected the session for deletes. Reload the tab, or add an API key in the extension options.';
    }
    if (/All paths failed|No forget endpoint/.test(message)) {
      return 'Could not reach the Freshsales API for this account. Details are in the page console.';
    }
    return message;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return false;
    if (msg.type === 'ERB_DETECT') {
      detect().then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    if (msg.type === 'ERB_RUN') {
      // Respond immediately; progress arrives via ERB_STATE so the popup can close safely.
      run();
      sendResponse({ ok: true, started: true });
      return false;
    }
    if (msg.type === 'ERB_CANCEL') {
      if (running) running.aborted = true;
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();
