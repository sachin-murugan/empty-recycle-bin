const test = require('node:test');
const assert = require('node:assert/strict');
const { customDomains: cd, platform } = require('./load');

test('built-in Freshworks domains are recognised, custom ones are not', () => {
  assert.equal(cd.isBuiltInHost('acme.freshsales.io'), true);
  assert.equal(cd.isBuiltInHost('acme.myfreshworks.com'), true);
  assert.equal(cd.isBuiltInHost('acme.freshworks.com'), true);
  assert.equal(cd.isBuiltInHost('crm.halnath.uk'), false);
  assert.equal(cd.isBuiltInHost('evilfreshworks.com'), false);
});

test('custom-domain CRM pages are detected by their /crm/sales path', () => {
  assert.equal(cd.looksLikeCrmUrl('https://crm.halnath.uk/crm/sales/contacts/view/98760987692'), true);
  assert.equal(cd.looksLikeCrmUrl('https://crm.halnath.uk/crm/sales'), true);
  assert.equal(cd.looksLikeCrmUrl('http://crm.halnath.uk/crm/sales/contacts/view/1'), false);
  assert.equal(cd.looksLikeCrmUrl('https://example.com/blog/crm/sales'), false);
  assert.equal(cd.looksLikeCrmUrl('not a url'), false);
});

test('origin patterns round-trip and ignore wildcards', () => {
  assert.equal(cd.originPattern('crm.halnath.uk'), 'https://crm.halnath.uk/*');
  assert.equal(cd.hostFromPattern('https://crm.halnath.uk/*'), 'crm.halnath.uk');
  assert.equal(cd.hostFromPattern('https://*.freshworks.com/*'), null);
  assert.equal(cd.hostFromPattern('https://*/*'), null);
});

test('host validation accepts custom domains', () => {
  assert.equal(cd.isValidHost('crm.halnath.uk'), true);
  assert.equal(cd.isValidHost('acme.myfreshworks.com'), true);
  assert.equal(cd.isValidHost('localhost'), false);
  assert.equal(cd.isValidHost('bad host.com'), false);
});

test('custom domains use the Freshworks CRM paths', () => {
  assert.equal(platform.detectPlatform('crm.halnath.uk'), 'crm');
});
