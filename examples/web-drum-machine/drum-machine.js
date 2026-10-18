// Web808: a drum machine of four sounds and sixteen steps that sends its beat to Ableton Live with
// LA2L: the one-bar loop, and each sound as a one-shot. The sounds are made here, in code, so the
// page needs no sample files. The loop is rendered with an OfflineAudioContext; the button turns it
// into a WAV file and sends it.

// The button and its WAV helpers. In your own page: from jsDelivr, or import 'la2l/button'.
import { wavFromAudioBuffer, wavFromSamples } from '../../vendor/la2l-button.js';

const RATE = 48000;
const STEPS = 16;

// A noise of its own, the same on every load.
function noise(seed) {
  let x = seed;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) / 4294967296) * 2 - 1;
  };
}

// ---- the four sounds, as samples from -1 to 1 ----

function kick() {
  const out = new Float32Array(Math.round(RATE * 0.5));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    phase += (2 * Math.PI * (45 + 105 * Math.exp(-t * 30))) / RATE;
    out[i] = Math.sin(phase) * Math.exp(-t * 6) * 0.9;
  }
  return out;
}

function snare() {
  const out = new Float32Array(Math.round(RATE * 0.3));
  const n = noise(7);
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    out[i] = n() * Math.exp(-t * 20) * 0.45 + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 25) * 0.4;
  }
  return out;
}

function hat() {
  const out = new Float32Array(Math.round(RATE * 0.08));
  const n = noise(11);
  let last = 0;
  for (let i = 0; i < out.length; i++) {
    const x = n();
    out[i] = (x - last) * Math.exp((-i / RATE) * 60) * 0.3; // the difference keeps the high part
    last = x;
  }
  return out;
}

function clap() {
  const out = new Float32Array(Math.round(RATE * 0.25));
  const n = noise(23);
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const burst = [0, 0.01, 0.02].reduce((a, s) => a + (t >= s ? Math.exp(-(t - s) * 180) : 0), 0);
    out[i] = n() * (burst * 0.4 + Math.exp(-t * 25) * 0.25);
  }
  return out;
}

const SOUNDS = [
  { id: 'kick', name: 'Kick', samples: kick(), steps: [0, 4, 8, 10] },
  { id: 'snare', name: 'Snare', samples: snare(), steps: [4, 12] },
  { id: 'hat', name: 'Hat', samples: hat(), steps: [0, 2, 4, 6, 8, 10, 12, 14] },
  { id: 'clap', name: 'Clap', samples: clap(), steps: [12] },
];

// ---- the pattern ----

const pattern = Object.fromEntries(SOUNDS.map((s) => [s.id, Array.from({ length: STEPS }, (_, i) => s.steps.includes(i))]));
const grid = document.getElementById('grid');
const cells = [];

for (const s of SOUNDS) {
  const row = document.createElement('div');
  row.className = 'row';
  row.append(Object.assign(document.createElement('span'), { textContent: s.name }));
  for (let i = 0; i < STEPS; i++) {
    const step = Object.assign(document.createElement('button'), { type: 'button', className: i % 4 === 0 ? 'step beat' : 'step' });
    step.setAttribute('aria-label', `${s.name}, step ${i + 1}`);
    step.setAttribute('aria-pressed', String(pattern[s.id][i]));
    step.addEventListener('click', () => {
      pattern[s.id][i] = !pattern[s.id][i];
      step.setAttribute('aria-pressed', String(pattern[s.id][i]));
      changed();
    });
    row.append(step);
    cells[i] = (cells[i] || []).concat(step);
  }
  grid.append(row);
}

const bpmField = document.getElementById('bpm');
const bpm = () => Math.min(200, Math.max(60, Math.round(Number(bpmField.value) || 120)));
bpmField.addEventListener('change', () => {
  bpmField.value = String(bpm());
  changed();
});

// ---- the loop: one bar, rendered offline ----

// Exactly one bar of four beats. What still rings at the end of the bar (a kick on the last
// step) is folded back to its start, as it would sound when the loop plays again: no click and
// no cut at the seam.
async function renderLoop(tempo) {
  const step = 60 / tempo / 4;
  const bar = Math.round(RATE * step * STEPS);
  const tail = Math.max(...SOUNDS.map((s) => s.samples.length));
  const context = new OfflineAudioContext(2, bar + tail, RATE);
  for (const s of SOUNDS) {
    const buffer = context.createBuffer(1, s.samples.length, RATE);
    buffer.copyToChannel(s.samples, 0);
    pattern[s.id].forEach((on, i) => {
      if (!on) return;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.start(i * step);
    });
  }
  const rendered = await context.startRendering();
  const loop = new AudioBuffer({ numberOfChannels: 2, length: bar, sampleRate: RATE });
  for (let c = 0; c < 2; c++) {
    const from = rendered.getChannelData(c);
    const to = loop.getChannelData(c);
    to.set(from.subarray(0, bar));
    for (let i = bar; i < from.length; i++) to[(i - bar) % bar] += from[i];
  }
  return loop;
}

// ---- playing ----

let audio = null; // { context, source, startedAt, step }
const playButton = document.getElementById('play');

async function play() {
  stop();
  const context = new AudioContext();
  const tempo = bpm();
  const loop = await renderLoop(tempo);
  const source = context.createBufferSource();
  source.buffer = loop;
  source.loop = true;
  source.connect(context.destination);
  source.start();
  audio = { context, source, startedAt: context.currentTime, step: 60 / tempo / 4 };
  playButton.textContent = 'Stop';
  playButton.setAttribute('aria-pressed', 'true');
  requestAnimationFrame(showStep);
}

function stop() {
  if (!audio) return;
  audio.source.stop();
  audio.context.close();
  audio = null;
  playButton.textContent = 'Play';
  playButton.setAttribute('aria-pressed', 'false');
  for (const column of cells) for (const c of column) c.classList.remove('now');
}

function showStep() {
  if (!audio) return;
  const now = Math.floor((audio.context.currentTime - audio.startedAt) / audio.step) % STEPS;
  cells.forEach((column, i) => column.forEach((c) => c.classList.toggle('now', i === now)));
  requestAnimationFrame(showStep);
}

function changed() {
  if (audio) play();
}

playButton.addEventListener('click', () => (audio ? stop() : play()));

// ---- sending: what the Send to Live button gets when it is clicked ----

document.getElementById('send').sounds = async () => {
  const tempo = bpm();
  const used = SOUNDS.filter((s) => pattern[s.id].some(Boolean));
  if (!used.length) return [];
  const loop = await renderLoop(tempo);
  return {
    title: `Web808 beat at ${tempo} BPM`,
    bpm: tempo,
    sounds: [
      // The loop: warped to the tempo, so it plays in time at any tempo of the Set.
      { name: 'Beat', audio: wavFromAudioBuffer(loop), kind: 'loop', role: 'drums', lengthBeats: 4 },
      // Every sound of the pattern as a one-shot, which plays as it is.
      ...used.map((s) => ({ name: s.name, audio: wavFromSamples(s.samples, RATE), kind: 'oneshot', role: 'drums' })),
    ],
  };
};
