// Worker entry point for cloned-voice inference.
//
// Model loading takes tens of seconds and blocks whichever thread it runs on, so
// the engine lives here and the window stays responsive while it works.
//
// Weights are served from this app's own loopback server (`npm run fetch:model`
// puts them in models/chatterbox/), not from the Hugging Face CDN: a 563 MB
// cross-origin fetch was dying with HTTP/2 protocol errors, and local files also
// make the feature work offline.
import * as transformers from '@huggingface/transformers';
import {
  ChatterboxEngine,
  exposeEngine,
  type RpcEndpoint,
  type TransformersModule,
} from 'voxshot';

const { env } = transformers;
env.allowRemoteModels = false;
env.allowLocalModels = true;
// Relative on purpose: transformers.js only treats `localModelPath` as a local
// directory when it is *not* an absolute URL, and an absolute one makes its file
// probes report "missing" for every file.
env.localModelPath = '/models/';
env.useBrowserCache = false;

let emit: ((progress: Record<string, unknown>) => void) | null = null;

const engine = new ChatterboxEngine({
  modelId: 'chatterbox',
  // Local files emit no transfer-progress events, so a slow WebGPU compile of the
  // language model looks like a stalled download. Give it real headroom.
  // A 1.4 GB model on WASM can sit inside session creation for many minutes
  // without emitting progress, so the guard has to be generous.
  stallTimeoutMs: 1_800_000,
  // voxshot's default loader imports the bare specifier at runtime, which the
  // browser cannot resolve. Hand it the module Vite already bundled instead.
  loadModule: async () => transformers as unknown as TransformersModule,
  onProgress: (progress) => {
    emit?.(progress as unknown as Record<string, unknown>);
  },
});

const serve = exposeEngine(engine, self as unknown as RpcEndpoint);
emit = serve.emitProgress;
