// Same-origin HTTP client used from the content script. Ported from fs-list-view-exporter's
// client.js, extended with DELETE for the forget calls.
//
// Auth: by default requests ride on the user's logged-in browser session (cookies are
// sent automatically because the content script fetches from the CRM's own origin).
// Writes over the session also send the page's CSRF token, as the web app does.
// If the user saved an API key in the options page, it's sent as
// `Authorization: Token token=...` instead.
(function (root) {
  const FSX = (root.FSX = root.FSX || {});
  const { pathStyleFor, otherStyle, joinPrefix } = FSX.platform;

  const MAX_RETRIES = 5;

  class HttpError extends Error {
    constructor(status, method, path, body, { json = false } = {}) {
      super(`HTTP ${status} ${method} ${path}: ${String(body || '').slice(0, 300)}`);
      this.status = status;
      this.method = method;
      this.path = path;
      // True when the server answered with JSON, i.e. the API itself replied (vs an HTML web route).
      this.json = json;
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Retry-After header (seconds or HTTP date) in ms, or null when absent/unparseable. */
  function parseRetryAfter(value, now = Date.now()) {
    if (value === null || value === undefined || value === '') return null;
    const s = String(value).trim();
    if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
    const at = Date.parse(s);
    return Number.isNaN(at) ? null : Math.max(0, at - now);
  }

  function uniq(items) {
    return [...new Set(items)];
  }

  function parseJson(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (_e) {
      return { ok: false };
    }
  }

  class CRMClient {
    constructor({ host, apiKey, csrfToken, fetchImpl, origin, sleepImpl } = {}) {
      this.host = host;
      this.origin = origin || `https://${host}`;
      this.style = pathStyleFor(host);
      this.apiKey = (apiKey || '').trim();
      this.csrfToken = (csrfToken || '').trim();
      this.fetch = fetchImpl || root.fetch.bind(root);
      this.retryDelay = (attempt, cap) => Math.min(2 ** attempt, cap) * 1000;
      this.sleep = sleepImpl || sleep;
    }

    get platformLabel() {
      return this.style.label;
    }

    headers(method) {
      const h = { Accept: 'application/json' };
      if (this.apiKey) h.Authorization = `Token token=${this.apiKey}`;
      else if (method !== 'GET' && this.csrfToken) h['X-CSRF-Token'] = this.csrfToken;
      return h;
    }

    async request(method, path, params) {
      const url = new URL(path.startsWith('/') ? path : `/${path}`, this.origin);
      for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));

      let lastErr;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        let resp;
        try {
          resp = await this.fetch(url.toString(), {
            method,
            credentials: 'include',
            headers: this.headers(method),
          });
        } catch (err) {
          lastErr = err;
          if (attempt < MAX_RETRIES) {
            await this.sleep(this.retryDelay(attempt, 15));
            continue;
          }
          throw new Error(`${method} ${path} failed: ${err.message}`);
        }
        if (resp.status === 429) {
          lastErr = new HttpError(429, method, path, 'rate limited', { json: true });
          if (attempt === MAX_RETRIES) break;
          const retryAfter = parseRetryAfter(resp.headers && resp.headers.get('Retry-After'));
          await this.sleep(retryAfter !== null ? retryAfter : this.retryDelay(attempt, 30));
          continue;
        }
        if (resp.status >= 500 && attempt < MAX_RETRIES) {
          lastErr = new HttpError(resp.status, method, path, '');
          await this.sleep(this.retryDelay(attempt, 20));
          continue;
        }
        if (resp.status === 304 || resp.status === 204) return {};
        const text = await resp.text();
        const parsed = text.trim() ? parseJson(text) : { ok: true, value: {} };
        if (!resp.ok) throw new HttpError(resp.status, method, path, text, { json: parsed.ok && !!text.trim() });
        if (parsed.ok) return parsed.value;
        // An HTML page usually means we hit a web route or a login redirect, not the API.
        throw new HttpError(404, method, path, 'non-JSON response');
      }
      throw new Error(`${method} ${path} failed: ${lastErr && lastErr.message}`);
    }

    get(path, params) {
      return this.request('GET', path, params);
    }

    delete(path, params) {
      return this.request('DELETE', path, params);
    }

    /**
     * Try GET paths in order, skipping 4xx; return { data, path } for the first that works.
     * `accept(data)` can reject a 200 whose body isn't the expected shape (try the next path).
     */
    async getFirst(paths, params, { accept } = {}) {
      const errors = [];
      for (const path of paths) {
        let data;
        try {
          data = await this.get(path, params);
        } catch (err) {
          errors.push(err.message);
          if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) continue;
          throw err;
        }
        if (accept && !accept(data)) {
          errors.push(`Unexpected response from ${path}`);
          continue;
        }
        return { data, path };
      }
      throw new Error('All paths failed:\n  ' + errors.slice(0, 12).join('\n  '));
    }

    apiPaths(suffix) {
      const prefixes = uniq([...this.style.apiFallbacks, ...otherStyle(this.style).apiFallbacks]);
      return prefixes.map((p) => joinPrefix(p, suffix));
    }

    /** API prefixes in the order apiPaths uses them (for remembering the one that worked). */
    apiPrefixes() {
      return uniq([...this.style.apiFallbacks, ...otherStyle(this.style).apiFallbacks]);
    }
  }

  FSX.client = { CRMClient, HttpError, parseRetryAfter };
})(globalThis);
