'use strict';
// Builds the device in devices/la2l from the sources in src/:
//   1. tools/gen-patch.js makes the patch and checks it,
//   2. tools/bundle-node.js merges src/node into one la2l-node.js,
//   3. tools/build-amxd.js wraps the patch in the .amxd header,
//   4. the v8 script and the logos are copied next to the device.
// Usage: node tools/build.js   (only Node is needed, no npm packages)

const fs = require('fs');
const path = require('path');
const { buildPatch, checkPatch, patchJson } = require('./gen-patch');
const { bundle } = require('./bundle-node');
const { amxd } = require('./build-amxd');
const { VERSION } = require('../src/node/version');

const root = path.join(__dirname, '..');
const out = path.join(root, 'devices', 'la2l');
const DEVICE = 'Lloyds App2Live.amxd';
const COPY = [
  ['src/live/la2l-live.js', 'la2l-live.js'],
  ['src/ui/la2l-logo.png', 'la2l-logo.png'],
  ['src/ui/la2l-logo-big.png', 'la2l-logo-big.png'],
];

function build() {
  const built = buildPatch();
  const problems = checkPatch(built);
  if (problems.length) throw new Error('The patch has problems:\n' + problems.join('\n'));

  // The v8 script carries its own version number; it must match.
  const live = fs.readFileSync(path.join(root, 'src/live/la2l-live.js'), 'utf8');
  const m = /var VERSION = '([^']+)'/.exec(live);
  if (!m || m[1] !== VERSION) throw new Error(`la2l-live.js has version ${m && m[1]}, version.js has ${VERSION}`);

  fs.mkdirSync(out, { recursive: true });
  const json = patchJson(built);
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'la2l.maxpat'), json);
  fs.writeFileSync(path.join(out, DEVICE), amxd(json, 'audio'));
  const { code, modules } = bundle(path.join(root, 'src/node/la2l-node.js'));
  fs.writeFileSync(path.join(out, 'la2l-node.js'), code);
  for (const [from, to] of COPY) fs.copyFileSync(path.join(root, from), path.join(out, to));
  return { built, modules, out };
}

if (require.main === module) {
  const { built, modules } = build();
  console.log(`LA2L ${VERSION}: ${built.patcher.boxes.length} boxes, ${built.patcher.lines.length} lines`);
  console.log(`Node bundle: ${modules.join(', ')}`);
  console.log(`Written to ${path.relative(root, out)}: ${fs.readdirSync(out).join(', ')}`);
}

module.exports = { build };
