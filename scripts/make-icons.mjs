// Renders the app mark from assets/icon.svg into the sizes the app serves:
// the favicon/touch PNGs in public/icons, and a multi-resolution Windows .ico
// for the window icon and shortcut.
//
//   npm run icons
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, 'assets', 'icon.svg');
const publicDir = path.join(root, 'public', 'icons');

const PNG_SIZES = [16, 32, 48, 64, 128, 180, 192, 256, 512];
/** Windows icons carry these; 256 is written as 0 in the directory entry. */
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

fs.mkdirSync(publicDir, { recursive: true });

const pngs = new Map();
for (const size of PNG_SIZES) {
  const png = await sharp(source, { density: 480 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
  pngs.set(size, png);

  if ([180, 192, 256, 512].includes(size)) {
    fs.writeFileSync(path.join(publicDir, `icon-${size}.png`), png);
  }
}

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // 1 = icon
header.writeUInt16LE(ICO_SIZES.length, 4);

const entries = [];
const blobs = [];
let offset = 6 + 16 * ICO_SIZES.length;

for (const size of ICO_SIZES) {
  const data = pngs.get(size);
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size === 256 ? 0 : size, 0);
  entry.writeUInt8(size === 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(data.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  blobs.push(data);
  offset += data.length;
}

fs.writeFileSync(path.join(root, 'assets', 'icon.ico'), Buffer.concat([header, ...entries, ...blobs]));
fs.copyFileSync(source, path.join(publicDir, 'icon.svg'));

console.log(`Wrote public/icons/ and assets/icon.ico (${ICO_SIZES.join('/')}).`);
