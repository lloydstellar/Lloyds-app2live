// Reads the files out of a ZIP archive in the browser, without a library: n-Track and other music
// apps export stems as a ZIP of WAV files. Stored and deflated entries; deflated ones go through
// DecompressionStream('deflate-raw'), in Chrome 103 and newer. Not ZIP64 (over 4 GB) and not
// encrypted archives. Every entry is held to its size and its CRC-32 while it is unpacked, so a
// small archive that would unpack to gigabytes stops at once. Runs in Node.js too, for the tests.

const END = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** One sound of a package is at most 200 MB, and an archive gives at most this many files, and bytes. */
export const LIMITS = { entryBytes: 200 * 1048576, entries: 256, totalBytes: 1024 * 1048576 };

const damaged = () => new Error('This ZIP file is damaged.');
const tooLarge = () => new Error('This ZIP file is too large to read here. Unpack it and share the WAV files.');

async function view(blob, start, end) {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

// Names without the UTF-8 flag are in code page 437, as old ZIP tools write them.
const CP437 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
function nameOf(bytes, utf8) {
  if (utf8) return new TextDecoder().decode(bytes);
  let s = '';
  for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : CP437[b - 0x80];
  return s;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

// The bytes of one entry as they come out: counted, so more than it said stops it, and checked
// against its CRC-32 at the end.
function guarded(name, length, crc) {
  let seen = 0;
  let c = 0xffffffff;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.length;
      if (seen > length) throw new Error(`${name} in the ZIP file is damaged.`);
      for (let i = 0; i < chunk.length; i++) c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
      controller.enqueue(chunk);
    },
    flush() {
      if (seen !== length || (c ^ 0xffffffff) >>> 0 !== crc) throw new Error(`${name} in the ZIP file is damaged.`);
    },
  });
}

/**
 * The files in a ZIP archive whose names `keep` accepts, as File objects named without their
 * folder. Folders, macOS leftovers (__MACOSX/, ._name) and hidden files are left out.
 * Resolves to { files, skipped }: skipped holds the names `keep` turned down.
 */
export async function readZip(blob, keep = () => true) {
  // The end record is in the last 22 bytes, or up to 64 KB before them when there is a comment.
  const tailStart = Math.max(0, blob.size - 22 - 65535);
  const tail = await view(blob, tailStart, blob.size);
  let end = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('This is not a ZIP file, or it is damaged.');
  const count = tail.getUint16(end + 10, true);
  const size = tail.getUint32(end + 12, true);
  const offset = tail.getUint32(end + 16, true);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw tooLarge();
  if (count > LIMITS.entries) throw new Error(`This ZIP file holds ${count} files. LA2L Sender reads ${LIMITS.entries} at most.`);
  if (offset + size > blob.size) throw damaged();
  const dir = await view(blob, offset, offset + size);
  const files = [];
  const skipped = [];
  let total = 0;
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > dir.byteLength || dir.getUint32(p, true) !== CENTRAL) throw damaged();
    const flags = dir.getUint16(p + 8, true);
    const method = dir.getUint16(p + 10, true);
    const crc = dir.getUint32(p + 16, true);
    const packed = dir.getUint32(p + 20, true);
    const length = dir.getUint32(p + 24, true);
    const nameLength = dir.getUint16(p + 28, true);
    const at = dir.getUint32(p + 42, true);
    if (p + 46 + nameLength > dir.byteLength) throw damaged();
    const path = nameOf(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLength), flags & 0x800);
    p += 46 + nameLength + dir.getUint16(p + 30, true) + dir.getUint16(p + 32, true);
    const name = path.split(/[/\\]/).pop();
    if (!name || path.startsWith('__MACOSX/') || name.startsWith('.')) continue;
    if (!keep(name)) {
      skipped.push(name);
      continue;
    }
    if (flags & 1) throw new Error(`${name} is protected with a password. Share it without one.`);
    if (method !== 0 && method !== 8) throw new Error(`${name} is packed in a way this page cannot read. Unpack the ZIP file and share the WAV files.`);
    if (packed === 0xffffffff || length === 0xffffffff) throw tooLarge();
    // What it says it holds decides, before a byte is unpacked; unpacking keeps it to that.
    if (length > LIMITS.entryBytes) throw new Error(`${name} is ${Math.round(length / 1048576)} MB. LA2L takes 200 MB per package at most.`);
    total += length;
    if (total > LIMITS.totalBytes) throw tooLarge();
    // The local header has a name and an extra field of its own, before the data.
    const head = await view(blob, at, at + 30);
    if (head.byteLength < 30 || head.getUint32(0, true) !== LOCAL) throw damaged();
    const start = at + 30 + head.getUint16(26, true) + head.getUint16(28, true);
    if (start + packed > blob.size) throw damaged();
    let stream = blob.slice(start, start + packed).stream();
    if (method === 8) stream = stream.pipeThrough(new DecompressionStream('deflate-raw'));
    let out;
    try {
      out = await new Response(stream.pipeThrough(guarded(name, length, crc))).blob();
    } catch (e) {
      throw new Error(`${name} in the ZIP file is damaged.`);
    }
    files.push(new File([out], name, { type: /\.wave?$/i.test(name) ? 'audio/wav' : '' }));
  }
  return { files, skipped };
}
