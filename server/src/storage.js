'use strict';
// The package files on disk: DATA_DIR/packages/<package_id>/<file>. Every path is built from a
// package id the server made itself and, for a file, a name found in the files table of that
// package; never from a raw URL segment.

const fs = require('fs');
const path = require('path');

const PACKAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class Storage {
  constructor(dataDir) {
    this.root = path.join(dataDir, 'packages');
    fs.mkdirSync(this.root, { recursive: true });
  }

  packageDir(id) {
    if (!PACKAGE_ID.test(id)) throw new Error(`Not a package id: ${String(id).slice(0, 40)}`);
    return path.join(this.root, id);
  }

  // Deletes the folder of a package with everything in it.
  removePackage(id) {
    fs.rmSync(this.packageDir(id), { recursive: true, force: true });
  }
}

module.exports = { Storage, PACKAGE_ID };
