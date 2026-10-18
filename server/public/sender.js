// LA2L Sender: the page that sends sounds to the LA2L device in Ableton Live, and the reference app
// of the SDK: everything it says to the server goes through `@lloydstellar/la2l` (sdk/js, served as
// vendor/la2l.js). Every address is relative ("api"), so the page works under any prefix, such as
// https://lloydstellar.nl/la2l/. Its keys in localStorage are those of the page before the SDK
// (la2l.token, la2l.deviceName, la2l.appId, la2l.recent), so paired browsers stay paired.
// Installed as a web app on Android it is in the share menu of other apps (sw.js, share.js).

import { LA2L, La2lError, checkWav, toWav } from './vendor/la2l.js';
import { readZip } from './zip.js';
import { getShare, removeShare, newestShare, manifestFromText, itemFor, missingFiles } from './share.js';

const APP_NAME = 'LA2L Sender';
const MAX_SOUNDS = 32;
const MAX_BYTES = 200 * 1048576;
// An mp3 or m4a becomes WAV in memory, as 48 kHz float samples first: above this, that takes too
// much memory on a phone (10 MB of mp3 at 128 kbit/s is 11 minutes, 250 MB of samples).
const MAX_DECODE = 10 * 1048576;
// A share that LA2L Sender could not open at once (offline, or Android closed the page) comes back for a day.
const SHARE_DAYS_MS = 24 * 3600 * 1000;
// The sound files a ZIP file may hold; the rest is left out.
const SOUND = /\.(wave?|mp3|m4a|aac|mp4|ogg|oga|opus|flac|webm)$/i;
const KINDS = ['loop', 'oneshot'];
const ROLES = ['drums', 'bass', 'melodic', 'vocal', 'texture', 'fx'];
const POLL_MS = 2000;
const RECENT = 10;

const $ = (id) => document.getElementById(id);

// Where the browser blocks localStorage, the values live in memory until the page closes.
const memory = new Map();
const saved = {
  // What could not be written (blocked or full) is kept in memory, and read from there first.
  get(key) {
    if (memory.has(key)) return memory.get(key);
    try {
      return localStorage.getItem('la2l.' + key);
    } catch (e) {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('la2l.' + key, value);
      memory.delete(key);
    } catch (e) {
      memory.set(key, value);
    }
  },
  remove(key) {
    memory.delete(key);
    try {
      localStorage.removeItem('la2l.' + key);
    } catch (e) {
      // only in memory, and gone there
    }
  },
};

const la2l = new LA2L({ appName: APP_NAME, server: 'api', storage: saved });

function say(el, text, bad) {
  el.textContent = text || '';
  el.classList.toggle('bad', !!bad);
}

// The text of an error for the page: the SDK's errors carry the server's text.
const problem = (e) => (e && e.message ? e.message : String(e));

// ---- step 1, pair ----

const pairMessage = (text, bad) => say($('pair-message'), text, bad);

function showUnpaired() {
  $('pair-checking').hidden = true;
  $('paired').hidden = true;
  $('pair-form').hidden = false;
  $('send-locked').hidden = false;
  $('send-form').hidden = true;
  $('sent').hidden = true;
  $('recent-card').hidden = true;
  stopPolling();
}

function showPaired(deviceName) {
  $('pair-checking').hidden = true;
  $('pair-form').hidden = true;
  $('device-name').textContent = deviceName;
  $('paired').hidden = false;
  $('send-locked').hidden = true;
  if ($('sent').hidden) $('send-form').hidden = false;
  showRecent(true);
}

// A call came back with not_paired: the SDK has forgotten the token. The packages of that
// pairing cannot be followed any more, so they go too.
function lostPairing() {
  saved.remove('recent');
  showUnpaired();
  pairMessage('This browser is no longer paired. Pair it again.');
}

// Every error of a call: not_paired means the pairing is gone.
function failed(e, show) {
  if (e instanceof La2lError && e.code === 'not_paired') return lostPairing();
  show(problem(e), true);
}

// At load: is the saved token still good?
async function checkPairing() {
  if (!la2l.paired) return showUnpaired();
  try {
    const me = await la2l.me();
    showPaired(me.deviceName);
  } catch (e) {
    if (e instanceof La2lError && e.code === 'not_paired') return lostPairing();
    showPaired(la2l.deviceName || 'your computer');
    pairMessage(problem(e), true);
  }
}

async function pair(event) {
  event.preventDefault();
  $('pair-button').disabled = true;
  pairMessage('Pairing...');
  try {
    // The packages of an old pairing cannot be followed with a new token, so they go too.
    saved.remove('recent');
    const { deviceName } = await la2l.pair($('code').value);
    $('code').value = '';
    showPaired(deviceName);
    pairMessage('Done. In a moment Live says: Paired with LA2L Sender.');
    if (shareNote) sendMessage(shareNote);
  } catch (e) {
    pairMessage(problem(e), true);
  } finally {
    $('pair-button').disabled = false;
  }
}

async function unpair() {
  $('unpair-button').disabled = true;
  try {
    await la2l.unpair();
  } catch (e) {
    // The server was not told: this browser stays paired, so Live and the page agree.
    return pairMessage(problem(e), true);
  } finally {
    $('unpair-button').disabled = false;
  }
  saved.remove('recent');
  showUnpaired();
  pairMessage('This browser is unpaired.');
}

// ---- step 2, send ----

const sendMessage = (text, bad) => say($('send-message'), text, bad);
let rows = []; // { file, el }
let serverVersion = '';

const isZip = (f) => /\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed';
const isWavName = (name) => /\.wave?$/i.test(name);

// The sounds in what the user chose or another app shared, as WAV files LA2L takes: a ZIP file
// gives its sound files, and mp3, m4a and the like become WAV in the browser. Resolves to
// { files, refused }, every file as { file, from }, `from` being the name it came with.
async function soundsFrom(list) {
  const refused = [];
  const found = [];
  for (const file of list) {
    if (!isZip(file)) {
      found.push(file);
      continue;
    }
    try {
      const { files, skipped } = await readZip(file, (name) => SOUND.test(name));
      found.push(...files);
      if (!files.length) refused.push(`${file.name}: there is no sound file in it.`);
      else if (skipped.length) refused.push(`${file.name}: left out ${skipped.join(', ')}: not ${skipped.length === 1 ? 'a sound' : 'sounds'}.`);
    } catch (e) {
      refused.push(`${file.name}: ${problem(e)}`);
    }
  }
  const files = [];
  for (const file of found) {
    let wav = file;
    let notWav = null;
    try {
      await checkWav(file);
    } catch (e) {
      notWav = e;
    }
    if (notWav) {
      // A WAV file LA2L cannot use gets LA2L's own text; anything else is decoded, if it is not too long.
      if (file.size > MAX_DECODE) {
        refused.push(`${file.name}: ${isWavName(file.name) ? problem(notWav) : 'too long to turn into WAV on this device. Export it as WAV.'}`);
        continue;
      }
      try {
        const made = await toWav(file, { maxBytes: MAX_BYTES });
        wav = new File([made], file.name.replace(/\.[^.]*$/, '') + '.wav', { type: 'audio/wav' });
      } catch (e) {
        refused.push(`${file.name}: ${problem(isWavName(file.name) ? notWav : e)}`);
        continue;
      }
    }
    if (wav.size > MAX_BYTES) {
      refused.push(`${file.name}: ${Math.round(wav.size / 1048576)} MB as WAV. LA2L takes 200 MB per package at most.`);
      continue;
    }
    files.push({ file: wav, from: file.name });
  }
  return { files, refused };
}

// One sound in the list, with its fields.
function addRow({ file, from }) {
  const el = $('sound-template').content.firstElementChild.cloneNode(true);
  el.querySelector('.file-name').textContent = from === file.name ? from : `${from}, as WAV`;
  el.querySelector('.name').value = from.replace(/\.[^.]*$/, '').slice(0, 40);
  const row = { file, from, el, extra: {} };
  // Only a loop is warped, so tempo and length only mean something for a loop.
  const kind = el.querySelector('.kind');
  const showKind = () => {
    const oneshot = kind.value === 'oneshot';
    for (const sel of ['.item-bpm', '.beats']) el.querySelector(sel).disabled = oneshot;
    el.querySelector('.oneshot-hint').hidden = !oneshot;
  };
  kind.addEventListener('change', showKind);
  showKind();
  el.querySelector('.remove').addEventListener('click', () => {
    rows = rows.filter((x) => x !== row);
    el.remove();
    // Every sound of a share removed: the share is done with.
    if (!rows.length) forgetShare();
  });
  rows.push(row);
  $('sounds').append(el);
  return row;
}

// Adds sound files to the list. Resolves to { added, refused }.
async function addFiles(list) {
  sendMessage('Reading the files...');
  const { files, refused } = await soundsFrom(list);
  const added = files.map(addRow);
  sendMessage(refused.join(' '), refused.length > 0);
  return { added, refused };
}

async function chooseFiles() {
  const input = $('files');
  const chosen = Array.from(input.files || []);
  input.value = ''; // so the same file can be chosen again
  await addFiles(chosen);
}

// A number from the field, or null when it is empty. NaN when it is not a number.
function numberIn(el) {
  const v = el.value.trim().replace(',', '.');
  if (!v) return null;
  return /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
}

// What the fields say, as a send for the SDK, or a problem to show.
function buildSend() {
  if (!rows.length) return { error: 'Choose one or more sound files first.' };
  const bpm = numberIn($('bpm'));
  if (bpm !== null && !(bpm >= 20 && bpm <= 999)) return { error: 'The BPM of the package must be a number from 20 to 999.' };
  const sounds = [];
  for (const [i, r] of rows.entries()) {
    const q = (sel) => r.el.querySelector(sel);
    const name = q('.name').value.trim() || `Sound ${i + 1}`;
    const sound = Object.assign({ id: `sound-${i + 1}` }, r.extra, { audio: r.file, name, kind: q('.kind').value });
    if (q('.role').value) sound.role = q('.role').value;
    if (sound.kind === 'loop') {
      const itemBpm = numberIn(q('.item-bpm'));
      if (itemBpm !== null && !(itemBpm >= 20 && itemBpm <= 999)) return { error: `${name}: the BPM must be a number from 20 to 999.` };
      if (itemBpm !== null) sound.bpm = itemBpm;
      const beats = numberIn(q('.beats'));
      if (beats !== null && !(beats > 0 && beats <= 4096)) return { error: `${name}: the length must be a number of beats above 0.` };
      if (beats !== null) sound.lengthBeats = beats;
    }
    if (q('.color').value) sound.color = q('.color').value;
    sounds.push(sound);
  }
  const send = { title: $('title').value.trim() || 'Sender test', sounds };
  // A share described by its app: the tracks carry that app's name, as the description says.
  if (shareApp) send.appName = shareApp;
  if (bpm !== null) send.bpm = bpm;
  return { send };
}

// The sounds in packages LA2L takes: at most 32 sounds and 200 MB each, in their order.
function split(sounds) {
  const parts = [];
  let part = [];
  let bytes = 0;
  for (const sound of sounds) {
    if (part.length && (part.length === MAX_SOUNDS || bytes + sound.audio.size > MAX_BYTES)) {
      parts.push(part);
      part = [];
      bytes = 0;
    }
    part.push(sound);
    bytes += sound.audio.size;
  }
  if (part.length) parts.push(part);
  return parts;
}

async function send(event) {
  event.preventDefault();
  if (!rows.length) return sendMessage('Choose one or more sound files first.', true);
  const built = buildSend();
  if (built.error) return sendMessage(built.error, true);
  const fields = $('send-fields');
  fields.disabled = true;
  const bars = rows.map((r) => r.el.querySelector('.progress'));
  for (const r of rows) say(r.el.querySelector('.sound-message'), '');
  // More than 32 sounds or 200 MB: several packages, "Title (1 of 2)" and so on.
  const parts = split(built.send.sounds);
  const sent = [];
  let first = 0;
  try {
    for (const [k, sounds] of parts.entries()) {
      // LA2L cuts a title at 60 characters: the part number must fit in them.
      const suffix = parts.length > 1 ? ` (${k + 1} of ${parts.length})` : '';
      const title = built.send.title.slice(0, 60 - suffix.length).trim() + suffix;
      const count = sounds.length;
      const offset = first;
      const where = parts.length > 1 ? `package ${k + 1} of ${parts.length}, ` : '';
      sendMessage('Checking the files...');
      const delivery = await la2l.send(
        Object.assign({}, built.send, {
          title,
          sounds,
          onProgress: (share, p) => {
            if (p.stage !== 'uploading') return;
            sendMessage(`Sending ${where}${p.sound + 1} of ${count}...`);
            const bar = bars[offset + p.sound];
            bar.hidden = false;
            bar.value = p.soundShare;
            for (let i = offset; i < offset + p.sound; i++) bars[i].value = 1;
          },
        })
      );
      const entry = { id: delivery.packageId, title, count, sentAt: new Date().toISOString(), status: 'waiting', text: statusText({ status: 'waiting', sounds: [] }, count) };
      remember(entry);
      follow(entry);
      sent.push(entry);
      first += count;
    }
    forgetShare();
    if (sent.length === 1) showSent(sent[0]);
    else showSentMany(sent);
  } catch (e) {
    // The sounds of the packages that went are taken off the list, so a new Send sends the rest only.
    if (sent.length) {
      for (const r of rows.slice(0, first)) r.el.remove();
      rows = rows.slice(first);
    }
    if (e instanceof La2lError && e.code === 'not_paired') return lostPairing();
    const done = sent.length ? ` Sent before this: ${sent.map((x) => x.title).join(', ')}. Send sends the sounds that are left.` : '';
    sendMessage(problem(e) + done, true);
  } finally {
    fields.disabled = false;
  }
}

// ---- the status of a package ----

// What the app shows for a status. count: the number of sounds that were sent.
function statusText(st, count) {
  const inLive = (st.sounds || []).filter((it) => it.status === 'imported').length;
  switch (st.status) {
    case 'waiting':
      return 'Waiting for Import in Live.';
    case 'imported':
      return `In Live: ${count} of ${count} ${count === 1 ? 'sound' : 'sounds'}.`;
    case 'partial':
      return `In Live: ${inLive} of ${count} sounds.`;
    case 'failed':
      return `Live could not import it.${st.error ? ' ' + st.error : ''} The next Import tries again.`;
    case 'expired':
      return 'Expired: it was not imported within 24 hours.';
    case 'gone':
      return 'No longer on the server.';
    case 'uploading':
      return 'Not sent completely.';
    default:
      return st.status;
  }
}

const FINAL = new Set(['imported', 'partial', 'expired', 'gone']);

// The problems per sound from what Live said, as lines for a list.
function itemProblems(st) {
  return (st.sounds || []).filter((it) => it.status === 'failed').map((it) => `${it.name || it.id}: ${it.error || 'not imported'}`);
}

function showSent(entry, st = { status: entry.status, sounds: [] }) {
  $('send-form').hidden = true;
  $('sent').hidden = false;
  $('sent').dataset.id = entry.id;
  say($('sent-status'), entry.text, entry.status === 'failed' || entry.status === 'expired' || entry.status === 'gone');
  $('sent-status').classList.toggle('ok', entry.status === 'imported');
  const list = $('sent-items');
  list.replaceChildren(...itemProblems(st).map((line) => Object.assign(document.createElement('li'), { textContent: line })));
}

async function refresh(entry) {
  let st;
  try {
    st = await la2l.delivery(entry.id).status();
  } catch (e) {
    if (e instanceof La2lError && e.code === 'not_paired') lostPairing();
    return null; // offline or a problem: keep what we had
  }
  // A package the server no longer knows at all (its result is kept 7 days).
  if (st.status === 'expired' && st.updatedAt === null) st = Object.assign({}, st, { status: 'gone' });
  const before = entry.text;
  entry.status = st.status;
  entry.text = statusText(st, entry.count);
  if (entry.text !== before) remember(entry);
  if ($('sent').dataset.id === entry.id && !$('sent').hidden) showSent(entry, st);
  return entry;
}

let pollers = new Map(); // package id -> interval

function follow(entry) {
  if (pollers.has(entry.id) || FINAL.has(entry.status)) return;
  const timer = setInterval(async () => {
    const now = await refresh(entry);
    if (now && FINAL.has(now.status)) {
      clearInterval(timer);
      pollers.delete(entry.id);
    }
  }, POLL_MS);
  pollers.set(entry.id, timer);
}

function stopPolling() {
  for (const timer of pollers.values()) clearInterval(timer);
  pollers = new Map();
}

// After a send of several packages: their status is under Recent.
function showSentMany(entries) {
  $('send-form').hidden = true;
  $('sent').hidden = false;
  $('sent').dataset.id = '';
  say($('sent-status'), `Sent as ${entries.length} packages: LA2L takes 32 sounds and 200 MB per package. Click Import in Live; each package shows under Recent.`);
  $('sent-status').classList.remove('ok');
  $('sent-items').replaceChildren(...entries.map((e) => Object.assign(document.createElement('li'), { textContent: e.title })));
}

function sendMore() {
  rows = [];
  $('sounds').replaceChildren();
  sendMessage('');
  $('sent').hidden = true;
  delete $('sent').dataset.id;
  $('send-form').hidden = false;
  $('files').focus();
}

// ---- recent ----

function recentList() {
  try {
    const list = JSON.parse(saved.get('recent') || '[]');
    return Array.isArray(list) ? list.filter((e) => e && typeof e.id === 'string') : [];
  } catch (e) {
    return [];
  }
}

function remember(entry) {
  const list = recentList().filter((e) => e.id !== entry.id);
  list.unshift({ id: entry.id, title: entry.title, count: entry.count, sentAt: entry.sentAt, status: entry.status, text: entry.text });
  saved.set('recent', JSON.stringify(list.slice(0, RECENT)));
  showRecent(false);
}

// fetchNow: also ask the server for the current status of each, as at load.
function showRecent(fetchNow) {
  const list = recentList();
  $('recent-card').hidden = list.length === 0;
  $('recent').replaceChildren(
    ...list.map((entry) => {
      const li = document.createElement('li');
      const what = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = entry.title;
      const when = document.createElement('span');
      when.className = 'hint';
      when.textContent = ` ${entry.count} ${entry.count === 1 ? 'sound' : 'sounds'}, ${new Date(entry.sentAt).toLocaleString()}`;
      const text = document.createElement('p');
      text.textContent = entry.text;
      text.className = entry.status === 'imported' ? 'ok' : ['failed', 'expired', 'gone'].includes(entry.status) ? 'bad' : '';
      what.append(title, when, text);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary small';
      button.textContent = 'Refresh';
      button.addEventListener('click', async () => {
        button.disabled = true;
        await refresh(entry);
        button.disabled = false;
      });
      li.append(what, button);
      return li;
    })
  );
  if (fetchNow) {
    for (const entry of list) {
      if (FINAL.has(entry.status)) continue;
      refresh(entry).then((now) => now && follow(now));
    }
  }
}

// ---- the big test (?big) ----

// A WAV file of 150 MB made by big.js, sent as a one-shot, with the time the upload took. For a
// long upload over a phone network, without a large file on the phone. The page carries its
// checksum, so a phone does not hash 150 MB.
const bigMessage = (text, bad) => say($('big-message'), text, bad);
const minutes = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

async function sendBig() {
  if (!la2l.paired) return bigMessage('Pair this browser first.', true);
  // big.js is a plain script before this one; its const is a global name, not a property of window.
  const big = BIG_TEST;
  const button = $('big-button');
  const bar = $('big-progress');
  button.disabled = true;
  bar.value = 0;
  bar.hidden = false;
  let tick = null;
  try {
    bigMessage('Making the file...');
    const audio = big.blob();
    const started = Date.now();
    tick = setInterval(() => bigMessage(`Sending: ${Math.round(bar.value * 100)}% after ${minutes(Date.now() - started)}.`), 1000);
    let delivery;
    try {
      delivery = await la2l.send({
        title: big.name,
        sounds: [{ id: 'big', name: big.name, audio, file: big.file, sha256: big.sha256, kind: 'oneshot' }],
        onProgress: (share) => {
          bar.value = share;
        },
      });
    } catch (e) {
      clearInterval(tick);
      if (e instanceof La2lError && e.code === 'not_paired') return lostPairing();
      return bigMessage(`The upload stopped after ${minutes(Date.now() - started)}, at ${Math.round(bar.value * 100)}%. ${problem(e)}`, true);
    }
    clearInterval(tick);
    const took = Date.now() - started;
    const mbit = (big.bytes * 8) / (took / 1000) / 1e6;
    bigMessage(`Sent 150 MB in ${minutes(took)} (${mbit.toFixed(1)} Mbit/s). Click Import in Live: it brings in Big test.`);
    const entry = { id: delivery.packageId, title: big.name, count: 1, sentAt: new Date().toISOString(), status: 'waiting', text: statusText({ status: 'waiting', sounds: [] }, 1) };
    remember(entry);
    follow(entry);
  } catch (e) {
    bigMessage(`Something went wrong in this browser: ${problem(e)}`, true);
  } finally {
    clearInterval(tick);
    button.disabled = false;
  }
}

// ---- sounds shared from another app ----

let shareId = null; // the share in IndexedDB whose sounds are in the list
let shareNote = ''; // what to say about it once this browser is paired
let shareApp = null; // source.app of its description

function forgetShare() {
  if (shareId) removeShare(shareId).catch(() => {});
  shareId = null;
  shareNote = '';
  shareApp = null;
}

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

// The description of a shared package: the tempo, and per sound what the app said. Only values of
// the right type are read, so a crafted description cannot make the page stop here.
function describe(manifest, added) {
  const tempo = manifest.tempo && typeof manifest.tempo === 'object' ? manifest.tempo : {};
  if (isNumber(tempo.bpm) && tempo.bpm >= 20 && tempo.bpm <= 999) $('bpm').value = String(tempo.bpm);
  for (const row of added) {
    const q = (sel) => row.el.querySelector(sel);
    const it = itemFor(manifest, row.from) || itemFor(manifest, row.file.name);
    // A shared file without an item gets the defaults of a description: a one-shot.
    const kind = it && KINDS.includes(it.kind) ? it.kind : 'oneshot';
    q('.kind').value = kind;
    q('.kind').dispatchEvent(new Event('change'));
    if (!it) continue;
    if (typeof it.name === 'string' && it.name.trim()) q('.name').value = it.name.trim().slice(0, 40);
    if (ROLES.includes(it.role)) q('.role').value = it.role;
    if (isNumber(it.bpm) && it.bpm >= 20 && it.bpm <= 999) q('.item-bpm').value = String(it.bpm);
    if (isNumber(it.length_beats) && it.length_beats > 0) q('.beats').value = String(it.length_beats);
    if (typeof it.color === 'string' && /^#[0-9a-f]{6}$/i.test(it.color)) {
      const color = q('.color');
      const value = it.color.toUpperCase();
      if (![...color.options].some((o) => o.value === value)) color.append(new Option(`From the app (${value})`, value));
      color.value = value;
    }
    if (typeof it.id === 'string' && it.id) row.extra.id = it.id;
    const extras = [];
    if (typeof it.warp_mode === 'string' || isNumber(it.warp_mode)) {
      row.extra.warpMode = it.warp_mode;
      extras.push(`warp mode ${it.warp_mode}`);
    }
    if (isNumber(it.gain_db)) {
      row.extra.gainDb = it.gain_db;
      extras.push(`gain ${it.gain_db} dB`);
    }
    if (extras.length) say(q('.sound-message'), `From the app: ${extras.join(', ')}.`);
  }
}

// What an app shared: with ?share=<id> the share the service worker just kept; without it, a
// share of the last day that the page could not open then. The share stays in IndexedDB until its
// sounds are sent or removed.
async function openShare() {
  const id = new URLSearchParams(location.search).get('share');
  // Without ?share in the address, a reload does not look for it again.
  if (id !== null) history.replaceState(null, '', location.pathname);
  const tell = (text, bad) => (la2l.paired ? sendMessage(text, bad) : pairMessage(text, bad));
  if (id === 'failed') return tell('The shared sounds could not be kept on this device, maybe for lack of room. Share them again.', true);
  let share = null;
  let earlier = false;
  try {
    const newest = await newestShare(SHARE_DAYS_MS);
    share = id !== null ? await getShare(id) : newest;
    earlier = id === null && !!share;
  } catch (e) {
    // no IndexedDB: as if it were gone
  }
  if (!share) return id !== null ? tell('The shared sounds are no longer here. Share them again.', true) : undefined;
  shareId = share.id;
  const files = Array.isArray(share.files) ? share.files : [];
  const { added, refused } = await addFiles(files);
  const described = manifestFromText(share.text);
  const manifest = described && described.manifest;
  const notes = [];
  try {
    if (manifest) {
      describe(manifest, added);
      const missing = missingFiles(manifest, [...files.map((f) => f.name), ...added.map((r) => r.from)]);
      if (missing.length) notes.push(`The description also names ${missing.join(', ')}, which ${missing.length === 1 ? 'was' : 'were'} not shared.`);
      if (manifest.source && typeof manifest.source === 'object' && typeof manifest.source.app === 'string' && manifest.source.app.trim()) shareApp = manifest.source.app.trim().slice(0, 40);
    } else if (described && described.error) notes.push(described.error);
  } catch (e) {
    notes.push('The app shared a description of the sounds that LA2L cannot read. Set them below.');
  }
  // The title: the description's, else the share's, else the name of the one file that came.
  let title = (manifest && typeof manifest.title === 'string' && manifest.title.trim()) || (typeof share.title === 'string' && share.title.trim()) || '';
  if (!title) title = files.length === 1 ? files[0].name.replace(/\.[^.]*$/, '') : 'Shared sounds';
  $('title').value = title.slice(0, 60);
  const n = added.length;
  const what = `${n} ${n === 1 ? 'sound' : 'sounds'} ${earlier ? 'shared earlier, here again' : 'shared'}${manifest ? ', described by the app' : ''}.`;
  shareNote = n ? `${what} Check loop or one-shot, the BPM and the role, then send.` : '';
  let text = n ? shareNote : 'No sound came with the share.';
  if (n && !la2l.paired) text = `Pair this browser with Live first. Then the ${n} shared ${n === 1 ? 'sound is' : 'sounds are'} ready to send.`;
  if (!n) forgetShare();
  tell([text, ...refused, ...notes].join(' '), !n || refused.length > 0 || notes.length > 0);
}

// ---- the installed app ----

let installPrompt = null;

function setUpApp() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (matchMedia('(display-mode: standalone)').matches) {
    $('install-card').hidden = true;
    return;
  }
  // Chrome offers to install the page: a button for that, next to the steps by hand.
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    $('install-button').hidden = false;
  });
  $('install-button').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    $('install-button').hidden = true;
  });
}

// ---- the server ----

async function showServer() {
  const out = $('server');
  try {
    const r = await fetch('api/health', { cache: 'no-store' });
    const json = await r.json();
    if (r.status === 200 && json.ok === true) {
      serverVersion = String(json.version || '');
      out.textContent = `Server: ${json.name} ${serverVersion}`;
      out.className = 'ok';
      return;
    }
    out.textContent = `The server has a problem: ${json.error || r.status}`;
  } catch (e) {
    out.textContent = 'The server does not answer.';
  }
  out.className = 'bad';
}

$('pair-form').addEventListener('submit', pair);
$('unpair-button').addEventListener('click', unpair);
$('files').addEventListener('change', chooseFiles);
$('send-form').addEventListener('submit', send);
$('send-more').addEventListener('click', sendMore);
if (new URLSearchParams(location.search).has('big')) {
  $('big').hidden = false;
  $('big-button').addEventListener('click', sendBig);
}
setUpApp();
checkPairing().then(openShare);
showServer();
