'use strict';
// Makes the fixtures in this folder: small WAV files and manifests, good and bad, and
// expected.json with the verdict on each. The verdicts are written here by hand, next to each
// fixture; tests/fixtures.test.js proves that the device agrees, server/test/fixtures.test.js
// that the server does, and the tests of every SDK that the SDK does.
//
//   node sdk/fixtures/make.js           write everything
//   node sdk/fixtures/make.js --check   only say whether the files on disk are up to date
//
// Every byte comes from integer arithmetic, so the files are the same on every machine.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HERE = __dirname;
const MB = 1048576;

// ---- WAV files ----

const PCM = 1;
const FLOAT = 3;
const EXTENSIBLE = 0xfffe;
// The rest of the KSDATAFORMAT_SUBTYPE GUID after the two bytes of the format.
const GUID_TAIL = Buffer.from('000000001000800000aa00389b71', 'hex');

function chunk(id, body) {
  const head = Buffer.alloc(8);
  head.write(id, 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

// The fmt body: 16 bytes, or 40 for WAVE_FORMAT_EXTENSIBLE.
function fmtBody({ format = PCM, channels = 1, rate = 44100, bits = 16, extensible = false }) {
  const block = (channels * bits) / 8;
  const b = Buffer.alloc(extensible ? 40 : 16);
  b.writeUInt16LE(extensible ? EXTENSIBLE : format, 0);
  b.writeUInt16LE(channels, 2);
  b.writeUInt32LE(rate, 4);
  b.writeUInt32LE(Math.round(rate * block), 8);
  b.writeUInt16LE(Math.ceil(block), 12);
  b.writeUInt16LE(bits, 14);
  if (extensible) {
    b.writeUInt16LE(22, 16); // cbSize
    b.writeUInt16LE(bits, 18); // valid bits
    b.writeUInt32LE(channels === 2 ? 3 : 4, 20); // channel mask: front left and right, or centre
    b.writeUInt16LE(format, 24);
    GUID_TAIL.copy(b, 26);
  }
  return b;
}

// Sound data: `frames` frames of a quiet saw wave, in the sample format given.
function samples({ format = PCM, channels = 1, bits = 16, frames = 441 }) {
  const bytes = Math.ceil(bits / 8);
  const b = Buffer.alloc(frames * channels * bytes);
  let at = 0;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const step = ((i + c * 16) % 64) - 32; // -32 .. 31
      if (format === FLOAT && bits === 32) b.writeFloatLE(step / 256, at);
      else if (format === FLOAT && bits === 64) b.writeDoubleLE(step / 256, at);
      else if (format === FLOAT && bits === 16) b.writeUInt16LE(0, at); // only the header matters
      else if (bits === 8) b.writeUInt8(128 + step, at);
      else if (bits === 12 || bits === 16) b.writeInt16LE(step * 64, at);
      else if (bits === 24) b.writeIntLE(step * 16384, at, 3);
      else if (bits === 32) b.writeInt32LE(step * 4194304, at);
      else b.writeUIntLE(0, at, bytes);
      at += bytes;
    }
  }
  return b;
}

// A whole file. opts: the format fields above, plus
//   before: chunks before fmt; between: chunks between fmt and data; after: chunks after data
//   dataSize: the size written in the data header (default: the real size); noData, noFmt
//   riff: 'RIFF' or 'RF64'; fmt: a fmt body of your own
function wav(opts = {}) {
  const fmt = opts.fmt || fmtBody(opts);
  const data = samples(opts);
  const parts = [...(opts.before || [])];
  if (!opts.noFmt) parts.push(chunk('fmt ', fmt));
  parts.push(...(opts.between || []));
  if (!opts.noData) {
    const d = chunk('data', data);
    if (opts.dataSize !== undefined) d.writeUInt32LE(opts.dataSize, 4);
    parts.push(d);
  }
  parts.push(...(opts.after || []));
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write(opts.riff || 'RIFF', 0, 'latin1');
  head.writeUInt32LE(opts.riff === 'RF64' ? 0xffffffff : 4 + body.length, 4);
  head.write('WAVE', 8, 'latin1');
  return Buffer.concat([head, body]);
}

// "RIFF....WAVE" and then n empty chunks, as a file built to keep a reader busy.
function emptyChunks(n) {
  const b = Buffer.alloc(12 + n * 8);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVE', 8, 'latin1');
  for (let i = 0; i < n; i++) b.write('junk', 12 + i * 8, 'latin1');
  return b;
}

// 12-bit PCM: the fmt says 12 bits, and the samples take 2 bytes each.
function pcm12() {
  const fmt = fmtBody({ bits: 16 });
  fmt.writeUInt16LE(12, 14);
  return wav({ fmt, bits: 12 });
}

const ok = (info) => Object.assign({ ok: true }, info);
const refused = (error) => ({ ok: false, error });

// file, what it is, how to make it, and the device's verdict: the header fields of
// src/node/wav.js readInfo, or the exact text of its WavError.
const WAVS = [
  ['pcm8-mono.wav', '8-bit PCM, mono', () => wav({ bits: 8 }), ok({ format: 'pcm', channels: 1, sampleRate: 44100, bitsPerSample: 8, frames: 441, dataBytes: 441 })],
  ['pcm16-mono.wav', '16-bit PCM, mono', () => wav(), ok({ format: 'pcm', channels: 1, sampleRate: 44100, bitsPerSample: 16, frames: 441, dataBytes: 882 })],
  ['pcm16-stereo.wav', '16-bit PCM, stereo', () => wav({ channels: 2 }), ok({ format: 'pcm', channels: 2, sampleRate: 44100, bitsPerSample: 16, frames: 441, dataBytes: 1764 })],
  ['pcm24-stereo.wav', '24-bit PCM, stereo, 48 kHz', () => wav({ channels: 2, bits: 24, rate: 48000, frames: 480 }), ok({ format: 'pcm', channels: 2, sampleRate: 48000, bitsPerSample: 24, frames: 480, dataBytes: 2880 })],
  ['pcm32-mono.wav', '32-bit integer PCM, mono', () => wav({ bits: 32 }), ok({ format: 'pcm', channels: 1, sampleRate: 44100, bitsPerSample: 32, frames: 441, dataBytes: 1764 })],
  ['float32-stereo.wav', '32-bit float, stereo', () => wav({ format: FLOAT, channels: 2, bits: 32 }), ok({ format: 'float', channels: 2, sampleRate: 44100, bitsPerSample: 32, frames: 441, dataBytes: 3528 })],
  ['float64-mono.wav', '64-bit float, mono, 96 kHz', () => wav({ format: FLOAT, bits: 64, rate: 96000, frames: 960 }), ok({ format: 'float', channels: 1, sampleRate: 96000, bitsPerSample: 64, frames: 960, dataBytes: 7680 })],
  ['extensible-pcm24.wav', 'WAVE_FORMAT_EXTENSIBLE with 24-bit PCM inside, stereo', () => wav({ extensible: true, channels: 2, bits: 24 }), ok({ format: 'pcm', channels: 2, sampleRate: 44100, bitsPerSample: 24, frames: 441, dataBytes: 2646 })],
  ['extensible-float32.wav', 'WAVE_FORMAT_EXTENSIBLE with 32-bit float inside, mono', () => wav({ extensible: true, format: FLOAT, bits: 32 }), ok({ format: 'float', channels: 1, sampleRate: 44100, bitsPerSample: 32, frames: 441, dataBytes: 1764 })],
  ['list-before-fmt.wav', 'a LIST chunk before fmt, as some editors write it', () => wav({ before: [chunk('LIST', Buffer.from('INFOISFT\x0a\x00\x00\x00Fixtures\x00\x00', 'latin1'))] }), ok({ format: 'pcm', channels: 1, sampleRate: 44100, bitsPerSample: 16, frames: 441, dataBytes: 882 })],
  ['odd-chunk.wav', 'a chunk of 3 bytes, with its pad byte, between fmt and data', () => wav({ between: [chunk('note', Buffer.from('odd', 'latin1'))] }), ok({ format: 'pcm', channels: 1, sampleRate: 44100, bitsPerSample: 16, frames: 441, dataBytes: 882 })],
  ['data-size-0.wav', 'the data size left at 0 by a recorder that never finished the header', () => wav({ dataSize: 0 }), ok({ format: 'pcm', channels: 1, sampleRate: 44100, bitsPerSample: 16, frames: 441, dataBytes: 882 })],
  ['data-size-ffffffff.wav', 'the data size left at 0xFFFFFFFF while recording', () => wav({ dataSize: 0xffffffff }), ok({ format: 'pcm', channels: 1, sampleRate: 44100, bitsPerSample: 16, frames: 441, dataBytes: 882 })],
  ['pcm12.wav', '12-bit PCM', () => pcm12(), refused('12-bit PCM is not supported. Use 16 or 24 bit.')],
  ['compressed.wav', 'a compressed WAV: format 85, MP3 inside', () => wav({ format: 85 }), refused('This WAV file is compressed (format 85). Send plain PCM or float WAV.')],
  ['float16.wav', '16-bit float', () => wav({ format: FLOAT, bits: 16 }), refused('16-bit float is not supported. Use 32-bit float.')],
  ['rf64.wav', 'RF64, the format for files over 4 GB', () => wav({ riff: 'RF64' }), refused('RF64 files are not supported. Send a normal WAV file.')],
  ['three-channels.wav', '3 channels', () => wav({ channels: 3 }), refused('The WAV file has 3 channels. Live places mono and stereo files only.')],
  ['rate-4000.wav', '4 kHz', () => wav({ rate: 4000, frames: 40 }), refused('The sample rate 4000 Hz is not supported.')],
  ['no-data.wav', 'no data chunk', () => wav({ noData: true }), refused('The WAV file has no sound data.')],
  ['empty-data.wav', 'a data chunk of 0 bytes at the end', () => wav({ frames: 0 }), refused('The WAV file is empty.')],
  ['no-fmt.wav', 'no fmt chunk', () => wav({ noFmt: true }), refused('The WAV file has no format block.')],
  ['short-fmt.wav', 'a fmt chunk of 14 bytes', () => wav({ fmt: fmtBody({}).subarray(0, 14) }), refused('The WAV header is damaged.')],
  ['empty-chunks.wav', '1001 empty chunks and no fmt or data', () => emptyChunks(1001), refused('The WAV header is damaged.')],
  ['text.wav', 'a text file named .wav, like an error page saved by a browser', () => Buffer.from('<!doctype html>\n<title>404 Not Found</title>\n<h1>Not Found</h1>\n', 'latin1'), refused('This is not a WAV file.')],
  ['ten-bytes.wav', 'a file of 10 bytes', () => Buffer.from('RIFF\x02\x00\x00\x00WA', 'latin1'), refused('The file is too short to be a WAV file.')],
];

// ---- manifests ----

const hex = (text) => crypto.createHash('sha256').update(text).digest('hex');
const sound = (name, extra = {}) =>
  Object.assign({ id: name.toLowerCase().replace(/\W+/g, '-'), file: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.wav', bytes: 352844, sha256: hex(name), name, kind: 'loop', role: 'drums' }, extra);
const pkg = (items, extra = {}) =>
  Object.assign({ schema: 'app2live/1', title: 'Fixture', source: { app: 'Fixtures', app_version: '1.0.0', platform: 'test' }, tempo: { bpm: 120 }, items }, extra);

// The example of docs/manifest.md, with real checksums.
const EXAMPLE = {
  schema: 'app2live/1',
  package_id: '7f3c2a9e-1b4d-4c8e-9a51-0d2e6f7b8c90',
  created_at: '2026-10-16T14:30:00Z',
  title: 'Treinbeat',
  source: { app: 'Web808', app_version: '1.0.0', platform: 'web' },
  tempo: { bpm: 92.0, time_signature: [4, 4] },
  items: [
    { id: 'kick', file: 'kick.wav', sha256: hex('kick'), bytes: 1693484, name: 'Kick', kind: 'loop', role: 'drums', length_beats: 16, color: '#E5484D' },
    { id: 'robot', file: 'robot.wav', sha256: hex('robot'), bytes: 420112, name: 'Robot hallo', kind: 'oneshot', role: 'vocal' },
  ],
  midi: [],
};

const items = (...list) => list.map(([name, kind, error = null]) => ({ name, kind, error }));
const accepted = (warnings = [], extra = {}) => Object.assign({ status: 201, warnings }, extra);
const turnedDown = (status, error) => ({ status, error });

// file, what it is, the manifest as an app sends it, the device's verdict on it (after the
// server gave it a package_id), the server's answer to POST /packages, and whether the JSON
// Schema accepts it. The schema describes a correct manifest: it is stricter than the server
// about types and known values, and cannot see two sounds with one file or the 200 MB in total.
const MANIFESTS = [
  ['example.json', 'the example of docs/manifest.md', EXAMPLE,
    { ok: true, warnings: [], items: items(['Kick', 'loop'], ['Robot hallo', 'oneshot']) }, accepted(), true],
  ['minimal.json', 'one loop with only what is required, and its kind', { schema: 'app2live/1', items: [{ file: 'loop.wav', bytes: 1000, sha256: hex('loop'), kind: 'loop' }] },
    { ok: true, warnings: ['no title', 'no source.app'], items: items(['Sound 1', 'loop']) }, accepted(['no title', 'no source.app']), true],
  ['no-sounds.json', 'no sounds', pkg([]),
    { ok: false, error: 'The package has no sounds.' }, turnedDown(422, 'The package has no sounds.'), false],
  ['33-sounds.json', '33 sounds', pkg(Array.from({ length: 33 }, (_, i) => sound(`Hit ${i + 1}`, { kind: 'oneshot', role: undefined }))),
    { ok: false, error: 'The package has 33 sounds. LA2L takes 32 at most.' }, turnedDown(422, 'The package has 33 sounds. LA2L takes 32 at most.'), false],
  ['201-mb.json', 'two sounds of 100.5 MB: 201 MB together', pkg([sound('Left', { bytes: 100.5 * MB }), sound('Right', { bytes: 100.5 * MB })]),
    { ok: false, error: 'The package is 201 MB. LA2L takes 200 MB at most.' }, turnedDown(422, 'The package is 201 MB. LA2L takes 200 MB at most.'), true],
  ['schema-2.json', 'a newer format, app2live/2', pkg([sound('Kick')], { schema: 'app2live/2' }),
    { ok: false, error: 'This package uses app2live/2. Update LA2L to import it.' }, turnedDown(422, 'This package uses app2live/2. Update LA2L to import it.'), false],
  ['no-schema.json', 'no schema at all', (() => { const m = pkg([sound('Kick')]); delete m.schema; return m; })(),
    { ok: false, error: 'This is not an App2Live package.' }, turnedDown(422, 'This is not an App2Live package.'), false],
  ['not-an-object.json', 'a list instead of an object', [sound('Kick')],
    { ok: false, error: 'The package description is not valid.' }, turnedDown(400, 'Send a JSON object.'), false],
  ['bad-file-name.json', 'a sound whose file name leads out of its folder', pkg([sound('Snare'), sound('Kick', { file: '../kick.wav' })]),
    { ok: true, warnings: [], items: items(['Snare', 'loop'], ['Kick', 'oneshot', 'has no valid file name']) }, turnedDown(422, 'Kick has no valid file name'), false],
  ['same-file.json', 'two sounds with one file', pkg([sound('Kick'), sound('Kick 2', { file: 'KICK.wav' })]),
    { ok: true, warnings: [], items: items(['Kick', 'loop'], ['Kick 2', 'oneshot', 'uses the same file as another sound']) }, turnedDown(422, 'Kick 2 uses the same file as another sound'), true],
  ['name-41.json', 'a name of 41 characters, cut to 40', pkg([sound('A name of exactly forty-one characters!!x')]),
    { ok: true, warnings: [], items: items(['A name of exactly forty-one characters!!', 'loop']) }, accepted(), false],
  ['unknown-role.json', 'an unknown role', pkg([sound('Kick', { role: 'drum' })]),
    { ok: true, warnings: ['Kick: role "drum" unknown'], items: items(['Kick', 'loop']) }, accepted(['Kick: role "drum" unknown']), false],
  ['no-kind.json', 'a sound without kind, which becomes a one-shot', pkg([sound('Kick', { kind: undefined })], { tempo: undefined }),
    { ok: true, warnings: ['Kick: no kind, placed as one-shot'], items: items(['Kick', 'oneshot']) }, accepted(['Kick: no kind, placed as one-shot']), true],
  ['oneshot-bpm.json', 'a one-shot with a bpm, in a package without loops', pkg([sound('Hit', { kind: 'oneshot', role: undefined, bpm: 120 })]),
    { ok: true, warnings: [], items: items(['Hit', 'oneshot']) },
    accepted(['Hit: bpm and length_beats only apply to a loop', 'tempo.bpm only applies to loops, and this package has none']), true],
  ['no-checksum.json', 'a sound without bytes and sha256', pkg([sound('Kick', { bytes: undefined, sha256: undefined })]),
    { ok: true, warnings: [], items: items(['Kick', 'loop']) }, turnedDown(422, 'Kick needs bytes and sha256.'), false],
];

// What the device does with a sound in Live: src/node/manifest.js planItem and trackName, for a
// sound of `duration` seconds (from its WAV header), with the default settings.
const PLANS = [
  ['a drum loop with its length: Beats, at the package tempo', 'example.json', 0, 10.4348,
    { warp: true, looping: true, warpMode: 0, bpm: 92, lengthBeats: 16 }, 'Kick (Web808)'],
  ['a one-shot plays as it is', 'example.json', 1, 1.2,
    { warp: false, looping: false, warpMode: null, bpm: null, lengthBeats: null }, 'Robot hallo (Web808)'],
  ['a loop of 2.0004 s at 120 BPM is 4 beats', 'unknown-role.json', 0, 2.0004,
    { warp: true, looping: true, warpMode: 4, bpm: 120, lengthBeats: 4 }, 'Kick (Fixtures)'],
  ['without a tempo and a length, Live guesses', 'minimal.json', 0, 2,
    { warp: true, looping: true, warpMode: 4, bpm: null, lengthBeats: null }, 'Sound 1 (App)'],
];

// ---- writing ----

function expected() {
  const wavs = WAVS.map(([file, about, , device]) => ({ file: `wav/${file}`, about, device }));
  const manifests = MANIFESTS.map(([file, about, , device, server, schema]) => ({ file: `manifests/${file}`, about, device, server, schema }));
  const plans = PLANS.map(([about, manifest, item, duration, plan, trackName]) => ({ about, manifest: `manifests/${manifest}`, item, duration, plan, trackName }));
  return {
    about: 'The verdict on every fixture. See README.md. Made by make.js: change it there.',
    wav: wavs,
    manifests,
    plans,
  };
}

function outputs() {
  const out = new Map();
  for (const [file, , make] of WAVS) out.set(`wav/${file}`, make());
  for (const [file, , manifest] of MANIFESTS) out.set(`manifests/${file}`, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  out.set('expected.json', Buffer.from(JSON.stringify(expected(), null, 2) + '\n'));
  return out;
}

function main() {
  const check = process.argv.includes('--check');
  const stale = [];
  for (const [rel, body] of outputs()) {
    const file = path.join(HERE, rel);
    const now = fs.existsSync(file) ? fs.readFileSync(file) : null;
    if (now && now.equals(body)) continue;
    stale.push(rel);
    if (!check) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    }
  }
  for (const dir of ['wav', 'manifests']) {
    const known = new Set([...outputs().keys()].filter((k) => k.startsWith(dir + '/')).map((k) => k.slice(dir.length + 1)));
    for (const f of fs.existsSync(path.join(HERE, dir)) ? fs.readdirSync(path.join(HERE, dir)) : []) {
      if (known.has(f)) continue;
      stale.push(`${dir}/${f} (not made by make.js)`);
      if (!check) fs.rmSync(path.join(HERE, dir, f));
    }
  }
  if (check) {
    if (stale.length) {
      console.error(`These fixtures are not what make.js makes: ${stale.join(', ')}. Run node sdk/fixtures/make.js.`);
      process.exitCode = 1;
    } else console.log('The fixtures are up to date.');
  } else console.log(stale.length ? `Wrote ${stale.length} file(s).` : 'Nothing to do: the fixtures are up to date.');
}

if (require.main === module) main();

module.exports = { outputs, expected };
