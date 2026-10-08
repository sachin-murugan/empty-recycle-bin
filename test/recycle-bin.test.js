const test = require('node:test');
const assert = require('node:assert/strict');
const { client, recycleBin, uiRequest } = require('./load');

const CONTACTS = { entity: 'contact', endpoint: 'contacts', custom: false };

// routes: { 'METHOD /path': (searchParams, init) => body | Response }
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, search: u.search, headers: init.headers, body: init.body });
    const handler = routes[`${init.method} ${u.pathname}`];
    if (!handler) return new Response('<html>not found</html>', { status: 404 });
    const body = handler(u.searchParams, init);
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

const noSleep = async () => {};
const makeBin = (host, fetchImpl, opts = {}) =>
  new recycleBin.RecycleBin(new client.CRMClient({ host, fetchImpl, sleepImpl: noSleep, ...opts }));

const bulkTemplate = uiRequest.buildTemplate({
  method: 'POST',
  url: 'https://acme.myfreshworks.com/crm/sales/contacts/bulk_forget',
  headers: { 'content-type': 'application/json' },
  body: '{"selected_ids":[402000123456]}',
});
const singleTemplate = uiRequest.buildTemplate({
  method: 'DELETE',
  url: 'https://acme.myfreshworks.com/crm/sales/contacts/402000123456/forget',
  headers: {},
  body: null,
});
const recs = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1) }));

test('reads views and records through the web app routes, never /api', async () => {
  const records = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, first_name: 'A', last_name: String(i + 1) }));
  const fetchImpl = fakeFetch({
    'GET /crm/sales/contacts/filters': () => ({ filters: [{ id: 1, name: 'All Contacts' }, { id: 2, name: 'Recycle Bin' }] }),
    'GET /crm/sales/contacts/view/2': (q) => {
      const page = Number(q.get('page'));
      return { contacts: records.slice((page - 1) * 100, page * 100), meta: { total_pages: 2 } };
    },
  });
  const bin = makeBin('acme.myfreshworks.com', fetchImpl);
  assert.deepEqual(await bin.resolveView({ ...CONTACTS, viewId: '2' }), { viewId: '2', viewName: 'Recycle Bin', isRecycleBin: true });
  assert.equal((await bin.resolveView({ ...CONTACTS, viewId: '1' })).isRecycleBin, false);
  const out = await bin.fetchRecords(CONTACTS, '2');
  assert.equal(out.length, 150);
  assert.deepEqual(out[0], { id: '1', label: 'A 1' });
  assert.ok(fetchImpl.calls.every((c) => !c.path.includes('/api/')), 'no /api calls');
});

test('classic Freshsales reads from the root routes', async () => {
  const fetchImpl = fakeFetch({ 'GET /contacts/view/3': () => ({ contacts: [{ id: 1 }], meta: { total_pages: 1 } }) });
  const out = await makeBin('acme.freshsales.io', fetchImpl).fetchRecords(CONTACTS, '3');
  assert.equal(out.length, 1);
  assert.ok(fetchImpl.calls.every((c) => !c.path.startsWith('/api/')));
});

test('an unreadable view list is never treated as the recycle bin', async () => {
  const bin = makeBin('acme.myfreshworks.com', fakeFetch({}));
  assert.equal((await bin.resolveView({ ...CONTACTS, viewId: '2' })).isRecycleBin, false);
});

test('bulk template deletes in batches of 100, one batch at a time', async () => {
  const sent = [];
  const fetchImpl = fakeFetch({
    'POST /crm/sales/contacts/bulk_forget': (_q, init) => (sent.push(JSON.parse(init.body).selected_ids), {}),
  });
  const bin = makeBin('acme.myfreshworks.com', fetchImpl);
  const result = await bin.forgetWithTemplate(bulkTemplate, recs(250), { csrfToken: 'tok' });
  assert.equal(result.forgotten.length, 250);
  assert.deepEqual(sent.map((s) => s.length), [100, 100, 50]);
  assert.equal(fetchImpl.calls[0].headers['x-csrf-token'], 'tok');
});

test('per-record template sends one request per record', async () => {
  const routes = {};
  for (const id of ['1', '2', '3']) routes[`DELETE /crm/sales/contacts/${id}/forget`] = () => new Response(null, { status: 204 });
  const f = fakeFetch(routes);
  const result = await makeBin('acme.myfreshworks.com', f).forgetWithTemplate(singleTemplate, recs(3));
  assert.deepEqual(result.forgotten.sort(), ['1', '2', '3']);
});

test('stops when the first request is refused', async () => {
  const fetchImpl = fakeFetch({
    'POST /crm/sales/contacts/bulk_forget': () => new Response('{"message":"denied"}', { status: 403 }),
  });
  const bin = makeBin('acme.myfreshworks.com', fetchImpl);
  await assert.rejects(bin.forgetWithTemplate(bulkTemplate, recs(250)), /refused the first delete/);
  assert.equal(fetchImpl.calls.length, 1);
});

test('keeps going past a failed batch and reports its records', async () => {
  let n = 0;
  const fetchImpl = fakeFetch({
    'POST /crm/sales/contacts/bulk_forget': () => (++n === 2 ? new Response('{"message":"locked"}', { status: 422 }) : {}),
  });
  const result = await makeBin('acme.myfreshworks.com', fetchImpl).forgetWithTemplate(bulkTemplate, recs(250));
  assert.equal(result.forgotten.length, 150);
  assert.equal(result.failed.length, 100);
});

test('cancelling stops further requests', async () => {
  const signal = { aborted: false };
  const fetchImpl = fakeFetch({ 'POST /crm/sales/contacts/bulk_forget': () => ((signal.aborted = true), {}) });
  const result = await makeBin('acme.myfreshworks.com', fetchImpl).forgetWithTemplate(bulkTemplate, recs(250), { signal });
  assert.equal(result.forgotten.length, 100);
  assert.equal(result.cancelled, true);
  assert.equal(fetchImpl.calls.length, 1);
});

test('refuses to replay a request to another site', async () => {
  const evil = { ...bulkTemplate, origin: 'https://evil.example' };
  const fetchImpl = fakeFetch({});
  await assert.rejects(makeBin('acme.myfreshworks.com', fetchImpl).forgetWithTemplate(evil, recs(1)), /another site/);
  assert.equal(fetchImpl.calls.length, 0);
});
