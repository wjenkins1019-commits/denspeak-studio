// Postinstall patch for @diffusionstudio/vits-web.
// The engine resolves models through a hardcoded voice -> file map that is
// missing a few voices its own model mirror already hosts (notably three
// extra en_US voices). This inserts those entries so predict/download/stored
// treat them like any other voice. Idempotent: entries that already exist
// are skipped, and a changed upstream layout fails loudly instead of
// corrupting the bundle.
//
//   node scripts/patch-vits.mjs   (also runs automatically on npm install)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = path.join(root, 'node_modules', '@diffusionstudio', 'vits-web', 'dist', 'vits-web.js');

// Voice id -> model path, same layout as the neighbouring entries.
const EXTRA = {
  'en_US-bryce-medium': 'en/en_US/bryce/medium/en_US-bryce-medium.onnx',
  'en_US-john-medium': 'en/en_US/john/medium/en_US-john-medium.onnx',
  'en_US-norman-medium': 'en/en_US/norman/medium/en_US-norman-medium.onnx',
};

let src;
try {
  src = fs.readFileSync(target, 'utf8');
} catch {
  console.log('[patch-vits] engine bundle not installed; skipping.');
  process.exit(0);
}

const missing = Object.entries(EXTRA).filter(([id]) => !src.includes(`"${id}":`));
if (missing.length === 0) {
  console.log('[patch-vits] all extra voices already mapped; nothing to do.');
  process.exit(0);
}

// Anchor on a neighbouring entry so a future engine layout fails loudly
// instead of patching the wrong bytes.
const anchor = '"en_US-danny-low":';
const at = src.indexOf(anchor);
if (at === -1) {
  console.error('[patch-vits] anchor entry not found; refusing to patch. Extra en_US voices stay unavailable.');
  process.exit(1);
}

const insert = missing.map(([id, file]) => `"${id}": "${file}",\n  `).join('');
fs.writeFileSync(target, src.slice(0, at) + insert + src.slice(at));
console.log(`[patch-vits] mapped ${missing.map(([id]) => id).join(', ')}.`);
