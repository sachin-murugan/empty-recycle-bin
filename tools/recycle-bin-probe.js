// Freshsales recycle bin probe. READ-ONLY: it never sends a DELETE.
//
// Paste into the DevTools console while the recycle bin of a module is open, e.g.
//   https://<acct>.myfreshworks.com/crm/sales/contacts/view/<recycle bin view id>
//   https://<acct>.freshsales.io/contacts/view/<recycle bin view id>
//
// It prints the page URL shape, the module's saved views (to find the recycle bin
// view's name and id), whether the page has a CSRF token for writes, and the
// status and response keys of the first page of the open view. No record data.
(async () => {
  const crm = location.host.endsWith(".myfreshworks.com");
  // Web app routes only (this branch avoids the public /api prefix).
  const api = crm ? ["/crm/sales"] : [""];
  const route = location.hash.startsWith("#/") ? location.hash.slice(1) : location.pathname;
  const m = route.match(/^(?:\/crm\/sales)?\/(contacts|deals|accounts|sales_accounts|leads|custom_module\/[\w-]+)(?:\/view\/(\d+))?/);
  console.log("[probe] platform:", crm ? "Freshworks CRM" : "Classic Freshsales");
  console.log("[probe] route:", route, "->", m ? { module: m[1], viewId: m[2] || null } : "no module in URL");
  console.log("[probe] csrf-token meta present:", !!document.querySelector('meta[name="csrf-token"]'));
  if (!m) return;

  const seg = m[1] === "accounts" ? "sales_accounts" : m[1];
  const get = async (path, params = {}) => {
    const url = path + (Object.keys(params).length ? "?" + new URLSearchParams(params) : "");
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" }, credentials: "same-origin" });
      const type = r.headers.get("content-type") || "";
      return { url, status: r.status, body: type.includes("json") ? await r.json() : null };
    } catch (e) {
      return { url, status: "ERR " + e.message };
    }
  };

  // 1. Saved views (filters): which one is the recycle bin?
  for (const p of api) {
    const res = await get(`${p}/${seg}/filters`);
    console.log(`[probe] ${res.status} ${res.url}`, res.body ? Object.keys(res.body) : "");
    const list = res.body && (res.body.filters || res.body.data);
    if (Array.isArray(list)) {
      console.table(list.map((f) => ({ id: f.id, name: f.name, is_default: f.is_default })));
      break;
    }
  }
  if (!m[2]) return;

  // 2. First page of the open view (record count only).
  for (const p of api) {
    const res = await get(`${p}/${seg}/view/${m[2]}`, { page: 1, per_page: 1 });
    console.log(`[probe] ${res.status} ${res.url}`, res.body ? Object.keys(res.body) : "");
    if (res.status === 200 && res.body) {
      console.log("[probe] meta:", res.body.meta);
      return;
    }
  }
})();
