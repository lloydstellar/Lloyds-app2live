// LA2L Test receiver: a stand-in for LA2L in Ableton Live (sdk/BUILD-PROMPT.md, section 8). It
// uses only the device side of the API, as the device does: it shows a code, looks for packages
// every few seconds, downloads and checks every file with the device's own checks (from
// vendor/la2l.js, built from sdk/js), works out what Live would do with each sound, and acks, so
// the app sees the same status as with Live. Its keys in localStorage start with
// "la2l-receiver.", so LA2L Sender on this same site keeps its own pairing.

import { checkManifest, checkWav, planSound, sha256, La2lError, LIMITS } from './vendor/la2l.js';

const NAME = 'Test receiver';
const INBOX_MS = 3000;
const APPS_MS = 15000;
const KEEP_REPORTS = 20;
const ID = /^[A-Za-z0-9._-]{1,100}$/;
// The time limits of the device: 15 seconds for a JSON call, 10 minutes for a file.
const JSON_MS = 15000;
const FILE_MS = 600000;
// A package whose manifest did not come is looked at again after this long.
const LATER_MS = 30000;

const timeout = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

const $ = (id) => document.getElementById(id);

// ---- what this browser keeps ----

const memory = new Map();
const saved = {
  get(key) {
    try {
      return localStorage.getItem('la2l-receiver.' + key);
    } catch (e) {
      return memory.has(key) ? memory.get(key) : null;
    }
  },
  set(key, value) {
    try {
      if (value === null) localStorage.removeItem('la2l-receiver.' + key);
      else localStorage.setItem('la2l-receiver.' + key, value);
    } catch (e) {
      if (value === null) memory.delete(key);
      else memory.set(key, value);
    }
  },
  list(key) {
    try {
      const v = JSON.parse(this.get(key) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return [];
    }
  },
};

function deviceId() {
  let id = saved.get('deviceId');
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    saved.set('deviceId', id);
  }
  return id;
}

// ---- the server ----

// The server's text from an error answer, cleaned as the device cleans it.
const serverText = (json) => String((json && (json.error || json.message)) || '').replace(/[^\w .:'()-]/g, '').slice(0, 80);

// An HTTP status in the device's words (src/node/http.js statusError).
function statusText(status, text) {
  const extra = text ? ` ${text}` : '';
  if (status === 401) return 'This computer is no longer paired.';
  if (status === 403) return `The server refused this (403).${extra}`;
  if (status === 404) return `The server does not know this address (404).${extra}`;
  if (status === 410) return `This is no longer on the server (410).${extra}`;
  if (status === 413) return `Too large for the server (413).${extra}`;
  if (status === 429) return 'The server is busy. Wait a minute and try again.';
  if (status >= 500) return `The server has a problem (${status}). Try again later.`;
  return `The server answered ${status}.${extra}`;
}

class Unpaired extends Error {}

// A JSON call. Resolves to { status, json }, status 0 when the server could not be reached.
// A 401 on a call with the token means this receiver is no longer paired.
async function api(method, path, body, useToken = true) {
  const headers = {};
  const token = useToken ? saved.get('token') : null;
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let r;
  try {
    r = await fetch('api/' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', signal: timeout(JSON_MS) });
  } catch (e) {
    return { status: 0, json: {} };
  }
  let json = {};
  try {
    json = await r.json();
  } catch (e) {
    // not JSON
  }
  if (r.status === 401 && token) throw new Unpaired();
  return { status: r.status, json };
}

function say(el, text, bad) {
  el.textContent = text || '';
  el.classList.toggle('bad', !!bad);
}

const pairMessage = (text, bad) => say($('pair-message'), text, bad);

// ---- pairing ----

let pairing = null; // the code that shows: { pairId, expiresAt, pollMs, timer, countdown }
let asking = null; // a start that is under way

function showView(view) {
  $('pair-wait').hidden = view !== 'asking';
  $('code-box').hidden = view !== 'code';
  $('paired-box').hidden = view !== 'paired';
  $('new-code').hidden = view !== 'ended';
}

function stopPairing() {
  if (!pairing) return;
  clearTimeout(pairing.timer);
  clearInterval(pairing.countdown);
  pairing = null;
}

// A code for an app to type. With the token (Pair another app) the new app joins this receiver.
// One start at a time: a second one would make the server cancel the code of the first.
function startPairing() {
  if (!asking) asking = askCode().finally(() => (asking = null));
  return asking;
}

async function askCode() {
  stopPairing();
  showView('asking');
  pairMessage('');
  let r;
  try {
    r = await api('POST', 'pair/start', { device_id: deviceId(), device_name: NAME, client: 'LA2L test receiver', platform: 'web', test: true });
  } catch (e) {
    if (e instanceof Unpaired) return lostPairing();
    throw e;
  }
  if (r.status !== 200 || !r.json.code) {
    showView('ended');
    return pairMessage(r.status === 0 ? 'The server does not answer. Try again later.' : statusText(r.status, serverText(r.json)), true);
  }
  const seconds = Math.min(1800, Math.max(30, Number(r.json.expires_in) || 600));
  const p = { pairId: r.json.pair_id, expiresAt: Date.now() + seconds * 1000, pollMs: Math.min(10000, Math.max(500, Number(r.json.poll_ms) || 2000)) };
  pairing = p;
  $('code').textContent = `${r.json.code.slice(0, 3)} ${r.json.code.slice(3)}`;
  showView('code');
  const tick = () => {
    const left = Math.max(0, Math.ceil((p.expiresAt - Date.now()) / 1000));
    $('countdown').textContent = `This code works for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.`;
  };
  tick();
  p.countdown = setInterval(tick, 1000);
  p.timer = setTimeout(() => pollPairing(p), p.pollMs);
}

async function pollPairing(p) {
  if (pairing !== p) return;
  const r = await api('GET', 'pair/' + encodeURIComponent(p.pairId), undefined, false);
  if (pairing !== p) return;
  const status = r.status === 404 ? 'expired' : r.json.status;
  if (r.status === 200 && status === 'paired' && r.json.device_token) {
    stopPairing();
    saved.set('token', r.json.device_token);
    pairMessage('Now send sounds from your app. They show up below.');
    await showPaired();
    return;
  }
  if (status === 'expired' || status === 'cancelled' || Date.now() > p.expiresAt) {
    stopPairing();
    showView(saved.get('token') ? 'paired' : 'ended');
    pairMessage(status === 'cancelled' ? 'The code was cancelled.' : 'The code expired.');
    return;
  }
  p.timer = setTimeout(() => pollPairing(p), p.pollMs);
}

let watching = null; // the timers of the inbox and the app list

async function showPaired() {
  showView('paired');
  $('watch').textContent = 'Looking for new sounds every 3 seconds, as Import in Live would.';
  await refreshApps();
  if (!watching) {
    const apps = () => refreshApps().catch((e) => (e instanceof Unpaired ? lostPairing() : onError(e)));
    watching = { inbox: setInterval(lookForPackages, INBOX_MS), apps: setInterval(apps, APPS_MS) };
    lookForPackages();
  }
}

function stopWatching() {
  if (!watching) return;
  clearInterval(watching.inbox);
  clearInterval(watching.apps);
  watching = null;
}

// "Paired with Web808 and Robot Voice", as the device says it.
async function refreshApps() {
  const r = await api('GET', 'apps');
  if (r.status !== 200 || !Array.isArray(r.json.apps)) return;
  const names = [...new Set(r.json.apps.map((a) => String(a.name || 'App')))];
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  $('paired-with').textContent = names.length ? `Paired with ${list}.` : 'No app paired. Click Pair another app.';
}

function lostPairing() {
  stopWatching();
  saved.set('token', null);
  pairMessage('This receiver is no longer paired. Here is a new code.');
  $('watch').textContent = 'Pair an app first.';
  startPairing().catch(onError);
}

async function stop() {
  $('stop').disabled = true;
  try {
    await api('POST', 'unpair', {});
  } catch (e) {
    if (!(e instanceof Unpaired)) throw e;
  } finally {
    $('stop').disabled = false;
  }
  stopWatching();
  saved.set('token', null);
  pairMessage('Stopped. The apps can no longer send to this receiver.');
  $('watch').textContent = 'Pair an app first.';
  await startPairing();
}

// ---- packages, as Import in the device ----

let busy = false;
// Packages not to import now: package id -> until when. A package that failed stays in the inbox
// until it expires; Live tries it again only when the user clicks Import, and this page only when
// the user clicks Try again. A reload of the page counts as that too.
const later = new Map();

async function lookForPackages() {
  if (busy || !saved.get('token')) return;
  busy = true;
  try {
    const r = await api('GET', 'inbox');
    if (r.status !== 200) return;
    const list = (Array.isArray(r.json.packages) ? r.json.packages : [])
      .filter((p) => p && typeof p.package_id === 'string' && ID.test(p.package_id))
      .filter((p) => !(later.get(p.package_id) > Date.now()))
      .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    for (const entry of list) await importPackage(entry);
  } catch (e) {
    if (e instanceof Unpaired) lostPairing();
    else onError(e);
  } finally {
    busy = false;
  }
}

async function ack(id, body) {
  const r = await api('POST', `packages/${encodeURIComponent(id)}/ack`, body);
  return r.status === 200;
}

async function importPackage(entry) {
  const id = entry.package_id;
  const done = new Set(saved.list('imported'));
  if (done.has(id)) {
    // In "Live" before, but that ack got lost: confirm again, place nothing.
    await ack(id, { status: 'imported', items: [], note: 'imported before' });
    return;
  }
  // As the device: when the manifest does not come, this package is left without an ack, and
  // looked at again a little later.
  const m = await api('GET', `packages/${encodeURIComponent(id)}/manifest`);
  if (m.status !== 200) {
    later.set(id, Date.now() + LATER_MS);
    return;
  }
  const check = checkManifest(m.json, { as: 'device' });
  const report = { id, title: entry.title || 'Package', app: entry.app || '', at: new Date().toISOString(), warnings: check.warnings, sounds: [] };
  if (!check.ok) {
    report.status = 'failed';
    report.error = check.error;
    later.set(id, Infinity);
    await ack(id, { status: 'failed', error: check.error, items: [] });
    return remember(report);
  }
  const pkg = check.package;
  report.title = pkg.title;
  report.app = pkg.app;
  const results = [];
  for (const item of pkg.items) {
    const sound = { name: item.name, kind: item.kind };
    report.sounds.push(sound);
    if (item.error) {
      sound.error = item.error;
      results.push({ id: item.id, name: item.name, status: 'failed', error: item.error });
      continue;
    }
    try {
      const blob = await download(id, item);
      const info = await checkWav(blob);
      sound.plan = planSound(item, pkg, info.duration);
      sound.info = { format: info.format, bits: info.bitsPerSample, channels: info.channels, rate: info.sampleRate, duration: info.duration, bytes: info.fileBytes };
      results.push({ id: item.id, name: item.name, status: 'imported' });
    } catch (e) {
      if (e instanceof Unpaired) throw e;
      // As the device: a sound that does not download or is no usable WAV is skipped.
      sound.error = e instanceof La2lError && e.code === 'bad_wav' ? `is not a usable WAV: ${e.message}` : `did not download: ${e.message}`;
      results.push({ id: item.id, name: item.name, status: 'failed', error: sound.error });
    }
  }
  const placed = results.filter((x) => x.status === 'imported').length;
  report.status = placed === pkg.items.length ? 'imported' : placed > 0 ? 'partial' : 'failed';
  report.placed = placed;
  if (placed > 0) saved.set('imported', JSON.stringify([id, ...done].slice(0, 200)));
  if (report.status === 'failed') later.set(id, Infinity);
  await ack(id, { status: report.status, items: results });
  remember(report);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A network problem in the device's words: a time limit, or a connection that broke off.
const netError = (e) => new Error(e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'The server did not answer in time.' : 'The connection was broken off.');

// One file, with the device's checks and its 3 retries after 1, 2 and 4 seconds for a broken
// connection, a time limit, a damaged file or a 5xx.
async function download(packageId, item) {
  const url = `api/packages/${encodeURIComponent(packageId)}/files/${encodeURIComponent(item.file)}`;
  let last = null;
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    let r;
    let blob;
    try {
      r = await fetch(url, { headers: { Authorization: 'Bearer ' + saved.get('token') }, cache: 'no-store', signal: timeout(FILE_MS) });
      if (r.status === 200) blob = await r.blob(); // the body can break off too
    } catch (e) {
      last = netError(e);
      continue;
    }
    if (r.status === 401) throw new Unpaired();
    if (r.status !== 200) {
      let json = {};
      try {
        json = await r.json();
      } catch (e) {
        // not JSON
      }
      last = new Error(statusText(r.status, serverText(json)));
      if (r.status >= 500) continue;
      throw last;
    }
    const max = item.bytes || LIMITS.maxPackageBytes;
    if (blob.size > max) throw new Error('The file is larger than the package said.');
    if (item.bytes !== null && blob.size !== item.bytes) {
      last = new Error(`The file arrived damaged (${blob.size} instead of ${item.bytes} bytes).`);
      continue;
    }
    if (item.sha256 && (await sha256(blob)) !== item.sha256) {
      last = new Error('The file arrived damaged (checksum does not match).');
      continue;
    }
    return blob;
  }
  throw last;
}

// ---- the reports ----

function remember(report) {
  const list = saved.list('reports').filter((r) => r && r.id !== report.id);
  list.unshift(report);
  saved.set('reports', JSON.stringify(list.slice(0, KEEP_REPORTS)));
  showReports();
}

const fixed = (n, digits) => String(Math.round(n * 10 ** digits) / 10 ** digits);

function planText(sound) {
  const p = sound.plan;
  if (!p.warp) return 'One-shot: plays as it is, without warp.';
  const tempo = p.bpm ? ` at ${fixed(p.bpm, 2)} BPM` : '';
  const length = p.lengthBeats ? `, ${fixed(p.lengthBeats, 3)} ${p.lengthBeats === 1 ? 'beat' : 'beats'}` : '';
  const guess = p.bpm ? '' : '. Live guesses the tempo';
  return `Loop, warped in ${p.warpModeName} mode${tempo}${length}${guess}.`;
}

function infoText(i) {
  const kind = i.format === 'float' ? `${i.bits}-bit float` : `${i.bits}-bit`;
  return `${fixed(i.rate / 1000, 1)} kHz, ${kind}, ${i.channels === 1 ? 'mono' : 'stereo'}, ${fixed(i.duration, 2)} s`;
}

function statusLine(r) {
  const n = r.sounds.length;
  if (r.status === 'imported') return [`Imported: ${n} of ${n} ${n === 1 ? 'sound' : 'sounds'}.`, 'ok'];
  if (r.status === 'partial') return [`Imported: ${r.placed} of ${n} sounds. Live would skip the rest.`, ''];
  return [`Not imported.${r.error ? ' ' + r.error : ''}`, 'bad'];
}

function showReports() {
  const list = saved.list('reports');
  $('clear').hidden = list.length === 0;
  $('reports').replaceChildren(
    ...list.map((r) => {
      const el = $('report-template').content.firstElementChild.cloneNode(true);
      el.querySelector('.report-title').textContent = r.app ? `${r.title} (${r.app})` : r.title;
      el.querySelector('.report-when').textContent = new Date(r.at).toLocaleString();
      const [text, cls] = statusLine(r);
      const status = el.querySelector('.report-status');
      status.textContent = text;
      if (cls) status.classList.add(cls);
      if (r.status === 'failed') {
        const again = Object.assign(document.createElement('button'), { type: 'button', className: 'secondary small', textContent: 'Try again' });
        again.addEventListener('click', () => {
          later.delete(r.id);
          again.disabled = true;
          lookForPackages();
        });
        status.after(again);
      }
      el.querySelector('.report-warnings').replaceChildren(...(r.warnings || []).map((w) => Object.assign(document.createElement('li'), { textContent: `Warning: ${w}` })));
      el.querySelector('.report-sounds').replaceChildren(
        ...(r.sounds || []).map((s) => {
          const li = document.createElement('li');
          const name = Object.assign(document.createElement('p'), { className: 'track', textContent: s.plan ? s.plan.trackName : s.name });
          li.append(name);
          if (s.error) li.append(Object.assign(document.createElement('p'), { className: 'bad', textContent: `${s.name} ${s.error}` }));
          else {
            li.append(Object.assign(document.createElement('p'), { textContent: planText(s) }));
            li.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: infoText(s.info) }));
          }
          return li;
        })
      );
      return el;
    })
  );
}

// ---- start ----

function onError(e) {
  pairMessage(`Something went wrong in this browser: ${e && e.message ? e.message : e}`, true);
}

async function showServer() {
  const out = $('server');
  let r;
  try {
    r = await api('GET', 'health', undefined, false);
  } catch (e) {
    r = { status: 0, json: {} };
  }
  if (r.status === 200 && r.json.ok === true) {
    out.textContent = `Server: ${r.json.name} ${r.json.version}`;
    out.className = 'ok';
  } else {
    out.textContent = r.status === 0 ? 'The server does not answer.' : `The server has a problem: ${r.json.error || r.status}`;
    out.className = 'bad';
  }
}

async function begin() {
  showReports();
  showServer();
  if (!saved.get('token')) return startPairing();
  try {
    await showPaired();
  } catch (e) {
    if (e instanceof Unpaired) return lostPairing();
    throw e;
  }
}

$('new-code').addEventListener('click', () => startPairing().catch(onError));
$('add-app').addEventListener('click', () => startPairing().catch(onError));
$('stop').addEventListener('click', () => stop().catch(onError));
$('clear').addEventListener('click', () => {
  saved.set('reports', null);
  showReports();
});
begin().catch(onError);
