'use strict';
// LA2L's Maven repository at /la2l/maven/ (src/maven.js): the files deploy/maven-sync.sh puts in
// MAVEN_DIR, with the right types and caching, and nothing else. deploy/maven-sync.sh itself is
// tested by hand on a scratch container (server/README.md, The Maven repository).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('./helpers');

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";
const LIB = '/maven/nl/lloydstellar/la2l';

let s;
let maven;
let outside;
test.before(async () => {
  maven = fs.mkdtempSync(path.join(os.tmpdir(), 'la2l-maven-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'la2l-outside-'));
  const put = (name, text) => {
    fs.mkdirSync(path.dirname(path.join(maven, name)), { recursive: true });
    fs.writeFileSync(path.join(maven, name), text);
  };
  put('signing-key.asc', '-----BEGIN PGP PUBLIC KEY BLOCK-----\n');
  put('nl/lloydstellar/la2l/maven-metadata.xml', '<metadata/>\n');
  put('nl/lloydstellar/la2l/maven-metadata.xml.sha256', 'abc');
  put('nl/lloydstellar/la2l/0.1.0/la2l-0.1.0.aar', 'aar');
  put('nl/lloydstellar/la2l/0.1.0/la2l-0.1.0.aar.asc', 'signature');
  put('nl/lloydstellar/la2l/0.1.0/la2l-0.1.0.pom', '<project/>\n');
  put('nl/lloydstellar/la2l/0.1.0/la2l-0.1.0.module', '{}\n');
  put('nl/lloydstellar/la2l/0.1.0/la2l-0.1.0-sources.jar', 'jar');
  put('nl/lloydstellar/la2l/0.1.0/notes.txt', 'not a Maven file');
  put('nl/lloydstellar/other/0.1.0/other-0.1.0.pom', '<project/>\n');
  fs.writeFileSync(path.join(outside, 'secret.pom'), 'outside');
  fs.symlinkSync(path.join(outside, 'secret.pom'), path.join(maven, 'nl/lloydstellar/la2l/0.1.0/la2l-0.1.0-link.pom'));
  fs.mkdirSync(path.join(maven, 'nl/lloydstellar/la2l-ktx'));
  fs.symlinkSync(outside, path.join(maven, 'nl/lloydstellar/la2l-ktx/0.1.0'));
  fs.writeFileSync(path.join(outside, 'la2l-ktx-0.1.0.pom'), 'outside');
  s = await startServer({ MAVEN_DIR: maven });
});
test.after(async () => {
  await s.stop();
  fs.rmSync(maven, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('the files of a version are served with their type and kept for a year; the metadata and the key are asked for every time', async () => {
  const expect = {
    [`${LIB}/0.1.0/la2l-0.1.0.aar`]: ['application/octet-stream', 'aar'],
    [`${LIB}/0.1.0/la2l-0.1.0.aar.asc`]: ['text/plain; charset=utf-8', 'signature'],
    [`${LIB}/0.1.0/la2l-0.1.0.pom`]: ['application/xml; charset=utf-8', '<project/>\n'],
    [`${LIB}/0.1.0/la2l-0.1.0.module`]: ['application/json; charset=utf-8', '{}\n'],
    [`${LIB}/0.1.0/la2l-0.1.0-sources.jar`]: ['application/java-archive', 'jar'],
  };
  for (const [p, [type, body]] of Object.entries(expect)) {
    const r = await s.request('GET', p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers['content-type'], type, p);
    assert.equal(r.body.toString(), body, p);
    assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable', p);
    assert.equal(r.headers['x-robots-tag'], 'noindex', p);
    assert.equal(r.headers['content-security-policy'], CSP, p);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
    const again = await s.request('GET', p, { headers: { 'If-None-Match': r.headers.etag } });
    assert.equal(again.status, 304, p);
    const head = await s.request('HEAD', p);
    assert.deepEqual([head.status, head.headers['content-length'], head.body.length], [200, String(body.length), 0], p);
  }
  for (const p of [`${LIB}/maven-metadata.xml`, `${LIB}/maven-metadata.xml.sha256`, '/maven/signing-key.asc']) {
    const r = await s.request('GET', p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers['cache-control'], 'no-cache', p);
  }
  assert.equal((await s.request('POST', `${LIB}/0.1.0/la2l-0.1.0.pom`)).status, 405);
});

test('the folder says what it is; everything else is a 404, also a link out of the folder', async () => {
  const index = await s.request('GET', '/maven/');
  assert.equal(index.status, 200);
  assert.match(index.body.toString(), /maven \{ url = uri\("https:\/\/lloydstellar\.nl\/la2l\/maven\/"\) \}/);
  const r = await s.request('GET', '/maven');
  assert.deepEqual([r.status, r.headers.location], [301, 'maven/']);
  for (const p of [
    `${LIB}/0.1.0/notes.txt`,
    `${LIB}/0.1.0/`,
    `${LIB}/0.1.0`,
    `${LIB}/`,
    '/maven/nl/lloydstellar/other/0.1.0/other-0.1.0.pom',
    `${LIB}/0.1.0/la2l-0.1.0-link.pom`,
    '/maven/nl/lloydstellar/la2l-ktx/0.1.0/la2l-ktx-0.1.0.pom',
    `${LIB}/0.1.0/../../../../signing-key.asc`,
    `${LIB}/0.1.0/%2e%2e/la2l-0.1.0.pom`,
    `${LIB}/0.1.0/.la2l-0.1.0.pom`,
    '/maven/../package.json',
    '/maven/nl/lloydstellar/la2l/0.1.0/la2l-0.1.0.aar/',
  ]) {
    const res = await s.request('GET', p);
    assert.equal(res.status, 404, p);
    assert.equal(res.headers['x-robots-tag'], 'noindex', p);
  }
});

test('without a repository, /maven/ is a 404 too', async () => {
  const empty = await startServer({ MAVEN_DIR: path.join(os.tmpdir(), 'la2l-no-such-folder') });
  try {
    for (const p of ['/maven/', '/maven/signing-key.asc', `${LIB}/0.1.0/la2l-0.1.0.pom`]) assert.equal((await empty.request('GET', p)).status, 404, p);
  } finally {
    await empty.stop();
  }
});
