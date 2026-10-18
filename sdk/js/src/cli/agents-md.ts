// la2l agents-md: an index of the docs of la2l in the project's AGENTS.md, and in its CLAUDE.md,
// so that AI coding agents read the docs of the installed version instead of guessing. Agents
// often leave a skill unused; an index in AGENTS.md they read every time.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.js';

const START = '<!-- BEGIN la2l docs index: npx la2l agents-md writes this part, and a new run replaces it -->';
const START_LINE = /<!-- BEGIN la2l docs index[^\n]*?-->/;
const END = '<!-- END la2l docs index -->';
// The order an agent should read them in; any other doc follows.
const ORDER = ['getting-started.md', 'api.md', 'web-audio.md', 'button.md', 'testing.md', 'errors.md'];

export interface IndexResult {
  /** The files written, relative to the project. */
  written: string[];
  /** CLAUDE.md, when it was left alone because it reads AGENTS.md already. */
  skipped: string[];
  /** Where the index points: node_modules/la2l/docs/, or the docs online. */
  docs: string;
  local: boolean;
  bytes: number;
}

// The docs of the installed la2l when the project has one, or else those of this copy, which
// npx may have fetched to a folder of its own.
function docsOf(project: string): { dir: string; version: string; local: boolean } {
  const installed = path.join(project, 'node_modules', 'la2l');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
    if (pkg.name === 'la2l' && fs.existsSync(path.join(installed, 'docs'))) return { dir: path.join(installed, 'docs'), version: String(pkg.version), local: true };
  } catch {
    // not installed in this project
  }
  return { dir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs'), version: VERSION, local: false };
}

// "api.md: The API of la2l: new LA2L(options); Pairing; Sending", from the headings of a doc.
function line(dir: string, file: string): string {
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  const plain = (s: string) => s.replace(/`/g, '').trim();
  const heading = text.match(/^# (.+)$/m);
  const title = plain(heading ? heading[1] : file);
  const sections = [...text.matchAll(/^## (.+)$/gm)].map((m) => plain(m[1]));
  return `|${file}: ${title}${sections.length ? ': ' + sections.join('; ') : ''}`;
}

/** The index, between its two marker lines. */
export function indexBlock(dir: string, version: string, docs: string): string {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  files.sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
  return [
    START,
    '## LA2L: sending sounds to Ableton Live',
    '',
    `This project sends sounds to Ableton Live with la2l ${version}. Before you write or change code that uses la2l, read the doc that fits below: it is the documentation of this version, and what you remember about la2l may be wrong or out of date.`,
    '',
    `Docs: ${docs}`,
    ...files.map((f) => line(dir, f)),
    '',
    'Rules:',
    "- Send WAV only. Make it with wavFromAudioBuffer, wavFromSamples or toWav from 'la2l'.",
    "- Give every sound kind: 'loop' (warped to the tempo and looped) or kind: 'oneshot' (plays as it is). Give loops a bpm, and render them a whole number of beats long.",
    '- Names have at most 40 characters. A package has at most 32 sounds and 200 MB.',
    '- Pair once with the code the user reads in Live ("In Live, click Pair app in LA2L and type the code it shows."). Ask for a code again only after the error code not_paired.',
    '- Never put the token in a URL, a log line, an analytics event or an error report.',
    "- Test without Ableton: npx la2l test-receiver --local, or startTestReceiver() from 'la2l/testing' in automated tests.",
    END,
  ].join('\n');
}

// The file with the index in it: in place of the old one, or added at the end.
function withIndex(text: string, block: string, name: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const own = block.replace(/\n/g, eol);
  const start = text.search(START_LINE);
  if (start < 0) {
    if (!text.trim()) return own + eol;
    return text.replace(/\s*$/, '') + eol + eol + own + eol;
  }
  const end = text.indexOf(END, start);
  if (end < 0) throw new Error(`${name} has the first line of the la2l docs index but not its last line, ${END}. Add it or remove the first line, then run this again.`);
  return text.slice(0, start) + own + text.slice(end + END.length);
}

/** Writes the index into AGENTS.md, and into CLAUDE.md when the project has one. */
export function writeIndex(project: string): IndexResult {
  const { dir, version, local } = docsOf(project);
  const docs = local ? 'node_modules/la2l/docs/' : `https://cdn.jsdelivr.net/npm/la2l@${version}/docs/`;
  const block = indexBlock(dir, version, docs);
  const targets = ['AGENTS.md'];
  const skipped: string[] = [];
  const claude = path.join(project, 'CLAUDE.md');
  if (fs.existsSync(claude)) {
    // Claude Code reads AGENTS.md through an import line: the index would be there twice.
    if (/^\s*@\.?\/?AGENTS\.md\s*$/m.test(fs.readFileSync(claude, 'utf8'))) skipped.push('CLAUDE.md');
    else targets.push('CLAUDE.md');
  }
  // Every file is checked before the first is written, so a problem leaves all of them as they were.
  const changes = targets.map((name) => {
    const file = path.join(project, name);
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    return { file, before, after: withIndex(before, block, name) };
  });
  for (const c of changes) if (c.after !== c.before) fs.writeFileSync(c.file, c.after);
  return { written: targets, skipped, docs, local, bytes: Buffer.byteLength(block) };
}
