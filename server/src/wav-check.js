'use strict';
// The WAV check of an upload: wav.readInfo from the device, in a worker thread. readInfo walks
// the chunks of the file one small read at a time. Until device 0.2.0 a file built of millions of
// empty chunks kept that walk busy for many seconds; now it stops after wav.MAX_CHUNKS. The thread
// stays as a second guard: on the main thread a slow check would hold up every other request, in
// a thread of its own it cannot, and after CHECK_MS the thread is stopped and the file refused.

const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const wav = require('../../src/node/wav');

const CHECK_MS = 10000;
const DAMAGED = 'The WAV header is damaged.';

// This same file is the worker.
if (!isMainThread && workerData && workerData.la2lWavCheck) {
  try {
    wav.readInfo(workerData.file);
    parentPort.postMessage({ ok: true });
  } catch (e) {
    parentPort.postMessage({ ok: false, wavError: e instanceof wav.WavError, message: String(e && e.message) });
  }
}

// Resolves when Live can use the file. Rejects with a WavError, whose message is for the app, or
// with another Error when the file could not be read at all.
function checkWav(file, timeoutMs = CHECK_MS) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { la2lWavCheck: true, file } });
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new wav.WavError(DAMAGED)), timeoutMs);
    worker.once('message', (m) => finish(m.ok ? null : m.wavError ? new wav.WavError(m.message) : new Error(m.message)));
    worker.once('error', (e) => finish(e));
    worker.once('exit', (code) => finish(new Error(`The WAV check stopped (exit code ${code}).`)));
  });
}

module.exports = { checkWav, CHECK_MS };
