// checkManifest as the server, on what an app could pass that is not a plain manifest: the server
// judges the JSON that arrives, so the SDK must too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkManifest } from '../dist/index.js';

const sound = { file: 'kick.wav', bytes: 1000, sha256: 'a'.repeat(64), name: 'Kick', kind: 'loop' };
const manifest = (extra = {}) => ({ schema: 'app2live/1', title: 'T', source: { app: 'A' }, items: [{ ...sound }], ...extra });

test('what is no JSON object when it is sent: 400 "Send a JSON object."', () => {
  const cyclic = manifest();
  cyclic.self = cyclic;
  for (const value of [undefined, null, 5, 'x', [manifest()], new Date(), { toJSON: () => [1] }, cyclic]) {
    const check = checkManifest(value);
    assert.deepEqual([check.ok, check.status, check.error], [false, 400, 'Send a JSON object.'], String(value));
  }
});

test('more than 1 MB of JSON: 413, also when the server id makes it larger', () => {
  const big = manifest({ notes: 'x'.repeat(1048576) });
  assert.deepEqual([checkManifest(big).status, checkManifest(big).error], [413, 'The request is larger than 1 MB.']);
  // Just under 1 MB without a package_id; the 52 bytes of the server's id push it over.
  const base = JSON.stringify(manifest({ notes: '' })).length;
  const edge = manifest({ notes: 'x'.repeat(1048576 - base - 10) });
  assert.ok(JSON.stringify(edge).length <= 1048576);
  assert.equal(checkManifest(edge).status, 413);
});

test('values JSON changes are judged as the server sees them', () => {
  // NaN becomes null: "bpm ignored"; undefined goes away: no warning at all.
  const check = checkManifest(manifest({ items: [{ ...sound, bpm: NaN, role: undefined }] }));
  assert.equal(check.ok, true);
  assert.deepEqual(check.warnings, ['Kick: bpm ignored']);
  // A Date as created_at is sent as its ISO text.
  assert.equal(checkManifest(manifest({ created_at: new Date(0) })).package.createdAt, '1970-01-01T00:00:00.000Z');
});
