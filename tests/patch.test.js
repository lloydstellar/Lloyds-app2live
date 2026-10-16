'use strict';
// Checks on the generated patch that would otherwise only show up as errors in the Max window,
// and checks that the patch, Node and the v8 script agree on their messages.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildPatch, checkPatch, patchJson, W, H } = require('../tools/gen-patch');
const { amxd } = require('../tools/build-amxd');
const { HANDLED, OUT_KEYS } = require('../src/node/app');

const ROOT = path.join(__dirname, '..');
const built = buildPatch();
const boxes = built.patcher.boxes.map((b) => b.box);
const lines = built.patcher.lines.map((l) => l.patchline);
const byId = new Map(boxes.map((b) => [b.id, b]));
const from = (id) => lines.filter((l) => l.source[0] === id).map((l) => byId.get(l.destination[0]));
const into = (id) => lines.filter((l) => l.destination[0] === id).map((l) => byId.get(l.source[0]));

test('no broken connections, names, positions or parameters', () => {
  assert.deepEqual(checkPatch(built), []);
  assert.equal(W, 480);
  assert.equal(H, 169);
});

test('the route after node.script has exactly the keys Node sends', () => {
  const route = boxes.find((b) => b.text && b.text.startsWith('route view'));
  assert.deepEqual(route.text.split(' ').slice(1), OUT_KEYS);
  // Every key is connected to something.
  OUT_KEYS.forEach((key, i) => assert.ok(lines.some((l) => l.source[0] === route.id && l.source[1] === i), `route ${key} goes nowhere`));
});

test('everything the patch sends to Node is handled by Node', () => {
  const senders = boxes.filter((b) => b.text === 's ---la2l');
  assert.ok(senders.length > 5);
  const sent = new Set();
  for (const s of senders) {
    for (const src of into(s.id)) {
      if (src.maxclass === 'message') sent.add(src.text.split(' ')[0]);
      else if (src.text.startsWith('prepend ')) sent.add(src.text.split(' ')[1]);
      else assert.fail('unexpected sender ' + src.text);
    }
  }
  sent.add('live'); // the v8 script talks to node.script directly
  for (const name of sent) assert.ok(HANDLED.includes(name), `Node does not handle "${name}"`);
  for (const name of HANDLED) assert.ok(sent.has(name), `nothing in the patch sends "${name}"`);
});

test('the v8 script has a function for every message the patch sends it', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/live/la2l-live.js'), 'utf8');
  const v8 = boxes.find((b) => b.text === 'v8 la2l-live.js');
  const msgs = new Set();
  for (const s of into(v8.id)) {
    if (s.maxclass === 'message') msgs.add(s.text.split(' ')[0]);
    else if (s.text.startsWith('route ')) msgs.add('request'); // Node sends "tolive request <json>"
  }
  assert.deepEqual([...msgs].sort(), ['init', 'request', 'step']);
  for (const m of msgs) assert.match(src, new RegExp(`\\nfunction ${m}\\(`), `no function ${m}`);
  assert.match(src, /\noutlets = 2;/);
  assert.equal(v8.numoutlets, 2);
  // The step loop goes through [deferlow], so the Live API runs on the low-priority thread.
  const delay = from(v8.id).find((b) => b.text === 'delay');
  assert.ok(delay);
  assert.equal(from(delay.id)[0].text, 'deferlow');
});

test('Node sends "tolive request <json>", which reaches the v8 script as "request <json>"', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/node/live-bridge.js'), 'utf8');
  assert.match(src, /this\.send\('tolive', 'request', JSON\.stringify/);
});

test('files named in the patch are the files the build puts next to the device', () => {
  const node = boxes.find((b) => b.text && b.text.startsWith('node.script'));
  assert.match(node.text, /^node\.script la2l-node\.js /);
  assert.equal(node.saved_object_attributes.autostart, 1);
  const pics = boxes.filter((b) => b.maxclass === 'fpic').map((b) => b.pic);
  assert.deepEqual(pics.sort(), ['la2l-logo-big.png', 'la2l-logo.png']);
  for (const p of pics) assert.ok(fs.existsSync(path.join(ROOT, 'src/ui', p)));
  const build = fs.readFileSync(path.join(ROOT, 'tools/build.js'), 'utf8');
  for (const f of ['la2l-live.js', 'la2l-logo.png', 'la2l-logo-big.png']) assert.ok(build.includes(`'${f}'`));
});

test('views: every group exists, starts hidden, and the header and status stay visible', () => {
  for (const [name, members] of Object.entries(built.groups)) {
    assert.ok(members.length > 0, `group ${name} is empty`);
    for (const v of members) assert.equal(boxes.find((b) => b.varname === v).hidden, 1, `${v} should start hidden`);
  }
  const visible = boxes.filter((b) => b.presentation && !b.hidden);
  const texts = visible.map((b) => b.text || b.pic || b.varname);
  assert.ok(texts.includes("Lloyd's App2Live"));
  assert.ok(texts.includes('la2l-logo.png'));
  assert.ok(texts.includes('Settings'));
  assert.ok(texts.includes('Starting LA2L...'));
  // One message per view, each showing its own group and hiding all others.
  for (const view of ['unpaired', 'pairing', 'paired', 'settings']) {
    const sel = boxes.find((b) => b.text && b.text.startsWith('sel unpaired'));
    const i = sel.text.split(' ').slice(1).indexOf(view);
    const msg = lines.filter((l) => l.source[0] === sel.id && l.source[1] === i).map((l) => byId.get(l.destination[0]))[0];
    for (const v of built.groups[view]) assert.ok(msg.text.includes('script show ' + v));
    for (const v of built.groups.tempo) assert.ok(msg.text.includes('script hide ' + v), 'every view hides the tempo row');
  }
});

test('views do not overlap each other in a way that hides controls', () => {
  // Within one view, no two controls (buttons and tabs) overlap.
  const rects = (group) => built.groups[group].map((v) => boxes.find((b) => b.varname === v)).filter((b) => b.maxclass.startsWith('live.'));
  const overlap = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
  for (const g of Object.keys(built.groups)) {
    const r = rects(g);
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) assert.ok(!overlap(r[i].presentation_rect, r[j].presentation_rect), `${r[i].varname} overlaps ${r[j].varname}`);
  }
  const status = boxes.find((b) => b.varname === 'status').presentation_rect;
  for (const b of boxes.filter((x) => x.presentation && x.varname !== 'status')) {
    assert.ok(!overlap(b.presentation_rect, status), `${b.varname || b.text} overlaps the status line`);
  }
});

test('all Live parameters are hidden: nothing fires by itself when a Set loads', () => {
  const lives = boxes.filter((b) => b.maxclass.startsWith('live.') && b.maxclass !== 'live.thisdevice');
  assert.ok(lives.length >= 10);
  for (const b of lives) assert.equal(b.saved_attribute_attributes.valueof.parameter_invisible, 2, b.varname);
  // Buttons go through [route bang 1] -> [t b].
  for (const b of lives.filter((x) => x.maxclass === 'live.text' && x.mode === 0)) {
    const r = from(b.id)[0];
    assert.equal(r.text, 'route bang 1', b.varname);
  }
});

test('.amxd header', () => {
  const buf = amxd(patchJson(built), 'audio');
  assert.equal(buf.toString('latin1', 0, 4), 'ampf');
  assert.equal(buf.toString('latin1', 8, 12), 'aaaa');
  assert.equal(buf.toString('latin1', 12, 16), 'meta');
  assert.equal(buf.toString('latin1', 24, 28), 'ptch');
  assert.equal(buf.readUInt32LE(28), buf.length - 32);
  assert.equal(buf[buf.length - 1], 0);
  const json = JSON.parse(buf.subarray(32, buf.length - 1).toString('utf8'));
  assert.equal(json.patcher.project.amxdtype, 1633771873);
  assert.equal(json.patcher.devicewidth, W);
});
