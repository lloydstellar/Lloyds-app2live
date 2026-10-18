// la2l agents-md: the index of the docs in AGENTS.md and CLAUDE.md, written once, replaced on a
// new run, and never in the way of what the files held before.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = path.join(HERE, '..');
const CLI = path.join(PACKAGE, 'dist', 'cli', 'main.js');
const VERSION = JSON.parse(fs.readFileSync(path.join(PACKAGE, 'package.json'), 'utf8')).version;
const DOCS = fs.readdirSync(path.join(PACKAGE, 'docs')).filter((f) => f.endsWith('.md'));

const projects = [];
test.after(() => projects.forEach((p) => fs.rmSync(p, { recursive: true, force: true })));

// A project folder, with @lloydstellar/la2l in node_modules unless `installed` is false.
function project({ installed = true, files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la2l-agents-'));
  projects.push(dir);
  if (installed) {
    fs.mkdirSync(path.join(dir, 'node_modules', '@lloydstellar'), { recursive: true });
    fs.symlinkSync(PACKAGE, path.join(dir, 'node_modules', '@lloydstellar', 'la2l'), 'dir');
  }
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

function la2l(args, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd }, (error, out, err) => resolve({ code: error ? error.code : 0, out, err }));
  });
}

const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');
const block = (text) => text.slice(text.indexOf('<!-- BEGIN la2l docs index'), text.indexOf('<!-- END la2l docs index -->') + 28);

test('a new AGENTS.md with an index of every doc, pointing to node_modules/@lloydstellar/la2l/docs', async () => {
  const dir = project();
  const r = await la2l(['agents-md'], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Wrote the index of the la2l docs \(\d\.\d KB\) to AGENTS\.md\. It points to node_modules\/@lloydstellar\/la2l\/docs\/\n$/);
  const text = read(dir, 'AGENTS.md');
  assert.equal(block(text) + '\n', text);
  assert.ok(text.includes('Docs: node_modules/@lloydstellar/la2l/docs/'));
  assert.ok(text.includes(`with @lloydstellar/la2l ${VERSION}.`));
  for (const doc of DOCS) {
    assert.ok(text.includes(`\n|${doc}: `), doc);
    assert.ok(fs.existsSync(path.join(dir, 'node_modules', '@lloydstellar', 'la2l', 'docs', doc)));
  }
  assert.ok(text.indexOf('|getting-started.md') < text.indexOf('|api.md'));
  assert.ok(Buffer.byteLength(text) < 8192, 'a few KB at most');
  assert.ok(!/[–—]/.test(text), 'no dashes as punctuation');
  assert.equal(fs.existsSync(path.join(dir, 'CLAUDE.md')), false, 'no CLAUDE.md of its own');
});

test('a second run replaces the index and keeps the rest of AGENTS.md and CLAUDE.md', async () => {
  const dir = project({ files: { 'AGENTS.md': '# Agents\n\nUse tabs.\n', 'CLAUDE.md': '# Claude\n\nBe brief.' } });
  assert.equal((await la2l(['agents-md'], dir)).code, 0);
  const first = { agents: read(dir, 'AGENTS.md'), claude: read(dir, 'CLAUDE.md') };
  assert.ok(first.agents.startsWith('# Agents\n\nUse tabs.\n\n<!-- BEGIN la2l docs index'));
  assert.ok(first.claude.startsWith('# Claude\n\nBe brief.\n\n<!-- BEGIN la2l docs index'));
  assert.equal(block(first.agents), block(first.claude));
  // Someone writes below the index, and the index gets old.
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), first.agents.replace('with @lloydstellar/la2l', 'with @lloydstellar/la2l OLD') + '\nMore rules.\n');
  const r = await la2l(['agents-md'], dir);
  assert.equal(r.code, 0);
  assert.match(r.out, /to AGENTS\.md and CLAUDE\.md\./);
  assert.equal(read(dir, 'AGENTS.md'), first.agents + '\nMore rules.\n');
  assert.equal(read(dir, 'CLAUDE.md'), first.claude);
});

test('a CLAUDE.md that imports AGENTS.md in a sentence is left alone too, and @.AGENTS.md is no import', async () => {
  const inline = project({ files: { 'CLAUDE.md': '# Claude\n\nRead @AGENTS.md first.\n' } });
  assert.match((await la2l(['agents-md'], inline)).out, /CLAUDE\.md reads AGENTS\.md already/);
  assert.equal(read(inline, 'CLAUDE.md'), '# Claude\n\nRead @AGENTS.md first.\n');
  const other = project({ files: { 'CLAUDE.md': '# Claude\n\nSee @.AGENTS.md and @docs/AGENTS.md.\n' } });
  assert.match((await la2l(['agents-md'], other)).out, /to AGENTS\.md and CLAUDE\.md\./);
});

test('a CLAUDE.md that reads AGENTS.md already is left as it was', async () => {
  const dir = project({ files: { 'CLAUDE.md': '@AGENTS.md\n\nMore for Claude.\n' } });
  const r = await la2l(['agents-md'], dir);
  assert.equal(r.code, 0);
  assert.match(r.out, /\nCLAUDE\.md reads AGENTS\.md already \(@AGENTS\.md\), so it was left as it was\.\n$/);
  assert.equal(read(dir, 'CLAUDE.md'), '@AGENTS.md\n\nMore for Claude.\n');
  assert.ok(read(dir, 'AGENTS.md').includes('Docs: node_modules/@lloydstellar/la2l/docs/'));
});

test('without @lloydstellar/la2l in the project the index points to the docs of this version online', async () => {
  const dir = project({ installed: false });
  const r = await la2l(['agents-md', dir], os.tmpdir());
  assert.equal(r.code, 0);
  assert.match(r.out, /@lloydstellar\/la2l is not installed in this folder, so the index points to the docs online\. After npm install @lloydstellar\/la2l, run this again to point it at node_modules\/@lloydstellar\/la2l\/docs\/\./);
  assert.ok(read(dir, 'AGENTS.md').includes(`Docs: https://cdn.jsdelivr.net/npm/@lloydstellar/la2l@${VERSION}/docs/`));
});

test('Windows line endings stay Windows line endings', async () => {
  const dir = project({ files: { 'AGENTS.md': '# Agents\r\n\r\nUse tabs.\r\n' } });
  assert.equal((await la2l(['agents-md'], dir)).code, 0);
  const text = read(dir, 'AGENTS.md');
  assert.ok(text.includes('<!-- END la2l docs index -->\r\n'));
  assert.equal(text.replace(/\r\n/g, '').includes('\n'), false, 'no bare line feed');
});

test('a half index, a missing folder or two folders: nothing is written', async () => {
  const half = '# Agents\n\n<!-- BEGIN la2l docs index: npx la2l agents-md writes this part, and a new run replaces it -->\nold\n';
  const dir = project({ files: { 'AGENTS.md': half, 'CLAUDE.md': '# Claude\n' } });
  const r = await la2l(['agents-md'], dir);
  assert.equal(r.code, 1);
  assert.equal(r.err, 'AGENTS.md has the first line of the la2l docs index but not its last line, <!-- END la2l docs index -->. Add it or remove the first line, then run this again.\n');
  assert.equal(read(dir, 'AGENTS.md'), half);
  assert.equal(read(dir, 'CLAUDE.md'), '# Claude\n', 'CLAUDE.md is not written either');
  const missing = await la2l(['agents-md', path.join(dir, 'nothing')], dir);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /^There is no folder /);
  assert.equal((await la2l(['agents-md', dir, dir], dir)).code, 2);
});
