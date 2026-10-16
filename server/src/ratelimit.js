'use strict';
// Rate limits: a sliding window per key (an address, an app or a token), kept in memory. A
// restart forgets them, which is fine: they are there to slow down code guessing and runaway
// clients, not to count anything.

const { HttpError } = require('./http-util');

class Window {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map(); // key -> times of the hits in the window, oldest first
  }

  // Counts a hit. Returns 0 when it may go ahead, otherwise the seconds until it may.
  take(key, now) {
    let list = this.hits.get(key);
    if (!list) {
      list = [];
      this.hits.set(key, list);
    }
    while (list.length && list[0] <= now - this.windowMs) list.shift();
    if (list.length >= this.limit) return Math.max(1, Math.ceil((list[0] + this.windowMs - now) / 1000));
    list.push(now);
    return 0;
  }

  // Forgets the keys that had no hit within the window.
  sweep(now) {
    for (const [key, list] of this.hits) {
      if (!list.length || list[list.length - 1] <= now - this.windowMs) this.hits.delete(key);
    }
  }
}

// The limits of the brief (section 10.2), with the text a client gets on a 429.
const LIMITS = {
  pairStart: [20, 10 * 60000, 'Too many codes asked. Wait a few minutes.'],
  pairStatus: [120, 60000, 'Too many requests. Wait a minute.'],
  claim: [10, 60000, 'Too many tries. Wait a minute and try again.'],
  packages: [30, 3600000, 'Too many packages in an hour. Wait a while.'],
  token: [600, 60000, 'Too many requests. Wait a minute.'],
};

class RateLimits {
  // enabled false (RATE_LIMITS=off) lets everything through; only for tests.
  constructor(enabled, clock) {
    this.enabled = enabled;
    this.clock = clock;
    this.windows = {};
    for (const [name, [limit, windowMs, message]] of Object.entries(LIMITS)) {
      this.windows[name] = { window: new Window(limit, windowMs), message };
    }
  }

  // Throws a 429 with Retry-After when `key` is over the limit `name`.
  check(name, key) {
    if (!this.enabled) return;
    const { window, message } = this.windows[name];
    const wait = window.take(key, this.clock());
    if (wait) throw new HttpError(429, message, { 'Retry-After': String(wait) });
  }

  sweep() {
    const now = this.clock();
    for (const { window } of Object.values(this.windows)) window.sweep(now);
  }
}

// The key for an address: IPv4 as it is, IPv6 by its /64 network. A home or a phone gets a whole
// /64 and could otherwise use a new address for every request.
function ipKey(ip) {
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('::');
  const front = head ? head.split(':') : [];
  const back = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? front.concat(Array(Math.max(0, 8 - front.length - back.length)).fill('0'), back) : front;
  return groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':') + '::/64';
}

module.exports = { RateLimits, Window, ipKey, LIMITS };
