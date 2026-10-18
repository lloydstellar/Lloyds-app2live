// Reads the files out of a ZIP archive in the browser, without a library: n-Track and other music
// apps export stems as a ZIP of WAV files. Stored and deflated entries; deflated ones go through
// DecompressionStream('deflate-raw'), in Chrome 103 and newer. Not ZIP64 (over 4 GB) and not
// encrypted archives. Runs in Node.js too, for the tests.

const END = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const damaged = () => new Error('This ZIP file is damaged.');

async function view(blob, start, end) {
  return new DataView(await blob.slice(start, end).arrayBuffer());
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
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new Error('This ZIP file is too large to read here. Unpack it and share the WAV files.');
  if (offset + size > blob.size) throw damaged();
  const dir = await view(blob, offset, offset + size);
  const names = new TextDecoder();
  const files = [];
  const skipped = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > dir.byteLength || dir.getUint32(p, true) !== CENTRAL) throw damaged();
    const flags = dir.getUint16(p + 8, true);
    const method = dir.getUint16(p + 10, true);
    const packed = dir.getUint32(p + 20, true);
    const length = dir.getUint32(p + 24, true);
    const nameLength = dir.getUint16(p + 28, true);
    const at = dir.getUint32(p + 42, true);
    const path = names.decode(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, Math.min(nameLength, dir.byteLength - p - 46)));
    p += 46 + nameLength + dir.getUint16(p + 30, true) + dir.getUint16(p + 32, true);
    const name = path.split(/[/\\]/).pop();
    if (!name || path.startsWith('__MACOSX/') || name.startsWith('.')) continue;
    if (!keep(name)) {
      skipped.push(name);
      continue;
    }
    if (flags & 1) throw new Error(`${name} is protected with a password. Share it without one.`);
    if (method !== 0 && method !== 8) throw new Error(`${name} is packed in a way this page cannot read. Unpack the ZIP file and share the WAV files.`);
    if (packed === 0xffffffff || length === 0xffffffff) throw new Error('This ZIP file is too large to read here. Unpack it and share the WAV files.');
    // The local header has a name and an extra field of its own, before the data.
    const head = await view(blob, at, at + 30);
    if (head.byteLength < 30 || head.getUint32(0, true) !== LOCAL) throw damaged();
    const start = at + 30 + head.getUint16(26, true) + head.getUint16(28, true);
    if (start + packed > blob.size) throw damaged();
    const data = blob.slice(start, start + packed);
    let out = data;
    if (method === 8) {
      try {
        out = await new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
      } catch (e) {
        throw new Error(`${name} in the ZIP file is damaged.`);
      }
    }
    if (out.size !== length) throw new Error(`${name} in the ZIP file is damaged.`);
    files.push(new File([out], name, { type: /\.wave?$/i.test(name) ? 'audio/wav' : '' }));
  }
  return { files, skipped };
}
