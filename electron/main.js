'use strict';

// Electron shell for Denspeak Studio.
//
// In development the window points at the Vite dev server. In production it
// serves the built `dist/` folder from a loopback HTTP origin, which is what
// gives the studio a secure context (OPFS model cache, microphone, workers).

const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require('electron');
// Shared with the dev server, so the /fetch rules exist in one place.
const { proxyRequest } = require('./fetch-proxy');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const DIST_DIR = path.join(__dirname, '..', 'dist');
const INDEX = path.join(DIST_DIR, 'index.html');
// Weights for cloned voices live outside dist/ so a build never copies 1.5 GB.
const MODELS_DIR = path.join(__dirname, '..', 'models');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

function sendFile(res, filePath) {
  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    // A HEAD response carries the same headers with no body; transformers.js
    // probes model files this way before downloading them.
    const headers = {
      'content-type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(stat.size),
      'cache-control': 'no-cache',
    };

    if (res.req?.method === 'HEAD') {
      res.writeHead(200, headers);
      res.end();
      return;
    }

    fs.readFile(filePath, (error, data) => {
      if (error) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, headers);
      res.end(data);
    });
  });
}

/** Static host on 127.0.0.1 — a secure origin, so OPFS and the workers work. */
function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      // Cross-origin isolation: onnxruntime-web only uses multiple threads
      // (SharedArrayBuffer) when the document is isolated.
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');

      if (url.pathname === '/fetch') {
        void proxyRequest(req, res, `DenspeakStudio/${app.getVersion()} (ebook import)`);
        return;
      }

      if (url.pathname.startsWith('/models/')) {
        const modelPath = path.normalize(path.join(MODELS_DIR, decodeURIComponent(url.pathname.slice('/models'.length))));
        if (!modelPath.startsWith(MODELS_DIR)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Forbidden');
          return;
        }
        sendFile(res, modelPath);
        return;
      }

      const requested = path.normalize(path.join(DIST_DIR, decodeURIComponent(url.pathname)));

      if (!requested.startsWith(DIST_DIR)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }

      fs.stat(requested, (error, stat) => {
        if (!error && stat.isFile()) {
          sendFile(res, requested);
          return;
        }
        // The studio routes with hash URLs, so any unknown path is the shell.
        sendFile(res, INDEX);
      });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let mainWindow = null;
let origin = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#040b18',
    // Window/taskbar and shortcut icon; generated from assets/icon.svg.
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    title: 'Denspeak Studio',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Links to other sites belong in the real browser, not in the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!origin || !url.startsWith(origin)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  void mainWindow.loadURL(`${origin}/`);
}

// Save As for exported takes and the library ZIP. The dialog picks the path,
// so the renderer only ever supplies the bytes and a suggested file name.
// Plain browser tabs do not have this channel and keep the download fallback.
ipcMain.handle('denspeak:save-file', async (event, input) => {
  const { defaultName = 'denspeak-studio', filters = [], data } = input ?? {};
  const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export',
    defaultPath: defaultName,
    filters,
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  });
  if (canceled || !filePath) return { saved: false };
  await fs.promises.writeFile(filePath, Buffer.from(data));
  return { saved: true };
});

app.setAppUserModelId('com.965media.denspeakstudio');

// This rebuild keeps its own profile. Sharing the installed 0.2.0 app's profile
// folder ("Chatter Box") would put both behind the same single-instance lock and
// the same disk caches, so the two could not run side by side.
app.setPath('userData', path.join(app.getPath('appData'), 'denspeak-studio'));

// The studio reads this token from the user agent to tell it is the packaged
// build rather than a browser tab.
app.userAgentFallback = `${app.userAgentFallback} DenspeakStudio/${app.getVersion()}`;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);

    // Recording in the Convert view needs the microphone; the rest is clipboard
    // access for the copy buttons.
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(['media', 'audioCapture', 'clipboard-read', 'clipboard-write'].includes(permission));
    });
    session.defaultSession.setPermissionCheckHandler(
      (_contents, permission) => permission === 'media' || permission.startsWith('clipboard'),
    );

    try {
      if (DEV_URL) {
        origin = DEV_URL.replace(/\/$/, '');
      } else {
        if (!fs.existsSync(INDEX)) {
          dialog.showErrorBox(
            'Denspeak Studio is not built yet',
            'Run "npm run build" first, then start the app again.',
          );
          app.quit();
          return;
        }
        const server = await startServer();
        const { port } = server.address();
        origin = `http://127.0.0.1:${port}`;
        app.on('before-quit', () => server.close());
      }
      createWindow();
    } catch (error) {
      dialog.showErrorBox(
        'Denspeak Studio could not start',
        `The local studio server did not start.\n\n${error instanceof Error ? error.message : String(error)}`,
      );
      app.quit();
    }
  });

  app.on('window-all-closed', () => app.quit());
}
