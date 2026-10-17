'use strict';
// The rules of a package's life that both sides of the API need: which status a package really
// has right now, and what an ack from the device may contain.
//
// A package is uploading until the app commits it; then it is waiting for the device. The ack
// makes it imported, partial or failed. A failed package stays in the inbox, so a later Import
// can still bring it in. Waiting and failed packages expire 24 hours after the upload. An app
// can delete its package (deleted) until it is in Live. Only uploading, waiting and failed
// packages have files on disk.

const { HttpError, cleanText } = require('./http-util');

const ACK_STATUSES = ['imported', 'partial', 'failed'];
const MAX_ACK_ITEMS = 64;
const MAX_ACK_TEXT = 200;

// The status of a package at `now` (ms). Rows only change when someone calls, so a package
// whose time ran out may still say waiting in the database; it counts as expired from that moment.
function statusAt(p, now, uploadTtlMs) {
  if ((p.status === 'waiting' || p.status === 'failed') && Date.parse(p.expires_at) <= now) return 'expired';
  if (p.status === 'uploading' && Date.parse(p.created_at) + uploadTtlMs <= now) return 'expired';
  return p.status;
}

// What the device may still download: its waiting and failed packages, until they expire.
const isOpen = (p, now) => (p.status === 'waiting' || p.status === 'failed') && Date.parse(p.expires_at) > now;

// The ack body as it is stored: the known fields only, at most 64 sounds, every text cut to 200
// characters. A wrong shape is a 400.
function cleanAck(body) {
  if (!ACK_STATUSES.includes(body.status)) throw new HttpError(400, 'The ack needs a status: imported, partial or failed.');
  if (body.items !== undefined && !Array.isArray(body.items)) throw new HttpError(400, 'The items of the ack must be a list.');
  const text = (v) => (typeof v === 'string' ? cleanText(v, MAX_ACK_TEXT) : undefined);
  const items = (body.items || [])
    .filter((it) => it !== null && typeof it === 'object' && !Array.isArray(it))
    .slice(0, MAX_ACK_ITEMS)
    .map((it) => {
      const item = {};
      for (const key of ['id', 'name', 'status', 'error']) {
        const v = text(it[key]);
        if (v !== undefined) item[key] = v;
      }
      return item;
    });
  const ack = { status: body.status, items };
  if (text(body.error)) ack.error = text(body.error);
  if (text(body.note)) ack.note = text(body.note);
  return ack;
}

module.exports = { statusAt, isOpen, cleanAck, MAX_ACK_ITEMS };
