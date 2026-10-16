'use strict';
// Runs the bundled la2l-node.js the way Max does: as its own Node process, with a stand-in for
// the max-api module. Proves the bundle is complete (Freeze packs only this one file).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { bundle } = require('../tools/bundle-node');

const ROOT = path.join(__dirname, '..');

// A stand-in for max-api: outlet() prints the message as a JSON line, lines on stdin are messages.
const MAX_API = `
const handlers = [];
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    for (const h of handlers) h(false, ...msg);
  }
});
module.exports = {
  MESSAGE_TYPES: { ALL: 'all' },
  addHandler: (type, fn) => handlers.push(fn),
  outlet: (...a) => { process.stdout.write(JSON.stringify(a) + '\\n'); return Promise.resolve(); },
  post: (s) => process.stdout.write(JSON.stringify(['post', s]) + '\\n'),
};
`;

test('the bundle starts, answers Max and asks the Live part for information', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la2l-bundle-'));
  const { code, modules } = bundle(path.join(ROOT, 'src/node/la2l-node.js'));
  assert.deepEqual(modules.sort(), ['app', 'http', 'la2l-node', 'live-bridge', 'manifest', 'server', 'settings', 'testsound', 'text', 'version', 'wav']);
  fs.writeFileSync(path.join(dir, 'la2l-node.js'), code);
  fs.mkdirSync(path.join(dir, 'node_modules', 'max-api'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'max-api', 'index.js'), MAX_API);
  const home = path.join(dir, 'home');
  const child = spawn(process.execPath, ['la2l-node.js'], { cwd: dir, env: Object.assign({}, process.env, { LA2L_HOME: home }) });
  const got = [];
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      got.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const waitFor = async (pred, what) => {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      if (got.some(pred)) return got.find(pred);
      await new Promise((r) => setTimeout(r, 10));
    }
    child.kill();
    throw new Error(`no ${what}. Got: ${JSON.stringify(got)} ${err}`);
  };
  try {
    await waitFor((m) => m[0] === 'view' && m[1] === 'unpaired', 'unpaired view');
    await waitFor((m) => m[0] === 'status' && m[1] === 'Ready.', 'Ready status');
    const req = await waitFor((m) => m[0] === 'tolive', 'getinfo request');
    assert.equal(req[1], 'request');
    const r = JSON.parse(req[2]);
    assert.equal(r.type, 'getinfo');
    // Answer as the Live part would, then open the settings.
    child.stdin.write(JSON.stringify(['live', JSON.stringify({ type: 'info', id: r.id, info: { live: { major: 12, minor: 4, bugfix: 6 }, set: { path: '', tempo: 120 }, device: { trackIndex: 0 } } })]) + '\n');
    child.stdin.write(JSON.stringify(['settings', 1]) + '\n');
    await waitFor((m) => m[0] === 'view' && m[1] === 'settings', 'settings view');
    assert.ok(fs.existsSync(path.join(home, 'settings.json')));
    await waitFor(() => fs.existsSync(path.join(home, 'la2l.log')) && /Live 12\.4\.6/.test(fs.readFileSync(path.join(home, 'la2l.log'), 'utf8')), 'Live version in the log');
  } finally {
    child.kill();
  }
  assert.equal(err, '');
});
