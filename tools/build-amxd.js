'use strict';
// Wraps a patch (JSON text) in the header of an unfrozen .amxd file:
//   'ampf', 4, device type ('aaaa' audio effect, 'mmmm' MIDI effect, 'iiii' instrument),
//   'meta', 4, 0, 'ptch', length, then the JSON in UTF-8 ending in a newline and a null byte.
// This is the format Lloyd's Sample Maker uses; Live 12.4 loads it.

const TYPES = { audio: 'aaaa', midi: 'mmmm', instrument: 'iiii' };

function amxd(jsonText, kind = 'audio') {
  JSON.parse(jsonText); // fail early on broken JSON
  const tag = TYPES[kind];
  if (!tag) throw new Error('Unknown device type ' + kind);
  const body = Buffer.concat([Buffer.from(jsonText.trimEnd(), 'utf8'), Buffer.from('\n\0', 'latin1')]);
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n, 0);
    return b;
  };
  return Buffer.concat([
    Buffer.from('ampf', 'latin1'),
    u32(4),
    Buffer.from(tag, 'latin1'),
    Buffer.from('meta', 'latin1'),
    u32(4),
    u32(0),
    Buffer.from('ptch', 'latin1'),
    u32(body.length),
    body,
  ]);
}

module.exports = { amxd };
