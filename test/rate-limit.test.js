const test = require('node:test');
const assert = require('node:assert/strict');
const { client, recycleBin, uiRequest } = require('./load');

// Per-record template: the case where many requests can run into Freshsales' rate limit.
const SINGLE = uiRequest.buildTemplate({
  method: 'DELETE',
  url: 'https://acme.myfreshworks.com/crm/sales/contacts/402000123456/forget',
  headers: {},
  body: null,
});

const CONTACTS = { entity: 'contact', endpoint: 'contacts', custom: false };

// A fake clock: sleeping advances time instantly, so hour-long waits finish at once.
function fakeClock() {
  const c = { t: 1_000_000, slept: 0 };
  c.now = () => c.t;
  c.sleep = async (ms) => {
    c.t += ms;
    c.slept += ms;
  };
  return c;
}

// Mimics an hourly API budget: `limit` calls per window, then 429 with Retry-After until it resets.
function limitedApi(clock, { limit, windowMs, retryAfter = true }) {
  let windowStart = clock.now();
  let used = 0;
  const forgotten = new Set();
  const fetchImpl = async (url, init) => {
    if (clock.now() - windowStart >= windowMs) {
      windowStart = clock.now();
      used = 0;
    }
    if (used >= limit) {
      const headers = retryAfter ? { 'Retry-After': String(Math.ceil((windowStart + windowMs - clock.now()) / 1000)) } : {};
      return new Response('{"message":"rate limited"}', { status: 429, headers });
    }
    used += 1;
    const m = new URL(url).pathname.match(/\/contacts\/(\d+)\/forget$/);
    if (m && init.method === 'DELETE') {
      forgotten.add(m[1]);
      return new Response(null, { status: 204 });
    }
    return new Response('{}', { status: 200 });
  };
  return { fetchImpl, forgotten };
}

const records = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1) }));

test('pauses for the hourly limit and finishes the rest instead of hanging', async () => {
  const clock = fakeClock();
  const api = limitedApi(clock, { limit: 1000, windowMs: 3_600_000 });
  const bin = new recycleBin.RecycleBin(
    new client.CRMClient({ host: 'acme.myfreshworks.com', fetchImpl: api.fetchImpl, sleepImpl: clock.sleep, nowImpl: clock.now })
  );
  const pauses = [];
  const result = await bin.forgetWithTemplate(SINGLE, records(1500), { onPause: (until) => pauses.push(until) });
  assert.equal(result.forgotten.length, 1500);
  assert.equal(result.failed.length, 0);
  assert.equal(api.forgotten.size, 1500);
  assert.ok(pauses.length >= 1, 'reported the pause');
  assert.ok(clock.slept >= 3_000_000 && clock.slept < 3_700_000, `waited about an hour, got ${clock.slept}`);
});

test('without Retry-After it backs off and still finishes', async () => {
  const clock = fakeClock();
  const api = limitedApi(clock, { limit: 50, windowMs: 5 * 60_000, retryAfter: false });
  const bin = new recycleBin.RecycleBin(
    new client.CRMClient({ host: 'acme.myfreshworks.com', fetchImpl: api.fetchImpl, sleepImpl: clock.sleep, nowImpl: clock.now })
  );
  const result = await bin.forgetWithTemplate(SINGLE, records(120));
  assert.equal(result.forgotten.length, 120);
  assert.equal(result.failed.length, 0);
});

test('Stop works while paused', async () => {
  const clock = fakeClock();
  const api = limitedApi(clock, { limit: 10, windowMs: 3_600_000 });
  const signal = { aborted: false };
  const sleep = async (ms) => {
    await clock.sleep(ms);
    if (clock.slept > 60_000) signal.aborted = true; // user clicks Stop a minute into the pause
  };
  const bin = new recycleBin.RecycleBin(
    new client.CRMClient({ host: 'acme.myfreshworks.com', fetchImpl: api.fetchImpl, sleepImpl: sleep, nowImpl: clock.now })
  );
  const result = await bin.forgetWithTemplate(SINGLE, records(50), { signal });
  assert.equal(result.cancelled, true);
  assert.equal(result.forgotten.length, 10);
  assert.ok(clock.slept < 120_000, 'did not sit out the whole hour');
});

test('a fail-fast client reports the limit instead of waiting (used when the popup opens)', async () => {
  const clock = fakeClock();
  const fetchImpl = async () => new Response('{}', { status: 429, headers: { 'Retry-After': '1800' } });
  const c = new client.CRMClient({
    host: 'acme.myfreshworks.com',
    fetchImpl,
    sleepImpl: clock.sleep,
    nowImpl: clock.now,
    maxRetries: 2,
    maxWaitMs: 0,
  });
  const bin = new recycleBin.RecycleBin(c);
  await assert.rejects(bin.resolveView({ ...CONTACTS, viewId: '2' }), (err) => {
    assert.ok(err instanceof client.RateLimitError);
    assert.equal(err.retryAfterMs, 1_800_000);
    return true;
  });
  assert.equal(clock.slept, 0);
});

test('a request that never answers times out instead of hanging', async () => {
  let calls = 0;
  const fetchImpl = (_url, init) =>
    new Promise((resolve, reject) => {
      calls += 1;
      if (calls === 2) return resolve(new Response('{"ok":1}', { status: 200 }));
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const c = new client.CRMClient({ host: 'acme.myfreshworks.com', fetchImpl, sleepImpl: async () => {}, timeoutMs: 20 });
  assert.deepEqual(await c.get('/x'), { ok: 1 });
  assert.equal(calls, 2);
});
