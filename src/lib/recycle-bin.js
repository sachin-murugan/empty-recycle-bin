// Reads the records in a module's recycle bin view and permanently deletes ("forgets") them.
// Paging and path fallbacks follow fs-list-view-exporter's fetcher.js.
(function (root) {
  const FSX = (root.FSX = root.FSX || {});
  const { isRecycleBinName } = FSX.platform;
  const { HttpError } = FSX.client;

  const PER_PAGE = 100;
  const FORGET_CONCURRENCY = 4;

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const hasId = (r) => isObj(r) && r.id !== null && r.id !== undefined;

  /** Run `worker` over `items` with at most `limit` in flight; results keep input order. */
  async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const run = async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i], i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, run));
    return results;
  }

  function recordsFromPage(data, primaryKey, entity) {
    if (!data || typeof data !== 'object') return [];
    const candidates = [primaryKey, entity, entity && !entity.endsWith('s') ? `${entity}s` : entity, 'records', 'results'];
    for (const key of new Set(candidates)) {
      if (key && Array.isArray(data[key]) && data[key].length) return data[key];
    }
    if (Array.isArray(data.data) && data.data.length && typeof data.data[0] === 'object') return data.data;
    return [];
  }

  /** Short human label for the confirmation preview. */
  function recordLabel(r) {
    const full = [r.first_name, r.last_name].filter(Boolean).join(' ');
    return r.display_name || r.name || full || r.email || `#${r.id}`;
  }

  function uniq(items) {
    return [...new Set(items)];
  }

  // A 404 that isn't JSON, or a 405, means this prefix has no such route: try the next one.
  const isMissingRoute = (err) => err instanceof HttpError && ((err.status === 404 && !err.json) || err.status === 405);
  // A JSON 404 from the API means the route exists but the record is already gone.
  const isAlreadyGone = (err) => err instanceof HttpError && err.status === 404 && err.json;

  class RecycleBin {
    constructor(client) {
      this.client = client;
      this.forgetPrefix = null; // API prefix whose forget route answered, once known
    }

    viewPaths(mod, viewId) {
      if (mod.custom) {
        return uniq([
          ...this.client.apiPaths(`custom_module/${mod.entity}/view/${viewId}`),
          `/custom_module/${mod.entity}/view/${viewId}`,
        ]);
      }
      return uniq([...this.client.apiPaths(`${mod.endpoint}/view/${viewId}`), `/${mod.endpoint}/view/${viewId}`]);
    }

    /** Saved views for a module as [{ id, name }]. */
    async fetchViews(mod) {
      const paths = mod.custom
        ? [...this.client.apiPaths(`${mod.entity}/filters`), `/${mod.entity}/filters`, `/api/${mod.entity}/filters`]
        : [...this.client.apiPaths(`${mod.endpoint}/filters`), `/${mod.endpoint}/filters`];
      const { data } = await this.client.getFirst(uniq(paths), undefined, {
        accept: (d) => isObj(d) && (Array.isArray(d.filters) || Array.isArray(d.data)),
      });
      const list = Array.isArray(data.filters) ? data.filters : data.data;
      return list.map((f) => ({ id: String(f.id), name: f.name }));
    }

    /**
     * Resolve the open page to { viewId, viewName, isRecycleBin }. A URL without a view id
     * (a dedicated recycle bin route) is matched to the module's view named like "Recycle Bin".
     */
    async resolveView(mod) {
      let views = [];
      try {
        views = await this.fetchViews(mod);
      } catch (_e) {
        // Without the view list we can't confirm the name, so the caller refuses to delete.
      }
      if (mod.viewId) {
        const match = views.find((v) => v.id === String(mod.viewId));
        const viewName = match ? match.name : null;
        return { viewId: String(mod.viewId), viewName, isRecycleBin: isRecycleBinName(viewName) };
      }
      const bin = views.find((v) => isRecycleBinName(v.name));
      if (!bin) return { viewId: null, viewName: null, isRecycleBin: false };
      return { viewId: bin.id, viewName: bin.name, isRecycleBin: true };
    }

    listParams(page) {
      return { page, per_page: PER_PAGE, sort: 'id', sort_type: 'asc' };
    }

    /**
     * Every record in the view as [{ id, label }]. All ids are collected before anything is
     * deleted, so removing records can't shift the pages being read.
     * `onProgress({ page, fetched, totalPages })` is called per page.
     */
    async fetchRecords(mod, viewId, { log = () => {}, onProgress = () => {}, signal } = {}) {
      log(`Platform: ${this.client.platformLabel}`);
      let paths = this.viewPaths(mod, viewId);
      const seen = new Set();
      const all = [];
      let page = 1;
      for (;;) {
        if (signal && signal.aborted) throw new Error('Cancelled');
        const { data, path } = await this.client.getFirst(paths, this.listParams(page));
        // Stick with the path that worked so later pages don't re-probe the fallbacks.
        paths = [path];

        const records = recordsFromPage(data, mod.custom ? mod.entity : mod.endpoint, mod.entity);
        if (!records.length) break;
        for (const r of records) {
          if (!hasId(r) || seen.has(String(r.id))) continue;
          seen.add(String(r.id));
          all.push({ id: String(r.id), label: recordLabel(r) });
        }

        const meta = (data && data.meta) || {};
        const totalPages = Number(meta.total_pages) || 0;
        onProgress({ page, fetched: all.length, totalPages });
        log(`Page ${page}${totalPages ? `/${totalPages}` : ''}: +${records.length} (total ${all.length})`);

        page += 1;
        if (totalPages && page > totalPages) break;
        if (records.length < PER_PAGE) break;
      }
      return all;
    }

    forgetSuffix(mod, id) {
      return mod.custom ? `custom_module/${mod.entity}/${id}/forget` : `${mod.endpoint}/${id}/forget`;
    }

    /** DELETE …/<id>/forget, trying API prefixes until one has the route. Returns 'forgotten' or 'gone'. */
    async forgetOne(mod, id) {
      const suffix = this.forgetSuffix(mod, id);
      const prefixes = this.forgetPrefix !== null ? [this.forgetPrefix] : this.client.apiPrefixes();
      const errors = [];
      for (const prefix of prefixes) {
        const path = FSX.platform.joinPrefix(prefix, suffix);
        try {
          await this.client.delete(path);
          this.forgetPrefix = prefix;
          return 'forgotten';
        } catch (err) {
          if (isAlreadyGone(err)) {
            this.forgetPrefix = prefix;
            return 'gone';
          }
          if (isMissingRoute(err) && this.forgetPrefix === null) {
            errors.push(err.message);
            continue;
          }
          throw err;
        }
      }
      const e = new Error('No forget endpoint answered:\n  ' + errors.join('\n  '));
      e.noRoute = true;
      throw e;
    }

    /**
     * Forget every record. The first one runs alone to find the working API prefix; if no
     * prefix has the forget route, this throws before touching anything else.
     * Returns { forgotten: [id], gone: [id], failed: [{ id, error }] }.
     */
    async forgetRecords(
      mod,
      records,
      { log = () => {}, onProgress = () => {}, signal, concurrency = FORGET_CONCURRENCY } = {}
    ) {
      const result = { forgotten: [], gone: [], failed: [] };
      const total = records.length;
      let done = 0;
      const one = async (rec) => {
        if (signal && signal.aborted) return;
        try {
          const outcome = await this.forgetOne(mod, rec.id);
          result[outcome === 'gone' ? 'gone' : 'forgotten'].push(rec.id);
        } catch (err) {
          if (err.noRoute) throw err;
          log(`Forget failed for id ${rec.id}: ${err.message}`);
          result.failed.push({ id: rec.id, error: err.message });
        }
        done += 1;
        onProgress({ done, total, failed: result.failed.length });
      };
      if (!total) return result;
      await one(records[0]);
      if (this.forgetPrefix === null) {
        // The first call failed without revealing a working route; don't hammer the rest.
        throw new Error(`Could not forget record ${records[0].id}: ${result.failed[0].error}`);
      }
      await mapWithConcurrency(records.slice(1), concurrency, one);
      if (signal && signal.aborted) result.cancelled = true;
      return result;
    }
  }

  FSX.recycleBin = { RecycleBin, recordsFromPage, recordLabel, mapWithConcurrency };
})(globalThis);
