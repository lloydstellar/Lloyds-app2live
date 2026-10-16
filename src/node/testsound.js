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
