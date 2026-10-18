// The skill la2l-send-to-ableton (skills/) against this package: its form follows the Agent
// Skills specification, its links lead somewhere, every name it imports exists, its examples of a
// package description pass the checks, and its example test runs against the built package.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import * as la2l from '../dist/index.js';
import * as button from '../dist/button.js';
import * as testing from '../dist/testing/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = path.join(HERE, '..');
const REPO = path.join(PACKAGE, '..', '..');
const SKILLS = path.join(REPO, 'skills');
const SKILL = path.join(SKILLS, 'la2l-send-to-ableton');
const read = (file) => fs.readFileSync(file, 'utf8');
const files = fs.readdirSync(SKILL, { recursive: true }).map((f) => path.join(SKILL, f)).filter((f) => fs.statSync(f).isFile());
const text = read(path.join(SKILL, 'SKILL.md'));
const [, front, body] = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
const meta = YAML.parse(front);

test('SKILL.md follows the Agent Skills specification', () => {
  assert.equal(meta.name, path.basename(SKILL));
  assert.match(meta.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(meta.name.length <= 64);
  assert.ok(meta.description.length <= 1024, `the description has ${meta.description.length} characters`);
  assert.ok(meta.compatibility.length <= 500);
  assert.equal(meta.license, 'Apache-2.0');
  assert.ok(text.split('\n').length <= 500, 'SKILL.md has more than 500 lines');
  // So that tools find it: when to use it, and the words people use.
  assert.match(meta.description, /^Use when /);
  for (const words of ['Ableton Live', 'Send to Live', 'LA2L']) assert.ok(meta.description.includes(words), words);
  assert.deepEqual(Object.keys(meta).filter((k) => !['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'].includes(k)), []);
});

test('the plugin and the marketplace entry carry the version of the skill', () => {
  const plugin = JSON.parse(read(path.join(SKILLS, '.claude-plugin', 'plugin.json')));
  const market = JSON.parse(read(path.join(REPO, '.claude-plugin', 'marketplace.json')));
  assert.equal(plugin.version, meta.metadata.version);
  assert.deepEqual(plugin.skills, ['./']);
  const entry = market.plugins.find((p) => p.name === plugin.name);
  assert.equal(entry.version, plugin.version);
  assert.equal(path.resolve(REPO, entry.source), SKILLS);
});

test('every link of the skill leads to a file of the skill', () => {
  for (const file of files.filter((f) => f.endsWith('.md'))) {
    for (const [, target] of read(file).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      assert.ok(fs.existsSync(path.join(path.dirname(file), target.split('#')[0])), `${path.relative(SKILL, file)} links to ${target}`);
    }
  }
});

test('every name the skill, the developer pages, the paste text and the package docs import exists in the package', () => {
  const modules = { '@lloydstellar/la2l': la2l, '@lloydstellar/la2l/button': button, '@lloydstellar/la2l/testing': testing };
  const cdn = /^https:\/\/cdn\.jsdelivr\.net\/npm\/@lloydstellar\/la2l@[\d.]+\/dist\/button\.min\.js$/;
  const docs = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f));
  let count = 0;
  for (const file of [...files.filter((f) => /\.(md|html|m?js)$/.test(f)), ...docs(path.join(REPO, 'docs', 'developers')), ...docs(path.join(PACKAGE, 'docs')), path.join(PACKAGE, 'README.md')]) {
    for (const [, names, from] of read(file).matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
      // react, in the React example. The old name 'la2l' is not skipped: it is in no module, so it fails.
      if (!/^(@lloydstellar\/)?la2l(\/|$)/.test(from) && !/cdn\.jsdelivr\.net\/npm\/(@lloydstellar\/)?la2l@/.test(from)) continue;
      const mod = modules[from] || (cdn.test(from) ? button : null);
      assert.ok(mod, `${path.relative(SKILL, file)} imports from ${from}`);
      for (const name of names.split(',').map((n) => n.trim()).filter(Boolean)) {
        assert.ok(name in mod, `${path.relative(SKILL, file)}: ${from} has no ${name}`);
        count++;
      }
    }
  }
  assert.ok(count > 10);
});

test('the error codes of the skill are the codes of the package', () => {
  const codes = [...read(path.join(PACKAGE, 'src', 'errors.ts')).matchAll(/\| '([a-z_]+)'/g)].map((m) => m[1]).sort();
  const table = body.slice(body.indexOf('## 7. Errors'), body.indexOf('## Pitfalls'));
  const shown = [...table.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
  assert.deepEqual(codes.filter((c) => c !== 'aborted' && !shown.includes(c)), [], 'codes the skill does not explain');
  const api = read(path.join(SKILL, 'references', 'api.md'));
  const listed = api.slice(api.indexOf('Every error is a `La2lError`')).split('\n')[0];
  assert.deepEqual([...listed.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((c) => !['code', 'message', 'status', 'retryAfter'].includes(c)).sort(), codes);
});

test('the package description in references/manifest.md passes the checks, as the text says', () => {
  const md = read(path.join(SKILL, 'references', 'manifest.md'));
  const json = JSON.parse(md.match(/```json\n([\s\S]*?)```/)[1].replaceAll('"…"', `"${'0'.repeat(64)}"`));
  const check = la2l.checkManifest(json);
  assert.equal(check.ok, true, check.error);
  assert.deepEqual(check.warnings, []);
  assert.deepEqual(check.package.items.map((s) => `${s.name} (${check.package.app})`), ['Kick (Web808)', 'Robot hallo (Web808)']);
  const kick = la2l.planSound(check.package.items[0], check.package, (16 * 60) / 92);
  assert.deepEqual([kick.warp, kick.warpModeName, kick.bpm, kick.lengthBeats], [true, 'Beats', 92, 16]);
  assert.equal(la2l.planSound(check.package.items[1], check.package, 1.5).warp, false);
});

test('the package of the curl example in references/api.md passes the checks', () => {
  const md = read(path.join(SKILL, 'references', 'api.md'));
  const json = JSON.parse(md.match(/-d '(\{\n[\s\S]*?\})'/)[1].replace('<64 hex characters>', 'a'.repeat(64)));
  const check = la2l.checkManifest(json);
  assert.equal(check.ok, true, check.error);
  assert.deepEqual(check.warnings, []);
});

test('assets/check-with-test-receiver.mjs runs against the built package, as an app would run it', async () => {
  // A project of its own with the package in node_modules, so the example imports '@lloydstellar/la2l' as it says.
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'la2l-skill-'));
  try {
    fs.mkdirSync(path.join(project, 'node_modules', '@lloydstellar'), { recursive: true });
    fs.symlinkSync(PACKAGE, path.join(project, 'node_modules', '@lloydstellar', 'la2l'), 'dir');
    fs.copyFileSync(path.join(SKILL, 'assets', 'check-with-test-receiver.mjs'), path.join(project, 'check.mjs'));
    const { code, out, err } = await new Promise((resolve) => {
      execFile(process.execPath, ['check.mjs'], { cwd: project }, (error, out, err) => resolve({ code: error ? error.code : 0, out, err }));
    });
    assert.equal(code, 0, err);
    assert.match(out, /OK: Live would place it as a loop of 4 beats at 120 BPM\./);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('renderLoop of the skill is renderLoop of the page on Web apps, and returns the AudioBuffer', () => {
  const fn = (file) => read(file).match(/async function renderLoop[\s\S]*?\n}\n/)[0];
  const page = fn(path.join(REPO, 'docs', 'developers', 'web.md'));
  assert.equal(fn(path.join(SKILL, 'references', 'web.md')), page);
  assert.match(page, /\n  return loop;\n}\n$/);
  // Every call gives it the tempo, and makes the WAV itself.
  for (const file of [path.join(SKILL, 'SKILL.md'), path.join(REPO, 'docs', 'developers', 'button.md'), path.join(REPO, 'docs', 'developers', 'web.md')]) {
    const code = [...read(file).matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
    for (const [call] of code.matchAll(/renderLoop\([^)]*\)/g)) assert.match(call, /^renderLoop\((\d+|bpm), schedule\)$|^renderLoop\(bpm, schedule, tailSeconds = 1\)$/, `${path.relative(REPO, file)}: ${call}`);
  }
});

test('the Kotlin of the skill is the Kotlin of the developer page on Android', () => {
  const kotlin = (file) => [...read(file).matchAll(/```kotlin\n([\s\S]*?)```/g)].map((m) => m[1]);
  const page = kotlin(path.join(REPO, 'docs', 'developers', 'android.md'));
  assert.ok(page.length >= 2);
  assert.deepEqual(kotlin(path.join(SKILL, 'references', 'android.md')), page);
});
