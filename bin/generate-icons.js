// Generates solid-color PNG icons using only built-in Node.js modules (no canvas needed).
// Run once: node bin/generate-icons.js
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

function crc32(buf) {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ t[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length);
  const tb = Buffer.from(type, 'ascii');
  const crcVal = Buffer.alloc(4); crcVal.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([lenBuf, tb, data, crcVal]);
}

// Draw a square PNG: bg color + a centered rounded-square block in accent color
// Using simple pixel-by-pixel approach (no font rendering)
function makePNG(size, bgR, bgG, bgB, fgR, fgG, fgB) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // RGB

  const margin = Math.round(size * 0.12);
  const radius = Math.round(size * 0.15);
  const x0 = margin, y0 = margin, x1 = size - margin - 1, y1 = size - margin - 1;

  function inRoundedRect(x, y) {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const corners = [[x0+radius,y0+radius],[x1-radius,y0+radius],[x1-radius,y1-radius],[x0+radius,y1-radius]];
    for (const [cx, cy] of corners) {
      if (x >= cx-radius && x <= cx && y >= cy-radius && y <= cy) {
        const dx = x - cx, dy = y - cy;
        return dx*dx + dy*dy <= radius*radius;
      }
    }
    return true;
  }

  // Fork icon: two vertical rectangles (fork tines) + one wider block (handle) centered
  const cx = Math.round(size / 2);
  const icy = Math.round(size * 0.5);
  const tineW = Math.round(size * 0.04);
  const tineH = Math.round(size * 0.22);
  const handleW = Math.round(size * 0.10);
  const handleH = Math.round(size * 0.18);
  const tineGap = Math.round(size * 0.06);
  const tineY = Math.round(icy - size * 0.12);
  const handleY = Math.round(icy + size * 0.06);

  function inIcon(x, y) {
    // Two fork tines
    const t1x = cx - tineGap - tineW/2, t2x = cx + tineGap - tineW/2;
    if ((x >= t1x && x < t1x+tineW || x >= t2x && x < t2x+tineW) && y >= tineY && y < tineY+tineH) return true;
    // Handle / grip
    if (x >= cx - handleW/2 && x < cx + handleW/2 && y >= handleY && y < handleY+handleH) return true;
    return false;
  }

  const rowBytes = size * 3;
  const raw = Buffer.alloc((rowBytes + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (rowBytes + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * (rowBytes + 1) + 1 + x * 3;
      if (inRoundedRect(x, y)) {
        if (inIcon(x, y)) { raw[i] = bgR; raw[i+1] = bgG; raw[i+2] = bgB; }
        else               { raw[i] = fgR; raw[i+1] = fgG; raw[i+2] = fgB; }
      } else {
        raw[i] = bgR; raw[i+1] = bgG; raw[i+2] = bgB;
      }
    }
  }

  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

const out = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(out, { recursive: true });

// Dark navy bg (#0f0f1a = 15,15,26), purple accent (#7c5cbf = 124,92,191)
const bg = [15, 15, 26], fg = [124, 92, 191];

fs.writeFileSync(path.join(out, 'icon-192.png'),        makePNG(192, ...bg, ...fg));
fs.writeFileSync(path.join(out, 'icon-512.png'),        makePNG(512, ...bg, ...fg));
fs.writeFileSync(path.join(out, 'apple-touch-icon.png'), makePNG(180, ...bg, ...fg));
console.log('Icons generated in public/icons/');
