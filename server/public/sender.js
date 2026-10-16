'use strict';
// LA2L Sender: the test page, and the reference client of the app API (docs/server-api.md).
// Every address is relative ("api/pair/claim"), so the page works under any prefix, such as
// https://lloydstellar.nl/la2l/. The app token lives in localStorage of this browser.

const APP_NAME = 'LA2L Sender';
const CODE_LETTERS = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

const $ = (id) => document.getElementById(id);

// localStorage can be missing or full (private windows); the page then works until it closes.
const saved = {
  get(key) {
    try {
      return localStorage.getItem('la2l.' + key);
    } catch (e) {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value === null) localStorage.removeItem('la2l.' + key);
      else localStorage.setItem('la2l.' + key, value);
    } catch (e) {
      // keep it in memory only
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
async function api(method, path, body) {
  const headers = {};
  const token = saved.get('token');
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    const r = await fetch('api/' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    let json = {};
    try {
      json = await r.json();
    } catch (e) {
      // not JSON: keep {}
    }
    return { status: r.status, json };
  } catch (e) {
    return { status: 0, json: {} };
  }
}

function message(text, bad) {
  const m = $('pair-message');
  m.textContent = text || '';
  m.className = bad ? 'message bad' : 'message';
}

function showUnpaired() {
  $('pair-checking').hidden = true;
  $('paired').hidden = true;
  $('pair-form').hidden = false;
}

function showPaired(deviceName) {
  $('pair-checking').hidden = true;
  $('pair-form').hidden = true;
  $('device-name').textContent = deviceName;
  $('paired').hidden = false;
}

// At load: is the saved token still good? A 401 means this browser was unpaired (in Live, or by
// pairing it again elsewhere): forget the token.
async function checkPairing() {
  if (!saved.get('token')) return showUnpaired();
  const r = await api('GET', 'app/me');
  if (r.status === 200) return showPaired(r.json.device_name);
  if (r.status === 401) {
    saved.set('token', null);
    showUnpaired();
    message('This browser is no longer paired. Pair it again.');
    return;
  }
  showPaired(saved.get('deviceName') || 'your computer');
  message(r.status === 0 ? 'The server does not answer. Try again later.' : r.json.error || `The server answered ${r.status}.`, true);
}

async function pair(event) {
  event.preventDefault();
  const typed = $('code').value;
  const code = typed.toUpperCase().replace(/[\s-]/g, '');
  if (!CODE_LETTERS.test(code)) {
    message('A code has 6 letters and digits, like K7P 42Q.', true);
    return;
  }
  $('pair-button').disabled = true;
  message('Pairing...');
  const r = await api('POST', 'pair/claim', { code, app_name: APP_NAME, app_id: appId() });
  $('pair-button').disabled = false;
  if (r.status === 200 && r.json.app_token) {
    saved.set('token', r.json.app_token);
    saved.set('deviceName', r.json.device_name);
    $('code').value = '';
    showPaired(r.json.device_name);
    message('Done. In a moment Live says: Paired with LA2L Sender.');
    return;
  }
  message(r.status === 0 ? 'The server does not answer. Try again later.' : r.json.error || `The server answered ${r.status}.`, true);
}

async function unpair() {
  $('unpair-button').disabled = true;
  const r = await api('POST', 'app/unpair', {});
  $('unpair-button').disabled = false;
  if (r.status === 200 || r.status === 401) {
    saved.set('token', null);
    saved.set('deviceName', null);
    showUnpaired();
    message('This browser is unpaired.');
    return;
  }
  message(r.status === 0 ? 'The server does not answer. Try again later.' : r.json.error || `The server answered ${r.status}.`, true);
}

async function showServer() {
  const out = $('server');
  const r = await api('GET', 'health');
  if (r.status === 200 && r.json.ok === true) {
    out.textContent = `Server: ${r.json.name} ${r.json.version}`;
    out.className = 'ok';
  } else {
    out.textContent = r.status === 0 ? 'The server does not answer.' : `The server has a problem: ${r.json.error || r.status}`;
    out.className = 'bad';
  }
}

$('pair-form').addEventListener('submit', pair);
$('unpair-button').addEventListener('click', unpair);
checkPairing();
showServer();
