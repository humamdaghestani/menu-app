const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

function makePNG(size, r, g, b) {
  const sig = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);

  const CRC_TABLE = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    CRC_TABLE[i] = c;
  }
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    const t = Buffer.from(type);
    const l = Buffer.alloc(4); l.writeUInt32BE(data.length);
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([l, t, data, cr]);
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8]=8; ihdr[9]=2; // RGB

  // Build rows: filter byte 0 + RGB pixels
  // Add a simple rounded square "M" design: background + white circle
  const rows = [];
  const cx = size / 2, cy = size / 2, rad = size * 0.35;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    row[0] = 0;
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const inCircle = dx*dx + dy*dy <= rad*rad;
      const pr = inCircle ? 255 : r;
      const pg = inCircle ? 255 : g;
      const pb = inCircle ? 255 : b;
      row[1 + x*3] = pr; row[2 + x*3] = pg; row[3 + x*3] = pb;
    }
    rows.push(row);
  }
  const raw = Buffer.concat(rows);
  const idat = zlib.deflateSync(raw, { level: 6 });

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const iconsDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(iconsDir, { recursive: true });

// Purple #7c5cbf
const [r, g, b] = [0x7c, 0x5c, 0xbf];
fs.writeFileSync(path.join(iconsDir, 'icon-192.png'), makePNG(192, r, g, b));
fs.writeFileSync(path.join(iconsDir, 'icon-512.png'), makePNG(512, r, g, b));
console.log('Icons generated in public/icons/');
