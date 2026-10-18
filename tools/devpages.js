'use strict';
// Makes the developer pages that la2l-server serves under /la2l/developers/ from their sources in
// docs/developers: an HTML page and a Markdown twin per page, llms.txt and llms-full.txt, and
// copies of the OpenAPI file and the JSON Schema. The output in server/public/developers is
// committed, as server/public/vendor is, so the server needs no build step.
// Usage: node tools/devpages.js           write the pages
//        node tools/devpages.js --check   only check that the committed pages are up to date (CI)
// Only Node is needed. The Markdown it reads is a small part of GitHub's: # to ### headings,
// paragraphs, "-" and "1." lists of one level, tables, quotes, ``` code blocks, and inline code,
// **bold**, links and bare https addresses. It stops at what would show up differently: other list
// marks, deeper headings, ~~~ fences, images, *emphasis*, HTML and HTML comments, a list inside a
// list, an ordered list that does not start at 1, and links other than http(s), mailto or relative.
// An underscore is always just an underscore.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCES = path.join(ROOT, 'docs', 'developers');
const OUT = path.join(ROOT, 'server', 'public', 'developers');
// Where the pages are online, for llms.txt and llms-full.txt, which tools read out of context.
const SITE = 'https://lloydstellar.nl/la2l/';
const BASE = SITE + 'developers/';

// The pages in the order of the menu: source, label in the menu, line in llms.txt. A source that
// is not here is not published: privacy.md waits for Erik's approval (sdk/BUILD-PROMPT.md, 10.4).
const PAGES = [
  ['index', 'Start', 'What LA2L does, the ways in, how pairing and sending go, the limits'],
  ['web', 'Web apps', 'The npm package la2l: pairing, WAV files from Web Audio, sending and following a package, errors'],
  ['button', 'The button', 'The <la2l-send-button> web component, in a page or a framework, and the brand rules'],
  ['android', 'Android', 'Sending from Kotlin or Java with the REST API'],
  ['sharing', 'Sharing', 'An Android app shares WAV files with LA2L Sender, the installed web app, with the description in the text'],
  ['rest-api', 'REST API', 'The five HTTPS calls, with curl; the command line npx la2l; the rules for errors and limits'],
  ['manifest', 'Package description', 'Every field of the app2live/1 description, and what LA2L does with it'],
  ['testing', 'Testing', 'The test receiver: a page, a terminal command, and startTestReceiver() for automated tests'],
  ['ai-tools', 'AI tools', 'The skill la2l-send-to-ableton, npx la2l agents-md, the paste text, llms.txt'],
  ['paste-text', null, 'A text to paste into the knowledge of Lovable or Bolt: the rules and examples on one page'],
];
const COPIES = [
  [path.join(ROOT, 'docs', 'openapi.yaml'), 'openapi.yaml'],
  [path.join(ROOT, 'docs', 'app2live-1.schema.json'), 'app2live-1.schema.json'],
  [path.join(__dirname, 'devpages.css'), 'style.css'],
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- Markdown ----

function fail(where, message) {
  throw new Error(`${where}: ${message}`);
}

// Inline: `code`, **bold**, [text](address) and bare https:// addresses. link() rewrites an address.
function inline(s, where, link, inLink = false) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      const ticks = '`'.repeat(n);
      const end = s.indexOf(ticks, i + n);
      if (end < 0) fail(where, 'a ` without its end');
      let code = s.slice(i + n, end);
      if (n > 1 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1);
      out += `<code>${esc(code)}</code>`;
      i = end + n;
      continue;
    }
    if (s[i] === '[' && !inLink) {
      const close = closing(s, i, where);
      if (close > 0 && s[close + 1] === '(') {
        const end = s.indexOf(')', close + 2);
        if (end < 0) fail(where, 'a link without its )');
        const href = s.slice(close + 2, end);
        if (!href || /\s/.test(href)) fail(where, `a link to "${href}"`);
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^(https?|mailto):/i.test(href)) fail(where, `a link to "${href}": only http(s), mailto and relative links`);
        out += `<a href="${esc(link(href))}">${inline(s.slice(i + 1, close), where, link, true)}</a>`;
        i = end + 1;
        continue;
      }
    }
    if (s.startsWith('**', i)) {
      const end = s.indexOf('**', i + 2);
      if (end < 0) fail(where, 'a ** without its end');
      out += `<strong>${inline(s.slice(i + 2, end), where, link, inLink)}</strong>`;
      i = end + 2;
      continue;
    }
    if (s[i] === '*') fail(where, 'a single *: use **bold**, or put it in a code span');
    if (s.startsWith('![', i)) fail(where, 'an image');
    const bare = !inLink && /^https?:\/\/[^\s<>()"'`]+/.exec(s.slice(i));
    if (bare) {
      const href = bare[0].replace(/[.,:;!?]+$/, '');
      out += `<a href="${esc(href)}">${esc(href)}</a>`;
      i += href.length;
      continue;
    }
    if (s[i] === '<' && /^<(\/?[a-z]|!)/i.test(s.slice(i))) fail(where, 'HTML outside a code span');
    out += esc(s[i]);
    i++;
  }
  return out;
}

// The ] that closes the [ at i, past code spans and nested brackets; -1 when there is none.
function closing(s, i, where) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '`') {
      const end = s.indexOf('`', j + 1);
      if (end < 0) fail(where, 'a ` without its end');
      j = end;
    } else if (s[j] === '[') depth++;
    else if (s[j] === ']' && --depth === 0) return j;
  }
  return -1;
}

const plain = (s) => s.replace(/`/g, '').replace(/\*\*/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

function slug(text, taken) {
  let id = plain(text).toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/\s+/g, '-');
  for (let n = 2; taken.has(id); n++) id = id.replace(/-\d+$/, '') + '-' + n;
  taken.add(id);
  return id;
}

// The cells of a table row, split at | outside code spans.
function cells(row, where) {
  const body = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out = [];
  let cell = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '`') {
      const end = body.indexOf('`', i + 1);
      if (end < 0) fail(where, 'a ` without its end');
      cell += body.slice(i, end + 1);
      i = end;
    } else if (body[i] === '|') {
      out.push(cell.trim());
      cell = '';
    } else cell += body[i];
  }
  out.push(cell.trim());
  return out;
}

const FENCE = /^```([\w-]*)\s*$/;
const HEADING = /^(#{1,3}) (.+)$/;
const ITEM = /^(-|\d+\.) (.*)$/;
const startsBlock = (line) => FENCE.test(line) || HEADING.test(line) || line.startsWith('|') || line.startsWith('> ') || ITEM.test(line);

/** Markdown to HTML. Resolves to { title, description, html }; `file` names the source in errors. */
function markdown(text, file, link = (href) => href) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  const ids = new Set();
  let title = null;
  let description = null;
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const where = `${file}:${i + 1}`;
    if (!line.trim()) {
      i++;
      continue;
    }
    let m;
    const mark = /^([*+] |#{4,} |~~~)/.exec(line);
    if (mark) fail(where, `"${mark[1].trim()}": use - for lists, # to ### for headings, and \`\`\` for code`);
    if ((m = FENCE.exec(line))) {
      const end = lines.findIndex((l, j) => j > i && /^```\s*$/.test(l));
      if (end < 0) fail(where, 'a code block without its end');
      const lang = m[1] ? ` class="language-${m[1]}"` : '';
      html.push(`<pre><code${lang}>${esc(lines.slice(i + 1, end).join('\n'))}</code></pre>`);
      i = end + 1;
    } else if ((m = HEADING.exec(line))) {
      const level = m[1].length;
      if (level === 1) {
        if (title !== null) fail(where, 'a second # heading');
        title = plain(m[2]);
      }
      html.push(`<h${level} id="${slug(m[2], ids)}">${inline(m[2], where, link)}</h${level}>`);
      i++;
    } else if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      if (rows.length < 2 || !/^\|(\s*:?-+:?\s*\|)+$/.test(rows[1].trim())) fail(where, 'a table without its |---| line');
      const head = cells(rows[0], where);
      const body = rows.slice(2).map((r) => cells(r, where));
      for (const r of body) if (r.length !== head.length) fail(where, `a table row with ${r.length} cells instead of ${head.length}`);
      const th = head.map((c) => `<th>${inline(c, where, link)}</th>`).join('');
      const tr = body.map((r) => `<tr>${r.map((c) => `<td>${inline(c, where, link)}</td>`).join('')}</tr>`).join('\n');
      html.push(`<div class="table"><table>\n<thead><tr>${th}</tr></thead>\n<tbody>\n${tr}\n</tbody>\n</table></div>`);
    } else if (line.startsWith('> ')) {
      const quote = [];
      while (i < lines.length && lines[i].startsWith('> ')) quote.push(lines[i++].slice(2));
      html.push(`<blockquote><p>${inline(quote.join(' '), where, link)}</p></blockquote>`);
    } else if ((m = ITEM.exec(line))) {
      const ordered = m[1] !== '-';
      if (ordered && m[1] !== '1.') fail(where, 'an ordered list that does not start at 1');
      const items = [];
      while (i < lines.length) {
        const item = ITEM.exec(lines[i]);
        if (!item || (item[1] !== '-') === !ordered) break;
        const parts = [item[2]];
        i++;
        // The item goes on in the lines below it, until a blank line or a new block.
        while (i < lines.length && lines[i].trim() && !startsBlock(lines[i].trimStart())) parts.push(lines[i++].trim());
        if (i < lines.length && /^\s+(-|\d+\.) /.test(lines[i])) fail(`${file}:${i + 1}`, 'a list inside a list');
        items.push(`<li>${inline(parts.join(' '), where, link)}</li>`);
        // A blank line between two items keeps the list going.
        let next = i;
        while (next < lines.length && !lines[next].trim()) next++;
        if (next > i && next < lines.length && ITEM.test(lines[next]) && (ITEM.exec(lines[next])[1] !== '-') === ordered) i = next;
      }
      html.push(ordered ? `<ol>\n${items.join('\n')}\n</ol>` : `<ul>\n${items.join('\n')}\n</ul>`);
    } else {
      if (/^\s/.test(line)) fail(where, 'an indented line outside a list or code block');
      const para = [];
      while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) para.push(lines[i++].trim());
      const text = para.join(' ');
      if (description === null && title !== null) description = plain(text);
      html.push(`<p>${inline(text, where, link)}</p>`);
    }
  }
  if (title === null) fail(file, 'no # heading');
  return { title, description: description || title, html: html.join('\n') };
}

// ---- the pages ----

// A link between pages: web.md is the page web, index.md the folder; everything else stays.
function pageLink(href) {
  const m = /^([a-z0-9-]+)\.md(#.*)?$/.exec(href);
  if (!m) return href;
  if (!PAGES.some(([name]) => name === m[1])) throw new Error(`a link to ${href}, which is not a page`);
  return (m[1] === 'index' ? './' : m[1]) + (m[2] || '');
}

// In llms-full.txt the pages are out of their folder, so every link gets its full address.
function absolute(href) {
  if (/^[a-z]+:/.test(href) || href.startsWith('#')) return href;
  return new URL(href, BASE).href;
}

function short(text, max = 160) {
  if (text.length <= max) return text;
  return text.slice(0, text.lastIndexOf(' ', max - 1)).replace(/[,:;]$/, '') + '…';
}

function page(name, md) {
  const { title, description, html } = markdown(md, `docs/developers/${name}.md`, pageLink);
  const menu = PAGES.filter(([, label]) => label)
    .map(([n, label]) => {
      const href = n === 'index' ? './' : n;
      return `    <li><a href="${href}"${n === name ? ' aria-current="page"' : ''}>${esc(label)}</a></li>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(name === 'index' ? title : `${title}: LA2L for developers`)}</title>
<meta name="description" content="${esc(short(description))}">
<link rel="alternate" type="text/markdown" href="${name}.md">
<link rel="icon" href="../logo.png">
<link rel="stylesheet" href="style.css">
</head>
<body>
<header class="top">
  <a class="home" href="./"><img src="../logo.png" alt="" width="40" height="40"> LA2L for developers</a>
  <nav aria-label="Pages">
  <ul>
${menu}
  </ul>
  </nav>
</header>
<main>
${html}
</main>
<footer class="foot">
  <p><a href="${name}.md">This page as Markdown</a> · <a href="../llms.txt">llms.txt</a> · <a href="../receiver">Test receiver</a></p>
  <p>LA2L is open source under the Apache License 2.0. Ableton and Live are trademarks of Ableton AG; LA2L is not made by Ableton.</p>
</footer>
</body>
</html>
`;
}

function llms(titles) {
  const line = ([name, , about]) => `- [${titles[name]}](${BASE}${name}.md): ${about}`;
  return `# LA2L

> LA2L (Lloyd's App2Live) is a Max for Live device that brings sounds from apps into Ableton Live. An app pairs once with a code that LA2L shows in Live, then sends WAV files with a short description of each sound: loop or one-shot, role, tempo. In Live every sound becomes an audio track, warped to the app's tempo. No API key or developer account.

Web apps use the npm package la2l (ESM, no dependencies) or its <la2l-send-button> web component. Every other language uses five HTTPS calls. The test receiver stands in for Live, so an app can be tested without Ableton.

## Docs

${PAGES.filter(([, label]) => label).map(line).join('\n')}

## Machine-readable

- [OpenAPI 3.1](${BASE}openapi.yaml): every call, answer and error text of the REST API
- [JSON Schema](${BASE}app2live-1.schema.json): the app2live/1 package description

## Optional

${PAGES.filter(([, label]) => !label).map(line).join('\n')}
- [All pages in one file](${SITE}llms-full.txt)
`;
}

// Every file of server/public/developers, by name.
function build() {
  const files = {};
  const titles = {};
  const full = [];
  for (const [name] of PAGES) {
    const md = fs.readFileSync(path.join(SOURCES, `${name}.md`), 'utf8');
    if (/[–—]/.test(md)) throw new Error(`docs/developers/${name}.md: use no en or em dashes`);
    files[`${name}.html`] = page(name, md);
    files[`${name}.md`] = md;
    titles[name] = markdown(md, name).title;
    full.push(`<!-- ${BASE}${name}.md -->\n\n` + md.replace(/\]\(([^)\s]+)\)/g, (all, href) => `](${absolute(href)})`).trimEnd());
  }
  files['llms.txt'] = llms(titles);
  files['llms-full.txt'] = full.join('\n\n') + '\n';
  for (const [from, name] of COPIES) files[name] = fs.readFileSync(from, 'utf8');
  return files;
}

function main(argv) {
  const files = build();
  const present = fs.existsSync(OUT) ? fs.readdirSync(OUT) : [];
  if (argv.includes('--check')) {
    const stale = Object.keys(files).filter((n) => !fs.existsSync(path.join(OUT, n)) || fs.readFileSync(path.join(OUT, n), 'utf8') !== files[n]);
    const stray = present.filter((n) => !(n in files));
    if (stale.length || stray.length) {
      console.error(`server/public/developers is not what docs/developers makes (${[...stale, ...stray].join(', ')}). Run "node tools/devpages.js" and commit it.`);
      return 1;
    }
    console.log('The developer pages are up to date.');
    return 0;
  }
  fs.mkdirSync(OUT, { recursive: true });
  for (const n of present) if (!(n in files)) fs.unlinkSync(path.join(OUT, n));
  for (const [n, text] of Object.entries(files)) fs.writeFileSync(path.join(OUT, n), text);
  console.log(`Made ${Object.keys(files).length} files in server/public/developers.`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { markdown, build, PAGES };
