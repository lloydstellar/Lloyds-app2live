'use strict';
// BUNDLED by tools/bundle-node.js. Do not edit: change src/node and build again.
const __la2l = { defs: {}, cache: {} };
function __la2lRequire(name) {
  if (!name.startsWith('./')) return require(name);
  const key = name.slice(2);
  if (__la2l.cache[key]) return __la2l.cache[key].exports;
  const module = { exports: {} };
  __la2l.cache[key] = module;
  __la2l.defs[key](module, module.exports, __la2lRequire);
  return module.exports;
}

__la2l.defs["la2l-node"] = function (module, exports, require) {
'use strict';
// Entry point of the Node part: the link between Max (max-api) and the controller in app.js.
// All logic lives in the other modules. tools/bundle-node.js merges them into one file,
// because Freeze only packs the script that [node.script] names, not the modules it loads.

const maxApi = require('max-api');
const { App } = require('./app');

const app = new App({
  out: (name, ...args) => {
    maxApi.outlet(name, ...args).catch((e) => maxApi.post('LA2L outlet failed: ' + e));
  },
  post: (line) => maxApi.post(line),
  deviceDir: __dirname,
});

// An error anywhere must not stop Node: it would leave the device without its network part.
process.on('unhandledRejection', (e) => app.fail(e));
process.on('uncaughtException', (e) => app.fail(e));

// The ALL handler gets a flag (whether a specific handler took the message), the name, then the values.
maxApi.addHandler(maxApi.MESSAGE_TYPES.ALL, (handled, name, ...args) => {
  Promise.resolve()
    .then(() => app.handle(name, ...args))
    .catch((e) => app.fail(e));
});

app.start();

};

__la2l.defs["app"] = function (module, exports, require) {
'use strict';
// The device controller. Everything the device does starts here: pairing, importing, the test
// import, the self test and the settings. It talks to Max through out(name, ...values) and to the
// Live part through the LiveBridge. It also runs without Max, which is how tests/app.test.js tests it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const { spawn } = require('child_process');
const { VERSION } = require('./version');
const { Store, Log } = require('./settings');
const { Server, readInbox } = require('./server');
const { download, anyWebAddress, NetError } = require('./http');
const { LiveBridge } = require('./live-bridge');
const wav = require('./wav');
const manifest = require('./manifest');
const { writeTestLoop } = require('./testsound');
const t = require('./text');

// Messages Max sends to Node. tests/patch.test.js checks that the patch sends only these.
const HANDLED = ['init', 'live', 'pair', 'addapp', 'cancelpair', 'import', 'testimport', 'usetempo', 'selftest', 'openfolder', 'unpair', 'settings', 'placement', 'newtracks'];
// Messages Node sends to Max. tests/patch.test.js checks that the patch routes all of them.
const OUT_KEYS = ['view', 'status', 'code', 'countdown', 'pairedwith', 'tempotext', 'tempolabel', 'tempo', 'placement', 'newtracks', 'settingsbutton', 'tolive'];

const BUSY_TEXT = {
  import: 'Still importing. Wait a moment.',
  test: 'Still busy with the test import.',
  pair: 'Still asking the server for a code.',
  selftest: 'Still running the self test.',
  unpair: 'Still unpairing.',
  tempo: 'Still changing the tempo.',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function versionText(info) {
  const l = (info && info.live) || {};
  return `${l.major}.${l.minor}.${l.bugfix}`;
}

// LA2L is made for Live 12.4 or newer (MIDI import in a later version needs it).
function liveOk(info) {
  const l = (info && info.live) || {};
  return l.major > 12 || (l.major === 12 && l.minor >= 4);
}

// "K7P42Q" -> ["K7P", "42Q"], easier to read and type.
function formatCode(code) {
  const parts = [];
  for (let i = 0; i < code.length; i += 3) parts.push(code.slice(i, i + 3));
  return parts;
}

function appList(apps) {
  if (!apps.length) return '';
  if (apps.length === 1) return apps[0];
  if (apps.length === 2) return `${apps[0]} and ${apps[1]}`;
  return `${apps[0]} and ${apps.length - 1} other apps`;
}

// A network error in two or three words, for the self test.
function shortNet(e) {
  if (!(e instanceof NetError)) return 'error';
  if (e.kind === 'offline') return 'offline';
  if (e.kind === 'timeout') return 'no answer';
  if (e.kind === 'tls') return 'certificate problem';
  if (e.kind === 'address') return 'address not valid';
  if (e.status) return `answered ${e.status}`;
  return 'error';
}

// What Self test says about the server. A web site without the App2Live server answers /health
// with a web page or a 404; "answered 200" would wrongly sound as if all is well.
function serverState(e, serverUrl) {
  if (e instanceof NetError && (e.kind === 'badjson' || e.status === 404)) {
    let host = 'that address';
    try {
      host = new URL(serverUrl).host;
    } catch (err) {
      // keep the general wording
    }
    return `no App2Live server at ${host}`;
  }
  return `server ${shortNet(e)}`;
}

// Opens a folder in Explorer or Finder.
function openFolder(dir) {
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

class App {
  // opts: out(name, ...values) to Max, post(line) to the Max window, home (settings folder),
  // timing (shorter waits for tests), openFolder (replaced in tests).
  constructor(opts = {}) {
    this.out = opts.out || (() => {});
    this.post = opts.post || (() => {});
    this.store = new Store(opts.home);
    this.home = this.store.home;
    this.logger = new Log(this.home);
    this.bridge = new LiveBridge((...v) => this.out(...v), (line) => this.log(line));
    this.timing = Object.assign(
      { pairPollMs: 2000, unpairConfirmMs: 5000, liveTimeoutMs: 5000, importTimeoutMs: 30000, retryDelayMs: 1000, liveRetryMs: 1000 },
      opts.timing
    );
    this.openFolderFn = opts.openFolder || openFolder;
    this.deviceDir = opts.deviceDir || __dirname;
    this.view = this.store.pairing ? 'paired' : 'unpaired';
    this.settingsOpen = false;
    this.busy = null;
    this.pairing = null; // { id, code, expiresAt, prevView, pollMs, pollTimer, clockTimer }
    this.live = null; // the last information from the Live part
    this.tempoHint = null; // { bpm } offered with the "Use N BPM" button
    this.unpairArmedAt = 0;
    this.refreshing = false;
  }

  // ---- log, status and errors ----

  log(line) {
    this.logger.write(line);
  }

  status(text) {
    this.out('status', ...t.words(text));
    this.log('status: ' + text);
  }

  fail(e) {
    this.status('Something went wrong. ' + ((e && e.message) || e));
    this.log('ERROR ' + ((e && e.stack) || e));
  }

  // A long-running action is going on: say so instead of starting a second one.
  isBusy() {
    if (!this.busy) return false;
    this.status(BUSY_TEXT[this.busy] || 'Busy. Wait a moment.');
    return true;
  }

  server() {
    return new Server(this.store.settings.serverUrl, () => (this.store.pairing ? this.store.pairing.token : null));
  }

  // ---- start and views ----

  start() {
    this.log(`LA2L ${VERSION} started. Node ${process.version} ${process.platform}. Device files: ${this.deviceDir}. Settings: ${this.home}`);
    this.post(`LA2L ${VERSION} started (Node ${process.version}). Settings and log: ${t.fwd(this.home)}`);
    this.sendSettings();
    this.showPairedWith();
    this.showView();
    this.status(this.store.pairing ? 'Ready. Click Import to get new sounds.' : 'Ready.');
    this.refreshLive();
  }

  sendSettings() {
    const s = this.store.settings;
    this.out('placement', s.placement === 'session' ? 1 : 0);
    this.out('newtracks', s.newTracks === 'end' ? 1 : 0);
  }

  showPairedWith() {
    const apps = this.store.pairing ? this.store.pairing.apps : [];
    this.out('pairedwith', ...t.words(apps.length ? `Paired with ${appList(apps)}.` : 'Paired.'));
  }

  // The patch shows one view at a time: unpaired, pairing, paired, or the settings on top.
  // The "view" message also hides the tempo row; it comes back here when it applies.
  showView() {
    this.out('view', this.settingsOpen ? 'settings' : this.view);
    if (this.tempoHint && this.tempoRowFits()) this.out('tempo', 1);
  }

  tempoRowFits() {
    return !this.settingsOpen && this.view === 'paired';
  }

  setView(view) {
    this.view = view;
    this.showView();
  }

  setSettingsOpen(on) {
    this.settingsOpen = Number(on) === 1;
    this.showView();
  }

  closeSettings() {
    if (!this.settingsOpen) return;
    this.settingsOpen = false;
    this.out('settingsbutton', 0);
    this.showView();
  }

  // ---- the Live part ----

  async liveInfo() {
    const r = await this.bridge.request('getinfo', {}, { timeoutMs: this.timing.liveTimeoutMs });
    if (!r.info || !r.info.live || !r.info.set) throw new Error('The Live part sent no information.');
    this.live = r.info;
    return r.info;
  }

  // At start the Live part may not be ready yet. Ask a few times, quietly, and log what Live says.
  async refreshLive() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      for (let i = 0; i < 5; i++) {
        try {
          const info = await this.liveInfo();
          this.log(
            `Live ${versionText(info)}${liveOk(info) ? '' : ' (older than 12.4)'}. Set: ${info.set.path || 'not saved'}. ` +
              `Tempo ${info.set.tempo}. Device on track ${info.device ? info.device.trackIndex : '?'}.`
          );
          return info;
        } catch (e) {
          await sleep(this.timing.liveRetryMs);
        }
      }
      this.log('The Live part did not answer at start.');
      return null;
    } finally {
      this.refreshing = false;
    }
  }

  // ---- messages from Max ----

  handle(name, ...args) {
    switch (name) {
      case 'init': return this.refreshLive();
      case 'live': return this.bridge.receive(args[0]);
      case 'pair':
      case 'addapp': return this.pair();
      case 'cancelpair': return this.cancelPair();
      case 'import': return this.importAll();
      case 'testimport': return this.testImport();
      case 'usetempo': return this.useTempo();
      case 'selftest': return this.selfTest();
      case 'openfolder': return this.openFolder();
      case 'unpair': return this.unpair();
      case 'settings': return this.setSettingsOpen(args[0]);
      case 'placement': return this.setPlacement(args[0]);
      case 'newtracks': return this.setNewTracks(args[0]);
      default:
        this.log('Unknown message from Max: ' + [name, ...args].join(' '));
        return undefined;
    }
  }

  // ---- pairing ----

  async pair() {
    if (this.isBusy()) return;
    if (this.pairing) {
      this.status('A code is already showing. Type it in your app.');
      return;
    }
    this.store.load();
    let server;
    try {
      server = this.server();
    } catch (e) {
      this.status(e.message);
      return;
    }
    this.busy = 'pair';
    this.closeSettings();
    this.status('Asking the server for a code...');
    try {
      const r = await server.pairStart({
        device_id: this.store.data.deviceId,
        device_name: os.hostname(),
        client: `LA2L ${VERSION}`,
        platform: process.platform,
      });
      const code = typeof r.code === 'string' ? r.code.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
      if (!code || typeof r.pair_id !== 'string' || !r.pair_id) throw new NetError('The server sent no code.', { kind: 'badjson' });
      // Count down from a duration: the clock of this computer may differ from the server's.
      let seconds = Number(r.expires_in);
      if (!(seconds > 0)) seconds = (Date.parse(r.expires_at) - Date.now()) / 1000;
      if (!(seconds > 0)) seconds = 600;
      seconds = Math.min(Math.max(seconds, 30), 1800);
      const pollMs = Number(r.poll_ms) >= 500 && Number(r.poll_ms) <= 10000 ? Number(r.poll_ms) : this.timing.pairPollMs;
      this.pairing = { id: r.pair_id, code, expiresAt: Date.now() + seconds * 1000, prevView: this.view, pollMs, pollTimer: null, clockTimer: null };
      this.log(`Pairing started: code ${code}, pair id ${r.pair_id}, ${Math.round(seconds)} s`);
      this.out('code', ...formatCode(code));
      this.setView('pairing');
      this.tick();
      this.pairing.clockTimer = setInterval(() => this.tick(), 1000);
      this.schedulePoll();
      this.status('Waiting for your app...');
    } catch (e) {
      this.status('Could not start pairing. ' + e.message);
      this.log('Pairing start failed: ' + (e.stack || e));
    } finally {
      this.busy = null;
    }
  }

  tick() {
    const p = this.pairing;
    if (!p) return;
    const left = (p.expiresAt - Date.now()) / 1000;
    if (left <= 0) {
      this.endPairing('expired');
      return;
    }
    this.out('countdown', ...t.words(`This code works for ${t.clock(left)}`));
  }

  schedulePoll() {
    const p = this.pairing;
    if (!p) return;
    clearTimeout(p.pollTimer);
    p.pollTimer = setTimeout(() => {
      this.pollPairing().catch((e) => this.log('Pairing poll failed: ' + (e.stack || e)));
    }, p.pollMs);
  }

  async pollPairing() {
    const p = this.pairing;
    if (!p) return;
    try {
      const r = await this.server().pairStatus(p.id);
      if (this.pairing !== p) return; // cancelled while we waited
      if (r.status === 'paired' && typeof r.device_token === 'string' && r.device_token) {
        const appName = t.cleanName(r.app_name, 'your app', 40);
        this.store.update((d) => {
          const same = d.pairing && d.pairing.token === r.device_token;
          const apps = same ? d.pairing.apps.filter((a) => a !== appName) : [];
          d.pairing = { token: r.device_token, apps: apps.concat(appName), pairedAt: new Date().toISOString() };
        });
        this.stopPairing();
        this.log(`Paired with ${appName}`);
        this.showPairedWith();
        this.setView('paired');
        this.status(`Paired with ${appName}. Send a sound from it and click Import.`);
        return;
      }
      if (r.status === 'expired' || r.status === 'cancelled') {
        this.endPairing('expired');
        return;
      }
    } catch (e) {
      if (this.pairing !== p) return;
      if (e instanceof NetError && e.status === 404) {
        this.endPairing('expired');
        return;
      }
      this.status('Waiting for your app. The server did not answer, trying again.');
      this.log('Pairing poll: ' + e.message);
    }
    if (this.pairing === p) this.schedulePoll();
  }

  stopPairing() {
    const p = this.pairing;
    if (!p) return;
    clearTimeout(p.pollTimer);
    clearInterval(p.clockTimer);
    this.pairing = null;
  }

  endPairing(reason) {
    const p = this.pairing;
    if (!p) return;
    this.stopPairing();
    this.store.load();
    this.setView(this.store.pairing ? 'paired' : 'unpaired');
    this.status(reason === 'expired' ? 'The code expired. Click Pair app for a new code.' : 'Pairing cancelled.');
  }

  cancelPair() {
    const p = this.pairing;
    if (!p) return;
    this.endPairing('cancelled');
    this.server()
      .pairCancel(p.id)
      .catch((e) => this.log('Pairing cancel at the server failed: ' + e.message));
  }

  forgetPairing() {
    this.store.update((d) => {
      d.pairing = null;
    });
    this.setTempoHint(null);
  }

  // A 401 from the server means the token is gone (unpaired in the app, or revoked).
  handleError(prefix, e) {
    if (e instanceof NetError && e.kind === 'unauthorized') {
      this.forgetPairing();
      this.setView('unpaired');
      this.status('This computer is no longer paired. Click Pair app to pair again.');
      this.log(`${prefix} ${e.message}`);
      return;
    }
    this.status(`${prefix} ${e.message || e}`);
    this.log(`${prefix} ${(e && e.stack) || e}`);
  }

  // ---- import ----

  async importAll() {
    if (this.isBusy()) return;
    this.store.load();
    if (!this.store.pairing) {
      this.setView('unpaired');
      this.status('Pair an app first. Then send a sound from it.');
      return;
    }
    let server;
    try {
      server = this.server();
    } catch (e) {
      this.status(e.message);
      return;
    }
    this.busy = 'import';
    this.setTempoHint(null);
    try {
      const live = await this.liveInfo();
      this.status('Looking for new sounds...');
      const packages = readInbox(await server.inbox());
      this.log(`Inbox: ${packages.length} package(s): ${packages.map((p) => p.id).join(' ')}`);
      if (!packages.length) {
        this.status('Nothing new yet. Send a sound from your app first.');
        return;
      }
      const done = [];
      let offset = 0;
      for (let i = 0; i < packages.length; i++) {
        const label = packages.length > 1 ? `Package ${i + 1} of ${packages.length}` : 'Package';
        const r = await this.importPackage(server, packages[i], live, offset, label);
        offset += r.placed;
        done.push(r);
      }
      this.status(this.summary(done, live));
    } catch (e) {
      this.handleError('Import stopped.', e);
    } finally {
      this.busy = null;
    }
  }

  async importPackage(server, entry, live, offset, label) {
    if (this.store.wasImported(entry.id)) {
      // Placed before, but the server did not get our confirmation. Confirm again, place nothing.
      this.log(`Package ${entry.id} was imported before. Confirming it again.`);
      await this.ack(server, entry.id, { status: 'imported', items: [], note: 'imported before' });
      return { title: entry.title || label, placed: 0, total: 0, skipped: true };
    }
    let pkg;
    try {
      const v = manifest.validate(await server.manifest(entry.id));
      pkg = v.pkg;
      for (const w of v.warnings) this.log(`${entry.id}: ${w}`);
    } catch (e) {
      if (e instanceof NetError) throw e; // network trouble stops the import, try again later
      this.log(`Package ${entry.id} refused: ${e.message}`);
      await this.ack(server, entry.id, { status: 'failed', error: e.message, items: [] });
      return { title: entry.title || label, placed: 0, total: 0, problem: e.message };
    }
    if (pkg.packageId !== entry.id) this.log(`Package id in manifest (${pkg.packageId}) differs from inbox (${entry.id})`);
    const name = pkg.title;
    const folder = this.packageFolder(live, pkg.title);
    this.log(`Importing "${pkg.title}" from ${pkg.app}: ${pkg.items.length} sound(s), bpm ${pkg.bpm}, folder ${folder}`);
    const { ready, results } = await this.prepareItems(pkg, folder, name, (item, file) =>
      server.downloadFile(entry.id, item.file, file, {
        expectBytes: item.bytes,
        expectSha256: item.sha256,
        maxBytes: item.bytes || manifest.LIMITS.maxPackageBytes,
        retryDelayMs: this.timing.retryDelayMs,
        onRetry: (n, e) => this.log(`${item.name}: download attempt ${n + 1} after: ${e.message}`),
      })
    );
    let placed = 0;
    let inexact = [];
    if (ready.length) {
      // If Live stops answering here, some tracks may be in the Set already. Leave the package on
      // the server (no confirmation) and stop, so nothing is placed twice by accident.
      ({ placed, inexact } = await this.placeReady(pkg, ready, results, offset, name));
    }
    const total = pkg.items.length;
    const status = placed === total ? 'imported' : placed > 0 ? 'partial' : 'failed';
    const items = pkg.items.map((it) => Object.assign({ id: it.id }, results.get(it.index) || { status: 'failed', error: 'not placed' }));
    if (placed > 0) this.store.markImported(entry.id);
    await this.ack(server, entry.id, { status, items });
    if (placed > 0 && pkg.bpm && live.set.tempo && Math.abs(pkg.bpm - live.set.tempo) >= 0.01) {
      this.setTempoHint({ bpm: pkg.bpm, setBpm: live.set.tempo });
    }
    const firstError = items.find((it) => it.status === 'failed');
    return {
      title: name,
      placed,
      total,
      problem: firstError ? `${firstError.name || 'A sound'} ${firstError.error}` : '',
      inexact: inexact.map((x) => x.name),
    };
  }

  // Confirms a package to the server. A failed confirmation is only logged: the package stays on
  // the server, and because it is in the imported list it is confirmed (not placed) next time.
  async ack(server, packageId, body) {
    try {
      await server.ack(packageId, body);
    } catch (e) {
      if (e instanceof NetError && e.kind === 'unauthorized') throw e;
      this.log(`Confirming ${packageId} failed: ${e.message}`);
    }
  }

  // Where the WAV files of a package go. With a saved Set: in its project folder, so Collect All
  // and Save keeps working. Otherwise in Documents/Lloyds App2Live/Inbox.
  packageFolder(live, title) {
    const name = `${t.stamp()} ${t.cleanFileName(title, 'Package', 40)}`;
    const setPath = live && live.set && live.set.path ? t.nativePath(live.set.path) : '';
    const candidates = [];
    if (setPath) candidates.push(path.join(path.dirname(setPath), 'Samples', 'LA2L', name));
    candidates.push(path.join(this.home, 'Inbox', name));
    for (const dir of candidates) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
        return dir;
      } catch (e) {
        this.log(`Cannot use folder ${dir}: ${e.message}`);
      }
    }
    throw new Error('Cannot make a folder for the sounds. Run the Self test.');
  }

  // Gets every sound of a package onto the disk and reads its WAV header.
  // fetch(item, file) puts the file there. A sound that fails is noted and skipped.
  async prepareItems(pkg, folder, label, fetch) {
    const ready = [];
    const results = new Map();
    for (const item of pkg.items) {
      if (item.error) {
        results.set(item.index, { name: item.name, status: 'failed', error: item.error });
        this.log(`${item.name}: ${item.error}`);
        continue;
      }
      const file = t.uniquePath(folder, t.cleanFileName(item.name, `Sound ${item.index + 1}`), '.wav');
      try {
        this.status(`${label}: downloading ${item.index + 1} of ${pkg.items.length}...`);
        await fetch(item, file);
        const info = wav.readInfo(file);
        const plan = manifest.planItem(item, pkg, info.duration);
        this.log(
          `${item.name}: ${t.megabytes(info.fileBytes)}, ${info.channels} ch, ${info.sampleRate} Hz, ${info.bitsPerSample} bit ${info.format}, ` +
            `${info.duration.toFixed(4)} s. Plan: ${JSON.stringify(plan)}`
        );
        ready.push({ item, file, info, plan });
      } catch (e) {
        try { fs.unlinkSync(file); } catch (e2) { /* nothing written */ }
        const error = e instanceof wav.WavError ? `is not a usable WAV: ${e.message}` : `did not download: ${e.message}`;
        results.set(item.index, { name: item.name, status: 'failed', error });
        this.log(`${item.name} ${error}`);
      }
    }
    return { ready, results };
  }

  // Sends the prepared sounds to the Live part and notes per sound whether it was placed.
  // Returns the number of placed sounds.
  // Resolves to { placed, inexact }: the number of sounds placed, and the loops whose tempo Live
  // did not take exactly (name, and the tempo Live plays them at, 0 when unknown).
  async placeReady(pkg, ready, results, offset, label) {
    const s = this.store.settings;
    const color = manifest.paletteColor(this.store.nextColorIndex());
    const job = {
      title: pkg.title,
      app: pkg.app,
      sceneName: manifest.sceneName(pkg),
      placement: s.placement,
      newTracks: s.newTracks,
      trackOffset: offset,
      items: ready.map((r) => ({
        index: r.item.index,
        name: r.item.name,
        trackName: manifest.trackName(r.item, pkg, s),
        clipName: r.item.name,
        path: r.file,
        altPath: t.fwd(r.file),
        folder: t.fwd(path.dirname(r.file)),
        duration: r.info.duration,
        warp: r.plan.warp,
        warpMode: r.plan.warpMode,
        looping: r.plan.looping,
        bpm: r.plan.bpm,
        lengthBeats: r.plan.lengthBeats,
        color: r.item.color !== null ? r.item.color : color,
        gainDb: r.item.gainDb,
      })),
    };
    this.status(`${label}: placing ${t.plural(ready.length, 'sound')} in Live...`);
    const res = await this.bridge.request('import', job, {
      timeoutMs: this.timing.importTimeoutMs,
      onProgress: (m) => this.status(`${label}: ${m.done} of ${m.total} placed...`),
    });
    let placed = 0;
    const inexact = []; // loops that are in Live, but not at exactly the tempo the app gave
    const byIndex = new Map((Array.isArray(res.tracks) ? res.tracks : []).map((tr) => [tr.index, tr]));
    for (const r of ready) {
      const tr = byIndex.get(r.item.index);
      if (tr && tr.ok) {
        placed++;
        results.set(r.item.index, { name: r.item.name, status: 'imported' });
        const report = tr.report || {};
        if (r.plan.warp && r.plan.bpm && !/^exact/.test(report.tempo || '')) inexact.push({ name: r.item.name, bpm: report.bpm || 0 });
      } else {
        const error = tr ? tr.error : res.error || 'was not placed';
        results.set(r.item.index, { name: r.item.name, status: 'failed', error });
      }
      this.log(`${r.item.name}: ${JSON.stringify(tr || res)}`);
    }
    if (res.error) this.log(`Live part: ${res.error}`);
    return { placed, inexact };
  }

  summary(done, live) {
    const placed = done.reduce((n, r) => n + r.placed, 0);
    const total = done.reduce((n, r) => n + r.total, 0);
    const problems = done.filter((r) => r.problem);
    let text;
    if (done.every((r) => r.skipped)) {
      text = 'These sounds were imported before. Nothing new.';
    } else if (done.length === 1) {
      const r = done[0];
      if (r.placed === r.total && r.total > 0) text = `${r.title}: ${t.plural(r.placed, 'track')} imported.`;
      else if (r.placed > 0) text = `${r.title}: ${r.placed} of ${r.total} tracks imported. ${r.problem}`;
      else text = `${r.title} was not imported. ${r.problem}`;
    } else {
      text = `${t.plural(done.length, 'package')} done. ${t.plural(placed, 'track')} imported`;
      text += placed < total || problems.length ? `. ${t.plural(problems.length, 'problem')}. See the log.` : '.';
    }
    const inexact = done.reduce((all, r) => all.concat(r.inexact || []), []);
    if (inexact.length) {
      const what = inexact.length === 1 ? `The tempo of ${inexact[0]} is` : `The tempo of ${inexact.length} sounds is`;
      text = `${text.replace(/ See the log\.$/, '')} ${what} not exact. See the log.`;
    }
    if (live && !liveOk(live)) text += ' LA2L is made for Live 12.4 or newer.';
    return text;
  }

  // ---- test import ----

  // Places the test file from the settings (or the built-in loop) without pairing or a server.
  async testImport() {
    if (this.isBusy()) return;
    this.store.load();
    const s = this.store.settings;
    this.busy = 'test';
    this.setTempoHint(null);
    try {
      const live = await this.liveInfo();
      const { pkg } = manifest.validate(manifest.testManifest(s));
      const folder = this.packageFolder(live, pkg.title);
      let builtIn = false;
      this.log(`Test import: ${s.testUrl} as "${s.testName}", ${s.testKind}, ${s.testRole}, ${s.testBpm} BPM, folder ${folder}`);
      const { ready, results } = await this.prepareItems(pkg, folder, 'Test', async (item, file) => {
        try {
          this.status('Downloading the test file...');
          await download(s.testUrl, file, {
            allowRedirect: anyWebAddress,
            retries: 1,
            retryDelayMs: this.timing.retryDelayMs,
            maxBytes: manifest.LIMITS.maxPackageBytes,
            timeoutMs: 120000,
          });
          wav.readInfo(file); // a file Live cannot use is replaced by the built-in loop too
        } catch (e) {
          this.log(`Test file not used: ${e.message}. Using the built-in test loop.`);
          try { fs.unlinkSync(file); } catch (e2) { /* nothing written */ }
          writeTestLoop(file, s.testBpm);
          builtIn = true;
        }
      });
      if (!ready.length) throw new Error(results.get(0).error);
      const { placed, inexact } = await this.placeReady(pkg, ready, results, 0, 'Test');
      const item = pkg.items[0];
      if (placed) {
        const name = manifest.trackName(item, pkg, s);
        let where = s.testKind === 'loop' ? ` at ${t.bpmText(s.testBpm)} BPM` : '';
        if (inexact.length) {
          const got = inexact[0].bpm ? ` (Live plays it at ${t.bpmText(inexact[0].bpm)})` : '';
          where = ` but not at exactly ${t.bpmText(s.testBpm)} BPM${got}. The log has the details`; // no comma: the display drops it
        }
        this.status(`Test done. ${name} is in Live${where}.${builtIn ? ' The test file did not download so the built-in loop was used.' : ''}`);
      } else {
        this.status(`Test failed. ${item.name} ${results.get(0).error}`);
      }
    } catch (e) {
      this.handleError('Test import stopped.', e);
    } finally {
      this.busy = null;
    }
  }

  // ---- tempo ----

  setTempoHint(hint) {
    this.tempoHint = hint;
    if (!hint) {
      this.out('tempo', 0);
      return;
    }
    this.out('tempotext', ...t.words(`These sounds are ${t.bpmText(hint.bpm)} BPM. Your Set is ${t.bpmText(hint.setBpm)} BPM.`));
    this.out('tempolabel', `Use ${t.bpmText(hint.bpm)} BPM`);
    this.out('tempo', this.tempoRowFits() ? 1 : 0);
  }

  // The device never changes the Set tempo by itself; this button does it when you ask.
  async useTempo() {
    if (!this.tempoHint || this.isBusy()) return;
    const bpm = this.tempoHint.bpm;
    this.busy = 'tempo';
    try {
      const r = await this.bridge.request('settempo', { bpm }, { timeoutMs: this.timing.liveTimeoutMs });
      if (!r.ok) throw new Error(r.error || 'Live did not take the tempo.');
      this.setTempoHint(null);
      this.status(`The Set tempo is now ${t.bpmText(r.tempo || bpm)} BPM.`);
    } catch (e) {
      this.status('Could not change the tempo. ' + e.message);
    } finally {
      this.busy = null;
    }
  }

  // ---- self test, folder, settings ----

  async selfTest() {
    if (this.isBusy()) return;
    this.busy = 'selftest';
    this.store.load();
    const parts = [`Node ${process.version}`];
    try {
      this.status('Self test running...');
      try {
        fs.mkdirSync(this.home, { recursive: true });
        const f = path.join(this.home, '.selftest');
        fs.writeFileSync(f, 'ok');
        fs.unlinkSync(f);
        parts.push('folder OK');
      } catch (e) {
        parts.push('folder NOT writable');
        this.log('Self test folder: ' + e.message);
      }
      try {
        const info = await this.liveInfo();
        parts.push(`Live ${versionText(info)}${liveOk(info) ? ' OK' : ' (needs 12.4)'}`);
        if (!info.set.path) parts.push('Set not saved');
      } catch (e) {
        parts.push('Live part not answering');
      }
      let server = null;
      try {
        server = this.server();
        const h = await server.health();
        if (!h || h.ok !== true) throw new NetError('The server did not answer {"ok": true} on /health.', { kind: 'badjson' });
        parts.push('server OK');
      } catch (e) {
        parts.push(serverState(e, this.store.settings.serverUrl));
        this.log('Self test server: ' + e.message);
        server = null;
      }
      if (!this.store.pairing) {
        parts.push('not paired');
      } else if (server) {
        try {
          const list = readInbox(await server.inbox());
          parts.push(`paired with ${list.length} waiting`);
        } catch (e) {
          if (e instanceof NetError && e.kind === 'unauthorized') {
            this.forgetPairing();
            this.setView('unpaired');
            parts.push('pairing no longer valid');
          } else {
            parts.push(`inbox ${shortNet(e)}`);
          }
        }
      }
      this.status('Self test: ' + parts.join(' / '));
      this.log(`Self test details: settings ${this.store.file()}, device id ${this.store.data.deviceId}, server ${this.store.settings.serverUrl}`);
    } finally {
      this.busy = null;
    }
  }

  openFolder() {
    try {
      fs.mkdirSync(this.home, { recursive: true });
      this.openFolderFn(this.home);
      this.status('Opened the LA2L folder. The log is la2l.log.');
    } catch (e) {
      this.status('Could not open the folder. ' + e.message);
    }
  }

  // Unpair needs two clicks, because every app has to pair again afterwards.
  async unpair() {
    if (this.isBusy()) return;
    this.store.load();
    if (!this.store.pairing) {
      this.setView('unpaired');
      this.status('This computer is not paired.');
      return;
    }
    const now = Date.now();
    if (now - this.unpairArmedAt > this.timing.unpairConfirmMs) {
      this.unpairArmedAt = now;
      this.status('Click Unpair again to unpair all apps from this computer.');
      return;
    }
    this.unpairArmedAt = 0;
    this.busy = 'unpair';
    try {
      try {
        await this.server().unpair();
      } catch (e) {
        this.log('Unpair at the server failed. The token is removed here anyway: ' + e.message);
      }
      this.forgetPairing();
      this.closeSettings();
      this.setView('unpaired');
      this.status('Unpaired. Apps can no longer send sounds to this computer.');
    } finally {
      this.busy = null;
    }
  }

  setPlacement(value) {
    const placement = Number(value) === 1 ? 'session' : 'arrangement';
    this.store.update((d) => {
      d.settings.placement = placement;
    });
    this.status(placement === 'session' ? 'New sounds go to a new scene in Session View.' : 'New sounds go to the Arrangement at the playhead.');
  }

  setNewTracks(value) {
    const newTracks = Number(value) === 1 ? 'end' : 'afterDevice';
    this.store.update((d) => {
      d.settings.newTracks = newTracks;
    });
    this.status(newTracks === 'end' ? 'New tracks go after all other tracks.' : 'New tracks go right after this track.');
  }
}

module.exports = { App, HANDLED, OUT_KEYS, formatCode, appList, liveOk };

};

__la2l.defs["version"] = function (module, exports, require) {
'use strict';
// One place for the version and the names. tools/gen-patch.js and the tests read this file too.

module.exports = {
  VERSION: '0.1.1',
  NAME: "Lloyd's App2Live",
  SHORT: 'LA2L',
  // The manifest format this device understands (see docs/manifest.md).
  SCHEMA: 'app2live/1',
  // File and folder names never contain an apostrophe.
  FOLDER_NAME: 'Lloyds App2Live',
};

};

__la2l.defs["settings"] = function (module, exports, require) {
'use strict';
// Settings, pairing state and the log, kept per computer in Documents/Lloyds App2Live.
// They live outside the Live Set (the token must never travel with a shared Set) and outside
// the device folder (a frozen device runs from a temporary folder that is gone after a restart).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { VERSION, FOLDER_NAME } = require('./version');

const DEFAULT_SETTINGS = {
  // The App2Live server. Only https, except localhost for testing.
  serverUrl: 'https://lloydstellar.nl/la2l/api',
  // Where new sounds go: 'arrangement' (at the playhead) or 'session' (a new scene).
  placement: 'arrangement',
  // Where new tracks go: 'afterDevice' (right after the track with this device) or 'end'.
  newTracks: 'afterDevice',
  // "Kick (Web808)" instead of "Kick".
  appNameInTrackName: true,
  // Test import: one file from a plain web address, no pairing and no server needed.
  testUrl: 'http://lloydstellar.nl/test/test-file-voor-max.wav',
  testName: 'Snare',
  testBpm: 135,
  testKind: 'loop',
  testRole: 'drums',
};

const CHOICES = {
  placement: ['arrangement', 'session'],
  newTracks: ['afterDevice', 'end'],
  testKind: ['loop', 'oneshot'],
};

const LOG_MAX_BYTES = 1e6;
const IMPORTED_KEEP = 200; // package ids remembered, so a package is never placed twice

function defaultHome() {
  if (process.env.LA2L_HOME) return process.env.LA2L_HOME;
  return path.join(os.homedir(), 'Documents', FOLDER_NAME);
}

function freshData() {
  return {
    version: VERSION,
    deviceId: '',
    settings: Object.assign({}, DEFAULT_SETTINGS),
    pairing: null, // { token, apps: ['Web808'], pairedAt }
    colorIndex: 0,
    imported: [], // [{ id, at }]
  };
}

// Keeps only known settings with valid values, so a hand-edited file cannot break the device.
function cleanSettings(raw) {
  const s = Object.assign({}, DEFAULT_SETTINGS);
  if (!raw || typeof raw !== 'object') return s;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    const def = DEFAULT_SETTINGS[key];
    if (CHOICES[key]) {
      if (CHOICES[key].includes(v)) s[key] = v;
    } else if (typeof def === 'boolean') {
      s[key] = v === true || v === 1 || v === 'true';
    } else if (typeof def === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) s[key] = n;
    } else if (typeof v === 'string' && v.trim()) {
      s[key] = v.trim();
    }
  }
  if (!(s.testBpm >= 20 && s.testBpm <= 999)) s.testBpm = DEFAULT_SETTINGS.testBpm;
  return s;
}

class Store {
  constructor(home) {
    this.home = home || defaultHome();
    this.data = freshData();
    this.load();
    if (!this.data.deviceId) {
      this.data.deviceId = crypto.randomUUID();
      this.save();
    }
  }

  file() {
    return path.join(this.home, 'settings.json');
  }

  get settings() {
    return this.data.settings;
  }

  get pairing() {
    return this.data.pairing;
  }

  // Reads the file again. Two copies of the device (or two Live Sets one after the other)
  // share this file, so every change starts from what is on disk now.
  load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
    } catch (e) {
      return false; // first start, or a broken file: keep what we have
    }
    const d = freshData();
    if (typeof raw.deviceId === 'string') d.deviceId = raw.deviceId;
    d.settings = cleanSettings(raw.settings);
    const p = raw.pairing;
    if (p && typeof p.token === 'string' && p.token) {
      d.pairing = {
        token: p.token,
        apps: Array.isArray(p.apps) ? p.apps.filter((a) => typeof a === 'string').slice(0, 50) : [],
        pairedAt: typeof p.pairedAt === 'string' ? p.pairedAt : '',
      };
    }
    if (Number.isInteger(raw.colorIndex) && raw.colorIndex >= 0) d.colorIndex = raw.colorIndex;
    if (Array.isArray(raw.imported)) {
      d.imported = raw.imported.filter((x) => x && typeof x.id === 'string').slice(-IMPORTED_KEEP);
    }
    this.data = d;
    return true;
  }

  save() {
    fs.mkdirSync(this.home, { recursive: true });
    const text = JSON.stringify(Object.assign({}, this.data, { version: VERSION }), null, 2);
    const tmp = this.file() + '.tmp';
    try {
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, this.file());
    } catch (e) {
      // A virus scanner can hold the file for a moment on Windows: write it directly then.
      fs.writeFileSync(this.file(), text);
      try { fs.unlinkSync(tmp); } catch (e2) { /* already gone */ }
    }
  }

  // Load, change, save. fn gets the data object and may change it.
  update(fn) {
    this.load();
    fn(this.data);
    this.save();
    return this.data;
  }

  wasImported(packageId) {
    return this.data.imported.some((x) => x.id === packageId);
  }

  markImported(packageId) {
    this.update((d) => {
      if (!d.imported.some((x) => x.id === packageId)) d.imported.push({ id: packageId, at: new Date().toISOString() });
      d.imported = d.imported.slice(-IMPORTED_KEEP);
    });
  }

  // A colour for the next package, so the tracks of one package share a colour.
  nextColorIndex() {
    let index = 0;
    this.update((d) => {
      index = d.colorIndex;
      d.colorIndex = d.colorIndex + 1;
    });
    return index;
  }
}

// The log: Documents/Lloyds App2Live/la2l.log, renamed to la2l.log.old at 1 MB.
class Log {
  constructor(home, echo) {
    this.home = home || defaultHome();
    this.echo = echo || null;
  }

  file() {
    return path.join(this.home, 'la2l.log');
  }

  write(line) {
    const text = String(line);
    try {
      fs.mkdirSync(this.home, { recursive: true });
      const file = this.file();
      try {
        if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, file + '.old');
      } catch (e) { /* no log yet */ }
      fs.appendFileSync(file, new Date().toISOString() + ' ' + text.replace(/\r?\n/g, '\r\n    ') + '\r\n');
    } catch (e) { /* logging must never break the device */ }
    if (this.echo) {
      try { this.echo(text); } catch (e) { /* ignore */ }
    }
  }
}

module.exports = { Store, Log, DEFAULT_SETTINGS, defaultHome, cleanSettings, LOG_MAX_BYTES };

};

__la2l.defs["server"] = function (module, exports, require) {
'use strict';
// The App2Live server, as the device sees it. The full contract is in docs/server-api.md.
// The device only ever talks to the one server in its settings, over https.

const { URL } = require('url');
const { requestJson, download, NetError } = require('./http');

// The server address from the settings. Only https, except localhost (for tests and self-hosting on one computer).
function checkServerUrl(text) {
  let u;
  try {
    u = new URL(String(text || '').trim());
  } catch (e) {
    throw new NetError('The server address in the settings is not valid.', { kind: 'address' });
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new NetError('The server address must start with https://', { kind: 'address' });
  }
  return u.href.replace(/\/+$/, '');
}

class Server {
  // getToken() returns the device token, or null when this computer is not paired.
  constructor(baseUrl, getToken, opts = {}) {
    this.base = checkServerUrl(baseUrl);
    this.getToken = getToken || (() => null);
    this.timeoutMs = opts.timeoutMs || 15000;
  }

  url(p) {
    return this.base + p;
  }

  auth() {
    const token = this.getToken();
    if (!token) throw new NetError('This computer is not paired yet.', { kind: 'unauthorized' });
    return { Authorization: 'Bearer ' + token };
  }

  call(method, p, opts = {}) {
    const headers = opts.auth === false ? {} : opts.auth === 'optional' ? this.optionalAuth() : this.auth();
    return requestJson(this.url(p), { method, headers, json: opts.json, timeoutMs: opts.timeoutMs || this.timeoutMs });
  }

  optionalAuth() {
    const token = this.getToken();
    return token ? { Authorization: 'Bearer ' + token } : {};
  }

  health() {
    return this.call('GET', '/health', { auth: false, timeoutMs: 8000 });
  }

  // Asks for a pairing code. When this computer is already paired, the token goes along,
  // so the new app is added to the same computer.
  pairStart(info) {
    return this.call('POST', '/pair/start', { auth: 'optional', json: info });
  }

  pairStatus(pairId) {
    return this.call('GET', '/pair/' + encodeURIComponent(pairId), { auth: false, timeoutMs: 10000 });
  }

  pairCancel(pairId) {
    return this.call('POST', '/pair/' + encodeURIComponent(pairId) + '/cancel', { auth: false, timeoutMs: 5000 });
  }

  inbox() {
    return this.call('GET', '/inbox');
  }

  manifest(packageId) {
    return this.call('GET', '/packages/' + encodeURIComponent(packageId) + '/manifest');
  }

  // Downloads one file of a package. Redirects are only followed within the same server.
  downloadFile(packageId, file, target, opts = {}) {
    const url = this.url('/packages/' + encodeURIComponent(packageId) + '/files/' + encodeURIComponent(file));
    return download(url, target, Object.assign({ headers: this.auth() }, opts));
  }

  ack(packageId, body) {
    return this.call('POST', '/packages/' + encodeURIComponent(packageId) + '/ack', { json: body });
  }

  unpair() {
    return this.call('POST', '/unpair', { json: {}, timeoutMs: 8000 });
  }
}

// The list of waiting packages from GET /inbox, checked and sorted oldest first.
function readInbox(answer) {
  const list = answer && Array.isArray(answer.packages) ? answer.packages : [];
  return list
    .filter((p) => p && typeof p.package_id === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(p.package_id))
    .map((p) => ({
      id: p.package_id,
      title: typeof p.title === 'string' ? p.title : '',
      app: typeof p.app === 'string' ? p.app : '',
      items: Number.isInteger(p.items) ? p.items : null,
      createdAt: typeof p.created_at === 'string' ? p.created_at : '',
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

module.exports = { Server, checkServerUrl, readInbox };

};

__la2l.defs["http"] = function (module, exports, require) {
'use strict';
// HTTP and HTTPS with only Node's built-in modules (no npm packages: Freeze would not pack them).
// Every exchange has a timeout and a size limit, and every error has a message in plain words
// that fits in the status line of the device.

const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { URL } = require('url');
const { VERSION } = require('./version');

class NetError extends Error {
  // kind: offline | timeout | network | tls | http | unauthorized | toolarge | badjson | redirect | checksum | address
  constructor(message, info = {}) {
    super(message);
    this.name = 'NetError';
    this.kind = info.kind || 'network';
    this.status = info.status || 0;
    this.code = info.code || '';
    this.url = info.url || '';
  }
}

const USER_AGENT = `LA2L/${VERSION} (Max for Live; ${process.platform})`;

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

// A Node network error code in words.
function codeError(e, url) {
  const code = (e && e.code) || '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new NetError('No internet, or the server name is wrong.', { kind: 'offline', code, url });
  }
  if (code === 'ECONNREFUSED') return new NetError('The server refused the connection.', { kind: 'offline', code, url });
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return new NetError('The server did not answer in time.', { kind: 'timeout', code, url });
  if (code === 'ECONNRESET' || code === 'EPIPE') return new NetError('The connection was broken off.', { kind: 'network', code, url });
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return new NetError('No internet connection.', { kind: 'offline', code, url });
  if (TLS_CODES.has(code)) return new NetError('The security certificate of the server is not valid.', { kind: 'tls', code, url });
  return new NetError(`Network error: ${(e && e.message) || code || 'unknown'}.`, { kind: 'network', code, url });
}

// An HTTP status in words. serverText is the server's own message, when it sent one.
function statusError(status, serverText, url) {
  const extra = serverText ? ` ${serverText}` : '';
  // Only 401 means the token is gone (see docs/server-api.md). A 403 can also come from a proxy or
  // firewall, and must not make the device forget its pairing.
  if (status === 401) return new NetError('This computer is no longer paired.', { kind: 'unauthorized', status, url });
  if (status === 403) return new NetError(`The server refused this (403).${extra}`, { kind: 'http', status, url });
  if (status === 404) return new NetError(`The server does not know this address (404).${extra}`, { kind: 'http', status, url });
  if (status === 410) return new NetError(`This is no longer on the server (410).${extra}`, { kind: 'http', status, url });
  if (status === 413) return new NetError(`Too large for the server (413).${extra}`, { kind: 'toolarge', status, url });
  if (status === 429) return new NetError('The server is busy. Wait a minute and try again.', { kind: 'http', status, url });
  if (status >= 500) return new NetError(`The server has a problem (${status}). Try again later.`, { kind: 'http', status, url });
  return new NetError(`The server answered ${status}.${extra}`, { kind: 'http', status, url });
}

function parseUrl(text) {
  let u;
  try {
    u = new URL(String(text));
  } catch (e) {
    throw new NetError(`Not a valid web address: ${text}`, { kind: 'address', url: String(text) });
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new NetError(`Only http and https addresses work: ${text}`, { kind: 'address', url: String(text) });
  }
  return u;
}

const sameOrigin = (from, to) => from.origin === to.origin;
const anyWebAddress = () => true;

// One exchange, following redirects when allowRedirect(fromUrl, toUrl) says yes.
// With opts.toFile the body is streamed to that file (and hashed) instead of kept in memory.
// Resolves to { status, headers, url, body } or { status, headers, url, bytes, sha256 }.
function exchange(urlText, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    json,
    timeoutMs = 15000, // whole exchange
    idleMs = 15000, // no data for this long: give up
    maxBytes = 2 * 1048576,
    redirects = 3,
    allowRedirect = sameOrigin,
    toFile = null,
  } = opts;
  const url = parseUrl(urlText);
  const lib = url.protocol === 'https:' ? https : http;
  const body = json !== undefined ? Buffer.from(JSON.stringify(json)) : null;
  const reqHeaders = Object.assign({ 'User-Agent': USER_AGENT, Accept: '*/*' }, headers);
  if (body) {
    reqHeaders['Content-Type'] = 'application/json';
    reqHeaders['Content-Length'] = String(body.length);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let out = null;
    let outClosed = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(total);
      if (!err) return resolve(value);
      req.destroy();
      // Wait until the file is closed, so the caller can delete it (Windows refuses open files).
      if (out && !outClosed) {
        out.once('close', () => reject(err));
        out.destroy();
      } else {
        reject(err);
      }
    };
    const total = setTimeout(() => {
      finish(new NetError('The server did not answer in time.', { kind: 'timeout', url: url.href }));
    }, timeoutMs);

    const req = lib.request(url, { method, headers: reqHeaders }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return finish(new NetError('Too many redirects.', { kind: 'redirect', status, url: url.href }));
        let next;
        try {
          next = new URL(res.headers.location, url);
        } catch (e) {
          return finish(new NetError('The server sent a broken redirect.', { kind: 'redirect', status, url: url.href }));
        }
        if (!allowRedirect(url, next)) {
          return finish(new NetError(`The server sent us to another address (${next.host}).`, { kind: 'redirect', status, url: url.href }));
        }
        const keepMethod = status === 307 || status === 308;
        const nextOpts = Object.assign({}, opts, {
          redirects: redirects - 1,
          method: keepMethod ? method : 'GET',
          json: keepMethod ? json : undefined,
        });
        clearTimeout(total);
        settled = true;
        return exchange(next.href, nextOpts).then(resolve, reject);
      }

      const declared = Number(res.headers['content-length']);
      if (declared > maxBytes) {
        res.resume();
        return finish(new NetError(`The file is too large (${Math.round(declared / 1048576)} MB).`, { kind: 'toolarge', status, url: url.href }));
      }
      const ok = status >= 200 && status < 300;
      let received = 0;
      const chunks = [];
      const hash = crypto.createHash('sha256');
      if (toFile && ok) {
        out = fs.createWriteStream(toFile);
        out.on('close', () => { outClosed = true; });
        out.on('error', (e) => finish(new NetError(`Cannot write the file: ${e.message}`, { kind: 'network', code: e.code, url: url.href })));
      }
      res.on('data', (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          return finish(new NetError('The file is larger than the package said.', { kind: 'toolarge', status, url: url.href }));
        }
        if (out) {
          hash.update(chunk);
          out.write(chunk);
        } else if (chunks.length < 1e5) {
          chunks.push(chunk);
        }
      });
      res.on('error', (e) => finish(codeError(e, url.href)));
      res.on('close', () => {
        if (!res.complete) finish(new NetError('The connection was broken off.', { kind: 'network', url: url.href }));
      });
      res.on('end', () => {
        if (settled) return;
        if (out) {
          out.end(() => finish(null, { status, headers: res.headers, url: url.href, bytes: received, sha256: hash.digest('hex') }));
        } else {
          finish(null, { status, headers: res.headers, url: url.href, body: Buffer.concat(chunks) });
        }
      });
    });
    req.setTimeout(idleMs, () => finish(new NetError('The server did not answer in time.', { kind: 'timeout', url: url.href })));
    req.on('error', (e) => finish(codeError(e, url.href)));
    if (body) req.write(body);
    req.end();
  });
}

// The server's own error text from a JSON body like {"error": "..."}, cleaned and short.
function serverText(body) {
  try {
    const j = JSON.parse(body.toString('utf8'));
    const t = typeof j.error === 'string' ? j.error : typeof j.message === 'string' ? j.message : '';
    return t.replace(/[^\w .:'()-]/g, '').slice(0, 80);
  } catch (e) {
    return '';
  }
}

// JSON request. Resolves to the parsed JSON of a 2xx answer, rejects with a NetError otherwise.
async function requestJson(url, opts = {}) {
  const r = await exchange(url, Object.assign({ maxBytes: 1048576 }, opts, { headers: Object.assign({ Accept: 'application/json' }, opts.headers) }));
  if (r.status < 200 || r.status >= 300) throw statusError(r.status, serverText(r.body), r.url);
  if (r.status === 204 || r.body.length === 0) return {};
  try {
    return JSON.parse(r.body.toString('utf8'));
  } catch (e) {
    throw new NetError('The server sent an answer the device cannot read.', { kind: 'badjson', status: r.status, url: r.url });
  }
}

const RETRY_KINDS = new Set(['offline', 'timeout', 'network', 'checksum']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Download to `file`. The data goes to file.part first and is renamed only when it is complete
// and matches the expected size and sha256 (when given). Retries with 1, 2 and 4 seconds of waiting.
// Resolves to { bytes, sha256, url }.
async function download(url, file, opts = {}) {
  const { expectBytes = null, expectSha256 = null, retries = 3, retryDelayMs = 1000, onRetry = null } = opts;
  const part = file + '.part';
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      if (onRetry) onRetry(attempt, lastError);
      await sleep(retryDelayMs * 2 ** (attempt - 1));
    }
    try {
      const r = await exchange(url, Object.assign({ timeoutMs: 10 * 60000, idleMs: 20000 }, opts, { toFile: part }));
      if (r.status < 200 || r.status >= 300) {
        throw statusError(r.status, '', r.url);
      }
      if (expectBytes !== null && r.bytes !== expectBytes) {
        throw new NetError(`The file arrived damaged (${r.bytes} instead of ${expectBytes} bytes).`, { kind: 'checksum', url: r.url });
      }
      if (expectSha256 && r.sha256 !== expectSha256) {
        throw new NetError('The file arrived damaged (checksum does not match).', { kind: 'checksum', url: r.url });
      }
      fs.renameSync(part, file);
      return { bytes: r.bytes, sha256: r.sha256, url: r.url };
    } catch (e) {
      try { fs.unlinkSync(part); } catch (e2) { /* no part file */ }
      lastError = e instanceof NetError ? e : codeError(e, url);
      if (!RETRY_KINDS.has(lastError.kind) && !(lastError.kind === 'http' && lastError.status >= 500)) break;
    }
  }
  throw lastError;
}

module.exports = { NetError, exchange, requestJson, download, sameOrigin, anyWebAddress, parseUrl, statusError, codeError, USER_AGENT };

};

__la2l.defs["live-bridge"] = function (module, exports, require) {
'use strict';
// Requests from Node to the Live part of the device, and their answers.
// Node for Max cannot use the Live API. Node sends "tolive request <json>" to the patch, the [v8]
// script la2l-live.js does the work in Live and answers with "live <json>". Answers are matched by id.

class LiveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LiveError';
  }
}

class LiveBridge {
  // send(...values) sends one message to Max. log(line) writes to the log file.
  constructor(send, log) {
    this.send = send;
    this.log = log || (() => {});
    this.pending = new Map();
    this.nextId = 1;
  }

  // Resolves with the answer. Rejects when the Live part stays silent for timeoutMs.
  // Each progress message starts that time again: an import of many sounds may take a while.
  request(type, payload = {}, opts = {}) {
    const { timeoutMs = 5000, onProgress = null } = opts;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, onProgress, timer: null };
      entry.arm = () => {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(
            new LiveError(
              type === 'getinfo'
                ? 'The Live part of LA2L does not answer. LA2L needs Live 12.4 or newer.'
                : 'Live stopped answering. Check the tracks and try again.'
            )
          );
        }, timeoutMs);
      };
      this.pending.set(id, entry);
      entry.arm();
      this.send('tolive', 'request', JSON.stringify(Object.assign({}, payload, { id, type })));
    });
  }

  // A "live <json>" message from the v8 script.
  receive(text) {
    let msg;
    try {
      msg = JSON.parse(String(text));
    } catch (e) {
      this.log('Live part sent something unreadable: ' + String(text).slice(0, 200));
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'log') {
      this.log('live: ' + msg.text);
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return; // an answer that came after its time-out
    if (msg.type === 'progress') {
      entry.arm();
      if (entry.onProgress) {
        try { entry.onProgress(msg); } catch (e) { this.log('progress handler failed: ' + e.message); }
      }
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(msg.id);
    entry.resolve(msg);
  }
}

module.exports = { LiveBridge, LiveError };

};

__la2l.defs["wav"] = function (module, exports, require) {
'use strict';
// Reads the header of a WAV file, and writes simple 16-bit WAV files (for the built-in test loop).
// Only the header is read: Live reads the sound itself. The header tells us whether Live can
// use the file and how long it is, which the device needs to work out the loop length.

const fs = require('fs');

class WavError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WavError';
  }
}

const PCM = 1;
const FLOAT = 3;
const EXTENSIBLE = 0xfffe;

function parseFmt(b) {
  if (b.length < 16) throw new WavError('The WAV header is damaged.');
  const fmt = {
    formatTag: b.readUInt16LE(0),
    channels: b.readUInt16LE(2),
    sampleRate: b.readUInt32LE(4),
    blockAlign: b.readUInt16LE(12),
    bitsPerSample: b.readUInt16LE(14),
  };
  // WAVE_FORMAT_EXTENSIBLE keeps the real format in the first two bytes of a GUID.
  if (fmt.formatTag === EXTENSIBLE && b.length >= 26) fmt.formatTag = b.readUInt16LE(24);
  return fmt;
}

function check(fmt) {
  const { formatTag, channels, sampleRate, bitsPerSample } = fmt;
  if (formatTag === PCM) {
    if (![8, 16, 24, 32].includes(bitsPerSample)) throw new WavError(`${bitsPerSample}-bit PCM is not supported. Use 16 or 24 bit.`);
  } else if (formatTag === FLOAT) {
    if (![32, 64].includes(bitsPerSample)) throw new WavError(`${bitsPerSample}-bit float is not supported. Use 32-bit float.`);
  } else {
    throw new WavError(`This WAV file is compressed (format ${formatTag}). Send plain PCM or float WAV.`);
  }
  if (channels < 1 || channels > 2) throw new WavError(`The WAV file has ${channels} channels. Live places mono and stereo files only.`);
  if (sampleRate < 8000 || sampleRate > 192000) throw new WavError(`The sample rate ${sampleRate} Hz is not supported.`);
}

// Returns { format, channels, sampleRate, bitsPerSample, blockAlign, dataOffset, dataBytes, frames, duration, fileBytes }.
function readInfo(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(12);
    if (size < 12 || fs.readSync(fd, head, 0, 12, 0) < 12) throw new WavError('The file is too short to be a WAV file.');
    const riff = head.toString('latin1', 0, 4);
    if (riff === 'RF64' || riff === 'BW64') throw new WavError('RF64 files are not supported. Send a normal WAV file.');
    if (riff !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') throw new WavError('This is not a WAV file.');

    let pos = 12;
    let fmt = null;
    let data = null;
    const hdr = Buffer.alloc(8);
    // Walk the chunks. Large chunks we do not need (LIST, bext, JUNK) are skipped, not read.
    while (pos + 8 <= size && !(fmt && data)) {
      fs.readSync(fd, hdr, 0, 8, pos);
      const id = hdr.toString('latin1', 0, 4);
      let len = hdr.readUInt32LE(4);
      const body = pos + 8;
      if (id === 'fmt ') {
        const b = Buffer.alloc(Math.min(len, 64));
        fs.readSync(fd, b, 0, b.length, body);
        fmt = parseFmt(b);
      } else if (id === 'data') {
        // Some recorders leave the size at 0 or 0xFFFFFFFF while writing: use what is there.
        if (len === 0 || len === 0xffffffff || body + len > size) len = size - body;
        data = { offset: body, bytes: len };
      }
      pos = body + len + (len & 1);
    }
    if (!fmt) throw new WavError('The WAV file has no format block.');
    if (!data) throw new WavError('The WAV file has no sound data.');
    check(fmt);
    const blockAlign = fmt.blockAlign || (fmt.channels * fmt.bitsPerSample) / 8;
    const frames = Math.floor(data.bytes / blockAlign);
    if (frames < 1) throw new WavError('The WAV file is empty.');
    return {
      format: fmt.formatTag === FLOAT ? 'float' : 'pcm',
      channels: fmt.channels,
      sampleRate: fmt.sampleRate,
      bitsPerSample: fmt.bitsPerSample,
      blockAlign,
      dataOffset: data.offset,
      dataBytes: data.bytes,
      frames,
      duration: frames / fmt.sampleRate,
      fileBytes: size,
    };
  } finally {
    fs.closeSync(fd);
  }
}

// A 16-bit PCM WAV file in memory. samples: numbers from -1 to 1, interleaved when stereo.
function buildWav16(samples, channels, sampleRate) {
  const dataBytes = samples.length * 2;
  const b = Buffer.alloc(44 + dataBytes);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(PCM, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    b.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return b;
}

function writeWav16(file, samples, channels, sampleRate) {
  fs.writeFileSync(file, buildWav16(samples, channels, sampleRate));
}

module.exports = { readInfo, buildWav16, writeWav16, WavError };

};

__la2l.defs["manifest"] = function (module, exports, require) {
'use strict';
// The App2Live manifest (docs/manifest.md). Checks a package description from an app and works
// out how each sound goes into Live: warp on or off, warp mode, tempo and loop length.
// The app only says what a sound is (loop or one-shot, drums or vocal); the device picks the Live settings.

const { SCHEMA } = require('./version');
const { cleanName, megabytes } = require('./text');

const LIMITS = {
  maxItems: 32,
  maxPackageBytes: 200 * 1048576,
};

const ROLES = ['drums', 'bass', 'melodic', 'vocal', 'texture', 'fx'];

// Live's warp modes (Clip.warp_mode). 5 is REX, which only REX files use.
const WARP_MODES = { beats: 0, tones: 1, texture: 2, repitch: 3, complex: 4, complexpro: 6 };
const MODE_NAMES = { 0: 'Beats', 1: 'Tones', 2: 'Texture', 3: 'Re-Pitch', 4: 'Complex', 6: 'Complex Pro' };

// Role -> warp mode. Complex Pro sounds best on mixed material but costs the most CPU,
// so only melodic parts and vocals get it.
const ROLE_MODES = { drums: 0, bass: 1, melodic: 6, vocal: 6, texture: 2, fx: 4 };
const DEFAULT_MODE = 4; // Complex, for fx and sounds without a role

// Colours close to Live's palette. Live picks the nearest colour of its own palette anyway.
const PALETTE = ['#FF94A6', '#FFA529', '#F7F47C', '#BFFB00', '#1AFF2F', '#5CFFE8', '#8BC5FF', '#5480E4', '#D86CE4', '#E553A0'];

class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManifestError';
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function parseColor(v) {
  if (typeof v !== 'string') return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
  return m ? parseInt(m[1], 16) : null;
}

function paletteColor(index) {
  return parseColor(PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length]);
}

function parseWarpMode(v) {
  if (typeof v === 'number') return [0, 1, 2, 3, 4, 6].includes(v) ? v : null;
  if (typeof v !== 'string') return null;
  const key = v.toLowerCase().replace(/[\s_-]/g, '');
  return key in WARP_MODES ? WARP_MODES[key] : null;
}

function parseKind(v) {
  const k = typeof v === 'string' ? v.toLowerCase().replace(/[\s_-]/g, '') : '';
  if (k === 'loop') return 'loop';
  if (k === 'oneshot') return 'oneshot';
  return null;
}

// A file name as the server knows it. Used only to build the download address; the file on
// disk gets a name made from the sound's name.
function validFile(v) {
  return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/.test(v) && /\.wav$/i.test(v) && !v.includes('..');
}

// Checks a manifest and returns { pkg, warnings }. Problems with the whole package throw a
// ManifestError. A problem with one sound only marks that sound (item.error), the rest still goes in.
function validate(raw) {
  const warnings = [];
  if (!isObject(raw)) throw new ManifestError('The package description is not valid.');
  if (typeof raw.schema !== 'string') throw new ManifestError('This is not an App2Live package.');
  if (raw.schema !== SCHEMA) {
    if (/^app2live\/\d+$/.test(raw.schema)) throw new ManifestError(`This package uses ${raw.schema}. Update LA2L to import it.`);
    throw new ManifestError('This is not an App2Live package.');
  }
  if (typeof raw.package_id !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(raw.package_id)) {
    throw new ManifestError('The package has no valid package_id.');
  }
  const source = isObject(raw.source) ? raw.source : {};
  const tempo = isObject(raw.tempo) ? raw.tempo : {};
  const pkg = {
    packageId: raw.package_id,
    title: cleanName(raw.title, 'Untitled', 60),
    app: cleanName(source.app, 'App', 40),
    appVersion: typeof source.app_version === 'string' ? source.app_version.slice(0, 40) : '',
    platform: typeof source.platform === 'string' ? source.platform.slice(0, 40) : '',
    createdAt: typeof raw.created_at === 'string' ? raw.created_at.slice(0, 40) : '',
    bpm: null,
    timeSignature: null,
    items: [],
    midiCount: Array.isArray(raw.midi) ? raw.midi.length : 0,
  };
  if (!raw.title) warnings.push('no title');
  if (!source.app) warnings.push('no source.app');
  if (tempo.bpm !== undefined) {
    const b = num(tempo.bpm);
    if (b !== null && b >= 20 && b <= 999) pkg.bpm = b;
    else warnings.push('tempo.bpm is not a number from 20 to 999');
  }
  const ts = tempo.time_signature;
  if (Array.isArray(ts) && ts.length === 2 && Number.isInteger(ts[0]) && Number.isInteger(ts[1])) pkg.timeSignature = ts;
  if (pkg.midiCount) warnings.push(`${pkg.midiCount} MIDI parts ignored (MIDI comes in a later version)`);

  if (!Array.isArray(raw.items) || raw.items.length === 0) throw new ManifestError('The package has no sounds.');
  if (raw.items.length > LIMITS.maxItems) {
    throw new ManifestError(`The package has ${raw.items.length} sounds. LA2L takes ${LIMITS.maxItems} at most.`);
  }

  const files = new Set();
  let total = 0;
  raw.items.forEach((it, index) => {
    const item = {
      index,
      id: '',
      file: '',
      sha256: null,
      bytes: null,
      name: `Sound ${index + 1}`,
      kind: 'oneshot',
      role: null,
      lengthBeats: null,
      warpMode: null,
      bpm: null,
      color: null,
      gainDb: null,
      error: null,
    };
    pkg.items.push(item);
    if (!isObject(it)) {
      item.error = 'is not described correctly';
      return;
    }
    item.id = typeof it.id === 'string' && it.id ? it.id.slice(0, 100) : String(index + 1);
    item.name = cleanName(it.name, `Sound ${index + 1}`, 40);
    if (!validFile(it.file)) {
      item.error = 'has no valid file name';
      return;
    }
    if (files.has(it.file.toLowerCase())) {
      item.error = 'uses the same file as another sound';
      return;
    }
    files.add(it.file.toLowerCase());
    item.file = it.file;

    if (typeof it.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(it.sha256)) item.sha256 = it.sha256.toLowerCase();
    else if (it.sha256 !== undefined) warnings.push(`${item.name}: sha256 ignored`);
    if (Number.isInteger(it.bytes) && it.bytes > 0) {
      item.bytes = it.bytes;
      total += it.bytes;
    } else if (it.bytes !== undefined) warnings.push(`${item.name}: bytes ignored`);

    const kind = parseKind(it.kind);
    if (kind) item.kind = kind;
    else warnings.push(`${item.name}: kind "${it.kind}" unknown, placed as one-shot`);

    if (typeof it.role === 'string' && ROLES.includes(it.role.toLowerCase())) item.role = it.role.toLowerCase();
    else if (it.role !== undefined) warnings.push(`${item.name}: role "${it.role}" unknown`);

    if (it.length_beats !== undefined) {
      const l = num(it.length_beats);
      if (l !== null && l > 0 && l <= 4096) item.lengthBeats = l;
      else warnings.push(`${item.name}: length_beats ignored`);
    }
    if (it.warp_mode !== undefined) {
      item.warpMode = parseWarpMode(it.warp_mode);
      if (item.warpMode === null) warnings.push(`${item.name}: warp_mode "${it.warp_mode}" unknown`);
    }
    if (it.bpm !== undefined) {
      const b = num(it.bpm);
      if (b !== null && b >= 20 && b <= 999) item.bpm = b;
      else warnings.push(`${item.name}: bpm ignored`);
    }
    if (it.color !== undefined) {
      item.color = parseColor(it.color);
      if (item.color === null) warnings.push(`${item.name}: color ignored`);
    }
    if (it.gain_db !== undefined) {
      const g = num(it.gain_db);
      if (g !== null) item.gainDb = Math.max(-70, Math.min(24, g));
      else warnings.push(`${item.name}: gain_db ignored`);
    }
  });
  if (total > LIMITS.maxPackageBytes) {
    throw new ManifestError(`The package is ${megabytes(total)}. LA2L takes ${megabytes(LIMITS.maxPackageBytes)} at most.`);
  }
  return { pkg, warnings };
}

// A loop that is within 0.1 beat of a whole number of beats was meant to be that long.
function snapBeats(raw) {
  const whole = Math.round(raw);
  if (whole >= 1 && Math.abs(raw - whole) <= 0.1) return whole;
  return Math.round(raw * 1000) / 1000;
}

// How one sound goes into Live, given its length in seconds (from the WAV header).
//   one-shot: warp off, loop off. It plays exactly as the app made it.
//   loop: warp on, warp mode from the role, the tempo of the package, looped over its length.
function planItem(item, pkg, duration) {
  if (item.kind !== 'loop') {
    return { warp: false, looping: false, warpMode: null, bpm: null, lengthBeats: null };
  }
  const warpMode = item.warpMode !== null ? item.warpMode : item.role ? ROLE_MODES[item.role] : DEFAULT_MODE;
  let bpm = item.bpm || pkg.bpm || null;
  let lengthBeats = item.lengthBeats || null;
  if (!bpm && lengthBeats && duration > 0) bpm = (60 * lengthBeats) / duration;
  if (bpm && (bpm < 5 || bpm > 999)) bpm = null;
  if (bpm && !lengthBeats && duration > 0) lengthBeats = snapBeats((duration * bpm) / 60);
  return { warp: true, looping: true, warpMode, bpm, lengthBeats };
}

function trackName(item, pkg, settings) {
  return settings.appNameInTrackName ? `${item.name} (${pkg.app})` : item.name;
}

function sceneName(pkg) {
  return `${pkg.title} (${pkg.app})`;
}

// The package that Test import places: one sound from the test address in the settings.
function testManifest(settings) {
  return {
    schema: SCHEMA,
    package_id: 'la2l-test-' + Date.now(),
    created_at: new Date().toISOString(),
    title: 'Test import',
    source: { app: 'LA2L', platform: 'test' },
    tempo: { bpm: settings.testBpm },
    items: [{ id: 'test', file: 'test.wav', name: settings.testName, kind: settings.testKind, role: settings.testRole }],
  };
}

module.exports = {
  LIMITS,
  ROLES,
  ROLE_MODES,
  MODE_NAMES,
  PALETTE,
  ManifestError,
  validate,
  planItem,
  snapBeats,
  parseColor,
  paletteColor,
  parseWarpMode,
  trackName,
  sceneName,
  testManifest,
};

};

__la2l.defs["text"] = function (module, exports, require) {
'use strict';
// Small helpers for text: what goes to the Max interface, what becomes a track or file name,
// and how paths are written. Everything here is pure and tested in tests/text.test.js.

const fs = require('fs');
const path = require('path');

// ---- text for the Max interface ----

// Max gives some characters a meaning in messages (comma, semicolon, backslash, quotes,
// dollar, braces). Display text never needs them, so they are dropped.
function cleanDisplay(text) {
  return String(text == null ? '' : text)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[,;\\"$`{}[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Display text goes to Max as separate words. A single symbol with spaces would be
// shown with quotes around it in a comment.
function words(text) {
  const t = cleanDisplay(text);
  return t ? t.split(' ') : [];
}

// ---- names from a manifest ----

function limit(s, maxLen) {
  return s.length > maxLen ? s.slice(0, maxLen).trim() : s;
}

// Track and clip names: letters and digits of any language, plus a few safe signs.
function cleanName(name, fallback, maxLen = 60) {
  const s = String(name == null ? '' : name)
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} _\-().'&+#!]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return limit(s, maxLen) || fallback;
}

// File and folder names: only letters, digits, space, - and _. Never a dot, slash or '..',
// so a name from a manifest can never point somewhere else on the disk.
function cleanFileName(name, fallback, maxLen = 60) {
  let s = String(name == null ? '' : name)
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} _-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = limit(s, maxLen);
  // Names that Windows reserves for devices.
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = '_' + s;
  return s || fallback;
}

// ---- paths ----

// Max reads a backslash as an escape sign, so paths go to Max with forward slashes.
const fwd = (p) => String(p).replace(/\\/g, '/');

// On a Mac, Max writes paths as "Macintosh HD:/Users/...". Node and Live want "/Users/...".
const nativePath = (p) => String(p).replace(/^[^/:\\]{2,}:\//, '/');

// A path in a folder that does not exist yet: "Kick.wav", then "Kick 2.wav", "Kick 3.wav", ...
function uniquePath(dir, base, ext) {
  for (let n = 1; n < 1000; n++) {
    const file = path.join(dir, (n === 1 ? base : `${base} ${n}`) + ext);
    if (!fs.existsSync(file)) return file;
  }
  throw new Error('Too many files called ' + base + ext);
}

// ---- time ----

const pad2 = (n) => String(n).padStart(2, '0');

// "2026-10-16 1530", used in folder names so they sort by time.
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

// 581 seconds -> "9:41"
function clock(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

// ---- numbers and lists ----

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || one + 's'}`;
}

// 135 -> "135", 92.5 -> "92.5", 120.0004 -> "120"
function bpmText(bpm) {
  return String(Math.round(bpm * 100) / 100);
}

function megabytes(bytes) {
  return (bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0) + ' MB';
}

module.exports = {
  cleanDisplay,
  words,
  cleanName,
  cleanFileName,
  fwd,
  nativePath,
  uniquePath,
  stamp,
  clock,
  plural,
  bpmText,
  megabytes,
};

};

__la2l.defs["testsound"] = function (module, exports, require) {
'use strict';
// The built-in test loop: one bar with a snare on beats 2 and 4 and a soft tick on every beat.
// Test import uses it when the test file cannot be downloaded, so the Live part can still be
// tested without a network. The sound is made from numbers, no sample files are needed.

const { writeWav16 } = require('./wav');

// A small fixed random generator (mulberry32), so the loop sounds the same every time.
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Returns mono samples from -1 to 1 for `beats` beats at `bpm`.
function makeLoop(bpm, beats = 4, sampleRate = 44100) {
  const frames = Math.round((sampleRate * beats * 60) / bpm);
  const out = new Float32Array(frames);
  const rnd = random(2026);
  const beatFrames = (sampleRate * 60) / bpm;
  for (let b = 0; b < beats; b++) {
    const start = Math.round(b * beatFrames);
    const snare = b % 2 === 1;
    const len = Math.min(frames - start, Math.round(sampleRate * (snare ? 0.25 : 0.03)));
    let last = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sampleRate;
      const noise = rnd() * 2 - 1;
      let v;
      if (snare) {
        v = noise * Math.exp(-t * 22) * 0.55 + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 30) * 0.35;
      } else {
        v = (noise - last) * Math.exp(-t * 140) * 0.18; // a bright, short tick
      }
      last = noise;
      out[start + i] += v;
    }
  }
  return out;
}

function writeTestLoop(file, bpm, beats = 4) {
  const sampleRate = 44100;
  writeWav16(file, makeLoop(bpm, beats, sampleRate), 1, sampleRate);
}

module.exports = { makeLoop, writeTestLoop };

};

__la2lRequire('./la2l-node');
