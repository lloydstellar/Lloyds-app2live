// Lloyd's App2Live (LA2L): the Live part.
// Runs in a [v8] object in the device. Node for Max cannot reach the Live API, so Node downloads
// the sounds and this script puts them into Live: new tracks, clips, warp, loop, names and colours.
//
// Messages in:
//   init            from live.thisdevice: from now on the Live API can be used
//   request <json>  a request from Node: {id, type: 'getinfo' | 'import' | 'settempo', ...}
//   step            from the patch: run the next step of the running import
// Messages out:
//   outlet 0  live <json>  answers to Node: {type: 'info' | 'progress' | 'result' | 'log', id, ...}
//   outlet 1  <ms>         asks the patch to send 'step' after this many milliseconds
//
// An import is a generator. Each `yield ms` gives Live a moment to finish what it is doing
// (Live applies some clip changes a little later), then the patch calls step() again.
// The patch runs step through [deferlow], so the Live API is always used from the low-priority thread.

autowatch = 0;
inlets = 1;
outlets = 2;

var VERSION = '0.2.1';

var ready = false; // true after init
var waiting = []; // requests that came before init
var queue = []; // imports waiting for their turn
var running = null; // { req, gen } of the running import

// ---------------------------------------------------------------------------
// Messages from the patch

function init() {
  ready = true;
  log('Live part ' + VERSION + ' ready');
  var w = waiting;
  waiting = [];
  for (var i = 0; i < w.length; i++) handle(w[i]);
  startNext();
}

function request(json) {
  var req;
  try {
    req = JSON.parse(String(json));
  } catch (e) {
    log('Request is not valid JSON: ' + String(json).slice(0, 200));
    return;
  }
  if (!ready) {
    waiting.push(req);
    return;
  }
  handle(req);
}

function step() {
  if (!running) return;
  var r;
  try {
    r = running.gen.next();
  } catch (e) {
    var failed = running.req;
    running = null;
    log('Import stopped: ' + errText(e));
    reply({ type: 'result', id: failed.id, ok: false, error: 'Live stopped the import: ' + errText(e), tracks: [] });
    startNext();
    return;
  }
  if (r.done) {
    var finished = running.req;
    running = null;
    var result = r.value || {};
    result.type = 'result';
    result.id = finished.id;
    reply(result);
    startNext();
    return;
  }
  outlet(1, Math.max(0, Math.round(Number(r.value) || 0)));
}

// ---------------------------------------------------------------------------
// Requests

function handle(req) {
  try {
    if (req.type === 'getinfo') {
      reply({ type: 'info', id: req.id, info: liveInfo() });
    } else if (req.type === 'settempo') {
      var tempo = setTempo(Number(req.bpm));
      reply({ type: 'result', id: req.id, ok: Math.abs(tempo - Number(req.bpm)) < 0.01, tempo: tempo });
    } else if (req.type === 'import') {
      queue.push(req);
      startNext();
    } else {
      reply({ type: 'result', id: req.id, ok: false, error: 'Unknown request: ' + req.type });
    }
  } catch (e) {
    log(req.type + ' failed: ' + errText(e));
    reply({ type: 'result', id: req.id, ok: false, error: errText(e) });
  }
}

function startNext() {
  if (running || !ready || !queue.length) return;
  var req = queue.shift();
  running = { req: req, gen: importJob(req) };
  step();
}

// What Node needs to know about Live, the Set and this device.
function liveInfo() {
  var app = api('live_app');
  var song = api('live_set');
  var info = {
    live: {
      major: num(app.call('get_major_version')),
      minor: num(app.call('get_minor_version')),
      bugfix: num(app.call('get_bugfix_version')),
    },
    set: {
      path: '',
      tempo: num(song.get('tempo')),
      numerator: num(song.get('signature_numerator')),
      denominator: num(song.get('signature_denominator')),
      songTime: num(song.get('current_song_time')),
      tracks: song.getcount('tracks'),
      scenes: song.getcount('scenes'),
    },
    device: { path: '', trackIndex: -1, trackName: '' },
  };
  try {
    info.set.path = str(song.get('file_path'));
  } catch (e) {
    info.set.path = '';
  }
  var dev = api('this_device');
  info.device.path = String(dev.unquotedpath || '');
  info.device.trackIndex = deviceTrackIndex();
  if (info.device.trackIndex >= 0) info.device.trackName = str(api('live_set tracks ' + info.device.trackIndex).get('name'));
  return info;
}

// Index of the track this device is on, or -1 on a return track or the master track.
function deviceTrackIndex() {
  var m = /^live_set tracks (\d+)/.exec(String(api('this_device').unquotedpath || ''));
  return m ? Number(m[1]) : -1;
}

function setTempo(bpm) {
  var song = api('live_set');
  if (bpm >= 20 && bpm <= 999) trySet(song, 'tempo', bpm);
  return num(song.get('tempo'));
}

// ---------------------------------------------------------------------------
// Import: one package, one new track per sound

function* importJob(req) {
  var song = api('live_set');
  var items = req.items || [];
  var session = req.placement === 'session';
  var deviceTrack = deviceTrackIndex();
  // New tracks go right after this device's track, in the order of the package, or at the end.
  var base = req.newTracks === 'end' || deviceTrack < 0 ? -1 : deviceTrack + 1 + (Number(req.trackOffset) || 0);
  var sceneIndex = -1;
  var sceneId = 0;
  var position = null;
  if (session) {
    sceneIndex = makeScene(song, req.sceneName || req.title || 'LA2L');
    sceneId = Number(api('live_set scenes ' + sceneIndex).id);
  } else {
    // Always at the start of the Arrangement (1.1.1), wherever the playhead is: after playing,
    // the playhead can be minutes into the Set, and the new sounds then land out of sight.
    position = 0;
  }
  log('Import "' + req.title + '": ' + items.length + ' sound(s), ' + (session ? 'Session, scene ' + sceneIndex : 'Arrangement at 1.1.1') + ', tracks from ' + (base < 0 ? 'the end' : 'index ' + base));

  var results = [];
  var placed = 0;
  var first = null;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var res;
    try {
      res = yield* placeItem(song, it, base < 0 ? -1 : base + placed, sceneIndex, position);
    } catch (e) {
      res = { index: it.index, ok: false, error: errText(e) };
      log(it.name + ': ' + errText(e));
    }
    results.push(res);
    if (res.ok) {
      placed++;
      if (!first) first = res;
    }
    reply({ type: 'progress', id: req.id, done: i + 1, total: items.length, name: it.name, ok: !!res.ok });
    yield 10;
  }
  if (first) select(first.trackId, first.clipId);
  if (sceneId && !placed) {
    // Nothing went in: remove the new scene again, like the track of a sound that failed.
    deleteScene(song, sceneId);
    sceneIndex = -1;
  }
  return { ok: placed > 0, tracks: results, position: position, sceneIndex: sceneIndex };
}

// One sound: a new audio track with its clip. Anything that fails removes the track again,
// so the Set is never left with an empty track.
function* placeItem(song, it, index, sceneIndex, position) {
  var count = song.getcount('tracks');
  var at = index < 0 ? count : Math.min(index, count);
  callSafe(song, 'create_audio_track', index < 0 ? -1 : at);
  if (song.getcount('tracks') !== count + 1) throw new Error('Live did not create a track');
  var track = api('live_set tracks ' + at);
  var trackId = Number(track.id);
  try {
    trySet(track, 'name', it.trackName || it.name);
    if (it.color !== null && it.color !== undefined) trySet(track, 'color', Number(it.color));

    // The clip goes into a Session slot first, also for the Arrangement: there it gets its warp
    // and loop, then it is copied to the Arrangement with the right length (see moveToArrangement).
    var slotIndex = sceneIndex >= 0 ? sceneIndex : 0;
    var slotPath = 'live_set tracks ' + at + ' clip_slots ' + slotIndex;
    var clip = yield* createClip(slotPath, it);
    trySet(clip, 'name', it.clipName || it.name);
    if (it.color !== null && it.color !== undefined) trySet(clip, 'color', Number(it.color));
    yield 30;

    var report = yield* configureClip(clip, it);
    if (it.gainDb !== null && it.gainDb !== undefined) report.gain = setGain(clip, Number(it.gainDb));

    var clipId = Number(clip.id);
    if (position !== null) {
      var arr = yield* moveToArrangement(track, slotPath, clip, position);
      report.arrangement = arr.ok;
      if (arr.ok) clipId = arr.clipId;
      else report.note = 'The clip stayed in the Session slot: ' + arr.error;
    }
    log(it.name + ': placed on track ' + at + '. ' + JSON.stringify(report));
    return { index: it.index, ok: true, trackIndex: at, trackId: trackId, clipId: clipId, report: report };
  } catch (e) {
    deleteTrack(song, trackId);
    throw e;
  }
}

// Loads the WAV into the slot. Tries the path as Node wrote it, then with forward slashes.
function* createClip(slotPath, it) {
  var slot = api(slotPath);
  var paths = [it.path];
  if (it.altPath && it.altPath !== it.path) paths.push(it.altPath);
  for (var p = 0; p < paths.length; p++) {
    callSafe(slot, 'create_audio_clip', paths[p]);
    for (var t = 0; t < 10 && !num(slot.get('has_clip')); t++) yield 50;
    if (num(slot.get('has_clip'))) {
      var clip = api(slotPath + ' clip');
      if (Number(clip.id) !== 0) {
        if (p > 0) log('create_audio_clip worked with path form ' + (p + 1) + ': ' + paths[p]);
        return clip;
      }
    }
    log('create_audio_clip did not load ' + paths[p]);
  }
  throw new Error('Live could not load the file. You can drag it in yourself from ' + (it.folder || it.path));
}

// One-shot: warp off and loop off, so it plays exactly as the app made it.
// Loop: warp on, the warp mode, the tempo of the package, and the loop over its length.
function* configureClip(clip, it) {
  var report = { warp: !!it.warp };
  if (!it.warp) {
    trySet(clip, 'looping', 0);
    trySet(clip, 'warping', 0);
    yield 30;
    report.warping = num(clip.get('warping'));
    report.looping = num(clip.get('looping'));
    return report;
  }
  report.liveWarp = { warping: num(clip.get('warping')), mode: num(clip.get('warp_mode')), markers: readMarkers(clip) };
  if (!num(clip.get('warping'))) {
    trySet(clip, 'warping', 1);
    // Live switches warping on a moment later.
    for (var t = 0; t < 20 && !num(clip.get('warping')); t++) yield 25;
  }
  report.warping = num(clip.get('warping'));
  if (!report.warping) {
    report.note = 'Live did not switch warping on';
    return report;
  }
  if (it.warpMode !== null && it.warpMode !== undefined) trySet(clip, 'warp_mode', Number(it.warpMode));
  report.warpMode = num(clip.get('warp_mode'));
  yield 20;

  var zero = 0;
  if (it.bpm) {
    var fit = yield* fitTempo(clip, Number(it.bpm), Number(it.duration));
    report.tempo = fit.mode;
    report.bpm = fit.bpm;
    report.markers = fit.markers;
    zero = fit.zeroBeat;
  } else {
    report.tempo = 'not given';
  }
  var length = Number(it.lengthBeats) || 0;
  if (it.looping && length > 0) {
    trySet(clip, 'looping', 1);
    setRange(clip, 'loop_start', 'loop_end', zero, zero + length);
    setRange(clip, 'start_marker', 'end_marker', zero, zero + length);
    yield 10;
  }
  report.loop = [num(clip.get('loop_start')), num(clip.get('loop_end'))];
  report.markersRange = [num(clip.get('start_marker')), num(clip.get('end_marker'))];
  report.looping = num(clip.get('looping'));
  return report;
}

// ---------------------------------------------------------------------------
// Tempo: make Live play the file at the tempo the app gave, using warp markers.
//
// What Live 12.4 does through the API (seen in the first test, in Live 12.4.6):
//   - A new clip is not warped. Clip.warp_markers gives the first marker at beat 0, sample 0,
//     plus a hidden marker 1/32 beat later that only holds the tempo of the last part.
//     Switching warping on keeps them, so the clip plays at the Set tempo of that moment.
//   - add_warp_marker with beat_time and sample_time works.
//   - move_warp_marker and remove_warp_marker find a marker by its beat time. That works for the
//     marker at beat 0, but not for a marker whose beat Live gives back as a long decimal number.
// So the script never has to find a marker other than the one at beat 0:
//   1. markers that Live's auto-warp made are removed (if Live lets us), and the first marker
//      is put at sample 0;
//   2. A: one marker just before the end of the file, at the beat that gives the wanted tempo.
//      The first marker stays at beat 0, so the clip starts at 1.1.1;
//   3. B, when Live put that marker at the old tempo after all: the first marker (at beat 0) is
//      moved so that the part up to the end marker runs at the wanted tempo. The clip then
//      starts before 1.1.1 in its own timeline; it still plays from the start of the file.
// After each step the markers are read back. The result says which step made the tempo exact,
// and Live's own markers and the final ones go to the log.

function* fitTempo(clip, bpm, duration) {
  var m = readMarkers(clip);
  var start = m.slice();
  if (m.length < 2) return { mode: 'failed (no warp markers)', bpm: 0, zeroBeat: 0, markers: m };

  // 1. Markers from Live's auto-warp between the first and the hidden one. A new clip has none.
  if (m.length > 2) {
    for (var i = m.length - 2; i >= 1; i--) callSafe(clip, 'remove_warp_marker', m[i].beat);
    yield 20;
    m = readMarkers(clip);
    if (m.length > 2) log('Could not remove ' + (m.length - 2) + ' warp marker(s) that Live made: ' + JSON.stringify(m));
  }
  // The first marker at sample 0 (auto-warp can put it on the first hit) ...
  if (m.length >= 2 && m[0].sample > 1e-6) {
    var zb = beatAtSample(m, 0);
    var old = m[0].beat;
    if (yield* addMarker(clip, zb, 0, zb)) {
      callSafe(clip, 'remove_warp_marker', old);
      yield 20;
    }
    m = readMarkers(clip);
  }
  // ... and at beat 0.
  if (m.length >= 2 && Math.abs(m[0].beat) > 1e-9) {
    callSafe(clip, 'move_warp_marker', m[0].beat, -m[0].beat);
    yield 20;
    m = readMarkers(clip);
  }

  var mode = fitsTempo(m, bpm) ? 'exact' : '';

  // 2. A: a marker just before the end of the file, at the wanted tempo.
  var length = Number(duration) || 0;
  var at = length - Math.min(0.005, length * 0.01);
  if (!mode && m.length >= 2 && at > m[m.length - 2].sample) {
    var f = m[0];
    var want = f.beat + ((at - f.sample) * bpm) / 60;
    yield* addMarker(clip, want, at, beatAtSample(m, at));
    m = readMarkers(clip);
    if (fitsTempo(m, bpm)) mode = 'exact (end marker)';
  }

  // 3. B: move the first marker (at beat 0) so the part up to the next marker runs at the tempo.
  if (!mode && m.length >= 3 && Math.abs(m[0].beat) < 1e-9) {
    var next = m[1];
    var target = next.beat - ((next.sample - m[0].sample) * bpm) / 60;
    callSafe(clip, 'move_warp_marker', m[0].beat, target - m[0].beat);
    yield 20;
    m = readMarkers(clip);
    if (fitsTempo(m, bpm)) mode = 'exact (first marker)';
  }

  if (!mode) {
    mode = 'approximate';
    log('The tempo is not exact. Live\'s markers: ' + JSON.stringify(start) + ' Now: ' + JSON.stringify(m));
  }
  var first = m[0] || { beat: 0, sample: 0 };
  var actual = m.length >= 2 ? segBpm(m[0], m[1]) : 0;
  var rate = mode === 'approximate' ? actual || bpm : bpm;
  return {
    mode: mode,
    bpm: Math.round(actual * 1000) / 1000,
    zeroBeat: first.beat - (first.sample * rate) / 60,
    markers: m,
  };
}

// Adds a warp marker at (beat, sample) and checks that it is there. Live takes the marker as a
// dictionary; the forms are tried one by one, so a Live or Max version that wants another form
// still works. The second form gives only a beat (keepBeat, where the file is at `sample` now),
// so Live keeps the current timing; step B of fitTempo then sets the tempo.
function* addMarker(clip, beat, sample, keepBeat) {
  var before = readMarkers(clip).length;
  var forms = [
    function () { clip.call('add_warp_marker', { beat_time: beat, sample_time: sample }); },
    function () { clip.call('add_warp_marker', { beat_time: keepBeat }); },
    function () {
      var d = new Dict();
      d.set('beat_time', beat);
      d.set('sample_time', sample);
      clip.call('add_warp_marker', d);
    },
  ];
  for (var i = 0; i < forms.length; i++) {
    try {
      forms[i]();
    } catch (e) {
      log('add_warp_marker form ' + (i + 1) + ' failed: ' + errText(e));
    }
    yield 20;
    if (readMarkers(clip).length > before) {
      if (i > 0) log('add_warp_marker worked with form ' + (i + 1));
      return true;
    }
  }
  log('Could not add a warp marker at beat ' + beat + ', sample ' + sample);
  return false;
}

// The warp markers as [{beat, sample}], the hidden marker last.
function readMarkers(clip) {
  var raw;
  try {
    raw = clip.get('warp_markers');
  } catch (e) {
    return [];
  }
  var data = null;
  if (typeof raw === 'string') {
    data = parseJson(raw);
  } else if (raw && typeof raw === 'object' && typeof raw.length === 'number') {
    data = raw.length === 1 && typeof raw[0] === 'object' ? raw[0] : parseJson(Array.prototype.join.call(raw, ' '));
  } else if (raw && typeof raw === 'object') {
    data = raw;
  }
  var list = data && data.warp_markers ? data.warp_markers : Array.isArray(data) ? data : [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var b = Number(list[i].beat_time);
    var s = Number(list[i].sample_time);
    if (isFinite(b) && isFinite(s)) out.push({ beat: b, sample: s });
  }
  return out;
}

// Tempo of the part between two markers.
function segBpm(a, b) {
  var ds = b.sample - a.sample;
  return ds > 0 ? (60 * (b.beat - a.beat)) / ds : 0;
}

// True when every part between visible markers runs at bpm. With only one visible marker,
// the part up to the hidden marker counts. The part after the last visible marker is left out:
// after the end marker of step A it only holds the last few milliseconds of the file.
function fitsTempo(m, bpm) {
  if (m.length < 2) return false;
  var last = m.length === 2 ? 1 : m.length - 2;
  for (var i = 0; i < last; i++) {
    if (Math.abs(segBpm(m[i], m[i + 1]) - bpm) > bpm * 0.0005) return false;
  }
  return true;
}

// The beat at which the clip plays a sample time now, following the markers. Before the first
// marker and after the hidden one, the tempo of the nearest part goes on.
function beatAtSample(m, sample) {
  if (m.length < 2) return 0;
  var i = 0;
  while (i < m.length - 2 && sample > m[i + 1].sample) i++;
  return m[i].beat + ((sample - m[i].sample) * segBpm(m[i], m[i + 1])) / 60;
}

// Sets a start/end pair (loop or markers) in an order Live accepts: the start may never pass the end.
function setRange(clip, startProp, endProp, a, b) {
  if (a < num(clip.get(endProp))) {
    trySet(clip, startProp, a);
    trySet(clip, endProp, b);
  } else {
    trySet(clip, endProp, b);
    trySet(clip, startProp, a);
  }
  if (Math.abs(num(clip.get(startProp)) - a) > 1e-4 || Math.abs(num(clip.get(endProp)) - b) > 1e-4) {
    trySet(clip, endProp, b);
    trySet(clip, startProp, a);
    trySet(clip, endProp, b);
  }
}

// ---------------------------------------------------------------------------
// Arrangement, scenes, gain, selection

// Track.create_audio_clip cannot set the length of an Arrangement clip, and changing the warp
// afterwards does not change it either. So the finished Session clip is copied to the Arrangement
// (the copy gets the loop length) and the Session clip is deleted.
// A form that worked is never tried again, so a clip is never copied twice: success is seen in the
// returned clip, or else in the number of Arrangement clips.
function* moveToArrangement(track, slotPath, clip, position) {
  var before = ids(track.get('arrangement_clips'));
  var count = arrangementCount(track);
  var clipId = Number(clip.id);
  var forms = [
    function () { return track.call('duplicate_clip_to_arrangement', 'id', clipId, position); },
    function () { return track.call('duplicate_clip_to_arrangement', 'id ' + clipId, position); },
  ];
  var made = 0;
  var copied = false;
  for (var i = 0; i < forms.length && !copied; i++) {
    try {
      made = refId(forms[i]());
    } catch (e) {
      log('duplicate_clip_to_arrangement form ' + (i + 1) + ' failed: ' + errText(e));
    }
    yield 20;
    copied = made > 0 || arrangementCount(track) > count;
    if (copied && i > 0) log('duplicate_clip_to_arrangement worked with form ' + (i + 1));
  }
  if (!copied) return { ok: false, error: 'Live did not copy it to the Arrangement' };
  var fresh = ids(track.get('arrangement_clips')).filter(function (id) { return before.indexOf(id) < 0; });
  callSafe(api(slotPath), 'delete_clip');
  return { ok: true, clipId: fresh[0] || made };
}

function arrangementCount(track) {
  try {
    return track.getcount('arrangement_clips');
  } catch (e) {
    return ids(track.get('arrangement_clips')).length;
  }
}

// A new scene at the top of the Session, named after the package, so you see it at once.
function makeScene(song, name) {
  var count = song.getcount('scenes');
  callSafe(song, 'create_scene', 0);
  if (song.getcount('scenes') !== count + 1) throw new Error('Live did not create a scene');
  trySet(api('live_set scenes 0'), 'name', name);
  return 0;
}

// Clip.gain runs from 0 to 1 and is not linear in dB. Search where the display text
// (for example "-6.0 dB") starts to show the wanted value and where it passes it, and take the middle.
function setGain(clip, db) {
  var from = searchGain(clip, function (shown) { return shown < db; });
  var to = searchGain(clip, function (shown) { return shown <= db; });
  trySet(clip, 'gain', (from + to) / 2);
  return str(clip.get('gain_display_string'));
}

// The lowest gain value for which below(shown dB) is false.
function searchGain(clip, below) {
  var lo = 0;
  var hi = 1;
  for (var i = 0; i < 14; i++) {
    var mid = (lo + hi) / 2;
    trySet(clip, 'gain', mid);
    if (below(gainDb(clip))) lo = mid;
    else hi = mid;
  }
  return hi;
}

function gainDb(clip) {
  var text = str(clip.get('gain_display_string'));
  if (/inf/i.test(text)) return -Infinity;
  var v = parseFloat(text);
  return isFinite(v) ? v : 0;
}

// Selects the first new track and shows its clip, so you see at once where the sounds are.
function select(trackId, clipId) {
  var view = api('live_set view');
  try {
    view.set('selected_track', 'id', Number(trackId));
  } catch (e) {
    log('Selecting the track failed: ' + errText(e));
  }
  if (clipId) {
    try {
      view.set('detail_clip', 'id', Number(clipId));
    } catch (e) {
      log('Showing the clip failed: ' + errText(e));
    }
  }
}

function deleteScene(song, sceneId) {
  var count = song.getcount('scenes');
  for (var i = 0; i < count; i++) {
    if (Number(api('live_set scenes ' + i).id) === sceneId) {
      callSafe(song, 'delete_scene', i);
      return;
    }
  }
}

function deleteTrack(song, trackId) {
  var count = song.getcount('tracks');
  for (var i = count - 1; i >= 0; i--) {
    if (Number(api('live_set tracks ' + i).id) === trackId) {
      callSafe(song, 'delete_track', i);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Small helpers

function api(path) {
  return new LiveAPI(path);
}

// LiveAPI.get gives arrays, also for single values.
function first(v) {
  return v !== null && typeof v === 'object' && typeof v.length === 'number' ? v[0] : v;
}

function num(v) {
  var n = Number(first(v));
  return isFinite(n) ? n : 0;
}

// Text values may come back as one symbol or as several words.
function str(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && typeof v.length === 'number') return Array.prototype.join.call(v, ' ');
  return String(v);
}

// ["id", 12, "id", 13] -> [12, 13]
function ids(v) {
  var out = [];
  if (!v || typeof v.length !== 'number') return out;
  for (var i = 0; i < v.length; i++) {
    if (v[i] === 'id' && i + 1 < v.length) out.push(Number(v[i + 1]));
  }
  return out;
}

// A Live object returned by call(): ["id", 5], "id 5" or 5 -> 5. Nothing -> 0.
function refId(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'object' && typeof v.length === 'number') {
    var list = ids(v);
    if (list.length) return list[0];
    v = Array.prototype.join.call(v, ' ');
  }
  var m = /^\s*(?:id\s+)?(\d+)\s*$/.exec(String(v));
  return m ? Number(m[1]) : 0;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function trySet(obj, prop, value) {
  try {
    obj.set(prop, value);
    return true;
  } catch (e) {
    log('set ' + prop + ' failed: ' + errText(e));
    return false;
  }
}

function callSafe(obj) {
  var args = Array.prototype.slice.call(arguments, 1);
  try {
    return obj.call.apply(obj, args);
  } catch (e) {
    log(args[0] + ' failed: ' + errText(e));
    return undefined;
  }
}

function errText(e) {
  return e && e.message ? e.message : String(e);
}

function reply(obj) {
  outlet(0, 'live', JSON.stringify(obj));
}

function log(text) {
  post('LA2L live: ' + text + '\n');
  reply({ type: 'log', text: String(text) });
}
