// Downloads the Chatterbox ONNX model into models/chatterbox/ so the app can load
// it from its own server instead of pulling gigabytes cross-origin from the Hub.
//
// Files download in parallel (a single connection to the Hub is slow), each one
// resumable: a partial file is continued with a Range request and retried with
// backoff. Files already the right size are skipped, so re-running is cheap.
//
//   npm run fetch:model                 # the base q4 set
//   npm run fetch:model -- q4f16 fp16   # also fetch extra language-model variants
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = path.join(root, 'models', 'chatterbox');
const REPO = 'onnx-community/chatterbox-ONNX';
const BASE = `https://huggingface.co/${REPO}/resolve/main`;

const BASE_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/embed_tokens.onnx',
  'onnx/embed_tokens.onnx_data',
  'onnx/speech_encoder.onnx',
  'onnx/speech_encoder.onnx_data',
  'onnx/conditional_decoder.onnx',
  'onnx/conditional_decoder.onnx_data',
  'onnx/language_model_q4.onnx',
  'onnx/language_model_q4.onnx_data',
];

// Extra quantisations of the language model. The GPU in this machine rejects the
// q4 shaders, so q4f16 (f16 compute) and fp16 are useful fallbacks.
const VARIANT_FILES = {
  q4f16: ['onnx/language_model_q4f16.onnx', 'onnx/language_model_q4f16.onnx_data'],
  fp16: ['onnx/language_model_fp16.onnx', 'onnx/language_model_fp16.onnx_data'],
  q4: ['onnx/language_model_q4.onnx', 'onnx/language_model_q4.onnx_data'],
};

const CONCURRENCY = 4;
const RETRIES = 8;

const requested = process.argv.slice(2).filter((argument) => !argument.startsWith('-'));
const FILES = [
  ...BASE_FILES,
  ...requested.flatMap((variant) => {
    const files = VARIANT_FILES[variant];
    if (!files) {
      console.error(`Unknown variant "${variant}". Options: ${Object.keys(VARIANT_FILES).join(', ')}`);
      process.exit(1);
    }
    return files;
  }),
].filter((file, index, list) => list.indexOf(file) === index);

async function remoteSize(file) {
  try {
    const response = await fetch(`${BASE}/${file}`, { method: 'HEAD', redirect: 'follow' });
    if (!response.ok) return null;
    const length = Number(response.headers.get('content-length') ?? 0);
    return length > 0 ? length : null;
  } catch {
    return null;
  }
}

async function download(file) {
  const destination = path.join(target, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  const expected = await remoteSize(file);
  const existing = fs.existsSync(destination) ? fs.statSync(destination).size : 0;

  if (expected !== null && existing === expected) {
    console.log(`  ${file}: already complete (${(existing / 1048576).toFixed(0)} MB)`);
    return;
  }
  if (expected !== null && existing > expected) {
    fs.truncateSync(destination, 0);
  }

  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    const have = fs.existsSync(destination) ? fs.statSync(destination).size : 0;
    const headers = have > 0 ? { Range: `bytes=${have}-` } : {};

    try {
      const response = await fetch(`${BASE}/${file}`, { headers, redirect: 'follow' });

      if (have > 0 && response.status === 416) {
        console.log(`  ${file}: already complete`);
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error('empty response body');

      const total = Number(response.headers.get('content-length') ?? 0) + have;
      let written = have;
      let lastReport = 0;

      const out = fs.createWriteStream(destination, { flags: have > 0 ? 'a' : 'w' });
      const source = Readable.fromWeb(response.body);
      source.on('data', (chunk) => {
        written += chunk.length;
        // One line per file every ~10%, so parallel downloads stay readable.
        const percent = total > 0 ? Math.floor((written / total) * 100) : 0;
        if (percent >= lastReport + 10) {
          lastReport = percent;
          console.log(`  ${file}: ${percent}%`);
        }
      });

      await pipeline(source, out);

      if (expected !== null && written !== expected) {
        throw new Error(`incomplete: ${written} of ${expected} bytes`);
      }
      console.log(`  ${file}: done (${(written / 1048576).toFixed(0)} MB)`);
      return;
    } catch (error) {
      const wait = Math.min(30, 2 ** attempt);
      console.warn(`  ${file}: attempt ${attempt} failed (${error.message}); retrying in ${wait}s`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    }
  }

  throw new Error(`could not download ${file}`);
}

async function runPool(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      await worker(items[current]);
    }
  });
  await Promise.all(runners);
}

console.log(`Fetching ${FILES.length} files into models/chatterbox (${CONCURRENCY} at a time)…`);
const started = Date.now();

try {
  await runPool(FILES, CONCURRENCY, download);
} catch (error) {
  console.error(`\nDownload failed: ${error.message}`);
  console.error('Re-run the same command to resume; completed files are skipped.');
  process.exit(1);
}

let total = 0;
for (const file of FILES) {
  const destination = path.join(target, file);
  if (fs.existsSync(destination)) total += fs.statSync(destination).size;
}
console.log(
  `\nDone in ${Math.round((Date.now() - started) / 1000)}s — ${(total / 1073741824).toFixed(2)} GB in models/chatterbox.`,
);
