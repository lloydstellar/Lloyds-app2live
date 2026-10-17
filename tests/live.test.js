'use strict';
// Tests of the Live part (src/live/la2l-live.js) against the fake Live in mock-live.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MockLive, syncLive } = require('./mock-live');
const { writeTestLoop } = require('../src/node/testsound');
const { writeWav16 } = require('../src/node/wav');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la2l-live-'));
const loopFile = path.join(dir, 'Snare.wav');
writeTestLoop(loopFile, 135); // one bar at 135 BPM: 1.7778 s
const shotFile = path.join(dir, 'Robot hallo.wav');
writeWav16(shotFile, new Float32Array(22050).map((_, i) => Math.sin(i / 10) * 0.5), 1, 44100);

let nextId = 1;
function item(o = {}) {
  return Object.assign(
    {
      index: 0,
      name: 'Snare',
      trackName: 'Snare (LA2L test)',
      clipName: 'Snare',
      path: loopFile,
      altPath: loopFile.replace(/\\/g, '/'),
      folder: dir,
      duration: 1.7777777,
      warp: true,
      warpMode: 0,
      looping: true,
      bpm: 135,
      lengthBeats: 4,
      color: 0xff94a6,
      gainDb: null,
    },
    o
  );
}

function importReq(items, o = {}) {
  return Object.assign({ id: nextId++, type: 'import', title: 'LA2L test', app: 'LA2L test', sceneName: 'LA2L test (LA2L test)', placement: 'arrangement', newTracks: 'afterDevice', trackOffset: 0, items }, o);
}

function setup(opts) {
  const mock = new MockLive(opts);
  const live = syncLive(mock);
  live.init();
  return { mock, live };
}

test('getinfo waits for init and then answers', () => {
  const mock = new MockLive({ filePath: '/Users/erik/Music/Song Project/Song.als' });
  const live = syncLive(mock);
  const before = live.request({ id: 1, type: 'getinfo' });
  assert.equal(before, undefined, 'no answer before live.thisdevice');
  live.init();
  const info = live.replies.find((r) => r.type === 'info');
  assert.ok(info, 'answered after init');
  assert.deepEqual(info.info.live, { major: 12, minor: 4, bugfix: 6 });
  assert.equal(info.info.set.tempo, 120);
  assert.equal(info.info.set.path, '/Users/erik/Music/Song Project/Song.als');
  assert.equal(info.info.device.trackIndex, 1);
  assert.equal(info.info.device.trackName, '2-Audio');
});

// Every combination of what Live may do. The defaults (unwarped, zeroOnly) are what Live 12.4.6 did.
for (const addHonoursBeat of [true, false]) {
  for (const markerMatch of ['zeroOnly', 'exact']) {
    for (const initialWarp of ['unwarped', 'loopwarp', 'autowarp']) {
      for (const errors of ['silent', 'throw']) {
        const opts = { addHonoursBeat, markerMatch, initialWarp, errors };
        test(`loop at 135 BPM in the Arrangement (${JSON.stringify(opts)})`, () => {
          const { mock, live } = setup(opts);
          const res = live.request(importReq([item()]));
          assert.ok(res.ok, JSON.stringify(res));
          const tr = res.tracks[0];
          assert.equal(tr.ok, true);
          assert.equal(tr.trackIndex, 2, 'right after the device track');
          const track = mock.track(2);
          assert.equal(track.name, 'Snare (LA2L test)');
          assert.equal(track.color, 0xff94a6);
          assert.equal(track.slots[0].clip, null, 'the temporary Session clip is gone');
          assert.equal(track.arrangement.length, 1);
          const clip = track.arrangement[0];
          assert.equal(clip.startTime, 0, 'at 1.1.1, although the playhead is at beat 9.3');
          assert.equal(clip.warping, 1);
          assert.equal(clip.warpMode, 0);
          assert.equal(clip.looping, 1);
          assert.equal(clip.name, 'Snare');
          assert.equal(mock.view.selectedTrack, track.id);
          assert.equal(mock.view.detailClip, clip.id);
          if (initialWarp === 'autowarp' && markerMatch === 'zeroOnly') {
            // Live's own markers cannot be removed then: placed and looped, tempo as close as it gets.
            assert.equal(tr.report.tempo, 'approximate');
            return;
          }
          assert.ok(Math.abs(mock.clipTempo(clip) - 135) < 0.01, `tempo ${mock.clipTempo(clip)}`);
          assert.match(tr.report.tempo, addHonoursBeat || initialWarp === 'autowarp' ? /^exact/ : /^exact \(first marker\)$/);
          assert.ok(Math.abs(clip.loopEnd - clip.loopStart - 4) < 1e-6, `loop ${clip.loopStart}..${clip.loopEnd}`);
          assert.ok(Math.abs(clip.endTime - clip.startTime - 4) < 1e-6, 'one bar long in the Arrangement');
          // The loop starts where sample 0 is.
          assert.ok(Math.abs(mock.beatAt(clip, 0) - clip.loopStart) < 1e-6);
          if (addHonoursBeat) assert.ok(Math.abs(clip.loopStart) < 1e-6, 'starts on beat 0');
        });
      }
    }
  }
}

// The first real test: Set at 120 BPM, a long recording at 135 BPM. Live 12.4.6 gave
// "approximate, 150.15 BPM" with version 0.1.0.
for (const addHonoursBeat of [true, false]) {
  test(`a long recording at 135 BPM in a Set at 120 BPM (marker placed as given: ${addHonoursBeat})`, () => {
    const file = path.join(dir, 'Long snare.wav');
    writeTestLoop(file, 135, 32); // 8 bars, 14.2 s
    const { mock, live } = setup({ tempo: 120, addHonoursBeat });
    const res = live.request(importReq([item({ path: file, altPath: file, duration: (32 * 60) / 135, lengthBeats: 32 })]));
    const tr = res.tracks[0];
    assert.ok(tr.ok, JSON.stringify(res));
    const clip = mock.track(2).arrangement[0];
    assert.ok(Math.abs(mock.clipTempo(clip) - 135) < 0.01, `tempo ${mock.clipTempo(clip)}`);
    assert.ok(Math.abs(tr.report.bpm - 135) < 0.01, 'the clip view shows 135');
    assert.equal(tr.report.tempo, addHonoursBeat ? 'exact (end marker)' : 'exact (first marker)');
    assert.ok(Math.abs(clip.loopEnd - clip.loopStart - 32) < 1e-6);
    assert.ok(Math.abs(mock.beatAt(clip, 0) - clip.loopStart) < 1e-6, 'the loop starts at the start of the file');
    // The end of the file falls on the end of the loop.
    assert.ok(Math.abs(mock.beatAt(clip, clip.duration) - clip.loopEnd) < 0.01);
    if (addHonoursBeat) {
      assert.equal(clip.markers[0].beat, 0, 'first marker stays at 1.1.1');
      assert.equal(clip.markers.length, 2, 'one marker added, near the end');
    }
  });
}

test('one-shot: warp and loop off, even when Live warped it', () => {
  const { mock, live } = setup({ initialWarp: 'loopwarp' });
  const res = live.request(importReq([item({ name: 'Robot hallo', trackName: 'Robot hallo (Voicy)', path: shotFile, altPath: shotFile, duration: 0.5, warp: false, looping: false, warpMode: null, bpm: null, lengthBeats: null })]));
  assert.ok(res.ok);
  const clip = mock.track(2).arrangement[0];
  assert.equal(clip.warping, 0);
  assert.equal(clip.looping, 0);
});

test('Session: a new scene at the top, named after the package, clips in that scene', () => {
  const { mock, live } = setup({});
  mock.song.scenes[0].name = 'Old first scene';
  const res = live.request(importReq([item(), item({ index: 1, name: 'Kick', trackName: 'Kick (LA2L test)' })], { placement: 'session' }));
  assert.ok(res.ok);
  assert.equal(mock.song.scenes.length, 3);
  assert.equal(mock.song.scenes[0].name, 'LA2L test (LA2L test)');
  assert.equal(mock.song.scenes[1].name, 'Old first scene', 'the other scenes move down');
  assert.equal(mock.track(2).name, 'Snare (LA2L test)');
  assert.equal(mock.track(3).name, 'Kick (LA2L test)');
  for (const t of [2, 3]) {
    assert.ok(mock.track(t).slots[0].clip, 'clip in the new scene');
    assert.ok(Math.abs(mock.clipTempo(mock.track(t).slots[0].clip) - 135) < 0.01);
    assert.equal(mock.track(t).arrangement.length, 0);
  }
  assert.equal(res.sceneIndex, 0);
});

test('Session: when no sound goes in, the new scene is removed again', () => {
  const { mock, live } = setup({});
  mock.song.scenes[0].name = 'Old first scene';
  const missing = path.join(dir, 'missing.wav');
  const res = live.request(importReq([item({ path: missing, altPath: missing })], { placement: 'session' }));
  assert.equal(res.ok, false);
  assert.equal(res.sceneIndex, -1);
  assert.deepEqual(mock.song.scenes.map((sc) => sc.name), ['Old first scene', '']);
  assert.ok(mock.song.tracks.every((t) => t.slots.length === 2));
});

test('tracks keep the order of the package, trackOffset moves the next package down', () => {
  const { mock, live } = setup({});
  live.request(importReq([item({ trackName: 'A' }), item({ index: 1, trackName: 'B' }), item({ index: 2, trackName: 'C' })]));
  live.request(importReq([item({ trackName: 'D' })], { trackOffset: 3 }));
  assert.deepEqual(mock.song.tracks.map((t) => t.name), ['1-Audio', '2-Audio', 'A', 'B', 'C', 'D', '3-Audio']);
});

test('new tracks at the end, and at the end when the device is on the master track', () => {
  let { mock, live } = setup({});
  live.request(importReq([item({ trackName: 'X' })], { newTracks: 'end' }));
  assert.equal(mock.song.tracks[3].name, 'X');
  ({ mock, live } = setup({ deviceTrack: -1 }));
  live.request(importReq([item({ trackName: 'Y' })]));
  assert.equal(mock.song.tracks[3].name, 'Y');
});

test('on a group track, new tracks go to the top of that group, and a folded group is unfolded', () => {
  // Tracks: 0 1-Audio, 1 the group with LA2L on it, 2 and 3 in the group, 4 4-Audio.
  for (const folded of [0, 1]) {
    const { mock, live } = setup({ tracks: 5, deviceTrack: 1, groups: [{ at: 1, size: 2, folded }] });
    const group = mock.song.tracks[1];
    const res = live.request(importReq([item({ trackName: 'A' }), item({ index: 1, trackName: 'B' })]));
    assert.ok(res.ok, JSON.stringify(res));
    assert.deepEqual(mock.song.tracks.map((t) => t.name), ['1-Audio', '2-Group', 'A', 'B', '3-Audio', '4-Audio', '5-Audio']);
    assert.equal(mock.song.tracks[2].group, group);
    assert.equal(mock.song.tracks[3].group, group);
    assert.equal(group.folded, 0, 'the new tracks can be seen');
    assert.equal(live.logs().some((l) => /Unfolded group "2-Group"/.test(l)), folded === 1);
    assert.ok(live.logs().some((l) => /Snare: placed on track 2 in group "2-Group"/.test(l)));
    assert.ok(live.logs().some((l) => /Device: live_set tracks 1 devices 0/.test(l)));
  }
});

test('a group inside a folded group: both are unfolded; on the master, new tracks stay out of groups', () => {
  // Tracks: 0 the outer group, 1 the inner group with LA2L on it, 2 in the inner group, 3 in the outer one.
  let { mock, live } = setup({ tracks: 4, deviceTrack: 1, groups: [{ at: 0, size: 3, folded: 1 }, { at: 1, size: 1, folded: 1 }] });
  live.request(importReq([item({ trackName: 'A' })]));
  assert.equal(mock.song.tracks[2].name, 'A');
  assert.equal(mock.song.tracks[2].group, mock.song.tracks[1]);
  assert.equal(mock.song.tracks[1].folded, 0);
  assert.equal(mock.song.tracks[0].folded, 0);
  // LA2L on the master of a Set that ends with a folded group: the new track goes at the end.
  ({ mock, live } = setup({ tracks: 3, deviceTrack: -1, groups: [{ at: 1, size: 1, folded: 1 }] }));
  live.request(importReq([item({ trackName: 'Y' })]));
  assert.equal(mock.song.tracks[3].name, 'Y');
  assert.equal(mock.song.tracks[3].group, undefined);
  assert.equal(mock.song.tracks[1].folded, 1, 'a group the new tracks are not in stays folded');
  assert.ok(live.logs().some((l) => /Device: live_set master_track devices 0/.test(l)));
});

test('a path with backslashes that Live refuses is retried with forward slashes', () => {
  const { mock, live } = setup({ paths: 'forward' });
  const winStyle = loopFile.replace(/\//g, '\\');
  const res = live.request(importReq([item({ path: winStyle, altPath: loopFile })]));
  assert.ok(res.ok, JSON.stringify(res));
  assert.ok(live.logs().some((l) => /path form 2/.test(l)));
  assert.ok(mock.errors.some((e) => /invalid path/.test(e)));
});

test('a file Live cannot load: the empty track is removed, the other sounds still go in', () => {
  for (const errors of ['silent', 'throw']) {
    const { mock, live } = setup({ errors });
    const missing = path.join(dir, 'missing.wav');
    const res = live.request(importReq([item({ trackName: 'Bad', path: missing, altPath: missing }), item({ index: 1, trackName: 'Good' })]));
    assert.equal(res.ok, true);
    assert.equal(res.tracks[0].ok, false);
    assert.match(res.tracks[0].error, /could not load/);
    assert.equal(res.tracks[1].ok, true);
    assert.deepEqual(mock.song.tracks.map((t) => t.name), ['1-Audio', '2-Audio', 'Good', '3-Audio']);
  }
});

test('other argument forms: "id n" for duplicate, Dict for add_warp_marker, marker JSON in an array', () => {
  const { mock, live } = setup({ dupForm: 'string', addForm: 'dict', markerFormat: 'array1' });
  const res = live.request(importReq([item()]));
  assert.ok(res.ok, JSON.stringify(res));
  const clip = mock.track(2).arrangement[0];
  assert.ok(clip, 'copied to the Arrangement with the second form');
  assert.equal(mock.track(2).arrangement.length, 1);
  assert.ok(Math.abs(mock.clipTempo(clip) - 135) < 0.05);
  assert.ok(live.logs().some((l) => /duplicate_clip_to_arrangement worked with form 2/.test(l)));
  assert.ok(live.logs().some((l) => /add_warp_marker worked with form 3/.test(l)));
});

test('the Arrangement copy is made once, also when Live gives back less than expected', () => {
  for (const opts of [{ dupReturns: 'nothing' }, { arrangementList: 'unreadable' }, { dupReturns: 'nothing', arrangementList: 'unreadable' }]) {
    const { mock, live } = setup(opts);
    const res = live.request(importReq([item()]));
    assert.ok(res.ok, JSON.stringify(opts));
    assert.equal(mock.track(2).arrangement.length, 1, 'one copy with ' + JSON.stringify(opts));
    assert.equal(mock.track(2).slots[0].clip, null, 'Session clip removed with ' + JSON.stringify(opts));
    assert.equal(res.tracks[0].report.arrangement, true);
    if (opts.arrangementList !== 'unreadable' || !opts.dupReturns) assert.equal(res.tracks[0].clipId, mock.track(2).arrangement[0].id);
  }
});

test('warp markers given back as an object', () => {
  const { mock, live } = setup({ markerFormat: 'object' });
  const res = live.request(importReq([item()]));
  assert.ok(res.ok);
  assert.ok(Math.abs(mock.clipTempo(mock.track(2).arrangement[0]) - 135) < 0.05);
});

test('when the Arrangement copy fails, the clip stays in the Session slot', () => {
  const { mock, live } = setup({ dupForm: 'none' });
  const res = live.request(importReq([item()]));
  assert.ok(res.ok);
  assert.equal(res.tracks[0].report.arrangement, false);
  assert.ok(mock.track(2).slots[0].clip, 'still in the slot');
});

test('gain_db is found through the display text', () => {
  const { mock, live } = setup({});
  live.request(importReq([item({ gainDb: -6 })]));
  const clip = mock.track(2).arrangement[0];
  const shown = (Math.log10(clip.gain) * 30 + 6);
  assert.ok(Math.abs(shown - -6) < 0.05, `gain shows ${shown}`);
});

test('a loop without tempo is warped and looped as Live sees it', () => {
  const { mock, live } = setup({});
  const res = live.request(importReq([item({ bpm: null, lengthBeats: null })]));
  assert.ok(res.ok);
  const clip = mock.track(2).arrangement[0];
  assert.equal(clip.warping, 1);
  assert.equal(res.tracks[0].report.tempo, 'not given');
});

test('settempo changes the Set tempo', () => {
  const { mock, live } = setup({});
  const r = live.request({ id: 99, type: 'settempo', bpm: 135 });
  assert.equal(r.ok, true);
  assert.equal(mock.song.tempo, 135);
});

test('progress for every sound, and an unknown request gets an error', () => {
  const { live } = setup({});
  const req = importReq([item(), item({ index: 1 })]);
  live.request(req);
  const progress = live.replies.filter((r) => r.type === 'progress' && r.id === req.id);
  assert.deepEqual(progress.map((p) => p.done), [1, 2]);
  const r = live.request({ id: 500, type: 'dance' });
  assert.equal(r.ok, false);
});

test('imports queue up: the second starts when the first is done', () => {
  const mock = new MockLive({});
  const live = syncLive(mock);
  live.init();
  // Two requests without driving the steps in between.
  const a = importReq([item({ trackName: 'A' })]);
  const b = importReq([item({ trackName: 'B' })], { trackOffset: 1 });
  live.ctx.request(JSON.stringify(a));
  live.ctx.request(JSON.stringify(b));
  const ra = live.request({ id: 777, type: 'getinfo' }); // drives the steps
  assert.ok(ra);
  const results = live.replies.filter((r) => r.type === 'result');
  assert.deepEqual(results.map((r) => r.id), [a.id, b.id]);
  assert.deepEqual(mock.song.tracks.map((t) => t.name).slice(2, 4), ['A', 'B']);
});
