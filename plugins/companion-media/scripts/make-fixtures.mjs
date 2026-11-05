import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// Synthetic fixtures for vision/screen verification.
//
// The images carry no semantic filename and no metadata: the only way to answer
// "what is on it" is to look at the pixels. That is exactly the property M2 asks
// for, so the fixture generator draws shapes and digits itself instead of
// downloading a picture with a telling name.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

export function encodePng(width, height, paint) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      const index = rowStart + 1 + x * 3;
      raw[index] = r;
      raw[index + 1] = g;
      raw[index + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 5x7 digit masks.
const DIGITS = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

function drawDigit(paint, digit, originX, originY, scale, color) {
  const mask = DIGITS[digit];
  return (x, y) => {
    const localX = Math.floor((x - originX) / scale);
    const localY = Math.floor((y - originY) / scale);
    if (localX < 0 || localX > 4 || localY < 0 || localY > 6) return null;
    return mask[localY][localX] === '1' ? color : null;
  };
}

function compose(layers, background) {
  return (x, y) => {
    for (const layer of layers) {
      const value = layer(x, y);
      if (value) return value;
    }
    return background;
  };
}

function circle(centerX, centerY, radius, color) {
  return (x, y) => {
    const dx = x - centerX;
    const dy = y - centerY;
    return dx * dx + dy * dy <= radius * radius ? color : null;
  };
}

function rect(x0, y0, x1, y1, color) {
  return (x, y) => (x >= x0 && x <= x1 && y >= y0 && y <= y1 ? color : null);
}

/** Colour name block next to a digit, on a white field. */
function colourAndDigit({ colour, name, digit, size = 320 }) {
  const background = [255, 255, 255];
  const layers = [
    circle(size * 0.3, size * 0.45, size * 0.18, colour),
    drawDigit(null, digit, size * 0.62, size * 0.2, size / 16, colour),
    rect(0, size * 0.88, size, size * 0.92, [230, 230, 230]),
  ];
  return encodePng(size, size, compose(layers, background));
}

function fakeDesktop() {
  const size = 480;
  const layers = [
    rect(0, 0, size, 26, [32, 34, 40]), // window title bar
    rect(0, 26, 150, size, [46, 49, 58]), // sidebar
    rect(160, 60, 300, 100, [90, 140, 200]), // button
    rect(160, 130, 460, 170, [220, 220, 225]), // text row
    rect(160, 180, 460, 220, [220, 220, 225]),
    rect(160, 230, 380, 270, [220, 220, 225]),
    drawDigit(null, 1, 400, 300, 14, [30, 30, 30]),
    drawDigit(null, 2, 420, 300, 14, [30, 30, 30]),
  ];
  return encodePng(size, size, compose(layers, [245, 245, 248]));
}

/** A sticker-like square with a big yellow face, used for the cloud route. */
function stickerFace() {
  const size = 240;
  const background = [255, 255, 255];
  const layers = [
    circle(size / 2, size / 2, size * 0.42, [255, 214, 64]),
    circle(size * 0.38, size * 0.42, 12, [40, 40, 40]),
    circle(size * 0.62, size * 0.42, 12, [40, 40, 40]),
    rect(size * 0.36, size * 0.62, size * 0.64, size * 0.66, [40, 40, 40]),
  ];
  return encodePng(size, size, compose(layers, background));
}

const targets = [
  { dir: 'test/fixtures/vision', name: 'sample-a.png', bytes: colourAndDigit({ colour: [220, 40, 40], name: 'red', digit: 7 }) },
  { dir: 'test/fixtures/vision', name: 'sample-b.png', bytes: colourAndDigit({ colour: [40, 90, 220], name: 'blue', digit: 3 }) },
  { dir: 'test/fixtures/vision', name: 'sticker_sample.png', bytes: stickerFace() },
  { dir: 'test/fixtures/screen', name: 'synthetic-desktop.png', bytes: fakeDesktop() },
];

for (const target of targets) {
  const dir = path.join(root, target.dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, target.name), target.bytes);
  console.log(`${path.relative(root, path.join(dir, target.name))} ${target.bytes.length} bytes`);
}
