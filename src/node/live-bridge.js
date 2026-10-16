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
