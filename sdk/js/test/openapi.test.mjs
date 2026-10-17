// docs/openapi.yaml against the real server (server/src, started in this process): every path
// and method in the spec is answered (never with 404 or 405), every app route of the server is
// in the spec, and every error text in the spec is one the server's code can give. The linter
// (npm run lint) checks the file itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const spec = YAML.parse(fs.readFileSync(path.join(ROOT, 'docs', 'openapi.yaml'), 'utf8'));
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

const operations = [];
for (const [p, item] of Object.entries(spec.paths)) {
  for (const m of METHODS) if (item[m]) operations.push({ method: m.toUpperCase(), path: p, op: item[m] });
}

test('the spec has the version of the server', () => {
  assert.equal(spec.info.version, require(path.join(ROOT, 'server', 'package.json')).version);
  assert.deepEqual(spec.servers.map((s) => s.url), ['https://lloydstellar.nl/la2l/api']);
});

test('every app route of the server is in the spec, and nothing else', () => {
  const routes = [];
  for (const file of ['app.js', 'packages.js']) {
    const source = fs.readFileSync(path.join(ROOT, 'server', 'src', 'routes', file), 'utf8');
    for (const m of source.matchAll(/router\.add\(\s*'([A-Z]+)',\s*'\/api([^']+)'/g)) routes.push(`${m[1]} ${m[2].replace(/:(\w+)/g, (_, n) => `{${n === 'id' ? 'package_id' : n}}`)}`);
  }
  routes.push('GET /health');
  assert.deepEqual(operations.map((o) => `${o.method} ${o.path}`).sort(), routes.sort());
});

test('every operation in the spec is answered by the real server', async () => {
  const { startServer, pairStart, packageManifest } = require(path.join(ROOT, 'server', 'test', 'helpers.js'));
  const s = await startServer();
  try {
    const wav = fs.readFileSync(path.join(ROOT, 'sdk', 'fixtures', 'wav', 'pcm16-mono.wav'));
    const start = await pairStart(s, 'openapi-test');
    const values = {};
    let token = null;
    // In the order an app makes the calls, so each one is a real answer, not a 404 for an id
    // that does not exist.
    const ORDER = ['getHealth', 'claimPairing', 'getMe', 'createPackage', 'uploadFile', 'commitPackage', 'getPackageStatus', 'deletePackage', 'unpairApp'];
    assert.deepEqual(operations.map((o) => o.op.operationId).sort(), [...ORDER].sort(), 'every operation has its place in ORDER');
    const bodies = {
      claimPairing: () => ({ code: start.code, app_name: 'OpenAPI test', app_id: 'openapi-1' }),
      createPackage: () => packageManifest([{ file: 'loop.wav', data: wav, kind: 'loop' }]),
      uploadFile: () => wav,
    };
    for (const id of ORDER) {
      const o = operations.find((x) => x.op.operationId === id);
      const url = '/api' + o.path.replace(/\{(\w+)\}/g, (_, name) => encodeURIComponent(values[name]));
      const secured = o.op.security ? o.op.security.length > 0 : spec.security.length > 0;
      const body = bodies[id] ? bodies[id]() : undefined;
      const r = await s.request(o.method, url, { token: secured ? token : undefined, body, headers: { 'X-LA2L-Client': 'openapi-test/1.0 (spec)' } });
      assert.ok(r.status !== 404 && r.status !== 405, `${o.method} ${o.path}: ${r.status} ${r.body}`);
      assert.ok(Object.keys(o.op.responses).includes(String(r.status)), `${o.method} ${o.path}: ${r.status} is not in the spec`);
      if (id === 'claimPairing') token = r.json.app_token;
      if (id === 'createPackage') Object.assign(values, { package_id: r.json.package_id, file: 'loop.wav' });
    }
  } finally {
    await s.stop();
  }
});

test('every call with a JSON body answers a wrong body with a status the spec lists', async () => {
  const { startServer, pairStart } = require(path.join(ROOT, 'server', 'test', 'helpers.js'));
  const s = await startServer();
  try {
    const start = await pairStart(s, 'openapi-errors');
    const token = (await s.request('POST', '/api/pair/claim', { body: { code: start.code, app_name: 'OpenAPI test' } })).json.app_token;
    const created = await s.request('POST', '/api/packages', { token, body: { schema: 'app2live/1', items: [{ file: 'a.wav', bytes: 10, sha256: 'a'.repeat(64), kind: 'loop' }] } });
    const values = { package_id: created.json.package_id, file: 'a.wav' };
    const json = operations.filter((o) => o.op.requestBody && o.op.requestBody.content['application/json']);
    assert.ok(json.length >= 4);
    for (const o of json) {
      const url = '/api' + o.path.replace(/\{(\w+)\}/g, (_, name) => values[name]);
      const secured = o.op.security ? o.op.security.length > 0 : true;
      for (const [headers, body] of [[{ 'Content-Type': 'text/plain' }, 'hello'], [{ 'Content-Type': 'application/json' }, '{not json'], [{ 'Content-Type': 'application/json' }, '[1]']]) {
        const r = await s.request(o.method, url, { token: secured ? token : undefined, headers, body });
        assert.ok(Object.keys(o.op.responses).includes(String(r.status)), `${o.method} ${o.path} with ${headers['Content-Type']} ${body}: ${r.status} is not in the spec`);
      }
    }
    // The health check has no rate limit, so its spec lists no 429.
    assert.equal(spec.paths['/health'].get.responses['429'], undefined);
  } finally {
    await s.stop();
  }
});

// ---- error texts ----

// The string and template literals of a JavaScript file. A small lexer: comments, regular
// expressions and nested ${...} in templates are skipped properly, so a quote in a regex never
// starts a string. Templates come back with their ${...} parts as null.
function literals(source) {
  const out = [];
  let i = 0;
  let last = ''; // the last significant character, to tell a regex from a division
  const regexCanStart = () => last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last) || /\b(return|typeof|case|do|else|in|of|new|delete|void|throw)$/.test(source.slice(Math.max(0, i - 8), i).trimEnd());
  function template() {
    const parts = [];
    let text = '';
    i++; // the backtick
    while (i < source.length && source[i] !== '`') {
      if (source[i] === '\\') {
        text += source[i + 1];
        i += 2;
      } else if (source[i] === '$' && source[i + 1] === '{') {
        parts.push(text, null);
        text = '';
        i += 2;
        let depth = 1;
        while (i < source.length && depth) {
          if (source[i] === '`') template();
          else if (source[i] === "'" || source[i] === '"') quoted();
          else {
            if (source[i] === '{') depth++;
            if (source[i] === '}') depth--;
            i++;
          }
        }
      } else text += source[i++];
    }
    i++;
    parts.push(text);
    out.push(parts);
  }
  function quoted() {
    const q = source[i++];
    let text = '';
    while (i < source.length && source[i] !== q) {
      if (source[i] === '\\') {
        text += source[i + 1];
        i += 2;
      } else text += source[i++];
    }
    i++;
    out.push([text]);
  }
  while (i < source.length) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') i = source.indexOf('\n', i) < 0 ? source.length : source.indexOf('\n', i);
    else if (c === '/' && source[i + 1] === '*') i = source.indexOf('*/', i) + 2;
    else if (c === "'" || c === '"') {
      quoted();
      last = 'a';
    } else if (c === '`') {
      template();
      last = 'a';
    } else if (c === '/' && regexCanStart()) {
      i++;
      let inClass = false;
      while (i < source.length && (source[i] !== '/' || inClass)) {
        if (source[i] === '\\') i++;
        else if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        i++;
      }
      i++;
      while (/[a-z]/.test(source[i])) i++;
      last = 'a';
    } else {
      if (!/\s/.test(c)) last = c;
      i++;
    }
  }
  return out;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sources = [
  ...fs.readdirSync(path.join(ROOT, 'server', 'src'), { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => path.join(ROOT, 'server', 'src', f)),
  path.join(ROOT, 'src', 'node', 'manifest.js'),
  path.join(ROOT, 'src', 'node', 'wav.js'),
];
// Every literal as a pattern: the ${...} parts may be anything. Kept only with at least 10
// characters of fixed text, so `${name} ${error}` matches nothing on its own.
const patterns = sources
  .flatMap((f) => literals(fs.readFileSync(f, 'utf8')))
  .map((parts) => ({ fixed: parts.filter((p) => p !== null).join('').length, re: new RegExp('^' + parts.map((p) => (p === null ? '.+' : escape(p))).join('') + '$', 's') }))
  .filter((p) => p.fixed >= 10);

function fromServer(text) {
  if (patterns.some((p) => p.re.test(text))) return true;
  // The server's text for a sound with a problem is `${item.name} ${item.error}`, where the
  // error is one of the device's texts: "Kick has no valid file name".
  const words = text.split(' ');
  for (let k = 1; k < words.length; k++) if (patterns.some((p) => p.re.test(words.slice(k).join(' ')))) return true;
  return false;
}

// The error texts of the spec: the examples of every 4xx and 5xx answer. (A status answer also
// holds texts, per sound, but those come from LA2L in Live, not from the server.)
function errorTexts() {
  const found = [];
  const collect = (response) => {
    for (const media of Object.values((response && response.content) || {})) {
      for (const example of Object.values(media.examples || {})) if (typeof example.value.error === 'string') found.push(example.value.error);
    }
  };
  for (const { op } of operations) for (const [code, response] of Object.entries(op.responses)) if (code >= '400' && !response.$ref) collect(response);
  for (const response of Object.values(spec.components.responses)) collect(response);
  return found;
}

test('the lexer finds the literals it should', () => {
  const found = literals("const a = 'x\\'y'; const r = /\"`'/g; const t = `a ${b ? 'c' : `d ${e}`} f`; // 'no'\n/* \"no\" */ x = 4 / 2 / 1;");
  assert.deepEqual(found, [["x'y"], ['c'], ['d ', null, ''], ['a ', null, ' f']]);
});

test('every error text in the spec is one the server can give', () => {
  const texts = [...new Set(errorTexts())];
  assert.ok(texts.length >= 35, `only ${texts.length} texts found`);
  const unknown = texts.filter((t) => !fromServer(t));
  assert.deepEqual(unknown, []);
  // And a text the server never gives is not taken for one.
  for (const invented of ['The server is on holiday. Try again in May.', 'Kick has a bad colour', 'Unknown package!']) assert.equal(fromServer(invented), false, invented);
  for (const t of texts) assert.ok(t.length <= 80, `${t}: longer than 80 characters`);
});

test('the request example of POST /packages is a valid manifest', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'app2live-1.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const examples = spec.paths['/packages'].post.requestBody.content['application/json'].examples;
  for (const [name, example] of Object.entries(examples)) assert.ok(validate(example.value), `${name}: ${JSON.stringify(validate.errors)}`);
});
