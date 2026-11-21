// Unit tests for the pure logic in src/lib (EQ, ZIP, filenames, WAV/MP3),
// plus component regression tests under src/components. Node environment by
// default; a component test opts into jsdom with its own pragma comment.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Release-script tests live beside the scripts they guard, so `npm test`
    // covers them in the workflow's test step too.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.mjs'],
  },
});
