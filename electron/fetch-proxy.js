'use strict';

// `/fetch?url=` proxy for the ebook importer.
//
// Remote books are almost never served with CORS headers, so the browser cannot
// read them directly; the app's own origin fetches them instead. Both servers
// mount this — the dev server (vite.config.mts) and the packaged one
// (electron/main.js) — so the scheme check and the size cap live here only.

const MAX_BYTES = 80 * 1024 * 1024;

function answer(response, status, message) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(message);
}

/**
 * Stream `rawUrl` into `response`, or answer with a short reason it will not.
 * http(s) only. Anything over MAX_BYTES is refused, whether the size is
 * declared up front or only discovered while the bytes arrive.
 */
async function proxyRemote(rawUrl, response, userAgent) {
  let target;
  try {
    target = new URL(rawUrl ?? '');
  } catch {
    answer(response, 400, 'Bad url');
    return;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    answer(response, 400, 'Only http(s) URLs');
    return;
  }

  let upstream;
  try {
    upstream = await fetch(target, { redirect: 'follow', headers: { 'user-agent': userAgent } });
  } catch (error) {
    answer(response, 502, error instanceof Error ? error.message : 'Fetch failed');
    return;
  }

  if (!upstream.ok || !upstream.body) {
    answer(response, upstream.status || 502, `Upstream said ${upstream.status}`);
    return;
  }

  if (Number(upstream.headers.get('content-length') ?? 0) > MAX_BYTES) {
    // Stop the download we just refused instead of leaving it streaming.
    void upstream.body.cancel().catch(() => {});
    answer(response, 413, 'File too large');
    return;
  }

  response.writeHead(200, {
    'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });

  let written = 0;
  try {
    for await (const chunk of upstream.body) {
      if (response.destroyed) return;
      written += chunk.byteLength;
      if (written > MAX_BYTES) {
        response.destroy();
        return;
      }
      if (!response.write(chunk)) {
        // Wait for the socket, but not forever: a closed client cannot drain.
        await new Promise((resume) => {
          response.once('drain', resume);
          response.once('close', resume);
        });
      }
    }
    if (!response.destroyed) response.end();
  } catch {
    response.destroy();
  }
}

/** Mountable handler: reads `?url=` from a Node request and proxies it. */
function proxyRequest(request, response, userAgent) {
  const raw = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('url');
  return proxyRemote(raw, response, userAgent);
}

module.exports = { MAX_BYTES, proxyRemote, proxyRequest };
