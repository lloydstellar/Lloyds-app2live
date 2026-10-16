'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const t = require('../src/node/text');

test('display text: Max-special characters dropped, sent as words', () => {
  assert.deepEqual(t.words('Hello, "world"; $1 {x} [y]\\ok'), ['Hello', 'world', '1', 'x', 'yok']);
  assert.deepEqual(t.words('  '), []);
  assert.deepEqual(t.words(null), []);
  assert.deepEqual(t.words('Line one\nline two'), ['Line', 'one', 'line', 'two']);
});

test('track names keep letters of any language and a few signs', () => {
  assert.equal(t.cleanName('Robot hallo!'), 'Robot hallo!');
  assert.equal(t.cleanName('Café über 808 (v2)'), 'Café über 808 (v2)');
  assert.equal(t.cleanName('a/b\\c:d*e?'), 'a b c d e');
  assert.equal(t.cleanName('   ', 'Sound 1'), 'Sound 1');
  assert.equal(t.cleanName('x'.repeat(100)).length, 60);
});

test('file names: only letters, digits, space, - and _; never a path', () => {
  assert.equal(t.cleanFileName('../../etc/passwd'), 'etc passwd');
  assert.equal(t.cleanFileName('Kick.wav'), 'Kick wav');
  assert.equal(t.cleanFileName('CON'), '_CON');
  assert.equal(t.cleanFileName('...', 'Sound'), 'Sound');
  assert.equal(t.cleanFileName('Snare_01 - take'), 'Snare_01 - take');
});

test('paths: forward slashes for Max, no Mac volume name for Node and Live', () => {
  assert.equal(t.fwd('C:\\Users\\Erik\\Music'), 'C:/Users/Erik/Music');
  assert.equal(t.nativePath('Macintosh HD:/Users/erik/Music'), '/Users/erik/Music');
  assert.equal(t.nativePath('C:/Users/erik'), 'C:/Users/erik');
  assert.equal(t.nativePath('/Users/erik'), '/Users/erik');
});

test('uniquePath never overwrites', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la2l-text-'));
  const a = t.uniquePath(dir, 'Kick', '.wav');
  assert.equal(path.basename(a), 'Kick.wav');
  fs.writeFileSync(a, 'x');
  assert.equal(path.basename(t.uniquePath(dir, 'Kick', '.wav')), 'Kick 2.wav');
});

test('time and numbers', () => {
  assert.equal(t.clock(581), '9:41');
  assert.equal(t.clock(600), '10:00');
  assert.equal(t.clock(0.2), '0:01');
  assert.equal(t.clock(-5), '0:00');
  assert.match(t.stamp(new Date(2026, 9, 16, 15, 7)), /^2026-10-16 1507$/);
  assert.equal(t.plural(1, 'track'), '1 track');
  assert.equal(t.plural(5, 'track'), '5 tracks');
  assert.equal(t.bpmText(135), '135');
  assert.equal(t.bpmText(92.5), '92.5');
  assert.equal(t.bpmText(120.0004), '120');
});
