// LA2L Test receiver: the page around the test receiver of the SDK (sdk/js/src/receiver.ts, served
// as vendor/la2l-receiver.js), a stand-in for LA2L in Ableton Live. It shows the code, the apps
// that are paired, and what Live would do with every package. Its keys in localStorage start
// with "la2l-receiver.", so LA2L Sender on this same site keeps its own pairing.

import { TestReceiver } from './vendor/la2l-receiver.js';

const KEEP_REPORTS = 20;
const $ = (id) => document.getElementById(id);

// ---- what this browser keeps ----

const memory = new Map();
const saved = {
  // What could not be written (blocked or full) is kept in memory, and read from there first.
  get(key) {
    if (memory.has(key)) return memory.get(key);
    try {
      return localStorage.getItem('la2l-receiver.' + key);
    } catch (e) {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('la2l-receiver.' + key, value);
      memory.delete(key);
    } catch (e) {
      memory.set(key, value);
    }
  },
  remove(key) {
    memory.delete(key);
    try {
      localStorage.removeItem('la2l-receiver.' + key);
    } catch (e) {
      // only in memory, and gone there
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

function say(el, text, bad) {
  el.textContent = text || '';
  el.classList.toggle('bad', !!bad);
}

const pairMessage = (text, bad) => say($('pair-message'), text, bad);

function showView(view) {
  $('pair-wait').hidden = view !== 'asking';
  $('code-box').hidden = view !== 'code';
  $('paired-box').hidden = view !== 'paired';
  $('new-code').hidden = view !== 'ended';
}

function onError(e) {
  pairMessage(`Something went wrong in this browser: ${e && e.message ? e.message : e}`, true);
}

// ---- the code ----

let countdown = null;

function showCode(code, expiresAt) {
  clearInterval(countdown);
  $('code').textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
  showView('code');
  const tick = () => {
    const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    $('countdown').textContent = `This code works for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.`;
  };
  tick();
  countdown = setInterval(tick, 1000);
}

function showPaired() {
  clearInterval(countdown);
  showView('paired');
  $('watch').textContent = 'Looking for new sounds every 3 seconds, as Import in Live would.';
}

const receiver = new TestReceiver({
  server: 'api',
  storage: saved,
  onCode: showCode,
  onPaired: () => {
    showPaired();
    pairMessage('Now send sounds from your app. They show up below.');
  },
  onApps: (names) => {
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
    $('paired-with').textContent = names.length ? `Paired with ${list}.` : 'No app paired. Click Pair another app.';
    if (receiver.paired && $('code-box').hidden) showPaired();
  },
  onCodeEnded: (why) => {
    clearInterval(countdown);
    showView(receiver.paired ? 'paired' : 'ended');
    pairMessage(why === 'cancelled' ? 'The code was cancelled.' : 'The code expired.');
  },
  onLost: () => {
    clearInterval(countdown);
    showView('asking');
    $('watch').textContent = 'Pair an app first.';
    pairMessage('This receiver is no longer paired. Here is a new code.');
  },
  onReport: remember,
  onError,
});

// A new code: the first one, one for another app, or one after Stop.
async function newCode(message = '') {
  showView('asking');
  pairMessage('');
  try {
    const code = await receiver.pair();
    if (code && message) pairMessage(message);
  } catch (e) {
    showView('ended');
    pairMessage(e.message, true);
  }
}

async function stop() {
  $('stop').disabled = true;
  try {
    await receiver.stop();
  } finally {
    $('stop').disabled = false;
  }
  $('watch').textContent = 'Pair an app first.';
  await newCode('Stopped. The apps can no longer send to this receiver. Here is a new code.');
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
        // As clicking Import again in Live.
        const again = Object.assign(document.createElement('button'), { type: 'button', className: 'secondary small', textContent: 'Try again' });
        again.addEventListener('click', () => {
          again.disabled = true;
          receiver.retry(r.id);
        });
        status.after(again);
      }
      el.querySelector('.report-warnings').replaceChildren(...(r.warnings || []).map((w) => Object.assign(document.createElement('li'), { textContent: `Warning: ${w}` })));
      el.querySelector('.report-sounds').replaceChildren(
        ...(r.sounds || []).map((s) => {
          const li = document.createElement('li');
          li.append(Object.assign(document.createElement('p'), { className: 'track', textContent: s.plan ? s.plan.trackName : s.name }));
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

async function showServer() {
  const out = $('server');
  let r;
  try {
    r = await fetch('api/health', { cache: 'no-store' });
    const json = await r.json();
    if (r.status === 200 && json.ok === true) {
      out.textContent = `Server: ${json.name} ${json.version}`;
      out.className = 'ok';
      return;
    }
    out.textContent = `The server has a problem: ${json.error || r.status}`;
  } catch (e) {
    out.textContent = 'The server does not answer.';
  }
  out.className = 'bad';
}

$('new-code').addEventListener('click', () => newCode().catch(onError));
$('add-app').addEventListener('click', () => newCode().catch(onError));
$('stop').addEventListener('click', () => stop().catch(onError));
$('clear').addEventListener('click', () => {
  saved.remove('reports');
  showReports();
});
showReports();
showServer();
if (receiver.paired) {
  showPaired();
  receiver.start().catch(onError);
} else newCode().catch(onError);
