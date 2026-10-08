// Turns a "Delete forever" request the Freshsales web app made (pasted from DevTools with
// "Copy as fetch" in the options page) into a template, and replays it for other record ids.
// This lets the extension delete through the same internal endpoint the UI uses, instead of
// the public /api routes and their hourly limit.
(function (root) {
  const FSX = (root.FSX = root.FSX || {});

  const BULK_SIZE = 100;

  // Keys that hold the view/filter being looked at, never the records to delete.
  const NOT_RECORD_KEY = /(view|filter|segment|page|per_page|module|owner|user|account_id$)/i;
  const RECORD_ID_KEY = /^(id|ids|selected_ids|record_ids|entity_ids|[a-z_]*_ids|[a-z_]*_id)$/i;
  const isIdLike = (v) => (typeof v === 'number' && Number.isInteger(v) && v > 0) || (typeof v === 'string' && /^\d{3,}$/.test(v));
  const isIdArray = (v) => Array.isArray(v) && v.length > 0 && v.every(isIdLike);

  // Headers worth replaying. Cookies ride along automatically and the CSRF token is read fresh
  // from the page at replay time, so neither is stored.
  const KEEP_HEADERS = /^(content-type|accept|x-requested-with)$/i;

  function keepHeaders(headers) {
    const out = {};
    for (const [k, v] of Object.entries(headers || {})) if (KEEP_HEADERS.test(k)) out[k.toLowerCase()] = String(v);
    return out;
  }

  /** Walk a JSON value; return paths (arrays of keys) to id arrays and to single id fields. */
  function findIdSlots(value, path = [], out = { arrays: [], scalars: [] }) {
    const key = path.length ? String(path[path.length - 1]) : '';
    if (key && NOT_RECORD_KEY.test(key) && !/^(selected_ids|ids|id)$/i.test(key)) return out;
    if (isIdArray(value)) {
      out.arrays.push(path);
      return out;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) findIdSlots(v, [...path, k], out);
      return out;
    }
    if (isIdLike(value) && RECORD_ID_KEY.test(key)) out.scalars.push(path);
    return out;
  }

  function parseBody(body, contentType) {
    if (body === null || body === undefined || body === '') return { kind: 'none', value: null };
    const text = String(body);
    if (/json/i.test(contentType || '') || /^\s*[[{]/.test(text)) {
      try {
        return { kind: 'json', value: JSON.parse(text) };
      } catch (_e) {
        /* fall through */
      }
    }
    if (/x-www-form-urlencoded/i.test(contentType || '') || /^[\w%[\].-]+=/.test(text)) {
      return { kind: 'form', value: [...new URLSearchParams(text)] };
    }
    return { kind: 'text', value: text };
  }

  /** Form/query pairs: keys like ids[] / selected_ids[] repeated, or a single id=. */
  function formIdKeys(pairs) {
    const counts = {};
    for (const [k, v] of pairs) if (isIdLike(v) && !NOT_RECORD_KEY.test(k.replace(/\[\]$/, ''))) counts[k] = (counts[k] || 0) + 1;
    const keys = Object.keys(counts).filter((k) => /\[\]$/.test(k) || RECORD_ID_KEY.test(k) || counts[k] > 1);
    return keys;
  }

  /**
   * Build a replay template from a captured request { method, url, headers, body }.
   * mode is 'bulk' (ids in an array/list, replayed in batches), 'single' (one id in the path or
   * body, replayed per record) or 'view' (no record ids at all: the UI acted on the whole view,
   * so it is replayed once). Returns null when the request can't be replayed.
   */
  function buildTemplate(captured) {
    if (!captured || !captured.url || !captured.method || captured.method.toUpperCase() === 'GET') return null;
    const url = new URL(captured.url);
    const headers = keepHeaders(captured.headers);
    const body = parseBody(captured.body, headers['content-type']);
    if (body.kind === 'text') return null;

    const segments = url.pathname.split('/');
    const pathIdIndex = segments.findIndex((s, i) => /^\d{3,}$/.test(s) && segments[i - 1] !== 'view');
    const query = [...url.searchParams];
    const queryIdKeys = formIdKeys(query);

    let bodySlots = { arrays: [], scalars: [] };
    let formKeys = [];
    if (body.kind === 'json') bodySlots = findIdSlots(body.value);
    if (body.kind === 'form') formKeys = formIdKeys(body.value);

    const bulk =
      bodySlots.arrays.length > 0 ||
      formKeys.some((k) => /\[\]$/.test(k)) ||
      queryIdKeys.some((k) => /\[\]$/.test(k)) ||
      (body.kind === 'form' && body.value.filter(([k]) => formKeys.includes(k)).length > 1);
    const single = !bulk && (pathIdIndex >= 0 || bodySlots.scalars.length > 0 || formKeys.length > 0 || queryIdKeys.length > 0);

    return {
      method: captured.method.toUpperCase(),
      origin: url.origin,
      path: url.pathname,
      query,
      queryIdKeys,
      pathIdIndex: single ? pathIdIndex : -1,
      headers,
      body,
      bodySlots,
      formKeys,
      mode: bulk ? 'bulk' : single ? 'single' : 'view',
      capturedAt: captured.at || Date.now(),
      viewId: captured.viewId || null,
    };
  }

  function setAt(obj, path, value) {
    let o = obj;
    for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
    o[path[path.length - 1]] = value;
  }

  function getAt(obj, path) {
    return path.reduce((o, k) => (o == null ? o : o[k]), obj);
  }

  // Keep the UI's id type: numbers stay numbers, strings stay strings.
  const likeOriginal = (sample, id) => (typeof sample === 'number' ? Number(id) : String(id));

  function fillPairs(pairs, keys, ids) {
    const out = [];
    const done = new Set();
    for (const [k, v] of pairs) {
      if (!keys.includes(k)) {
        out.push([k, v]);
        continue;
      }
      if (done.has(k)) continue;
      done.add(k);
      for (const id of ids) out.push([k, String(id)]);
    }
    return out;
  }

  /** One request ({ method, url, headers, body }) for this set of ids. */
  function fill(template, ids, csrfToken) {
    const segments = template.path.split('/');
    if (template.pathIdIndex >= 0) segments[template.pathIdIndex] = String(ids[0]);
    const url = new URL(segments.join('/'), template.origin);
    for (const [k, v] of fillPairs(template.query, template.queryIdKeys, ids)) url.searchParams.append(k, v);

    let body = null;
    if (template.body.kind === 'json') {
      const value = JSON.parse(JSON.stringify(template.body.value));
      for (const p of template.bodySlots.arrays) {
        const sample = getAt(value, p)[0];
        if (p.length) setAt(value, p, ids.map((id) => likeOriginal(sample, id)));
      }
      for (const p of template.bodySlots.scalars) setAt(value, p, likeOriginal(getAt(value, p), ids[0]));
      // A body that is itself the id array (e.g. "[1,2,3]").
      body = JSON.stringify(template.bodySlots.arrays.some((p) => !p.length) ? ids.map((id) => likeOriginal(template.body.value[0], id)) : value);
    } else if (template.body.kind === 'form') {
      body = new URLSearchParams(fillPairs(template.body.value, template.formKeys, ids)).toString();
    }

    const headers = { ...template.headers };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    return { method: template.method, url: url.toString(), headers, body };
  }

  /** All requests needed to delete `ids`, in order. */
  function plan(template, ids, { csrfToken, bulkSize = BULK_SIZE } = {}) {
    if (template.mode === 'view') return [fill(template, [], csrfToken)];
    if (template.mode === 'single') return ids.map((id) => ({ ...fill(template, [id], csrfToken), ids: [id] }));
    const out = [];
    for (let i = 0; i < ids.length; i += bulkSize) {
      const batch = ids.slice(i, i + bulkSize);
      out.push({ ...fill(template, batch, csrfToken), ids: batch });
    }
    return out;
  }

  /**
   * Parse what Chrome DevTools gives for Network > right-click > Copy > Copy as fetch:
   *   fetch("https://acme.myfreshworks.com/crm/sales/...", { "headers": {...}, "body": "...", "method": "POST", ... });
   * The second argument is JSON, so it's parsed as data (never evaluated). Cookies are dropped.
   * Returns { method, url, headers, body } or throws with a message for the options page.
   */
  function parseCopiedFetch(text) {
    const src = String(text || '').trim();
    const m = src.match(/^(?:await\s+)?fetch\(\s*("(?:[^"\\]|\\.)*")\s*,\s*([\s\S]*)\)\s*;?\s*$/);
    if (!m) throw new Error('Paste the request exactly as DevTools copies it ("Copy as fetch").');
    let url;
    let init;
    try {
      url = JSON.parse(m[1]);
      init = JSON.parse(m[2]);
    } catch (_e) {
      throw new Error('Could not read that request. Use "Copy as fetch", not "Copy as fetch (Node.js)" or cURL.');
    }
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) if (!/^cookie$/i.test(k)) headers[k] = v;
    return { method: String(init.method || 'GET').toUpperCase(), url, headers, body: init.body == null ? null : String(init.body) };
  }

  FSX.uiRequest = { buildTemplate, plan, fill, parseCopiedFetch, BULK_SIZE };
})(globalThis);
