'use strict';
// Generates the Max patch of the device as JSON: every object, connection, position and Live
// parameter. The device is never saved from the Max editor; change this file and build again.
// buildPatch() is also used by tests/patch.test.js. Run directly to write build/la2l.maxpat.

const fs = require('fs');
const path = require('path');
const { VERSION, NAME } = require('../src/node/version');
const { OUT_KEYS } = require('../src/node/app');

const W = 480;
const H = 169;
const FONT = 'Ableton Sans';
const DIM = [0.5, 0.5, 0.5, 1.0];

// ---------------------------------------------------------------------------
// A small builder for Max patcher JSON

class Patch {
  constructor() {
    this.boxes = [];
    this.lines = [];
    this.params = {};
  }

  box(attrs) {
    const id = 'obj-' + (this.boxes.length + 1);
    this.boxes.push({ box: Object.assign({ id }, attrs) });
    return id;
  }

  get(id) {
    return this.boxes.find((b) => b.box.id === id).box;
  }

  obj(text, x, y, o = {}) {
    const { w = 100, h = 22, nin = 1, nout = 1, ot, ...rest } = o;
    return this.box(Object.assign({ maxclass: 'newobj', text, numinlets: nin, numoutlets: nout, outlettype: ot || Array(nout).fill(''), patching_rect: [x, y, w, h] }, rest));
  }

  msg(text, x, y, o = {}) {
    const { w = 100, h = 22, ...rest } = o;
    return this.box(Object.assign({ maxclass: 'message', text, numinlets: 2, numoutlets: 1, outlettype: [''], patching_rect: [x, y, w, h] }, rest));
  }

  // A text in the presentation. Its patching position sits far to the right, out of the way.
  comment(text, pres, o = {}) {
    const { size = 10, bold = 0, color = null, ...rest } = o;
    const b = {
      maxclass: 'comment',
      text,
      numinlets: 1,
      numoutlets: 0,
      patching_rect: [pres[0] + 3000, pres[1] + 1000, pres[2], pres[3]],
      presentation: 1,
      presentation_rect: pres,
      fontname: FONT,
      fontsize: size,
      fontface: bold,
    };
    if (color) b.textcolor = color;
    return this.box(Object.assign(b, rest));
  }

  con(src, outlet, dst, inlet) {
    this.lines.push({ patchline: { source: [src, outlet], destination: [dst, inlet] } });
  }

  // A Live UI object that is a Live parameter. Hidden parameters (parameter_invisible 2) are not
  // stored in the Set and not automatable, so they never fire by themselves when a Set loads.
  live(maxclass, label, longname, pres, enumValues, nout, ot, o = {}) {
    const { info, ...rest } = o;
    const valueof = {
      parameter_enum: enumValues,
      parameter_longname: longname,
      parameter_mmax: enumValues.length - 1,
      parameter_shortname: label,
      parameter_type: 2,
      parameter_invisible: 2,
    };
    const b = {
      maxclass,
      numinlets: 1,
      numoutlets: nout,
      outlettype: ot,
      parameter_enable: 1,
      patching_rect: [pres[0] + 3000, pres[1] + 1000, pres[2], pres[3]],
      presentation: 1,
      presentation_rect: pres,
      varname: longname,
      fontname: FONT,
      fontsize: 10.0,
      saved_attribute_attributes: { valueof },
    };
    if (info) Object.assign(b, { annotation: info, annotation_name: label });
    const id = this.box(Object.assign(b, rest));
    this.params[id] = [longname, label, 0];
    return id;
  }

  // live.text: mode 0 is a button, mode 1 a toggle.
  ltext(label, mode, longname, pres, o = {}) {
    const rest = Object.assign({ texton: label }, o);
    return this.live('live.text', label, longname, pres, ['off', 'on'], 2, ['', ''], Object.assign({ mode, text: label, outputmode: 1 }, rest));
  }

  patcher(rect, extra) {
    return Object.assign(
      {
        fileversion: 1,
        appversion: { major: 9, minor: 1, revision: 5, architecture: 'x64', modernui: 1 },
        classnamespace: 'box',
        rect,
        openinpresentation: 1,
        default_fontsize: 10.0,
        default_fontname: FONT,
        gridsize: [8.0, 8.0],
        boxes: this.boxes,
        lines: this.lines,
      },
      extra
    );
  }
}

// Wraps text into lines of at most `chars` characters, for comments that need more than one line.
function wrap(text, chars) {
  const out = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && (line + ' ' + word).length > chars) {
      out.push(line);
      line = word;
    } else {
      line = line ? line + ' ' + word : word;
    }
  }
  if (line) out.push(line);
  return out.join('\n');
}

const script = (show, hide) => show.map((v) => 'script show ' + v).concat(hide.map((v) => 'script hide ' + v)).join(', ');

// ---------------------------------------------------------------------------
// The device

function buildPatch() {
  const p = new Patch();

  // Audio passes through unchanged: the device can sit on any track.
  const plugin = p.obj('plugin~', 20, 20, { w: 60, nin: 2, nout: 2, ot: ['signal', 'signal'] });
  const plugout = p.obj('plugout~', 20, 140, { w: 60, nin: 2, nout: 0 });
  p.con(plugin, 0, plugout, 0);
  p.con(plugin, 1, plugout, 1);

  // Node: the network, the disk and the logic. Everything for Node goes through [s ---la2l]
  // (three dashes make the name local to this device).
  const fromUi = p.obj('r ---la2l', 200, 20, { w: 70, nin: 0, nout: 1 });
  const node = p.obj('node.script la2l-node.js @autostart 1 @watch 0', 200, 60, {
    w: 300,
    nin: 1,
    nout: 2,
    ot: ['', ''],
    saved_object_attributes: { autostart: 1, defer: 0, node_bin_path: '', npm_bin_path: '', watch: 0 },
  });
  p.con(fromUi, 0, node, 0);
  const route = p.obj('route ' + OUT_KEYS.join(' '), 200, 100, { w: 900, nin: 2, nout: OUT_KEYS.length + 1 });
  p.con(node, 0, route, 0);
  const R = (key) => {
    const i = OUT_KEYS.indexOf(key);
    if (i < 0) throw new Error('No route key ' + key);
    return i;
  };
  const toNode = (x, y) => p.obj('s ---la2l', x, y, { w: 70, nout: 0 });

  // The Live part: a [v8] script that uses the Live API. Its second outlet drives the step loop:
  // [delay] waits, [deferlow] moves to the low-priority thread where the Live API may be used.
  const v8 = p.obj('v8 la2l-live.js', 200, 600, { w: 110, nin: 1, nout: 2, ot: ['', ''], saved_object_attributes: { parameter_enable: 0 } });
  p.con(route, R('tolive'), v8, 0);
  p.con(v8, 0, node, 0);
  const delay = p.obj('delay', 360, 640, { w: 50, nin: 2, nout: 1, ot: ['bang'] });
  const defer = p.obj('deferlow', 360, 670, { w: 60 });
  const stepMsg = p.msg('step', 360, 700, { w: 40 });
  p.con(v8, 1, delay, 0);
  p.con(delay, 0, defer, 0);
  p.con(defer, 0, stepMsg, 0);
  p.con(stepMsg, 0, v8, 0);

  // When Live has loaded the device, the Live API can be used: tell the v8 script, then Node.
  const thisDevice = p.obj('live.thisdevice', 500, 600, { w: 90, nout: 3, ot: ['bang', 'int', ''] });
  const thisT = p.obj('t b b', 500, 630, { w: 40, nout: 2, ot: ['bang', 'bang'] });
  const initLive = p.msg('init', 540, 660, { w: 35 });
  const initNode = p.msg('init', 500, 660, { w: 35 });
  p.con(thisDevice, 0, thisT, 0);
  p.con(thisT, 1, initLive, 0);
  p.con(initLive, 0, v8, 0);
  p.con(thisT, 0, initNode, 0);
  p.con(initNode, 0, toNode(500, 690), 0);

  const thisp = p.obj('thispatcher', 1300, 600, { w: 80, nout: 2, ot: ['', ''] });

  // A text that Node fills. A bare bang (empty text from Node) clears it.
  let dx = 200;
  const display = (key, target) => {
    const rb = p.obj('route bang', dx, 160, { w: 70, nin: 2, nout: 2 });
    const clear = p.msg('set', dx, 190, { w: 30 });
    const set = p.obj('prepend set', dx + 35, 190, { w: 70, nin: 2 });
    p.con(route, R(key), rb, 0);
    p.con(rb, 0, clear, 0);
    p.con(rb, 1, set, 0);
    p.con(clear, 0, target, 0);
    p.con(set, 0, target, 0);
    dx += 120;
  };

  // A button that sends one message to Node. Buttons send bang or 1: both count as one click.
  let bx = 1500;
  const action = (label, longname, pres, message, o = {}) => {
    const b = p.ltext(label, 0, longname, pres, o);
    const r = p.obj('route bang 1', bx, 160, { w: 80, nin: 2, nout: 3, ot: ['bang', 'bang', ''] });
    const tb = p.obj('t b', bx, 190, { w: 30, nout: 1, ot: ['bang'] });
    const m = p.msg(message, bx, 220, { w: 80 });
    p.con(b, 0, r, 0);
    p.con(r, 0, tb, 0);
    p.con(r, 1, tb, 0);
    p.con(tb, 0, m, 0);
    p.con(m, 0, toNode(bx, 250), 0);
    bx += 100;
    return b;
  };

  const groups = { unpaired: [], pairing: [], paired: [], tempo: [], settings: [] };
  const inGroup = (group, id, name) => {
    const b = p.get(id);
    b.varname = name;
    b.hidden = 1;
    groups[group].push(name);
    return id;
  };

  // ---- header: logo, name, version, Settings ----
  p.box({
    maxclass: 'fpic',
    pic: 'la2l-logo.png',
    autofit: 2,
    numinlets: 1,
    numoutlets: 1,
    outlettype: ['jit_matrix'],
    patching_rect: [3006, 1004, 32, 32],
    presentation: 1,
    presentation_rect: [6, 4, 32, 32],
  });
  p.comment(NAME, [44, 4, 220, 18], { size: 12, bold: 1 });
  p.comment('v' + VERSION, [44, 22, 120, 14], { size: 9, color: DIM });
  const settingsBtn = p.ltext('Settings', 1, 'Settings', [W - 80, 9, 74, 20], {
    texton: 'Close',
    info: 'Where new sounds go, Test import, Self test, the log folder and Unpair.',
  });
  const settingsMsg = p.obj('prepend settings', 1300, 160, { w: 110, nin: 2 });
  p.con(settingsBtn, 0, settingsMsg, 0);
  p.con(settingsMsg, 0, toNode(1300, 190), 0);
  const settingsSet = p.obj('prepend set', 1300, 220, { w: 70, nin: 2 });
  p.con(route, R('settingsbutton'), settingsSet, 0);
  p.con(settingsSet, 0, settingsBtn, 0);

  // ---- status line, two lines high, always visible ----
  const status = p.comment('Starting LA2L...', [6, 140, W - 12, 27], { size: 9.5 });
  p.get(status).varname = 'status';
  display('status', status);

  // ---- not paired ----
  inGroup('unpaired', p.comment('Send sounds from your apps to Live.', [6, 46, 330, 18], { size: 11 }), 'u_title');
  inGroup(
    'unpaired',
    action('Pair app', 'PairApp', [6, 70, 120, 26], 'pair', {
      fontsize: 11,
      info: 'Shows a code. Type it in your app to connect the app to this computer. You do this once for every app.',
    }),
    'u_pair'
  );
  inGroup('unpaired', p.comment(wrap('Click Pair app and type the code in your app. You do this once for every app.', 58), [6, 102, 340, 30], { size: 9.5, color: DIM }), 'u_help');

  // ---- showing a code ----
  inGroup('pairing', p.comment('Type this code in your app:', [6, 44, 300, 16], { size: 10 }), 'p_title');
  const code = inGroup('pairing', p.comment('--- ---', [6, 58, 300, 42], { size: 30, bold: 1 }), 'p_code');
  display('code', code);
  const count = inGroup('pairing', p.comment('', [6, 100, 260, 16], { size: 9.5, color: DIM }), 'p_count');
  display('countdown', count);
  inGroup('pairing', action('Cancel', 'CancelPair', [6, 118, 80, 20], 'cancelpair', { info: 'Stop pairing. The code stops working.' }), 'p_cancel');

  // ---- paired ----
  const pairedWith = inGroup('paired', p.comment('Paired.', [6, 46, 330, 18], { size: 11 }), 'd_title');
  display('pairedwith', pairedWith);
  inGroup(
    'paired',
    action('Import', 'Import', [6, 70, 120, 26], 'import', {
      fontsize: 11,
      info: 'Gets every sound your apps sent to this computer and puts it in Live, one new track per sound.',
    }),
    'd_import'
  );
  inGroup('paired', p.comment(wrap('Gets every sound your apps sent and puts it in Live.', 40), [134, 72, 240, 28], { size: 9.5, color: DIM }), 'd_help');

  // The tempo row shows after an import whose tempo differs from the Set. The device never
  // changes the Set tempo by itself.
  const tempoText = inGroup('tempo', p.comment('', [6, 104, 218, 30], { size: 9.5 }), 'd_tempotext');
  display('tempotext', tempoText);
  const tempoBtn = inGroup('tempo', action('Use tempo', 'UseTempo', [230, 108, 110, 20], 'usetempo', { info: 'Sets the tempo of the Live Set to the tempo of the sounds you just imported.' }), 'd_tempobtn');
  const tempoLabel = p.obj('prepend text', 1300, 280, { w: 80, nin: 2 });
  const tempoLabelOn = p.obj('prepend texton', 1390, 280, { w: 90, nin: 2 });
  p.con(route, R('tempolabel'), tempoLabel, 0);
  p.con(route, R('tempolabel'), tempoLabelOn, 0);
  p.con(tempoLabel, 0, tempoBtn, 0);
  p.con(tempoLabelOn, 0, tempoBtn, 0);

  // ---- settings, on top of the views ----
  inGroup('settings', p.comment('New sounds go to', [6, 47, 110, 16], { size: 10 }), 's_placelbl');
  const place = inGroup(
    'settings',
    p.live('live.tab', 'Placement', 'Placement', [118, 45, 220, 20], ['Arrangement', 'Session'], 3, ['', '', 'float'], {
      num_lines_patching: 1,
      num_lines_presentation: 1,
      livemode: 1,
      info: 'Arrangement: new clips start at the playhead, rounded to the nearest bar. Session: a new scene with one clip per track.',
    }),
    's_place'
  );
  const placeMsg = p.obj('prepend placement', 1600, 300, { w: 110, nin: 2 });
  p.con(place, 0, placeMsg, 0);
  p.con(placeMsg, 0, toNode(1600, 330), 0);
  const placeSet = p.obj('prepend set', 1600, 270, { w: 70, nin: 2 });
  p.con(route, R('placement'), placeSet, 0);
  p.con(placeSet, 0, place, 0);

  inGroup('settings', p.comment('New tracks go', [6, 71, 110, 16], { size: 10 }), 's_trackslbl');
  const tracks = inGroup(
    'settings',
    p.live('live.tab', 'New tracks', 'NewTracks', [118, 69, 220, 20], ['After this track', 'At the end'], 3, ['', '', 'float'], {
      num_lines_patching: 1,
      num_lines_presentation: 1,
      livemode: 1,
      info: 'Put the new tracks right after the track with this device, or after all other tracks.',
    }),
    's_tracks'
  );
  const tracksMsg = p.obj('prepend newtracks', 1750, 300, { w: 110, nin: 2 });
  p.con(tracks, 0, tracksMsg, 0);
  p.con(tracksMsg, 0, toNode(1750, 330), 0);
  const tracksSet = p.obj('prepend set', 1750, 270, { w: 70, nin: 2 });
  p.con(route, R('newtracks'), tracksSet, 0);
  p.con(tracksSet, 0, tracks, 0);

  inGroup('settings', action('Test import', 'TestImport', [6, 95, 72, 20], 'testimport', { info: 'Puts a test loop in Live without an app or a server. Use it to check that LA2L works.' }), 's_test');
  inGroup('settings', action('Self test', 'SelfTest', [82, 95, 64, 20], 'selftest', { info: 'Checks Node, the folder, Live, the server and the pairing. The result shows in the status line.' }), 's_selftest');
  inGroup('settings', action('Open folder', 'OpenFolder', [150, 95, 72, 20], 'openfolder', { info: 'Opens Documents/Lloyds App2Live with the settings, the log (la2l.log) and the Inbox.' }), 's_folder');
  inGroup('settings', action('Add app', 'AddApp', [226, 95, 64, 20], 'addapp', { info: 'Pair one more app with this computer.' }), 's_addapp');
  inGroup('settings', action('Unpair', 'Unpair', [294, 95, 52, 20], 'unpair', { info: 'Disconnects all apps from this computer. Click twice.' }), 's_unpair');
  inGroup('settings', p.comment(`${NAME} ${VERSION} by Lloyd Stellar. lloydstellar.nl`, [6, 119, 340, 16], { size: 9, color: DIM }), 's_about');
  inGroup(
    'settings',
    p.box({
      maxclass: 'fpic',
      pic: 'la2l-logo-big.png',
      autofit: 2,
      numinlets: 1,
      numoutlets: 1,
      outlettype: ['jit_matrix'],
      patching_rect: [3400, 1050, 86, 86],
      presentation: 1,
      presentation_rect: [W - 92, 44, 86, 86],
    }),
    's_logo'
  );

  // ---- switching views ----
  const VIEWS = ['unpaired', 'pairing', 'paired', 'settings'];
  const viewSel = p.obj('sel ' + VIEWS.join(' '), 1100, 600, { w: 200, nin: 2, nout: VIEWS.length + 1 });
  p.con(route, R('view'), viewSel, 0);
  VIEWS.forEach((v, i) => {
    const hide = VIEWS.filter((o) => o !== v).flatMap((o) => groups[o]).concat(groups.tempo);
    const m = p.msg(script(groups[v], hide), 1100 + i * 10, 640 + i * 30, { w: 600 });
    p.con(viewSel, i, m, 0);
    p.con(m, 0, thisp, 0);
  });
  const tempoSel = p.obj('sel 1 0', 1100, 800, { w: 60, nin: 2, nout: 3, ot: ['bang', 'bang', ''] });
  p.con(route, R('tempo'), tempoSel, 0);
  const showTempo = p.msg(script(groups.tempo, []), 1100, 830, { w: 300 });
  const hideTempo = p.msg(script([], groups.tempo), 1100, 860, { w: 300 });
  p.con(tempoSel, 0, showTempo, 0);
  p.con(tempoSel, 1, hideTempo, 0);
  p.con(showTempo, 0, thisp, 0);
  p.con(hideTempo, 0, thisp, 0);

  // ---- the top-level patcher of an audio effect device ----
  const params = Object.assign({}, p.params, {
    parameterbanks: { 0: { index: 0, name: '', parameters: Array(8).fill('-'), buttons: Array(8).fill('-') } },
    inherited_shortname: 1,
  });
  const top = p.patcher([100.0, 100.0, 1400.0, 900.0], {
    openrect: [0.0, 0.0, W, H],
    openrectmode: 0,
    boxanimatetime: 500,
    devicewidth: W,
    parameters: params,
    dependency_cache: [],
    latency: 0,
    is_mpe: 0,
    external_mpe_tuning_enabled: 0,
    minimum_live_version: '',
    minimum_max_version: '',
    platform_compatibility: 0,
    project: {
      version: 1,
      creationdate: 3590052786,
      modificationdate: 3590052786,
      viewrect: [0.0, 0.0, 300.0, 500.0],
      autoorganize: 1,
      hideprojectwindow: 1,
      showdependencies: 1,
      autolocalize: 0,
      contents: { patchers: {} },
      layout: {},
      searchpath: {},
      detailsvisible: 0,
      amxdtype: 1633771873,
      readonly: 0,
      devpathtype: 0,
      devpath: '.',
      sortmode: 0,
      viewmode: 0,
      includepackages: 0,
    },
    autosave: 0,
  });
  return { patcher: top, groups, W, H };
}

// Checks that would otherwise only show up as errors in the Max window.
function checkPatch(built) {
  const { patcher, W: width, H: height } = built;
  const problems = [];
  const byId = new Map(patcher.boxes.map((b) => [b.box.id, b.box]));
  for (const { patchline } of patcher.lines) {
    const [s, so] = patchline.source;
    const [d, di] = patchline.destination;
    const src = byId.get(s);
    const dst = byId.get(d);
    if (!src || !dst) {
      problems.push(`line ${s} -> ${d} points at a missing object`);
      continue;
    }
    if (so >= src.numoutlets) problems.push(`${src.text || src.maxclass} has no outlet ${so}`);
    if (di >= dst.numinlets) problems.push(`${dst.text || dst.maxclass} has no inlet ${di}`);
  }
  const names = patcher.boxes.map((b) => b.box.varname).filter(Boolean);
  for (const n of new Set(names)) if (names.filter((x) => x === n).length > 1) problems.push(`varname ${n} is used twice`);
  for (const { box } of patcher.boxes) {
    const r = box.presentation_rect;
    if (r && (r[0] < 0 || r[1] < 0 || r[0] + r[2] > width || r[1] + r[3] > height)) problems.push(`${box.varname || box.text || box.maxclass} is outside the device: ${r}`);
    if (box.maxclass === 'outlettype') problems.push('bad box');
    if (box.outlettype && box.outlettype.length !== box.numoutlets) problems.push(`${box.text || box.maxclass} has ${box.numoutlets} outlets but ${box.outlettype.length} outlet types`);
  }
  // Every "script show/hide x" must name an object that exists.
  for (const { box } of patcher.boxes) {
    if (box.maxclass !== 'message') continue;
    for (const m of box.text.matchAll(/script (?:show|hide) (\S+?)(?:,|$)/g)) {
      if (!names.includes(m[1])) problems.push(`script names unknown object ${m[1]}`);
    }
  }
  const longnames = Object.values(patcher.parameters).filter(Array.isArray).map((x) => x[0]);
  for (const n of new Set(longnames)) if (longnames.filter((x) => x === n).length > 1) problems.push(`parameter ${n} is used twice`);
  return problems;
}

function patchJson(built) {
  return JSON.stringify({ patcher: built.patcher }, null, 2) + '\n';
}

if (require.main === module) {
  const built = buildPatch();
  const problems = checkPatch(built);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  const out = path.join(__dirname, '..', 'build', 'la2l.maxpat');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, patchJson(built));
  console.log(`${built.patcher.boxes.length} boxes, ${built.patcher.lines.length} lines -> ${out}`);
}

module.exports = { buildPatch, checkPatch, patchJson, wrap, W, H };
