#!/usr/bin/env node
// The command line of la2l: pair, send WAV files, follow them, and the test receiver. So a script
// in any language can send sounds to LA2L in Ableton Live without an SDK of its own.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { LA2L } from '../client.js';
import { La2lError } from '../errors.js';
import { DEFAULT_SERVER } from '../http.js';
import { ROLES, type Role } from '../manifest.js';
import { defaultStorage, fileStorage, memoryStorage, type La2lStorage } from '../storage.js';
import { TestReceiver, type ReceiverReport } from '../receiver.js';
import { startTestReceiver } from '../testing/index.js';
import { VERSION } from '../version.js';

const HELP = `la2l ${VERSION}: send sounds to Ableton Live with LA2L.

  la2l pair [code]              Pair with LA2L in Live. In Live, click Pair app in LA2L
                                and type the code it shows.
  la2l send <file.wav>...       Send WAV files to Live, one track each.
      --loop | --oneshot        What the sounds are. A loop is warped to the tempo;
                                a one-shot plays as it is. One of the two is needed.
      --bpm <n>                 The tempo of the loops.
      --role <role>             drums, bass, melodic, vocal, texture or fx.
      --title <text>            The name of the scene and of the folder in Live.
      --name <text>             The track name, when you send one file.
      --wait                    Wait until the sounds are in Live.
  la2l status [package-id]      Where the last package you sent is now.
  la2l unpair                   Unpair the command line.
  la2l test-receiver            Stand in for LA2L in Live, to test an app without
                                Ableton: shows a code and what Live would do with
                                every package.
      --local                   An LA2L server in memory on 127.0.0.1, without
                                internet: point your app at the address it shows.
      --port <n>                The port of --local. Default: any free port.

  Every command takes --server <address> (default ${DEFAULT_SERVER},
  or LA2L_SERVER) and --app-name <name> (default "la2l command line", or LA2L_APP_NAME).
  LA2L_TOKEN: an app token to use instead of the one kept in the config folder.
`;

const VALUE_FLAGS = new Set(['bpm', 'role', 'title', 'name', 'server', 'app-name', 'port']);
const BOOL_FLAGS = new Set(['loop', 'oneshot', 'wait', 'local', 'help', 'version']);

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

class Usage extends Error {}

function parse(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (BOOL_FLAGS.has(name)) flags[name] = true;
    else if (VALUE_FLAGS.has(name)) {
      const value = inline !== undefined ? inline : argv[++i];
      if (value === undefined) throw new Usage(`--${name} needs a value.`);
      flags[name] = value;
    } else throw new Usage(`Unknown option --${name}. See la2l help.`);
  }
  return { command: positional.shift() || 'help', positional, flags };
}

const out = (line = '') => process.stdout.write(line + '\n');
const env = (name: string) => (process.env[name] || '').trim();

function settings(args: Args) {
  const server = String(args.flags.server || env('LA2L_SERVER') || DEFAULT_SERVER);
  const appName = String(args.flags['app-name'] || env('LA2L_APP_NAME') || 'la2l command line');
  return { server, appName };
}

// The token in LA2L_TOKEN, or in the config folder.
function storageFor(appName: string): La2lStorage {
  const kept = defaultStorage(appName);
  const token = env('LA2L_TOKEN');
  if (!token) return kept;
  return {
    get: (key) => (key === 'token' ? token : kept.get(key)),
    set: (key, value) => key !== 'token' && kept.set(key, value),
    remove: (key) => key !== 'token' && kept.remove(key),
  };
}

function client(args: Args): { la2l: LA2L; storage: La2lStorage } {
  const { server, appName } = settings(args);
  const storage = storageFor(appName);
  return { la2l: new LA2L({ appName, server, storage }), storage };
}

async function pair(args: Args): Promise<void> {
  const { la2l } = client(args);
  let code = args.positional.join(' ').trim();
  if (!code) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    code = (await rl.question('In Live, click Pair app in LA2L. Type the code it shows: ')).trim();
    rl.close();
  }
  const { deviceName } = await la2l.pair(code);
  out(`Paired with ${deviceName}. Send sounds with: la2l send <file.wav> --loop --bpm <tempo>`);
}

async function send(args: Args): Promise<void> {
  const { la2l, storage } = client(args);
  const files = args.positional;
  if (!files.length) throw new Usage('Name one or more WAV files: la2l send kick.wav --loop --bpm 92');
  if (!!args.flags.loop === !!args.flags.oneshot) throw new Usage('Say what the sounds are: --loop or --oneshot.');
  if (args.flags.name !== undefined && files.length > 1) throw new Usage('--name is for one file; with more, every track is named after its file.');
  const role = args.flags.role === undefined ? undefined : String(args.flags.role).toLowerCase();
  if (role !== undefined && !ROLES.includes(role as (typeof ROLES)[number])) throw new Usage(`--role must be one of: ${ROLES.join(', ')}.`);
  const bpm = args.flags.bpm === undefined ? undefined : Number(String(args.flags.bpm).replace(',', '.'));
  if (bpm !== undefined && !(bpm >= 20 && bpm <= 999)) throw new Usage('--bpm must be a number from 20 to 999.');
  const sounds = files.map((file) => {
    let data: Buffer;
    try {
      data = fs.readFileSync(file);
    } catch (e) {
      throw new Usage(`Cannot read ${file}.`);
    }
    const name = files.length === 1 && args.flags.name !== undefined ? String(args.flags.name) : path.basename(file).replace(/\.[^.]*$/, '');
    const audio = new File([new Uint8Array(data)], path.basename(file), { type: 'audio/wav' });
    return { name, audio, kind: args.flags.loop ? ('loop' as const) : ('oneshot' as const), role: role as Role | undefined };
  });
  const tty = process.stdout.isTTY;
  let shown = -1;
  // The scene and folder name in Live: the one file's track name, or how many there are.
  const title = args.flags.title !== undefined ? String(args.flags.title) : sounds.length === 1 ? sounds[0].name : `${sounds.length} sounds`;
  const delivery = await la2l.send({
    title,
    bpm,
    sounds,
    onProgress: (share) => {
      const pct = Math.floor(share * 100);
      if (tty && pct !== shown) {
        shown = pct;
        process.stdout.write(`\rSending ${sounds.length === 1 ? '1 sound' : `${sounds.length} sounds`}: ${pct}%`);
      }
    },
  });
  if (tty) process.stdout.write('\n');
  storage.set('lastPackage', delivery.packageId);
  for (const w of delivery.warnings) out(`Warning: ${w}`);
  out(`Sent: ${sounds.length === 1 ? '1 sound' : `${sounds.length} sounds`}. Click Import in Live. Package ${delivery.packageId}`);
  if (!args.flags.wait) return;
  out('Waiting for Import in Live...');
  const st = await delivery.imported();
  out(st.status === 'imported' ? `In Live: ${st.sounds.length} of ${st.sounds.length}.` : `In Live: ${st.sounds.filter((x) => x.status === 'imported').length} of ${st.sounds.length}.`);
  for (const x of st.sounds) if (x.status === 'failed') out(`${x.name}: ${x.error || 'not imported'}`);
}

async function status(args: Args): Promise<void> {
  const { la2l, storage } = client(args);
  const id = args.positional[0] || storage.get('lastPackage');
  if (!id) throw new Usage('Nothing sent yet. Name a package: la2l status <package-id>');
  const st = await la2l.delivery(id).status();
  const done = st.sounds.filter((x) => x.status === 'imported').length;
  const words: Record<string, string> = {
    uploading: 'Not sent completely.',
    waiting: 'Waiting for Import in Live.',
    imported: `In Live: ${st.sounds.length} of ${st.sounds.length}.`,
    partial: `In Live: ${done} of ${st.sounds.length}.`,
    failed: `Live could not import it.${st.error ? ' ' + st.error : ''} The next Import tries again.`,
    expired: 'Expired: it was not imported within 24 hours, or it is gone.',
  };
  out(`${id}: ${words[st.status]}`);
  for (const x of st.sounds) if (x.status === 'failed') out(`${x.name}: ${x.error || 'not imported'}`);
}

async function unpair(args: Args): Promise<void> {
  const { la2l } = client(args);
  const was = la2l.paired;
  await la2l.unpair();
  out(was ? 'Unpaired.' : 'This command line was not paired.');
}

// ---- the test receiver ----

const fixed = (n: number, digits: number) => String(Math.round(n * 10 ** digits) / 10 ** digits);

/** What the test receiver did with a package, as lines for a terminal. */
export function reportLines(r: ReceiverReport): string[] {
  const n = r.sounds.length;
  const head =
    r.status === 'imported'
      ? `imported ${n} of ${n} ${n === 1 ? 'sound' : 'sounds'}`
      : r.status === 'partial'
        ? `imported ${r.placed} of ${n} sounds; Live would skip the rest`
        : `not imported${r.error ? ': ' + r.error : ''}`;
  const lines = [`${r.title}${r.app ? ` (${r.app})` : ''}: ${head}`];
  for (const s of r.sounds) {
    if (s.error || !s.plan || !s.info) {
      lines.push(`  ${s.name} ${s.error || 'was not placed'}`);
      continue;
    }
    const p = s.plan;
    const what = p.warp
      ? `loop, warped in ${p.warpModeName} mode${p.bpm ? ` at ${fixed(p.bpm, 2)} BPM` : ', Live guesses the tempo'}${p.lengthBeats ? `, ${fixed(p.lengthBeats, 3)} beats` : ''}`
      : 'one-shot, plays as it is';
    const i = s.info;
    lines.push(`  ${p.trackName}: ${what}. ${fixed(i.rate / 1000, 1)} kHz, ${i.bits}-bit${i.format === 'float' ? ' float' : ''}, ${i.channels === 1 ? 'mono' : 'stereo'}, ${fixed(i.duration, 2)} s`);
  }
  for (const w of r.warnings) lines.push(`  warning: ${w}`);
  return lines;
}

const formatCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

async function testReceiver(args: Args): Promise<void> {
  const printReport = (r: ReceiverReport) => reportLines(r).forEach((l) => out(l));
  if (args.flags.local) {
    const port = args.flags.port === undefined ? 0 : Number(args.flags.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Usage('--port must be a number from 0 to 65535.');
    let started = false;
    const local = await startTestReceiver({
      port,
      // A new code after an app used one, or when one ran out: for one more app.
      onCode: (code) => started && out(`For one more app: code ${formatCode(code)}.`),
      onReport: printReport,
    });
    started = true;
    out(`LA2L test receiver, with an LA2L server in memory: ${local.server}`);
    out(`In your app, use that address as the server and pair with code ${formatCode(local.code)}.`);
    out('Every package you send is imported as LA2L in Live would. Stop with Ctrl+C.');
    await stopOnSignal(() => local.close());
    return;
  }
  const { server } = settings(args);
  const receiver: TestReceiver = new TestReceiver({
    server,
    storage: fileStorage('test-receiver') || memoryStorage(),
    onCode: (code) => out(`In your app, pair with code ${formatCode(code)}. It works for 10 minutes.`),
    onPaired: (app) => out(`Paired with ${app}. Waiting for sounds. Stop with Ctrl+C.`),
    onCodeEnded: () => {
      out('The code expired. Here is a new one.');
      receiver.pair().catch((e) => out(e.message));
    },
    onLost: () => out('This test receiver is no longer paired. Here is a new code.'),
    onReport: printReport,
    onError: (e) => out(`Problem: ${(e as Error).message}`),
  });
  out(`LA2L test receiver on ${server}`);
  // Paired before: the apps of then can still send, and a fresh code is there for one more.
  if (receiver.paired) {
    out('Paired before: those apps can send. Waiting for sounds. Stop with Ctrl+C.');
    await receiver.start();
  }
  await receiver.pair();
  await stopOnSignal(async () => receiver.close());
}

function stopOnSignal(stop: () => Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      stop().then(resolve, resolve);
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}

// ---- main ----

const COMMANDS: Record<string, (args: Args) => Promise<void>> = { pair, send, status, unpair, 'test-receiver': testReceiver };

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parse(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }
  if (args.flags.version || args.command === 'version') {
    out(VERSION);
    return 0;
  }
  if (args.flags.help || args.command === 'help') {
    out(HELP);
    return 0;
  }
  const run = Object.prototype.hasOwnProperty.call(COMMANDS, args.command) ? COMMANDS[args.command] : null;
  if (!run) {
    process.stderr.write(`Unknown command ${args.command}. See la2l help.\n`);
    return 2;
  }
  try {
    await run(args);
    return 0;
  } catch (e) {
    if (e instanceof Usage) {
      process.stderr.write(`${e.message}\n`);
      return 2;
    }
    if (e instanceof La2lError) {
      const hint = e.code === 'not_paired' ? ' Pair first: la2l pair' : '';
      process.stderr.write(`${e.message}${hint}\n`);
      return 1;
    }
    process.stderr.write(`${(e as Error).message || e}\n`);
    return 1;
  }
}

// Run when started as a program (npx la2l, node dist/cli/main.js), not when imported.
const self = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (self && import.meta.url === pathToFileURL(self).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
