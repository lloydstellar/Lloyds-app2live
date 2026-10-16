'use strict';
// Small helpers for text: what goes to the Max interface, what becomes a track or file name,
// and how paths are written. Everything here is pure and tested in tests/text.test.js.

const fs = require('fs');
const path = require('path');

// ---- text for the Max interface ----

// Max gives some characters a meaning in messages (comma, semicolon, backslash, quotes,
// dollar, braces). Display text never needs them, so they are dropped.
function cleanDisplay(text) {
  return String(text == null ? '' : text)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[,;\\"$`{}[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Display text goes to Max as separate words. A single symbol with spaces would be
// shown with quotes around it in a comment.
function words(text) {
  const t = cleanDisplay(text);
  return t ? t.split(' ') : [];
}

// ---- names from a manifest ----

function limit(s, maxLen) {
  return s.length > maxLen ? s.slice(0, maxLen).trim() : s;
}

// Track and clip names: letters and digits of any language, plus a few safe signs.
function cleanName(name, fallback, maxLen = 60) {
  const s = String(name == null ? '' : name)
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} _\-().'&+#!]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return limit(s, maxLen) || fallback;
}

// File and folder names: only letters, digits, space, - and _. Never a dot, slash or '..',
// so a name from a manifest can never point somewhere else on the disk.
function cleanFileName(name, fallback, maxLen = 60) {
  let s = String(name == null ? '' : name)
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} _-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = limit(s, maxLen);
  // Names that Windows reserves for devices.
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = '_' + s;
  return s || fallback;
}

// ---- paths ----

// Max reads a backslash as an escape sign, so paths go to Max with forward slashes.
const fwd = (p) => String(p).replace(/\\/g, '/');

// On a Mac, Max writes paths as "Macintosh HD:/Users/...". Node and Live want "/Users/...".
const nativePath = (p) => String(p).replace(/^[^/:\\]{2,}:\//, '/');

// A path in a folder that does not exist yet: "Kick.wav", then "Kick 2.wav", "Kick 3.wav", ...
function uniquePath(dir, base, ext) {
  for (let n = 1; n < 1000; n++) {
    const file = path.join(dir, (n === 1 ? base : `${base} ${n}`) + ext);
    if (!fs.existsSync(file)) return file;
  }
  throw new Error('Too many files called ' + base + ext);
}

// ---- time ----

const pad2 = (n) => String(n).padStart(2, '0');

// "2026-10-16 1530", used in folder names so they sort by time.
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

// 581 seconds -> "9:41"
function clock(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

// ---- numbers and lists ----

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || one + 's'}`;
}

// 135 -> "135", 92.5 -> "92.5", 120.0004 -> "120"
function bpmText(bpm) {
  return String(Math.round(bpm * 100) / 100);
}

function megabytes(bytes) {
  return (bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0) + ' MB';
}

module.exports = {
  cleanDisplay,
  words,
  cleanName,
  cleanFileName,
  fwd,
  nativePath,
  uniquePath,
  stamp,
  clock,
  plural,
  bpmText,
  megabytes,
};
