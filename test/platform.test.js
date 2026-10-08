const test = require('node:test');
const assert = require('node:assert/strict');
const { platform } = require('./load');

test('detects platform from host', () => {
  assert.equal(platform.detectPlatform('acme.freshsales.io'), 'classic');
  assert.equal(platform.detectPlatform('acme.myfreshworks.com'), 'crm');
  assert.equal(platform.detectPlatform('unknown.example.com'), 'crm');
});

test('parses CRM list view URLs', () => {
  assert.deepEqual(platform.parseRecycleBinUrl('https://acme.myfreshworks.com/crm/sales/contacts/view/31000123'), {
    host: 'acme.myfreshworks.com',
    entity: 'contact',
    endpoint: 'contacts',
    custom: false,
    viewId: '31000123',
    recycleBinRoute: false,
  });
});

test('parses classic URLs, accounts, hash routes and custom modules', () => {
  const classic = platform.parseRecycleBinUrl('https://acme.freshsales.io/deals/view/42?page=2');
  assert.equal(classic.entity, 'deal');
  assert.equal(classic.viewId, '42');

  const accounts = platform.parseRecycleBinUrl('https://acme.myfreshworks.com/crm/sales/accounts/view/7');
  assert.equal(accounts.endpoint, 'sales_accounts');

  const hash = platform.parseRecycleBinUrl('https://acme.freshsales.io/#/leads/view/5000123456');
  assert.equal(hash.entity, 'lead');

  const custom = platform.parseRecycleBinUrl('https://acme.myfreshworks.com/crm/sales/custom_module/cm_policy/view/9');
  assert.equal(custom.custom, true);
  assert.equal(custom.entity, 'cm_policy');
});

test('accepts a recycle bin route without a view id', () => {
  const v = platform.parseRecycleBinUrl('https://acme.myfreshworks.com/crm/sales/contacts/recycle_bin');
  assert.equal(v.entity, 'contact');
  assert.equal(v.viewId, null);
  assert.equal(v.recycleBinRoute, true);
});

test('returns null for pages that are not a view', () => {
  assert.equal(platform.parseRecycleBinUrl('https://acme.myfreshworks.com/crm/sales/contacts/123'), null);
  assert.equal(platform.parseRecycleBinUrl('https://acme.myfreshworks.com/crm/sales/contacts'), null);
  assert.equal(platform.parseRecycleBinUrl('https://acme.myfreshworks.com/crm/sales/products/view/3'), null);
  assert.equal(platform.parseRecycleBinUrl('not a url'), null);
});

test('recognises recycle bin view names', () => {
  for (const n of ['Recycle Bin', 'recycle bin contacts', 'Deleted contacts', 'Trash']) {
    assert.ok(platform.isRecycleBinName(n), n);
  }
  for (const n of ['All Contacts', 'My recycled leads', '', null]) {
    assert.ok(!platform.isRecycleBinName(n), String(n));
  }
});
