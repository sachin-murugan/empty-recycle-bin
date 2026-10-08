const test = require('node:test');
const assert = require('node:assert/strict');
const { uiRequest } = require('./load');

const copied = (url, init) => `fetch(${JSON.stringify(url)}, ${JSON.stringify(init, null, 2)});`;
const BASE = 'https://acme.myfreshworks.com';

test('parses "Copy as fetch" text as data and drops cookies', () => {
  const c = uiRequest.parseCopiedFetch(
    copied(`${BASE}/crm/sales/contacts/bulk_forget`, {
      headers: { 'content-type': 'application/json', cookie: 'session=secret', 'x-csrf-token': 'old' },
      body: '{"selected_ids":[402000123456]}',
      method: 'POST',
      mode: 'cors',
      credentials: 'include',
    })
  );
  assert.equal(c.method, 'POST');
  assert.equal(c.headers.cookie, undefined);
  const t = uiRequest.buildTemplate(c);
  assert.equal(t.headers['x-csrf-token'], undefined, 'the copied token is not stored');
});

test('rejects text that is not a copied fetch, without evaluating it', () => {
  assert.throws(() => uiRequest.parseCopiedFetch('curl https://x'), /Copy as fetch/);
  assert.throws(() => uiRequest.parseCopiedFetch('fetch("https://x", {headers: alert(1)})'), /Could not read/);
});

test('JSON id array becomes a bulk template, replayed in batches with a fresh token', () => {
  const t = uiRequest.buildTemplate({
    method: 'POST',
    url: `${BASE}/crm/sales/contacts/bulk_forget`,
    headers: { 'content-type': 'application/json' },
    body: '{"selected_ids":[402000123456],"filter_id":9,"view_id":9}',
  });
  assert.equal(t.mode, 'bulk');
  const reqs = uiRequest.plan(t, ['1', '2', '3'], { csrfToken: 'fresh', bulkSize: 2 });
  assert.equal(reqs.length, 2);
  assert.deepEqual(JSON.parse(reqs[0].body), { selected_ids: [1, 2], filter_id: 9, view_id: 9 });
  assert.deepEqual(JSON.parse(reqs[1].body).selected_ids, [3]);
  assert.equal(reqs[0].headers['x-csrf-token'], 'fresh');
  assert.deepEqual(reqs[1].ids, ['3']);
});

test('string ids stay strings', () => {
  const t = uiRequest.buildTemplate({
    method: 'PUT',
    url: `${BASE}/crm/sales/contacts/recycle_bin/purge`,
    headers: { 'content-type': 'application/json' },
    body: '{"contact":{"ids":["402000123456"]}}',
  });
  assert.deepEqual(JSON.parse(uiRequest.plan(t, ['7'])[0].body), { contact: { ids: ['7'] } });
});

test('form-encoded ids[] become a bulk template', () => {
  const t = uiRequest.buildTemplate({
    method: 'POST',
    url: 'https://acme.freshsales.io/contacts/destroy_permanently',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: 'ids%5B%5D=5000123&view_id=4',
  });
  assert.equal(t.mode, 'bulk');
  const body = new URLSearchParams(uiRequest.plan(t, ['1', '2'])[0].body);
  assert.deepEqual(body.getAll('ids[]'), ['1', '2']);
  assert.equal(body.get('view_id'), '4');
});

test('an id in the path becomes a per-record template; the view id is left alone', () => {
  const t = uiRequest.buildTemplate({
    method: 'DELETE',
    url: `${BASE}/crm/sales/contacts/view/9/402000123456/forget`,
    headers: {},
    body: null,
  });
  assert.equal(t.mode, 'single');
  const reqs = uiRequest.plan(t, ['11', '12']);
  assert.deepEqual(
    reqs.map((r) => new URL(r.url).pathname),
    ['/crm/sales/contacts/view/9/11/forget', '/crm/sales/contacts/view/9/12/forget']
  );
});

test('a request with no record ids acts on the whole view and is sent once', () => {
  const t = uiRequest.buildTemplate({
    method: 'POST',
    url: `${BASE}/crm/sales/contacts/recycle_bin/empty`,
    headers: { 'content-type': 'application/json' },
    body: '{"view_id":9}',
  });
  assert.equal(t.mode, 'view');
  assert.equal(uiRequest.plan(t, ['1', '2', '3']).length, 1);
});

test('GET requests and unreadable bodies are not templates', () => {
  assert.equal(uiRequest.buildTemplate({ method: 'GET', url: `${BASE}/x`, headers: {} }), null);
  assert.equal(
    uiRequest.buildTemplate({ method: 'POST', url: `${BASE}/x/bulk`, headers: { 'content-type': 'text/plain' }, body: 'hello' }),
    null
  );
});
