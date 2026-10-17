'use strict';
// LA2L Sender: the test page, and the reference client of the app API (docs/server-api.md).
// Every address is relative ("api/pair/claim"), so the page works under any prefix, such as
// https://lloydstellar.nl/la2l/. The app token lives in localStorage of this browser.

const APP_NAME = 'LA2L Sender';
const CODE_LETTERS = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const MAX_SOUNDS = 32;
const MAX_BYTES = 200 * 1048576;
const POLL_MS = 2000;
const RECENT = 10;

const $ = (id) => document.getElementById(id);

// Where the browser blocks localStorage, the values live in memory until the page closes.
const memory = new Map();
const saved = {
  get(key) {
    try {
      return localStorage.getItem('la2l.' + key);
    } catch (e) {
      return memory.has(key) ? memory.get(key) : null;
    }
  },
  set(key, value) {
    try {
      if (value === null) localStorage.removeItem('la2l.' + key);
      else localStorage.setItem('la2l.' + key, value);
    } catch (e) {
      if (value === null) memory.delete(key);
      else memory.set(key, value);
    }
  },
};

// One id per browser, so pairing this browser again replaces its old token.
function appId() {
  let id = saved.get('appId');
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    saved.set('appId', id);
  }
  return id;
}

// A call to the API. Resolves to { status, json }; status 0 when the server could not be reached.
// A 401 means this browser is no longer paired: the page forgets the token and shows step 1.
async function api(method, path, body) {
  const headers = {};
  const token = saved.get('token');
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let r;
  try {
    r = await fetch('api/' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  } catch (e) {
    return { status: 0, json: {} };
  }
  let json = {};
  try {
    json = await r.json();
  } catch (e) {
    // not JSON: keep {}
  }
  if (r.status === 401 && token && path !== 'pair/claim') lostPairing();
  return { status: r.status, json };
}

// The server's own text when it sent one, else a line that says what happened.
function problem(r) {
  if (r.status === 0) return 'The server does not answer. Try again later.';
  return r.json.error || `The server answered ${r.status}.`;
}

function say(el, text, bad) {
  el.textContent = text || '';
  el.classList.toggle('bad', !!bad);
}

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

// The packages of an old pairing cannot be followed with a new token, so they go too.
function forgetPairing() {
  saved.set('token', null);
  saved.set('deviceName', null);
  saved.set('recent', null);
}

function lostPairing() {
  if (!saved.get('token')) return;
  forgetPairing();
  showUnpaired();
  pairMessage('This browser is no longer paired. Pair it again.');
}

// At load: is the saved token still good?
async function checkPairing() {
  if (!saved.get('token')) return showUnpaired();
  const r = await api('GET', 'app/me');
  if (r.status === 200) return showPaired(r.json.device_name);
  if (r.status === 401) return;
  showPaired(saved.get('deviceName') || 'your computer');
  pairMessage(problem(r), true);
}

async function pair(event) {
  event.preventDefault();
  const code = $('code').value.toUpperCase().replace(/[\s-]/g, '');
  if (!CODE_LETTERS.test(code)) {
    pairMessage('A code has 6 letters and digits, like K7P 42Q.', true);
    return;
  }
  $('pair-button').disabled = true;
  pairMessage('Pairing...');
  const r = await api('POST', 'pair/claim', { code, app_name: APP_NAME, app_id: appId() });
  $('pair-button').disabled = false;
  if (r.status === 200 && r.json.app_token) {
    forgetPairing();
    saved.set('token', r.json.app_token);
    saved.set('deviceName', r.json.device_name);
    $('code').value = '';
    showPaired(r.json.device_name);
    pairMessage('Done. In a moment Live says: Paired with LA2L Sender.');
    return;
  }
  pairMessage(problem(r), true);
}

async function unpair() {
  $('unpair-button').disabled = true;
  const r = await api('POST', 'app/unpair', {});
  $('unpair-button').disabled = false;
  if (r.status === 200 || r.status === 401) {
    forgetPairing();
    showUnpaired();
    pairMessage('This browser is unpaired.');
    return;
  }
  pairMessage(problem(r), true);
}

// ---- step 2, send ----

const sendMessage = (text, bad) => say($('send-message'), text, bad);
let rows = []; // { file, el, sha256 }
let serverVersion = '';

// The first 12 bytes of a WAV file are "RIFF", the size, "WAVE". Resolves to a problem, or ''.
async function wavProblem(file) {
  if (!file.size) return 'This file is empty.';
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const text = (from, to) => String.fromCharCode(...head.slice(from, to));
  if (text(0, 4) === 'RF64') return 'RF64 files are not supported. Send a normal WAV file.';
  if (head.length < 12 || text(0, 4) !== 'RIFF' || text(8, 12) !== 'WAVE') return 'This is not a WAV file.';
  return '';
}

async function addFiles() {
  const input = $('files');
  const chosen = Array.from(input.files || []);
  input.value = ''; // so the same file can be chosen again
  const refused = [];
  for (const file of chosen) {
    const why = await wavProblem(file);
    if (why) {
      refused.push(`${file.name}: ${why}`);
      continue;
    }
    const el = $('sound-template').content.firstElementChild.cloneNode(true);
    el.querySelector('.file-name').textContent = file.name;
    el.querySelector('.name').value = file.name.replace(/\.wav$/i, '').slice(0, 40);
    const row = { file, el, sha256: null };
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
    });
    rows.push(row);
    $('sounds').append(el);
  }
  sendMessage(refused.join(' '), refused.length > 0);
}

// A number from the field, or null when it is empty. NaN when it is not a number.
function numberIn(el) {
  const v = el.value.trim().replace(',', '.');
  if (!v) return null;
  return /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
}

// A file name the server takes: letters, digits, space, "." "_" "-", ending in .wav, unique.
function serverFileName(name, index, taken) {
  let base = name
    .replace(/\.wav$/i, '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 ._-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 90)
    .replace(/[ ._-]+$/, '');
  if (!base) base = `sound ${index + 1}`;
  let file = base + '.wav';
  for (let n = 2; taken.has(file.toLowerCase()); n++) file = `${base}-${n}.wav`;
  taken.add(file.toLowerCase());
  return file;
}

// The manifest (docs/manifest.md), or a problem to show.
function buildManifest() {
  if (!rows.length) return { error: 'Choose one or more WAV files first.' };
  if (rows.length > MAX_SOUNDS) return { error: `LA2L takes ${MAX_SOUNDS} sounds at most. Remove ${rows.length - MAX_SOUNDS}.` };
  const total = rows.reduce((n, r) => n + r.file.size, 0);
  if (total > MAX_BYTES) return { error: `These files are ${Math.round(total / 1048576)} MB together. LA2L takes 200 MB at most.` };
  const bpm = numberIn($('bpm'));
  if (bpm !== null && !(bpm >= 20 && bpm <= 999)) return { error: 'The BPM of the package must be a number from 20 to 999.' };
  const taken = new Set();
  const items = [];
  for (const [i, r] of rows.entries()) {
    const q = (sel) => r.el.querySelector(sel);
    const name = q('.name').value.trim() || `Sound ${i + 1}`;
    const item = { id: `sound-${i + 1}`, file: serverFileName(r.file.name, i, taken), bytes: r.file.size, sha256: r.sha256, name, kind: q('.kind').value };
    if (q('.role').value) item.role = q('.role').value;
    if (item.kind === 'loop') {
      const itemBpm = numberIn(q('.item-bpm'));
      if (itemBpm !== null && !(itemBpm >= 20 && itemBpm <= 999)) return { error: `${name}: the BPM must be a number from 20 to 999.` };
      if (itemBpm !== null) item.bpm = itemBpm;
      const beats = numberIn(q('.beats'));
      if (beats !== null && !(beats > 0 && beats <= 4096)) return { error: `${name}: the length must be a number of beats above 0.` };
      if (beats !== null) item.length_beats = beats;
    }
    if (q('.color').value) item.color = q('.color').value;
    r.item = item;
    items.push(item);
  }
  const manifest = {
    schema: 'app2live/1',
    created_at: new Date().toISOString(),
    title: $('title').value.trim() || 'Sender test',
    source: { app: APP_NAME, app_version: serverVersion, platform: 'web' },
    items,
  };
  if (bpm !== null) manifest.tempo = { bpm };
  return { manifest };
}

async function sha256Hex(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// One file with XMLHttpRequest, because fetch cannot show the progress of an upload.
function putFile(path, file, progress) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', 'api' + path);
    xhr.setRequestHeader('Authorization', 'Bearer ' + saved.get('token'));
    xhr.setRequestHeader('Content-Type', 'audio/wav');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) progress.value = e.loaded / e.total;
    };
    xhr.onload = () => {
      let json = {};
      try {
        json = JSON.parse(xhr.responseText);
      } catch (e) {
        // not JSON
      }
      if (xhr.status === 401) lostPairing();
      resolve({ status: xhr.status, json });
    };
    xhr.onerror = () => resolve({ status: 0, json: {} });
    xhr.send(file);
  });
}

async function send(event) {
  event.preventDefault();
  if (!rows.length) return sendMessage('Choose one or more WAV files first.', true);
  const fields = $('send-fields');
  fields.disabled = true;
  for (const r of rows) say(r.el.querySelector('.sound-message'), '');
  try {
    let built = buildManifest(); // the fields first, before the files are read
    if (built.error) return sendMessage(built.error, true);
    sendMessage('Checking the files...');
    for (const r of rows) if (!r.sha256) r.sha256 = await sha256Hex(r.file);
    built = buildManifest();

    sendMessage('Sending...');
    const created = await api('POST', 'packages', built.manifest);
    if (created.status !== 201) return sendMessage(problem(created), true);
    const id = created.json.package_id;
    for (const [i, r] of rows.entries()) {
      sendMessage(`Sending ${i + 1} of ${rows.length}...`);
      const bar = r.el.querySelector('.progress');
      bar.value = 0;
      bar.hidden = false;
      const put = await putFile(created.json.upload[r.item.file], r.file, bar);
      if (put.status !== 200) {
        say(r.el.querySelector('.sound-message'), problem(put), true);
        api('DELETE', 'packages/' + id); // the rest would only wait for an hour
        return sendMessage(`${r.item.name} was not sent. ${problem(put)}`, true);
      }
      bar.value = 1;
    }
    const commit = await api('POST', `packages/${id}/commit`, {});
    if (commit.status !== 200) return sendMessage(problem(commit), true);

    const entry = { id, title: built.manifest.title, count: rows.length, sentAt: new Date().toISOString(), status: 'waiting', text: statusText({ status: 'waiting' }, rows.length) };
    remember(entry);
    showSent(entry);
    follow(entry);
  } catch (e) {
    sendMessage(`Something went wrong in this browser: ${e.message}`, true);
  } finally {
    fields.disabled = false;
  }
}

// ---- the status of a package ----

// What the app shows for a status answer. count: the number of sounds that were sent.
function statusText(st, count) {
  const inLive = (st.items || []).filter((it) => it.status === 'imported').length;
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
    case 'uploading':
      return 'Not sent completely.';
    default:
      return st.status;
  }
}

const FINAL = new Set(['imported', 'partial', 'expired', 'gone']);

// The problems per sound from the ack, as lines for a list.
function itemProblems(st) {
  return (st.items || []).filter((it) => it.status === 'failed').map((it) => `${it.name || it.id}: ${it.error || 'not imported'}`);
}

function showSent(entry, st = { status: entry.status, items: [] }) {
  $('send-form').hidden = true;
  $('sent').hidden = false;
  $('sent').dataset.id = entry.id;
  say($('sent-status'), entry.text, entry.status === 'failed' || entry.status === 'expired' || entry.status === 'gone');
  $('sent-status').classList.toggle('ok', entry.status === 'imported');
  const list = $('sent-items');
  list.replaceChildren(...itemProblems(st).map((line) => Object.assign(document.createElement('li'), { textContent: line })));
}

async function refresh(entry) {
  const r = await api('GET', `packages/${entry.id}/status`);
  const before = entry.text;
  if (r.status === 200) {
    entry.status = r.json.status;
    entry.text = statusText(r.json, entry.count);
  } else if (r.status === 404) {
    entry.status = 'gone';
    entry.text = 'No longer on the server.';
  } else {
    return null; // offline or a problem: keep what we had
  }
  if (entry.text !== before) remember(entry);
  if ($('sent').dataset.id === entry.id && !$('sent').hidden) showSent(entry, r.json);
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

// fetch: also ask the server for the current status of each, as at load.
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
// long upload over a phone network, without a large file on the phone.
const bigMessage = (text, bad) => say($('big-message'), text, bad);
const minutes = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

async function sendBig() {
  if (!saved.get('token')) return bigMessage('Pair this browser first.', true);
  const button = $('big-button');
  const bar = $('big-progress');
  button.disabled = true;
  bar.value = 0;
  bar.hidden = false;
  let tick = null;
  try {
    bigMessage('Making the file...');
    const blob = BIG_TEST.blob();
    const manifest = {
      schema: 'app2live/1',
      created_at: new Date().toISOString(),
      title: BIG_TEST.name,
      source: { app: APP_NAME, app_version: serverVersion, platform: 'web' },
      items: [{ id: 'big', file: BIG_TEST.file, bytes: BIG_TEST.bytes, sha256: BIG_TEST.sha256, name: BIG_TEST.name, kind: 'oneshot' }],
    };
    const created = await api('POST', 'packages', manifest);
    if (created.status !== 201) return bigMessage(problem(created), true);
    const id = created.json.package_id;
    const started = Date.now();
    tick = setInterval(() => bigMessage(`Sending: ${Math.round(bar.value * 100)}% after ${minutes(Date.now() - started)}.`), 1000);
    const put = await putFile(created.json.upload[BIG_TEST.file], blob, bar);
    clearInterval(tick);
    const took = Date.now() - started;
    if (put.status !== 200) {
      api('DELETE', 'packages/' + id); // it would only wait for an hour
      return bigMessage(`The upload stopped after ${minutes(took)}, at ${Math.round(bar.value * 100)}%. ${problem(put)}`, true);
    }
    const commit = await api('POST', `packages/${id}/commit`, {});
    if (commit.status !== 200) return bigMessage(problem(commit), true);
    const mbit = (BIG_TEST.bytes * 8) / (took / 1000) / 1e6;
    bigMessage(`Sent 150 MB in ${minutes(took)} (${mbit.toFixed(1)} Mbit/s). Click Import in Live: it brings in Big test.`);
    const entry = { id, title: BIG_TEST.name, count: 1, sentAt: new Date().toISOString(), status: 'waiting', text: statusText({ status: 'waiting' }, 1) };
    remember(entry);
    follow(entry);
  } catch (e) {
    bigMessage(`Something went wrong in this browser: ${e.message}`, true);
  } finally {
    clearInterval(tick);
    button.disabled = false;
  }
}

// ---- the server ----

async function showServer() {
  const out = $('server');
  const r = await api('GET', 'health');
  if (r.status === 200 && r.json.ok === true) {
    serverVersion = String(r.json.version || '');
    out.textContent = `Server: ${r.json.name} ${r.json.version}`;
    out.className = 'ok';
  } else {
    out.textContent = r.status === 0 ? 'The server does not answer.' : `The server has a problem: ${r.json.error || r.status}`;
    out.className = 'bad';
  }
}

$('pair-form').addEventListener('submit', pair);
$('unpair-button').addEventListener('click', unpair);
$('files').addEventListener('change', addFiles);
$('send-form').addEventListener('submit', send);
$('send-more').addEventListener('click', sendMore);
if (new URLSearchParams(location.search).has('big')) {
  $('big').hidden = false;
  $('big-button').addEventListener('click', sendBig);
}
checkPairing();
showServer();
