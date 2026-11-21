// Development runner: starts Vite on a fixed loopback port, then opens Electron
// on it. Closing the app window shuts the dev server down with it.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electronPath from 'electron';

const HOST = '127.0.0.1';
const PORT = 5173;

const server = await createServer({
  server: { host: HOST, port: PORT, strictPort: true },
});
await server.listen();

const url = `http://${HOST}:${PORT}`;
console.log(`\n  Denspeak Studio dev server: ${url}\n`);

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});

let closing = false;
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  await server.close();
  process.exit(code);
}

child.on('close', (code) => void shutdown(code ?? 0));
process.on('SIGINT', () => {
  child.kill();
  void shutdown(0);
});
