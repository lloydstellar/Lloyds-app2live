'use strict';
// Entry point of the Node part: the link between Max (max-api) and the controller in app.js.
// All logic lives in the other modules. tools/bundle-node.js merges them into one file,
// because Freeze only packs the script that [node.script] names, not the modules it loads.

const maxApi = require('max-api');
const { App } = require('./app');

const app = new App({
  out: (name, ...args) => {
    maxApi.outlet(name, ...args).catch((e) => maxApi.post('LA2L outlet failed: ' + e));
  },
  post: (line) => maxApi.post(line),
  deviceDir: __dirname,
});

// An error anywhere must not stop Node: it would leave the device without its network part.
process.on('unhandledRejection', (e) => app.fail(e));
process.on('uncaughtException', (e) => app.fail(e));

// The ALL handler gets a flag (whether a specific handler took the message), the name, then the values.
maxApi.addHandler(maxApi.MESSAGE_TYPES.ALL, (handled, name, ...args) => {
  Promise.resolve()
    .then(() => app.handle(name, ...args))
    .catch((e) => app.fail(e));
});

app.start();
