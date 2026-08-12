'use strict';

/* ================================================================
   A very small zip reader and writer

   Enough of the format to pack a plugin folder into one file people can
   download, and to unpack one they downloaded — nothing more. Deflate and
   stored entries, no zip64, no encryption, no spanning. Node ships the
   compression (zlib), so this stays dependency-free like the rest of the app.

   Files produced here open in Explorer, Finder and `unzip`; files those tools
   produce read back here.
================================================================ */

const zlib = require('zlib');

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

// CRC-32, which every zip entry carries and which is the only integrity check
// the format offers. Node has zlib.crc32 on newer releases; this table keeps
// the tool working on every version that runs the app.
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosStamp(d) {
  // The zip epoch starts in 1980; anything older is clamped to it.
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/* ---------------- writing ---------------- */
// entries: [{ name, data, mtime }] with forward-slash paths. Returns a Buffer.
function writeZip(entries, when) {
  const stamp = dosStamp(when || new Date());
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // Tiny files can come out bigger compressed; store those as they are.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);            // version needed to extract: 2.0
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);            // extra field length
    chunks.push(local, name, body);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(CENTRAL_SIG, 0);
    head.writeUInt16LE(0x0314, 4);         // made by: unix, 2.0 — external attrs are a mode
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0, 8);
    head.writeUInt16LE(method, 10);
    head.writeUInt16LE(stamp.time, 12);
    head.writeUInt16LE(stamp.date, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt16LE(0, 30);             // extra
    head.writeUInt16LE(0, 32);             // comment
    head.writeUInt16LE(0, 34);             // disk number
    head.writeUInt16LE(0, 36);             // internal attrs
    // regular file, rw-r--r-- — shifted past bit 31, so back to unsigned
    head.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);

    offset += local.length + name.length + body.length;
  }

  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD_SIG, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);                // no archive comment
  return Buffer.concat([...chunks, dir, end]);
}

/* ---------------- reading ---------------- */
// Returns [{ name, data }] for every file in the archive. Directory entries are
// dropped: the extractor makes the folders it needs from the file paths.
function readZip(buf, maxTotalBytes) {
  const limit = maxTotalBytes || 32 * 1024 * 1024;
  // The end record sits at the back, behind an archive comment of up to 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xFFFF; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('this is not a zip file (no end-of-archive record)');

  const count = buf.readUInt16LE(eocd + 10);
  const dirSize = buf.readUInt32LE(eocd + 12);
  const dirStart = buf.readUInt32LE(eocd + 16);
  if (dirStart === 0xFFFFFFFF || dirSize === 0xFFFFFFFF) throw new Error('zip64 archives are not supported');
  if (dirStart + dirSize > buf.length) throw new Error('the archive is truncated');

  const files = [];
  let total = 0;
  let p = dirStart;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) throw new Error('the archive index is damaged');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const attrs = buf.readUInt32LE(p + 38);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // a folder entry; the paths carry the shape
    // A symlink in an archive can point anywhere on the machine unpacking it.
    if (((attrs >>> 16) & 0o170000) === 0o120000) throw new Error(`"${name}" is a symlink, which is not unpacked`);

    total += rawSize;
    if (total > limit) throw new Error('the archive unpacks to more than this tool will write');

    if (buf.readUInt32LE(localAt) !== LOCAL_SIG) throw new Error(`the entry for "${name}" is damaged`);
    // The local header repeats the name and extra field, and its lengths are
    // the ones that place the data — they need not match the index's.
    const start = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const body = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = zlib.inflateRawSync(body);
    else throw new Error(`"${name}" uses a compression method this tool cannot read (${method})`);
    if (data.length !== rawSize || crc32(data) !== crc) throw new Error(`"${name}" did not survive the download intact`);
    files.push({ name, data });
  }
  return files;
}

module.exports = { readZip, writeZip, crc32 };
