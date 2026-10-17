'use strict';
// A small fake of Live and its LiveAPI, enough to run src/live/la2l-live.js outside Max.
// It models what the import needs: tracks, scenes, clip slots, clips with warp markers,
// the Arrangement, the song and its view. The defaults follow what Live 12.4.6 did in the first
// test on Windows (see docs/design-notes.md). Where Live's behaviour is still unknown, the fake
// has switches for the plausible variants (see the options below), and the tests run the import
// against each of them.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const wav = require('../src/node/wav');

const ROOT = path.join(__dirname, '..');

const DEFAULTS = {
  version: [12, 4, 6],
  tempo: 120,
  songTime: 9.3, // beats
  filePath: '',
  tracks: 3,
  scenes: 2,
  deviceTrack: 1, // index of the track with LA2L on it; -1 = on the master track
  // Group tracks: { at, size, folded } makes the track at index `at` a group with the next
  // `size` tracks in it. A later entry inside an earlier one makes a group within that group.
  groups: [],
  // The state of a new clip:
  //   'unwarped': not warped, first marker at (0, 0), hidden marker at the Set tempo (Live 12.4.6)
  //   'loopwarp': warped and looped at guessTempo, like Live's "Loop/Warp Short Samples"
  //   'autowarp': warped, first marker on the first hit plus one more marker, like auto-warp
  initialWarp: 'unwarped',
  guessTempo: 100,
  // add_warp_marker with beat_time and sample_time: true = the marker goes exactly there,
  // false = Live keeps the current timing and works out the beat itself (unknown, both tested).
  addHonoursBeat: true,
  // move_warp_marker and remove_warp_marker find a marker by beat time:
  //   'zeroOnly': only the marker at beat 0 can be found (Live 12.4.6)
  //   'exact': any marker, by the beat time warp_markers gave
  markerMatch: 'zeroOnly',
  // Moving the last visible marker takes the hidden marker along (unknown, both tested).
  lastMoveShifts: true,
  // How errors show: 'silent' (printed to the Max window only) or 'throw'.
  errors: 'silent',
  // Which path forms create_audio_clip accepts: 'any', 'forward' (only forward slashes).
  paths: 'any',
  // Which argument form duplicate_clip_to_arrangement accepts: 'string' ("id 5"), 'pair' ("id", 5) or 'both'.
  dupForm: 'both',
  // What duplicate_clip_to_arrangement returns: 'clip' (["id", n], as Live does) or 'nothing'.
  dupReturns: 'clip',
  // What get('arrangement_clips') gives: 'ids' (["id", 1, "id", 2]) or 'unreadable' (a form the script does not know).
  arrangementList: 'ids',
  // add_warp_marker: 'object' (a JS object works) or 'dict' (only a Dict works).
  addForm: 'object',
  // warp_markers comes back as 'string', 'array1' (["{...}"]) or 'object'.
  markerFormat: 'string',
  allowNegative: true, // whether loop_start and start_marker may be below 0
};

class MockDict {
  constructor() {
    this.values = {};
  }
  set(k, v) {
    this.values[k] = v;
  }
  get(k) {
    return this.values[k];
  }
}

class MockLive {
  constructor(opts = {}) {
    this.o = Object.assign({}, DEFAULTS, opts);
    this.objects = new Map();
    this.nextId = 1;
    this.errors = []; // what Live would print in the Max window
    this.posts = [];
    this.pending = []; // changes Live applies a moment later (warping)
    this.song = this.reg({
      kind: 'song',
      tempo: this.o.tempo,
      numerator: 4,
      denominator: 4,
      songTime: this.o.songTime,
      filePath: this.o.filePath,
      tracks: [],
      scenes: [],
    });
    this.app = this.reg({ kind: 'app' });
    this.view = this.reg({ kind: 'view', selectedTrack: 0, detailClip: 0 });
    this.master = this.reg({ kind: 'master', name: 'Master' });
    for (let s = 0; s < this.o.scenes; s++) this.song.scenes.push(this.reg({ kind: 'scene', name: '' }));
    for (let t = 0; t < this.o.tracks; t++) this.song.tracks.push(this.newTrack(`${t + 1}-Audio`));
    for (const g of this.o.groups) {
      const head = this.song.tracks[g.at];
      Object.assign(head, { name: `${g.at + 1}-Group`, foldable: true, folded: g.folded ? 1 : 0 });
      for (let k = 1; k <= g.size; k++) this.song.tracks[g.at + k].group = head;
    }
    this.device = this.reg({ kind: 'device', track: this.o.deviceTrack >= 0 ? this.song.tracks[this.o.deviceTrack] : null });
    const mock = this;
    this.LiveAPI = function LiveAPI(p) {
      const obj = mock.resolve(String(p));
      this._obj = obj;
      this.id = obj ? String(obj.id) : '0';
      this.unquotedpath = obj ? mock.pathOf(obj) : '';
      this.path = obj ? '"' + this.unquotedpath + '"' : '';
    };
    this.LiveAPI.prototype.get = function (prop) {
      return mock.get(this._obj, prop);
    };
    this.LiveAPI.prototype.set = function (prop, ...values) {
      return mock.set(this._obj, prop, values);
    };
    this.LiveAPI.prototype.call = function (fn, ...args) {
      return mock.call(this._obj, fn, args);
    };
    this.LiveAPI.prototype.getcount = function (child) {
      return mock.getcount(this._obj, child);
    };
  }

  reg(obj) {
    obj.id = this.nextId++;
    this.objects.set(obj.id, obj);
    return obj;
  }

  newTrack(name) {
    const t = this.reg({ kind: 'track', name, color: 0, slots: [], arrangement: [] });
    for (let s = 0; s < this.song.scenes.length; s++) t.slots.push(this.reg({ kind: 'slot', track: t, clip: null }));
    return t;
  }

  fail(message) {
    if (this.o.errors === 'throw') throw new Error(message);
    this.errors.push(message);
    return undefined;
  }

  // ---- paths ----

  resolve(p) {
    let m;
    if (p === 'live_set') return this.song;
    if (p === 'live_app') return this.app;
    if (p === 'live_set view') return this.view;
    if (p === 'this_device') return this.device;
    if ((m = /^id (\d+)$/.exec(p))) return this.objects.get(Number(m[1])) || null;
    if ((m = /^live_set scenes (\d+)$/.exec(p))) return this.song.scenes[Number(m[1])] || null;
    if ((m = /^live_set tracks (\d+)(?: clip_slots (\d+)( clip)?)?$/.exec(p))) {
      const t = this.song.tracks[Number(m[1])];
      if (!t) return null;
      if (m[2] === undefined) return t;
      const slot = t.slots[Number(m[2])];
      if (!slot) return null;
      return m[3] ? slot.clip : slot;
    }
    return null;
  }

  pathOf(obj) {
    switch (obj.kind) {
      case 'song': return 'live_set';
      case 'app': return 'live_app';
      case 'view': return 'live_set view';
      case 'track': return 'live_set tracks ' + this.song.tracks.indexOf(obj);
      case 'scene': return 'live_set scenes ' + this.song.scenes.indexOf(obj);
      case 'slot': return this.pathOf(obj.track) + ' clip_slots ' + obj.track.slots.indexOf(obj);
      case 'device': return obj.track ? this.pathOf(obj.track) + ' devices 0' : 'live_set master_track devices 0';
      case 'clip':
        if (obj.slot) return this.pathOf(obj.slot) + ' clip';
        return this.pathOf(obj.track) + ' arrangement_clips ' + obj.track.arrangement.indexOf(obj);
      default: return '';
    }
  }

  // ---- get / set / call ----

  get(obj, prop) {
    if (!obj) return this.fail('get on an invalid object');
    const c = obj;
    switch (obj.kind + '.' + prop) {
      case 'song.tempo': return [c.tempo];
      case 'song.signature_numerator': return [c.numerator];
      case 'song.signature_denominator': return [c.denominator];
      case 'song.current_song_time': return [c.songTime];
      case 'song.file_path': return [c.filePath];
      case 'track.name': return [c.name];
      case 'track.color': return [c.color];
      case 'track.group_track': return ['id', c.group ? c.group.id : 0];
      case 'track.is_grouped': return [c.group ? 1 : 0];
      case 'track.is_foldable': return [c.foldable ? 1 : 0];
      case 'track.fold_state':
        if (!c.foldable) return this.fail('get: fold_state is only available on a group track');
        return [c.folded];
      case 'track.arrangement_clips':
        if (this.o.arrangementList === 'unreadable') return [{ clips: c.arrangement.length }];
        return c.arrangement.flatMap((x) => ['id', x.id]);
      case 'scene.name': return [c.name];
      case 'slot.has_clip': return [c.clip ? 1 : 0];
      case 'view.selected_track': return ['id', c.selectedTrack];
      case 'view.detail_clip': return ['id', c.detailClip];
      default:
        if (obj.kind === 'clip') return this.getClip(c, prop);
        return this.fail(`get: no property ${prop} on ${obj.kind}`);
    }
  }

  set(obj, prop, values) {
    if (!obj) return this.fail('set on an invalid object');
    const v = values[0];
    switch (obj.kind + '.' + prop) {
      case 'song.tempo': obj.tempo = Number(v); return undefined;
      case 'track.name':
      case 'scene.name': obj.name = String(v); return undefined;
      case 'track.color': obj.color = Number(v); return undefined;
      case 'track.fold_state':
        if (!obj.foldable) return this.fail('set: fold_state is only available on a group track');
        obj.folded = Number(v) ? 1 : 0;
        return undefined;
      case 'view.selected_track':
      case 'view.detail_clip': {
        const id = this.refId(values);
        if (!id) return this.fail('set: not an object reference');
        if (prop === 'selected_track') obj.selectedTrack = id;
        else obj.detailClip = id;
        return undefined;
      }
      default:
        if (obj.kind === 'clip') return this.setClip(obj, prop, v);
        return this.fail(`set: no property ${prop} on ${obj.kind}`);
    }
  }

  // An object reference as ("id", 5) or "id 5".
  refId(args, form = 'both') {
    if (args[0] === 'id' && args.length >= 2 && (form === 'both' || form === 'pair')) return Number(args[1]);
    const m = /^id (\d+)$/.exec(String(args[0]));
    if (m && (form === 'both' || form === 'string')) return Number(m[1]);
    return 0;
  }

  call(obj, fn, args) {
    if (!obj) return this.fail('call on an invalid object');
    const key = obj.kind + '.' + fn;
    switch (key) {
      case 'app.get_major_version': return this.o.version[0];
      case 'app.get_minor_version': return this.o.version[1];
      case 'app.get_bugfix_version': return this.o.version[2];
      case 'song.create_audio_track': return this.createTrack(Number(args[0]));
      case 'song.delete_track': {
        const i = Number(args[0]);
        if (!(i >= 0 && i < this.song.tracks.length)) return this.fail('delete_track: bad index');
        this.song.tracks.splice(i, 1);
        return undefined;
      }
      case 'song.create_scene': return this.createScene(Number(args[0]));
      case 'song.delete_scene': {
        const i = Number(args[0]);
        if (!(i >= 0 && i < this.song.scenes.length) || this.song.scenes.length < 2) return this.fail('delete_scene: bad index');
        this.song.scenes.splice(i, 1);
        for (const t of this.song.tracks) t.slots.splice(i, 1);
        return undefined;
      }
      case 'slot.create_audio_clip': return this.createClipInSlot(obj, String(args[0]));
      case 'slot.delete_clip':
        if (!obj.clip) return this.fail('delete_clip: no clip');
        obj.clip.slot = null;
        obj.clip = null;
        return undefined;
      case 'track.duplicate_clip_to_arrangement': return this.duplicate(obj, args);
      case 'track.create_audio_clip': {
        const clip = this.loadClip(String(args[0]));
        if (!clip) return undefined;
        clip.track = obj;
        clip.startTime = Number(args[1]);
        clip.endTime = clip.startTime + (clip.endMarker - clip.startMarker);
        obj.arrangement.push(clip);
        return undefined;
      }
      case 'clip.add_warp_marker': return this.addMarker(obj, args[0]);
      case 'clip.move_warp_marker': return this.moveMarker(obj, Number(args[0]), Number(args[1]));
      case 'clip.remove_warp_marker': return this.removeMarker(obj, Number(args[0]));
      default: return this.fail(`call: no function ${fn} on ${obj.kind}`);
    }
  }

  getcount(obj, child) {
    if (obj === this.song && child === 'tracks') return this.song.tracks.length;
    if (obj === this.song && child === 'scenes') return this.song.scenes.length;
    if (obj && obj.kind === 'track' && child === 'clip_slots') return obj.slots.length;
    if (obj && obj.kind === 'track' && child === 'arrangement_clips') return obj.arrangement.length;
    this.fail(`getcount: no child ${child}`);
    return 0;
  }

  // ---- song ----

  // A new track joins the group of the track it pushes down: right after a group's header, or
  // between two tracks of a group, it lands in that group (a Max forum report on Live). At the
  // end of the Set, or before a track that is not in a group, it is in no group; that part is a
  // guess about Live.
  createTrack(index) {
    const n = this.song.tracks.length;
    const at = index === -1 ? n : index;
    if (!(at >= 0 && at <= n)) return this.fail('create_audio_track: index out of range');
    const track = this.newTrack(`${n + 1}-Audio`);
    if (at < n && this.song.tracks[at].group) track.group = this.song.tracks[at].group;
    this.song.tracks.splice(at, 0, track);
    return undefined;
  }

  createScene(index) {
    const n = this.song.scenes.length;
    const at = index === -1 ? n : index;
    if (!(at >= 0 && at <= n)) return this.fail('create_scene: index out of range');
    this.song.scenes.splice(at, 0, this.reg({ kind: 'scene', name: '' }));
    for (const t of this.song.tracks) t.slots.splice(at, 0, this.reg({ kind: 'slot', track: t, clip: null }));
    return undefined;
  }

  // ---- clips ----

  pathAccepted(p) {
    if (/^[^/:\\]{2,}:\//.test(p)) return false; // "Macintosh HD:/..." is refused, like in the forum report
    if (this.o.paths === 'forward' && p.includes('\\')) return false;
    return fs.existsSync(p.replace(/\\/g, '/')) || fs.existsSync(p);
  }

  loadClip(p) {
    if (!this.pathAccepted(p)) return this.fail('create_audio_clip: invalid path ' + p);
    let info;
    try {
      info = wav.readInfo(fs.existsSync(p) ? p : p.replace(/\\/g, '/'));
    } catch (e) {
      return this.fail('create_audio_clip: cannot read ' + p);
    }
    const dur = info.duration;
    const tempo = this.song.tempo;
    const clip = this.reg({
      kind: 'clip',
      name: path.basename(p.replace(/\\/g, '/'), '.wav'),
      color: 0,
      file: p,
      duration: dur,
      warping: 0,
      warpMode: 0,
      looping: 0,
      gain: 0.4,
      markers: [{ beat: 0, sample: 0 }],
      hidden: after({ beat: 0, sample: 0 }, tempo),
      slot: null,
      track: null,
      startTime: 0,
      endTime: 0,
    });
    if (this.o.initialWarp === 'autowarp') {
      clip.warping = 1;
      clip.looping = 1;
      clip.markers = [{ beat: 0, sample: 0.012 }, { beat: 2, sample: 0.012 + (2 * 60) / tempo + 0.003 }];
      clip.hidden = after(clip.markers[1], segTempo(clip.markers[0], clip.markers[1]));
    } else if (this.o.initialWarp === 'loopwarp') {
      clip.warping = 1;
      clip.looping = 1;
      clip.hidden = after(clip.markers[0], this.o.guessTempo);
    }
    this.resetRanges(clip);
    return clip;
  }

  resetRanges(clip) {
    const end = clip.warping ? this.beatAt(clip, clip.duration) : clip.duration;
    const start = clip.warping ? this.beatAt(clip, 0) : 0;
    clip.loopStart = clip.startMarker = start;
    clip.loopEnd = clip.endMarker = end;
  }

  createClipInSlot(slot, p) {
    if (slot.clip) return this.fail('create_audio_clip: slot not empty');
    const clip = this.loadClip(p);
    if (!clip) return undefined;
    clip.slot = slot;
    slot.clip = clip;
    return undefined;
  }

  duplicate(track, args) {
    const id = this.refId(args.slice(0, args.length - 1), this.o.dupForm);
    const time = Number(args[args.length - 1]);
    const src = id && this.objects.get(id);
    if (!src || src.kind !== 'clip') return this.fail('duplicate_clip_to_arrangement: invalid clip');
    const copy = this.reg(Object.assign({}, src, { id: undefined, slot: null, track, markers: src.markers.map((m) => Object.assign({}, m)), hidden: Object.assign({}, src.hidden) }));
    copy.id = this.nextId - 1;
    copy.startTime = time;
    copy.endTime = time + (src.looping ? src.loopEnd - src.loopStart : src.endMarker - src.startMarker);
    track.arrangement.push(copy);
    return this.o.dupReturns === 'clip' ? ['id', copy.id] : undefined;
  }

  getClip(c, prop) {
    switch (prop) {
      case 'warping': return [c.warping];
      case 'warp_mode': return [c.warpMode];
      case 'looping': return [c.looping];
      case 'loop_start': return [c.loopStart];
      case 'loop_end': return [c.loopEnd];
      case 'start_marker': return [c.startMarker];
      case 'end_marker': return [c.endMarker];
      case 'name': return [c.name];
      case 'color': return [c.color];
      case 'gain': return [c.gain];
      case 'gain_display_string': return [gainText(c.gain)];
      case 'start_time': return [c.startTime];
      case 'end_time': return [c.endTime];
      case 'warp_markers': {
        const list = this.all(c).map((m) => ({ beat_time: m.beat, sample_time: m.sample }));
        const text = JSON.stringify({ warp_markers: list });
        if (this.o.markerFormat === 'array1') return [text];
        if (this.o.markerFormat === 'object') return { warp_markers: list };
        return text;
      }
      default: return this.fail('get: no clip property ' + prop);
    }
  }

  setClip(c, prop, v) {
    const n = Number(v);
    switch (prop) {
      case 'name': c.name = String(v); return undefined;
      case 'color': c.color = n; return undefined;
      case 'gain': c.gain = Math.max(0, Math.min(1, n)); return undefined;
      case 'warp_mode':
        if (![0, 1, 2, 3, 4, 6].includes(n)) return this.fail('warp_mode: invalid');
        c.warpMode = n;
        return undefined;
      case 'warping':
        // Live applies this a moment later.
        this.pending.push(() => {
          if (c.warping === (n ? 1 : 0)) return;
          c.warping = n ? 1 : 0;
          if (!c.warping) c.looping = 0;
          this.resetRanges(c);
        });
        return undefined;
      case 'looping':
        if (n && !c.warping) return this.fail('looping: an unwarped clip cannot loop');
        c.looping = n ? 1 : 0;
        return undefined;
      case 'loop_start':
      case 'start_marker': {
        const endKey = prop === 'loop_start' ? 'loopEnd' : 'endMarker';
        if (!(n < c[endKey])) return this.fail(prop + ': must be before the end');
        if (n < 0 && !this.o.allowNegative) return this.fail(prop + ': cannot be negative');
        c[prop === 'loop_start' ? 'loopStart' : 'startMarker'] = n;
        return undefined;
      }
      case 'loop_end':
      case 'end_marker': {
        const startKey = prop === 'loop_end' ? 'loopStart' : 'startMarker';
        if (!(n > c[startKey])) return this.fail(prop + ': must be after the start');
        c[prop === 'loop_end' ? 'loopEnd' : 'endMarker'] = n;
        return undefined;
      }
      default: return this.fail('set: no clip property ' + prop);
    }
  }

  // Applies the changes Live makes "a moment later". The test harness calls this before each step.
  tick() {
    const p = this.pending;
    this.pending = [];
    for (const fn of p) fn();
  }

  // ---- warp markers ----
  // A clip has visible markers plus a hidden one, 1/32 beat after the last visible marker,
  // that holds the tempo of the part after it. Like Live, warp_markers lists the hidden one last.

  all(c) {
    return c.markers.concat([c.hidden]);
  }

  // Where the clip plays a sample time, in beats. Outside the markers the nearest part goes on.
  beatAt(c, sample) {
    const m = this.all(c);
    let i = 0;
    while (i < m.length - 2 && sample > m[i + 1].sample) i++;
    const a = m[i];
    const b = m[i + 1];
    return a.beat + ((sample - a.sample) * (b.beat - a.beat)) / (b.sample - a.sample);
  }

  sampleAt(c, beat) {
    const m = this.all(c);
    let i = 0;
    while (i < m.length - 2 && beat > m[i + 1].beat) i++;
    const a = m[i];
    const b = m[i + 1];
    return a.sample + ((beat - a.beat) * (b.sample - a.sample)) / (b.beat - a.beat);
  }

  // Ascending in beats and samples, visible markers inside the file, every part 5 to 999 BPM.
  validMap(markers, hidden, duration) {
    const m = markers.concat([hidden]);
    for (let i = 0; i < m.length; i++) {
      if (i < markers.length && (m[i].sample < -1e-9 || m[i].sample > duration + 1e-9)) return false;
      if (i === 0) continue;
      const db = m[i].beat - m[i - 1].beat;
      const ds = m[i].sample - m[i - 1].sample;
      if (!(db > 0 && ds > 0)) return false;
      const bpm = (60 * db) / ds;
      if (bpm < 5 || bpm > 999) return false;
    }
    return true;
  }

  addMarker(c, arg) {
    if (!c.warping) return this.fail('add_warp_marker: clip is not warped');
    let beat;
    let sample;
    if (arg instanceof MockDict) {
      beat = Number(arg.get('beat_time'));
      sample = arg.get('sample_time');
    } else if (arg && typeof arg === 'object' && this.o.addForm === 'object') {
      beat = Number(arg.beat_time);
      sample = arg.sample_time;
    } else {
      return this.fail('add_warp_marker: expects a dictionary');
    }
    if (!Number.isFinite(beat)) return this.fail('add_warp_marker: no beat_time');
    if (sample === undefined || sample === null) {
      sample = this.sampleAt(c, beat);
    } else {
      sample = Number(sample);
      if (!this.o.addHonoursBeat) beat = this.beatAt(c, sample);
    }
    // Live stores the beat a tiny bit differently from what it was given (seen in Live 12.4.6).
    if (beat !== 0) beat *= 1 + 1.68e-6;
    const markers = c.markers.concat([{ beat, sample }]).sort((x, y) => x.sample - y.sample);
    const last = markers[markers.length - 1];
    let hidden = c.hidden;
    if (last.beat === beat && last.sample === sample) hidden = after(last, segTempo(markers[markers.length - 2], last));
    if (!this.validMap(markers, hidden, c.duration)) return this.fail('add_warp_marker: invalid position');
    c.markers = markers;
    c.hidden = hidden;
    return undefined;
  }

  findMarker(c, beat) {
    if (this.o.markerMatch === 'zeroOnly') return beat === 0 ? c.markers.findIndex((m) => m.beat === 0) : -1;
    return c.markers.findIndex((m) => Math.abs(m.beat - beat) < 1e-12);
  }

  moveMarker(c, beat, distance) {
    const i = this.findMarker(c, beat);
    if (i < 0) return this.fail('move_warp_marker: no marker at ' + beat);
    const markers = c.markers.map((m) => Object.assign({}, m));
    markers[i].beat += distance;
    let hidden = c.hidden;
    if (i === markers.length - 1 && this.o.lastMoveShifts) hidden = { beat: hidden.beat + distance, sample: hidden.sample };
    if (!this.validMap(markers, hidden, c.duration)) return this.fail('move_warp_marker: invalid position');
    c.markers = markers;
    c.hidden = hidden;
    return undefined;
  }

  removeMarker(c, beat) {
    const i = this.findMarker(c, beat);
    if (i < 0) return this.fail('remove_warp_marker: no marker at ' + beat);
    if (c.markers.length === 1) return this.fail('remove_warp_marker: cannot remove the only marker');
    const markers = c.markers.filter((_, k) => k !== i);
    let hidden = c.hidden;
    // Removing the last visible marker: the part before it runs on.
    if (i === c.markers.length - 1) hidden = after(markers[markers.length - 1], segTempo(c.markers[i - 1], c.markers[i]));
    if (!this.validMap(markers, hidden, c.duration)) return this.fail('remove_warp_marker: invalid result');
    c.markers = markers;
    c.hidden = hidden;
    return undefined;
  }

  // ---- helpers for tests ----

  track(i) {
    return this.song.tracks[i];
  }

  // The tempo the clip plays the file at, between sample 0 and the end.
  clipTempo(c) {
    const b0 = this.beatAt(c, 0);
    const b1 = this.beatAt(c, Math.max(0, c.duration - 0.01));
    return (60 * (b1 - b0)) / Math.max(1e-9, c.duration - 0.01);
  }
}

// The hidden marker after a marker: 1/32 beat later, at the given tempo.
function after(m, tempo) {
  return { beat: m.beat + 1 / 32, sample: m.sample + (60 / 32) / tempo };
}

function segTempo(a, b) {
  return (60 * (b.beat - a.beat)) / (b.sample - a.sample);
}

// Clip gain 0..1 to the text Live shows. Not linear, like the real one.
function gainText(g) {
  if (g <= 0.0001) return '-inf dB';
  return (Math.log10(g) * 30 + 6).toFixed(1) + ' dB';
}

// Loads la2l-live.js into a fresh context with the fake LiveAPI.
// onOutlet(n, args) gets what the script sends out of its outlets.
function loadLiveScript(mock, onOutlet) {
  const src = fs.readFileSync(path.join(ROOT, 'src/live/la2l-live.js'), 'utf8');
  const ctx = {
    LiveAPI: mock.LiveAPI,
    Dict: MockDict,
    post: (s) => mock.posts.push(String(s).trim()),
    outlet: (n, ...args) => onOutlet(n, args),
    autowatch: 1,
    inlets: 1,
    outlets: 1,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'la2l-live.js' });
  return ctx;
}

// Runs the script synchronously: every requested step runs at once (after Live's pending changes).
// Returns { ctx, replies, request(obj) -> the final answer for that request }.
function syncLive(mock) {
  const replies = [];
  let steps = 0;
  let wantStep = false;
  const ctx = loadLiveScript(mock, (n, args) => {
    if (n === 0) replies.push(JSON.parse(args[1]));
    else wantStep = true;
  });
  const drive = () => {
    while (wantStep) {
      wantStep = false;
      if (++steps > 100000) throw new Error('too many steps');
      mock.tick();
      ctx.step();
    }
  };
  return {
    ctx,
    replies,
    init() {
      ctx.init();
      drive();
    },
    request(obj) {
      const start = replies.length;
      ctx.request(JSON.stringify(obj));
      drive();
      return replies.slice(start).find((r) => r.id === obj.id && (r.type === 'result' || r.type === 'info'));
    },
    logs() {
      return replies.filter((r) => r.type === 'log').map((r) => r.text);
    },
  };
}

module.exports = { MockLive, MockDict, loadLiveScript, syncLive, gainText };
