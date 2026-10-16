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
