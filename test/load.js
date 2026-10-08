// Loads the extension's library files into this Node process the same way the
// manifest loads them into the content script (in order, sharing globalThis.FSX).
const path = require('node:path');

const FILES = ['platform', 'client', 'recycle-bin'];
for (const f of FILES) require(path.join(__dirname, '..', 'src', 'lib', `${f}.js`));

module.exports = globalThis.FSX;
