'use strict';
// The package files on disk: DATA_DIR/packages/<package_id>/<file>. Every path is built from a
// package id the server made itself and, for a file, a name found in the files table of that
// package; never from a raw URL segment.

const fs = require('fs');
const path = require('path');

const PACKAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The file names docs/manifest.md allows: a letter or digit first, then letters, digits, space,
// "." "_" "-", ending in .wav, at most 100 characters, no "..". So a file can never be called
// "<another file>.part", and no name leads out of its package folder.
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/;
const isFileName = (name) => typeof name === 'string' && FILE_NAME.test(name) && /\.wav$/i.test(name) && !name.includes('..');

class Storage {
  constructor(dataDir) {
    this.root = path.join(dataDir, 'packages');
    fs.mkdirSync(this.root, { recursive: true });
  }

  packageDir(id) {
    if (!PACKAGE_ID.test(id)) throw new Error(`Not a package id: ${String(id).slice(0, 40)}`);
    return path.join(this.root, id);
  }

  makePackageDir(id) {
    fs.mkdirSync(this.packageDir(id), { recursive: true });
  }

  filePath(id, file) {
    if (!isFileName(file)) throw new Error(`Not a file name: ${String(file).slice(0, 40)}`);
    return path.join(this.packageDir(id), file);
  }

  // Where an upload is written until it is complete and checked.
  partPath(id, file) {
    return this.filePath(id, file) + '.part';
  }

  // Deletes the folder of a package with everything in it.
  removePackage(id) {
    fs.rmSync(this.packageDir(id), { recursive: true, force: true });
  }

  // Bytes the server may still write on this disk.
  freeBytes() {
    const s = fs.statfsSync(this.root);
    return s.bavail * s.bsize;
  }
}

module.exports = { Storage, PACKAGE_ID, isFileName };
