'use strict';
// Receives the body of a file upload into a file, while counting and hashing it. The body is
// never kept in memory, and never written past the size the package declared.

const fs = require('fs');
const crypto = require('crypto');
const { HttpError } = require('./http-util');

const TOO_LARGE = 'The file is larger than the package said.';
const FULL = 'The server is full. Try again later.';
// After a 413 the rest of the body is read and thrown away, so the client can read the answer
// (see readJson in http-util.js). A client that keeps sending far more is cut off.
const DISCARD_LIMIT = 16 * 1048576;

function discardRest(req) {
  let extra = 0;
  req.on('data', (chunk) => {
    extra += chunk.length;
    if (extra > DISCARD_LIMIT) req.socket.destroy();
  });
  req.resume();
}

// Streams the request body to `file` (made or replaced). Resolves to { bytes, sha256 } when the
// body is complete and the file is closed. Rejects with a 413 as soon as the body is larger
// than maxBytes, a 507 when the disk is full, a 400 when the client goes away; `file` is
// deleted then.
function receiveFile(req, file, maxBytes) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > maxBytes) {
      req.bytesIn = 0;
      discardRest(req);
      return reject(new HttpError(413, TOO_LARGE));
    }
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file);
    let size = 0;
    let done = false;

    const fail = (err) => {
      if (done) return;
      done = true;
      req.bytesIn = size;
      out.destroy();
      out.once('close', () => fs.rm(file, { force: true }, () => reject(err)));
    };

    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        discardRest(req);
        return fail(new HttpError(413, TOO_LARGE));
      }
      hash.update(chunk);
      if (!out.write(chunk)) {
        req.pause();
        out.once('drain', () => req.resume());
      }
    });
    req.on('end', () => {
      if (done) return;
      out.end();
    });
    // 'close' comes after everything is written and the file is closed, so the caller can read
    // and rename it at once.
    out.on('close', () => {
      if (done) return;
      done = true;
      req.bytesIn = size;
      resolve({ bytes: size, sha256: hash.digest('hex') });
    });
    out.on('error', (e) => fail(e.code === 'ENOSPC' || e.code === 'EDQUOT' ? new HttpError(507, FULL) : e));
    req.on('error', () => fail(new HttpError(400, 'The upload was broken off.')));
    req.on('close', () => {
      if (!req.complete) fail(new HttpError(400, 'The upload was broken off.'));
    });
  });
}

module.exports = { receiveFile, TOO_LARGE, FULL };
