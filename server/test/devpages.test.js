'use strict';
// The developer pages: the converter of tools/devpages.js, the committed pages it made, and how the
// server serves them, with every link on them leading somewhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer } = require('./helpers');
const { markdown, build, PAGES } = require('../../tools/devpages');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'server', 'public', 'developers');
const SITE = 'https://lloydstellar.nl/la2l/';

test('the converter: headings, paragraphs, lists, tables, code and links', () => {
  const md = [
    '# The `la2l` page',
    '',
    'A **bold** start with `<la2l-send-button>` and [a page](web.md#errors),',
    'on two lines, and https://lloydstellar.nl/la2l/receiver.',
    '',
    '## Two & three',
    '',
    '- one',
    '  more of one',
    '',
    '- two with `a | b`',
    '',
    '1. first',
    '2. second',
    '',
    '| Field | What |',
    '|---|---|',
    '| `kind` | `loop` or `oneshot` |',
    '',
    '> A quote',
    '',
    '```js',
    'if (a < b) x = "<b>";',
    '```',
  ].join('\n');
  const { title, description, html } = markdown(md, 'test.md', (href) => href.replace('.md', ''));
  assert.equal(title, 'The la2l page');
  assert.equal(description, 'A bold start with <la2l-send-button> and a page, on two lines, and https://lloydstellar.nl/la2l/receiver.');
  assert.equal(
    html,
    [
      '<h1 id="the-la2l-page">The <code>la2l</code> page</h1>',
      '<p>A <strong>bold</strong> start with <code>&lt;la2l-send-button&gt;</code> and <a href="web#errors">a page</a>, on two lines, and <a href="https://lloydstellar.nl/la2l/receiver">https://lloydstellar.nl/la2l/receiver</a>.</p>',
      '<h2 id="two-three">Two &amp; three</h2>',
      '<ul>\n<li>one more of one</li>\n<li>two with <code>a | b</code></li>\n</ul>',
      '<ol>\n<li>first</li>\n<li>second</li>\n</ol>',
      '<div class="table"><table>\n<thead><tr><th>Field</th><th>What</th></tr></thead>\n<tbody>\n<tr><td><code>kind</code></td><td><code>loop</code> or <code>oneshot</code></td></tr>\n</tbody>\n</table></div>',
      '<blockquote><p>A quote</p></blockquote>',
      '<pre><code class="language-js">if (a &lt; b) x = &quot;&lt;b&gt;&quot;;</code></pre>',
    ].join('\n')
  );
});

test('the converter stops at what it does not know, with the line', () => {
  const bad = {
    '# A\n\n- one\n  - two\n': 'test.md:4: a list inside a list',
    '# A\n\nSome <b>HTML</b>\n': 'test.md:3: HTML outside a code span',
    '# A\n\nA `code span\n': 'test.md:3: a ` without its end',
    '# A\n\n| a | b |\n| c | d |\n': 'test.md:3: a table without its |---| line',
    '# A\n\n# B\n': 'test.md:3: a second # heading',
    'No heading\n': 'test.md: no # heading',
    '# A\n\n```js\nnever closed\n': 'test.md:3: a code block without its end',
    '# A\n\n[a link](a b)\n': 'test.md:3: a link to "a b"',
    '# A\n\n| a | b |\n|---|---|\n| c |\n': 'test.md:3: a table row with 1 cells instead of 2',
    '# A\n\n    indented\n': 'test.md:3: an indented line outside a list or code block',
  };
  for (const [md, message] of Object.entries(bad)) assert.throws(() => markdown(md, 'test.md'), { message }, md);
});

test('server/public/developers is what docs/developers makes, and nothing else', () => {
  const made = build();
  assert.deepEqual(fs.readdirSync(OUT).sort(), Object.keys(made).sort());
  for (const [name, text] of Object.entries(made)) assert.equal(fs.readFileSync(path.join(OUT, name), 'utf8'), text, `${name}: run node tools/devpages.js`);
  // The privacy statement waits for Erik's approval (sdk/BUILD-PROMPT.md, 10.4).
  assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'developers', 'privacy.md')));
  assert.equal(PAGES.some(([name]) => name === 'privacy'), false);
});

let s;
test.before(async () => {
  s = await startServer();
});
test.after(() => s.stop());

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

test('every page, its Markdown twin, llms.txt and the machine-readable files are served, kept out of search engines', async () => {
  const expect = { '/developers/': 'text/html; charset=utf-8', '/llms.txt': 'text/plain; charset=utf-8', '/llms-full.txt': 'text/plain; charset=utf-8' };
  for (const [name] of PAGES) {
    if (name !== 'index') expect[`/developers/${name}`] = 'text/html; charset=utf-8';
    expect[`/developers/${name}.md`] = 'text/markdown; charset=utf-8';
  }
  expect['/developers/openapi.yaml'] = 'application/yaml; charset=utf-8';
  expect['/developers/app2live-1.schema.json'] = 'application/json; charset=utf-8';
  expect['/developers/style.css'] = 'text/css; charset=utf-8';
  for (const [p, type] of Object.entries(expect)) {
    const r = await s.request('GET', p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers['content-type'], type, p);
    assert.equal(r.headers['content-security-policy'], CSP, p);
    assert.equal(r.headers['x-robots-tag'], 'noindex', p);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
  }
  for (const [name] of PAGES) {
    const md = (await s.request('GET', `/developers/${name}.md`)).body.toString();
    assert.equal(md, fs.readFileSync(path.join(ROOT, 'docs', 'developers', `${name}.md`), 'utf8'));
    const page = (await s.request('GET', name === 'index' ? '/developers/' : `/developers/${name}`)).body.toString();
    assert.doesNotMatch(page, /style=|<style|<script/, `${name}: nothing inline, the CSP would block it`);
  }
  assert.equal((await s.request('GET', '/developers/openapi.yaml')).body.toString(), fs.readFileSync(path.join(ROOT, 'docs', 'openapi.yaml'), 'utf8'));
  const r = await s.request('GET', '/developers');
  assert.deepEqual([r.status, r.headers.location], [301, 'developers/']);
  for (const p of ['/developers/web.html', '/developers/web/', '/developers/privacy', '/developers/privacy.md', '/privacy', '/developers/../sender.js', '/developers/index', '/developers/README.md']) {
    assert.equal((await s.request('GET', p)).status, 404, p);
  }
  // The Sender and the receiver stay as search engines see them now.
  assert.equal((await s.request('GET', '/')).headers['x-robots-tag'], undefined);
});

// The path on this test server for a link on a page at `from`, or null for a link elsewhere.
function local(href, from) {
  const url = new URL(href.startsWith(SITE) ? href.slice(SITE.length - 1) : href, 'http://test' + from);
  return url.host === 'test' ? url.pathname : null;
}

test('every link and image on the pages, in the Markdown twins and in llms.txt leads somewhere', async () => {
  const checked = new Map();
  const ok = async (p) => {
    if (!checked.has(p)) checked.set(p, (await s.request('GET', p)).status);
    return checked.get(p);
  };
  const sources = [['/llms.txt', /\]\(([^)\s]+)\)/g], ['/llms-full.txt', /\]\(([^)\s]+)\)/g]];
  for (const [name] of PAGES) {
    sources.push([name === 'index' ? '/developers/' : `/developers/${name}`, /(?:href|src)="([^"]+)"/g]);
    sources.push([`/developers/${name}.md`, /\]\(([^)\s]+)\)/g]);
  }
  let links = 0;
  for (const [from, pattern] of sources) {
    const text = (await s.request('GET', from)).body.toString();
    for (const [, href] of text.matchAll(pattern)) {
      if (href.startsWith('#')) continue;
      const p = local(href.replace(/&amp;/g, '&'), from);
      if (p === null) continue;
      links++;
      const status = await ok(p);
      assert.ok(status === 200 || status === 301, `${from} links to ${href}: ${status}`);
    }
  }
  assert.ok(links > 100, `${links} links`);
});
