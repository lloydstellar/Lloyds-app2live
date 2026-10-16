'use strict';
// Tokens, pair ids and pairing codes, all from the operating system's secure random source.
// The database keeps only sha256 hashes of tokens and pair ids.

const crypto = require('crypto');

// A to Z without I and O, and 2 to 9: no mix-up of 0 and O or 1 and I when a code is read off a
// screen. 32 characters, 6 of them: about a billion codes.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

// 32 random bytes in base64url: 43 characters. The prefix shows at a glance which kind of token
// it is, also when one turns up where it should not be.
const random = () => crypto.randomBytes(32).toString('base64url');
const newDeviceToken = () => 'la2ld_' + random();
const newAppToken = () => 'la2la_' + random();
const newPairId = () => random();

function newCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// The token in "Authorization: Bearer <token>", or null. Anything else counts as no token.
function bearer(header) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(typeof header === 'string' ? header : '');
  return m ? m[1] : null;
}

// A code as someone typed it: "k7p 42q" and "K7P-42Q" both become "K7P42Q". Null when it
// cannot be a code at all.
function normalizeCode(text) {
  if (typeof text !== 'string') return null;
  const code = text.toUpperCase().replace(/[\s-]/g, '');
  return CODE_RE.test(code) ? code : null;
}

module.exports = { CODE_ALPHABET, newDeviceToken, newAppToken, newPairId, newCode, sha256, bearer, normalizeCode };
