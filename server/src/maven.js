'use strict';
// LA2L's own Maven repository at /la2l/maven/: nl.lloydstellar:la2l and nl.lloydstellar:la2l-ktx,
// the Android SDK of sdk/android. deploy/maven-sync.sh fills the folder MAVEN_DIR (in Docker the
// volume la2l-maven, which the server can only read) with every GitHub release android-v<version>,
// after checking its signatures. A file is read when it is asked for, so a sync needs no restart.
// Only the paths of the two libraries and of the public key can be asked for, a URL path never
// names anything else, and a link is never followed out of the folder.

const fs = require('fs');
const path = require('path');

// The public key, the maven-metadata.xml of a library with its checksums, and the files of one
// version of a library. A file name starts with a letter or a digit, so it is never "..".
const FILE = /^\/maven\/(signing-key\.asc|nl\/lloydstellar\/la2l(?:-ktx)?\/(?:maven-metadata\.xml(?:\.(?:md5|sha1|sha256|sha512))?|\d{1,4}\.\d{1,4}\.\d{1,4}\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}))$/;
const VERSIONED = /^nl\/lloydstellar\/[^/]+\/\d+\.\d+\.\d+\//;
const TYPES = {
  '.aar': 'application/octet-stream',
  '.jar': 'application/java-archive',
  '.pom': 'application/xml; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.module': 'application/json; charset=utf-8',
  '.asc': 'text/plain; charset=utf-8',
  '.md5': 'text/plain; charset=utf-8',
  '.sha1': 'text/plain; charset=utf-8',
  '.sha256': 'text/plain; charset=utf-8',
  '.sha512': 'text/plain; charset=utf-8',
};
// Far larger than a library; a bigger file is not one of ours.
const MAX_BYTES = 50 * 1048576;

// What /maven/ says once something is published.
const INDEX = Buffer.from(`LA2L's Maven repository: nl.lloydstellar:la2l and nl.lloydstellar:la2l-ktx, for Android.

In settings.gradle.kts, under repositories:
    maven { url = uri("https://lloydstellar.nl/la2l/maven/") }

How to use them: https://lloydstellar.nl/la2l/developers/android
Every file is signed with the key in https://lloydstellar.nl/la2l/maven/signing-key.asc
`);

class Maven {
  constructor(dir) {
    this.dir = dir ? path.resolve(dir) : null;
  }

  // Whether a URL path is a file this repository can have, for the route name in the log.
  static known(urlPath) {
    return urlPath === '/maven/' || FILE.test(urlPath);
  }

  // The file for a URL path: { body, type, cache, etag }, or null when there is none.
  async file(urlPath) {
    if (!this.dir) return null;
    if (urlPath === '/maven/') {
      if (!(await this.real(path.join(this.dir, 'nl', 'lloydstellar'), 'dir'))) return null;
      return { body: INDEX, type: 'text/plain; charset=utf-8', cache: 'no-cache', etag: '"maven-index-1"' };
    }
    const m = FILE.exec(urlPath);
    if (!m) return null;
    const type = TYPES[path.extname(m[1]).toLowerCase()];
    if (!type) return null;
    const file = path.join(this.dir, ...m[1].split('/'));
    const st = await this.real(file, 'file');
    if (!st || st.size > MAX_BYTES) return null;
    let body;
    try {
      body = await fs.promises.readFile(file);
    } catch (e) {
      return null;
    }
    // A version never changes once it is published; the metadata and the key can.
    const cache = VERSIONED.test(m[1]) ? 'public, max-age=31536000, immutable' : 'no-cache';
    return { body, type, cache, etag: `"${st.size}-${Math.floor(st.mtimeMs)}"` };
  }

  // The stat of a file or folder that really is inside the repository folder, or null.
  async real(p, kind) {
    try {
      const [resolved, root] = await Promise.all([fs.promises.realpath(p), fs.promises.realpath(this.dir)]);
      if (!resolved.startsWith(root + path.sep)) return null;
      const st = await fs.promises.stat(resolved);
      return (kind === 'dir' ? st.isDirectory() : st.isFile()) ? st : null;
    } catch (e) {
      return null;
    }
  }
}

module.exports = { Maven };
