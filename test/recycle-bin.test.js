const test = require('node:test');
const assert = require('node:assert/strict');
const { client, recycleBin } = require('./load');

const CONTACTS = { entity: 'contact', endpoint: 'contacts', custom: false };

// routes: { 'METHOD /path': (searchParams) => body | Response }
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, search: u.search, headers: init.headers });
    const handler = routes[`${init.method} ${u.pathname}`];
    if (!handler) return new Response('<html>not found</html>', { status: 404 });
    const body = handler(u.searchParams);
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

const noSleep = async () => {};
const makeBin = (host, fetchImpl, opts = {}) =>
  new recycleBin.RecycleBin(new client.CRMClient({ host, fetchImpl, sleepImpl: noSleep, ...opts }));

test('resolves the open view and refuses a view that is not the recycle bin', async () => {
  const fetchImpl = fakeFetch({
    'GET /crm/sales/api/contacts/filters': () => ({
      filters: [
        { id: 1, name: 'All Contacts' },
        { id: 2, name: 'Recycle Bin' },
      ],
    }),
  });
  const bin = makeBin('acme.myfreshworks.com', fetchImpl);
  assert.deepEqual(await bin.resolveView({ ...CONTACTS, viewId: '2' }), {
    viewId: '2',
    viewName: 'Recycle Bin',
    isRecycleBin: true,
  });
  assert.equal((await bin.resolveView({ ...CONTACTS, viewId: '1' })).isRecycleBin, false);
  // A recycle bin route without an id is matched by name.
  assert.equal((await bin.resolveView({ ...CONTACTS, viewId: null })).viewId, '2');
});

test('an unreadable view list is never treated as the recycle bin', async () => {
  const bin = makeBin('acme.myfreshworks.com', fakeFetch({}));
  assert.equal((await bin.resolveView({ ...CONTACTS, viewId: '2' })).isRecycleBin, false);
});

test('collects every record id across pages before deleting', async () => {
  const records = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, first_name: 'A', last_name: String(i + 1) }));
  const fetchImpl = fakeFetch({
    'GET /crm/sales/api/contacts/view/2': (q) => {
      const page = Number(q.get('page'));
      return { contacts: records.slice((page - 1) * 100, page * 100), meta: { total_pages: 2 } };
    },
  });
  const progress = [];
  const out = await makeBin('acme.myfreshworks.com', fetchImpl).fetchRecords(CONTACTS, '2', {
    onProgress: (p) => progress.push(p.fetched),
  });
  assert.equal(out.length, 150);
  assert.deepEqual(out[0], { id: '1', label: 'A 1' });
  assert.deepEqual(progress, [100, 150]);
  assert.ok(fetchImpl.calls.every((c) => c.method === 'GET'));
});

test('forgets each record with DELETE …/forget on the first API prefix that has the route', async () => {
  const forgotten = [];
  const fetchImpl = fakeFetch({
    // Classic host: /api is tried first.
    'DELETE /api/contacts/1/forget': () => (forgotten.push(1), {}),
    'DELETE /api/contacts/2/forget': () => (forgotten.push(2), new Response(null, { status: 204 })),
    'DELETE /api/contacts/3/forget': () => new Response('{"errors":{"message":"not found"}}', { status: 404 }),
  });
  const bin = makeBin('acme.freshsales.io', fetchImpl, { csrfToken: 'tok' });
  const result = await bin.forgetRecords(CONTACTS, [{ id: '1' }, { id: '2' }, { id: '3' }], { concurrency: 2 });
  assert.deepEqual(result.forgotten.sort(), ['1', '2']);
  assert.deepEqual(result.gone, ['3']);
  assert.deepEqual(result.failed, []);
  const deletes = fetchImpl.calls.filter((c) => c.method === 'DELETE');
  assert.equal(deletes.length, 3);
  assert.equal(deletes[0].headers['X-CSRF-Token'], 'tok');
});

test('falls back across path styles, then sticks with the one that worked', async () => {
  const fetchImpl = fakeFetch({
    'DELETE /api/leads/10/forget': () => ({}),
    'DELETE /api/leads/11/forget': () => ({}),
  });
  const bin = makeBin('acme.myfreshworks.com', fetchImpl);
  const result = await bin.forgetRecords({ entity: 'lead', endpoint: 'leads', custom: false }, [{ id: '10' }, { id: '11' }]);
  assert.deepEqual(result.forgotten.sort(), ['10', '11']);
  const paths = fetchImpl.calls.map((c) => c.path);
  assert.deepEqual(paths, [
    '/crm/sales/api/leads/10/forget',
    '/crm/sales/leads/10/forget',
    '/api/leads/10/forget',
    '/api/leads/11/forget',
  ]);
});

test('stops before touching the rest when no forget route exists', async () => {
  const fetchImpl = fakeFetch({});
  const bin = makeBin('acme.myfreshworks.com', fetchImpl);
  await assert.rejects(bin.forgetRecords(CONTACTS, [{ id: '1' }, { id: '2' }]), /No forget endpoint/);
  assert.ok(!fetchImpl.calls.some((c) => c.path.includes('/2/')));
});

test('stops when the first delete is refused', async () => {
  const fetchImpl = fakeFetch({
    'DELETE /crm/sales/api/contacts/1/forget': () => new Response('{"message":"denied"}', { status: 403 }),
  });
  const bin = makeBin('acme.myfreshworks.com', fetchImpl);
  await assert.rejects(bin.forgetRecords(CONTACTS, [{ id: '1' }, { id: '2' }]), /HTTP 403/);
  assert.ok(!fetchImpl.calls.some((c) => c.path.includes('/2/')));
});

test('keeps going past a failed record and reports it', async () => {
  const fetchImpl = fakeFetch({
    'DELETE /crm/sales/api/contacts/1/forget': () => ({}),
    'DELETE /crm/sales/api/contacts/2/forget': () => new Response('{"message":"locked"}', { status: 422 }),
    'DELETE /crm/sales/api/contacts/3/forget': () => ({}),
  });
  const bin = makeBin('acme.myfreshworks.com', fetchImpl);
  const result = await bin.forgetRecords(CONTACTS, [{ id: '1' }, { id: '2' }, { id: '3' }]);
  assert.deepEqual(result.forgotten.sort(), ['1', '3']);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, '2');
});

test('cancelling stops further deletes', async () => {
  const signal = { aborted: false };
  const fetchImpl = fakeFetch({
    'DELETE /crm/sales/api/contacts/1/forget': () => ((signal.aborted = true), {}),
    'DELETE /crm/sales/api/contacts/2/forget': () => ({}),
  });
  const bin = makeBin('acme.myfreshworks.com', fetchImpl);
  const result = await bin.forgetRecords(CONTACTS, [{ id: '1' }, { id: '2' }], { signal });
  assert.deepEqual(result.forgotten, ['1']);
  assert.equal(result.cancelled, true);
});

test('custom modules use the custom_module forget path', async () => {
  const fetchImpl = fakeFetch({ 'DELETE /crm/sales/api/custom_module/cm_policy/5/forget': () => ({}) });
  const bin = makeBin('acme.myfreshworks.com', fetchImpl);
  const result = await bin.forgetRecords({ entity: 'cm_policy', endpoint: 'cm_policy', custom: true }, [{ id: '5' }]);
  assert.deepEqual(result.forgotten, ['5']);
});

test('API key replaces the CSRF token', async () => {
  const fetchImpl = fakeFetch({ 'DELETE /api/contacts/1/forget': () => ({}) });
  const bin = makeBin('acme.freshsales.io', fetchImpl, { apiKey: ' abc ', csrfToken: 'tok' });
  await bin.forgetRecords(CONTACTS, [{ id: '1' }]);
  const h = fetchImpl.calls[0].headers;
  assert.equal(h.Authorization, 'Token token=abc');
  assert.equal(h['X-CSRF-Token'], undefined);
});
