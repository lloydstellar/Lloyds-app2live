'use strict';
// The device side of the API, as LA2L 0.1.1 uses it (docs/server-api.md, "Device side").
// That side is fixed: the device is installed and must keep working unchanged.

const fs = require('fs');
const { sendJson } = require('../http-util');

// Can the server keep sounds right now? The data folder must be writable.
function storageOk(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (e) {
    return false;
  }
}

function deviceRoutes(router, { config }) {
  // Self test in the device needs {"ok": true}; anything else reads as "no App2Live server".
  router.add('GET', '/api/health', ({ res }) => {
    if (!storageOk(config.dataDir)) {
      return sendJson(res, 503, { ok: false, error: 'The server cannot store sounds right now.' });
    }
    sendJson(res, 200, { ok: true, name: 'la2l-server', version: config.version });
  });
}

module.exports = { deviceRoutes };
