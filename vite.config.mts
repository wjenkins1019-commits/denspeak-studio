import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The packaged app mounts the same module from electron/main.js, so the /fetch
// rules (http(s) only, 80 MB cap) are written once for both servers.
const { proxyRequest } = createRequire(import.meta.url)('./electron/fetch-proxy.js') as {
  proxyRequest: (request: IncomingMessage, response: ServerResponse, userAgent: string) => Promise<void>;
};

const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.onnx': 'application/octet-stream',
  '.onnx_data': 'application/octet-stream',
  '.wav': 'audio/wav',
};

/**
 * Serves `models/` at /models in dev, so the cloning engine reads the weights
 * from this machine instead of streaming ~1.5 GB from the Hub at first use.
 * The packaged app serves the same folder from electron/main.js.
 */
function localModels(rootDir: string): Plugin {
  const base = path.join(rootDir, 'models');

  return {
    name: 'chatterbox-local-models',
    configureServer(server) {
      server.middlewares.use('/models', (request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const filePath = path.normalize(path.join(base, decodeURIComponent(url.pathname)));

        if (!filePath.startsWith(base)) {
          response.statusCode = 403;
          response.end('Forbidden');
          return;
        }

        fs.stat(filePath, (error, stat) => {
          if (error || !stat.isFile()) {
            next();
            return;
          }

          const extension = path.extname(filePath);
          response.setHeader('content-type', MIME[extension] ?? 'application/octet-stream');
          response.setHeader('content-length', stat.size);

          // transformers.js probes for a file with HEAD before downloading it, and
          // treats a non-200 as "this model has no tokenizer".
          if (request.method === 'HEAD') {
            response.statusCode = 200;
            response.end();
            return;
          }

          fs.createReadStream(filePath).pipe(response);
        });
      });
    },
  };
}

/** Serves the ebook importer's `/fetch?url=` proxy in development. */
function remoteFetch(): Plugin {
  return {
    name: 'denspeak-remote-fetch',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (pathname !== '/fetch') {
          next();
          return;
        }
        void proxyRequest(request, response, 'DenspeakStudio dev (ebook import)');
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localModels(import.meta.dirname), remoteFetch()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Cross-origin isolation gives onnxruntime-web SharedArrayBuffer, so the
    // cloning model runs on all cores instead of one (it is otherwise minutes
    // per line). The packaged app sends the same headers from electron/main.js.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // legacy-build/ is the original compiled app kept for reference; it must not
    // be scanned or watched (its package.json is the truncated asar copy).
    watch: { ignored: ['**/legacy-build/**', '**/models/**'] },
  },
  optimizeDeps: {
    entries: ['index.html'],
    // The transcription worker imports the transformers bundle directly; the
    // pre-bundler chokes on it (504 on the optimized dep), so it stays raw.
    exclude: ['@huggingface/transformers'],
  },
  // The cloning worker is created with `{ type: 'module' }` and uses top-level
  // await while it probes which model quantisation to load.
  worker: {
    format: 'es',
  },
  build: {
    outDir: 'dist',
    target: 'chrome120',
  },
});
