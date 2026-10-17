// docs/app2live-1.schema.json: valid JSON Schema 2020-12 (Ajv in strict mode refuses anything
// it does not know), with the verdict of expected.json on every fixture, and the same limits and
// file names as the checks of the device.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { LIMITS, ROLES, isValidFileName } from '../dist/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURES = path.join(ROOT, 'sdk', 'fixtures');
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'app2live-1.schema.json'), 'utf8'));
const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected.json'), 'utf8'));

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

// What a schema cannot see: the server refuses these, the schema accepts them.
const CANNOT_SAY = new Set(['manifests/same-file.json', 'manifests/201-mb.json']);

for (const f of expected.manifests) {
  test(`schema on ${f.file}: ${f.about}`, () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, f.file), 'utf8'));
    assert.equal(validate(manifest), f.schema, JSON.stringify(validate.errors));
    // What the schema accepts, the server accepts, except the two things a schema cannot see.
    if (f.schema && f.server.status !== 201) assert.ok(CANNOT_SAY.has(f.file), `${f.file}: the schema accepts what the server refuses`);
    if (CANNOT_SAY.has(f.file)) assert.equal(f.server.status, 422);
  });
}

test('the limits are those of the device', () => {
  const items = schema.properties.items;
  assert.equal(items.maxItems, LIMITS.maxItems);
  assert.equal(schema.$defs.sound.properties.bytes.maximum, LIMITS.maxPackageBytes);
  assert.deepEqual(schema.$defs.sound.properties.role.enum, ROLES);
  assert.deepEqual(schema.$defs.sound.properties.kind.enum, ['loop', 'oneshot']);
  assert.deepEqual(schema.$defs.sound.required, ['file', 'bytes', 'sha256']);
});

test('the file name pattern takes exactly the names the device takes', () => {
  const pattern = new RegExp(schema.$defs.sound.properties.file.pattern, 'u');
  const names = ['kick.wav', 'KICK.WAV', 'Kick.Wav', 'my kick.wav', '0.wav', 'a.wav', '.wav', 'a..b.wav', '../a.wav', '-a.wav', ' a.wav', 'a.wav ', 'a.mp3', 'a.wave', 'a.b.wav', 'a_b-c.wav', 'é.wav', 'a/b.wav', 'a\\b.wav', 'kick.wav.part'];
  for (let n = 92; n <= 102; n++) names.push('k'.repeat(n) + '.wav', 'k'.repeat(n - 4) + '..' + '.wav');
  for (const name of names) assert.equal(pattern.test(name), isValidFileName(name), name);
});
